import type { Pool, RowDataPacket } from "mysql2/promise";

/**
 * 遥测数据仓储：本仓库中唯一出现 SQL 的地方。
 *
 * 三条查询形状都是**窗口无关**的——返回行数只取决于请求了多少个指标，与时间窗口内
 * 有多少行无关。这是"不把几十万行塞进 LLM 上下文"的结构性保证：聚合在数据库里做，
 * 原始行根本不进入 Node 进程（除非显式要求少量采样）。
 */

/** 单个数值指标的统计摘要。 */
export interface MeasurementAggregate {
	readonly column: string;
	/** 命中行数（含空值）。 */
	readonly totalCount: number;
	/** 该列非空点数；与 totalCount 对比可看出空值密度。 */
	readonly valueCount: number;
	readonly min: number | null;
	readonly max: number | null;
	readonly avg: number | null;
	readonly stddev: number | null;
}

/** 状态量的一种取值及其出现区间。 */
export interface StateGroup {
	readonly column: string;
	readonly value: string;
	readonly count: number;
	readonly firstTimestamp: string;
	readonly lastTimestamp: string;
}

/** 一条原始采样点，键是物理列名。 */
export interface RawSampleRow {
	readonly timestamp: string;
	readonly values: Readonly<Record<string, number | string | null>>;
}

/** 一次聚合查询的附带信息：命中总量与窗口内首末时间。 */
export interface AggregationCoverage {
	readonly rowCount: number;
	readonly firstTimestamp: string | null;
	readonly lastTimestamp: string | null;
}

export interface AggregationResult {
	readonly coverage: AggregationCoverage;
	readonly aggregates: readonly MeasurementAggregate[];
}

/** 设备表自身的数据覆盖范围，用于查询落空时给出可操作提示。 */
export interface TableCoverage {
	readonly rowCount: number;
	readonly firstTimestamp: string | null;
	readonly lastTimestamp: string | null;
}

/** 时间窗口，闭区间（两端都含）。 */
export interface TimeWindow {
	readonly startTime: string;
	readonly endTime: string;
}

/**
 * 库表名与列名无法参数化，只能拼接进 SQL。呼叫方保证它们来自白名单
 * （表名来自 DeviceRegistry，列名来自 MetricCatalog）；这里再校验一次它们确实是
 * 普通标识符——定义表是手写的，复制粘贴出错时希望在这里失败，而不是生成畸形 SQL。
 */
function quoteIdentifier(name: string): string {
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
		throw new Error(`非法的库表或列标识符：${name}`);
	}
	return `\`${name}\``;
}

/** `LIMIT` 用参数占位符在不同 MySQL 版本上行为不一致，这里夹紧成整数后直接拼接。 */
function clampLimit(value: number, max: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.min(Math.max(Math.trunc(value), 0), max);
}

/**
 * 把驱动错误翻译成可读的中文。
 *
 * 刻意只用 `code` 与 `sqlMessage`，**绝不用 `error.sql`**——那里面是拼好的完整 SQL，
 * 会把表名列名回显进 LLM 上下文与会话日志，正好绕开了白名单想守住的东西。
 */
function describeError(error: unknown): Error {
	if (typeof error !== "object" || error === null) return new Error(String(error));
	const { code, sqlMessage, message } = error as { code?: string; sqlMessage?: string; message?: string };

	const detail = sqlMessage ?? message ?? "未知错误";
	switch (code) {
		case "ER_NO_SUCH_TABLE":
			return new Error(`设备数据表不存在，可能已归档或改名（${detail}）`);
		case "ER_ACCESS_DENIED_ERROR":
			return new Error(`数据库凭据无效，请检查 .env 中的 DCMA_DB_USER / DCMA_DB_PASSWORD（${detail}）`);
		case "ER_BAD_DB_ERROR":
			return new Error(`数据库不存在，请检查 .env 中的 DCMA_DB_NAME（${detail}）`);
		case "ECONNREFUSED":
		case "ETIMEDOUT":
		case "ENOTFOUND":
			return new Error(`无法连接数据库，请检查 .env 中的 DCMA_DB_HOST / DCMA_DB_PORT（${detail}）`);
		default:
			return new Error(`数据库查询失败${code ? `（${code}）` : ""}：${detail}`);
	}
}

export class TelemetryRepository {
	/**
	 * 接收的是连接池的**提供函数**而不是连接池实例：池要等到第一次真正查询时才创建，
	 * 这样数据库没配好时 agent 仍能启动，报错只发生在调用工具的那一刻。
	 */
	constructor(private readonly poolProvider: () => Pool) {}

	private async rows(sql: string, params: readonly unknown[]): Promise<RowDataPacket[]> {
		try {
			// 展开一次：mysql2 的 QueryValues 是可变的，readonly 数组传不进去。
			const [result] = await this.poolProvider().query<RowDataPacket[]>(sql, [...params]);
			return result;
		} catch (error) {
			throw describeError(error);
		}
	}

	/**
	 * 在数据库里完成统计聚合，无论窗口多宽都只返回一行。
	 *
	 * 对比"取回原始行再在 Node 里算"：全范围查询要搬 32 万行 × 22 个浮点列（约 56MB）
	 * 过来只为算五个数。聚合下推是这里唯一的正确做法。
	 */
	async aggregate(
		table: string,
		windows: TimeWindow,
		columns: readonly string[],
	): Promise<AggregationResult> {
		const selects = [
			"COUNT(*) AS `__row_count`",
			"MIN(`timestamp`) AS `__first_ts`",
			"MAX(`timestamp`) AS `__last_ts`",
		];
		for (const column of columns) {
			const quoted = quoteIdentifier(column);
			// 输出别名不含反引号与外层引号，直接取用。
			selects.push(
				`COUNT(${quoted}) AS \`${column}__value_count\``,
				`MIN(${quoted}) AS \`${column}__min\``,
				`MAX(${quoted}) AS \`${column}__max\``,
				`AVG(${quoted}) AS \`${column}__avg\``,
				`STDDEV_SAMP(${quoted}) AS \`${column}__stddev\``,
			);
		}

		const sql = `SELECT ${selects.join(", ")} FROM ${quoteIdentifier(table)}
			WHERE \`timestamp\` >= ? AND \`timestamp\` <= ?`;
		const [row] = await this.rows(sql, [windows.startTime, windows.endTime]);
		if (!row) throw new Error("聚合查询未返回结果");

		const aggregates = columns.map<MeasurementAggregate>((column) => ({
			column,
			totalCount: Number(row.__row_count ?? 0),
			valueCount: Number(row[`${column}__value_count`] ?? 0),
			min: toNumberOrNull(row[`${column}__min`]),
			max: toNumberOrNull(row[`${column}__max`]),
			avg: toNumberOrNull(row[`${column}__avg`]),
			stddev: toNumberOrNull(row[`${column}__stddev`]),
		}));

		return {
			coverage: {
				rowCount: Number(row.__row_count ?? 0),
				firstTimestamp: toTextOrNull(row.__first_ts),
				lastTimestamp: toTextOrNull(row.__last_ts),
			},
			aggregates,
		};
	}

	/**
	 * 状态量按取值分组。
	 *
	 * 比"采样看几个点"有用得多：状态列的取值极少（实测 status ∈ {"0","42"}），分组结果
	 * 直接给出"何时变成什么值"，也就是故障起始时刻，且行数有界。
	 */
	async groupState(
		table: string,
		windows: TimeWindow,
		column: string,
		maxGroups: number,
	): Promise<readonly StateGroup[]> {
		const quoted = quoteIdentifier(column);
		const limit = clampLimit(maxGroups, 200);
		const sql = `SELECT ${quoted} AS \`value\`, COUNT(*) AS \`count\`,
				MIN(\`timestamp\`) AS \`first_ts\`, MAX(\`timestamp\`) AS \`last_ts\`
			FROM ${quoteIdentifier(table)}
			WHERE \`timestamp\` >= ? AND \`timestamp\` <= ?
			GROUP BY ${quoted}
			ORDER BY \`count\` DESC
			LIMIT ${limit}`;

		const rows = await this.rows(sql, [windows.startTime, windows.endTime]);
		return rows.map((row) => ({
			column,
			value: toTextOrNull(row.value) ?? "",
			count: Number(row.count ?? 0),
			firstTimestamp: toTextOrNull(row.first_ts) ?? "",
			lastTimestamp: toTextOrNull(row.last_ts) ?? "",
		}));
	}

	/**
	 * 取窗口内最早的 N 条原始采样。只在这条路径上可能拿到多行，且 N 被硬夹紧。
	 *
	 * `ORDER BY timestamp` 而非 `ORDER BY id`：后者能走主键避免排序，但依赖
	 * "id 顺序与时间顺序一致"这个未经确认的假设，不值得为几十毫秒换一个静默出错的风险。
	 */
	async sample(
		table: string,
		windows: TimeWindow,
		columns: readonly string[],
		limit: number,
	): Promise<readonly RawSampleRow[]> {
		const capped = clampLimit(limit, 200);
		if (capped === 0) return [];

		const quotedColumns = columns.map(quoteIdentifier);
		const sql = `SELECT \`timestamp\`, ${quotedColumns.join(", ")}
			FROM ${quoteIdentifier(table)}
			WHERE \`timestamp\` >= ? AND \`timestamp\` <= ?
			ORDER BY \`timestamp\` ASC
			LIMIT ${capped}`;

		const rows = await this.rows(sql, [windows.startTime, windows.endTime]);
		return rows.map((row) => {
			const values: Record<string, number | string | null> = {};
			for (const column of columns) {
				values[column] = (row[column] ?? null) as number | string | null;
			}
			return { timestamp: toTextOrNull(row.timestamp) ?? "", values };
		});
	}

	/** 设备表自身的覆盖范围。只在查询落空时调用，用于给出可操作的提示。 */
	async describeTable(table: string): Promise<TableCoverage> {
		const sql = `SELECT COUNT(*) AS \`row_count\`, MIN(\`timestamp\`) AS \`first_ts\`,
				MAX(\`timestamp\`) AS \`last_ts\`
			FROM ${quoteIdentifier(table)}`;
		const [row] = await this.rows(sql, []);
		return {
			rowCount: Number(row?.row_count ?? 0),
			firstTimestamp: toTextOrNull(row?.first_ts),
			lastTimestamp: toTextOrNull(row?.last_ts),
		};
	}

	/** 最新数据时间。用于「未指定时间范围」时定位到有数据的那一段。 */
	async latestTimestamp(table: string): Promise<string | undefined> {
		const sql = `SELECT MAX(\`timestamp\`) AS \`last_ts\` FROM ${quoteIdentifier(table)}`;
		const [row] = await this.rows(sql, []);
		return toTextOrNull(row?.last_ts) ?? undefined;
	}
}

function toNumberOrNull(value: unknown): number | null {
	if (value === null || value === undefined) return null;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : null;
}

function toTextOrNull(value: unknown): string | null {
	if (value === null || value === undefined) return null;
	return String(value);
}
