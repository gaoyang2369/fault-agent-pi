import type { Pool, PoolConnection, RowDataPacket } from "mysql2/promise";
import { deviceRegistry } from "../domain/device/registry.ts";

/**
 * 遥测数据仓储：本仓库中唯一出现 SQL 的地方。
 *
 * 聚合与状态分组的返回规模不随窗口行数增长；原始采样有数量上限。
 * 故障事件读取另走分批迭代，只供服务在进程内消费，不作为工具返回值发送给 LLM。
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

/** 原始编码记录；这里只读数据，清除值、消息类别和连续事件由服务解释。 */
export interface RawFaultRecord {
	/** 数据库 id 是 BIGINT，以十进制字符串返回，避免 JavaScript number 丢失精度。 */
	readonly id: string;
	readonly timestamp: string;
	readonly faultCode: string | null;
	readonly alarmCode: string | null;
}

/** 闭区间查询；table 必须来自设备注册表，不能是任意合法 SQL 标识符。 */
export interface FaultRecordQuery extends TimeWindow {
	readonly table: string;
}

export interface FaultRecordReadOptions {
	/** 默认 1000，范围 1–5000；控制单批内存与数据库返回规模。 */
	readonly batchSize?: number;
	/** 单次数据库操作（含等待连接）的硬截止时间，默认 10 秒，上限 60 秒。 */
	readonly queryTimeoutMs?: number;
	/** 整次读取预算，包含消费方处理时间，默认 120 秒，上限 600 秒。 */
	readonly scanTimeoutMs?: number;
	readonly signal?: AbortSignal;
}

/** 用接口注入后续事件服务，服务测试不必创建数据库连接。 */
export interface FaultRecordReader {
	iterateFaultRecords(request: FaultRecordQuery, options?: FaultRecordReadOptions): AsyncIterable<RawFaultRecord>;
}

const FAULT_TABLES = new Set(deviceRegistry.list().map((device) => device.table));
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

function isTimestamp(value: string): boolean {
	if (!TIMESTAMP_PATTERN.test(value)) return false;
	const date = new Date(`${value.replace(" ", "T")}Z`);
	return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 19).replace("T", " ") === value;
}

function boundedOption(value: number, maximum: number, label: string): number {
	if (!Number.isInteger(value) || value < 1 || value > maximum) {
		throw new Error(`${label} 必须是 1–${maximum} 的整数。`);
	}
	return value;
}

/**
 * 超时 / 取消先拒绝调用方，再关闭本次专用连接。只做 Promise.race 会留下后台 SQL。
 * 同时观察迟到的完成 / 失败，避免底层请求稍后拒绝产生 unhandled rejection。
 */
async function faultReadOperation<T>(
	operation: () => Promise<T>,
	timeoutMs: number,
	signal: AbortSignal,
	interrupt: () => void,
): Promise<T> {
	signal.throwIfAborted();
	return new Promise<T>((resolve, reject) => {
		const cleanup = () => {
			clearTimeout(timer);
			signal.removeEventListener("abort", onAbort);
		};
		const stop = (reason: unknown) => {
			cleanup();
			reject(reason);
			interrupt();
		};
		const onAbort = () => stop(signal.reason);
		const timer = setTimeout(() => stop(new DOMException("故障记录读取的单次数据库操作超时。", "TimeoutError")), timeoutMs);
		signal.addEventListener("abort", onAbort, { once: true });
		Promise.resolve().then(() => {
			signal.throwIfAborted();
			return operation();
		}).then(
			(value) => { cleanup(); resolve(value); },
			(error: unknown) => { cleanup(); reject(error); },
		);
	});
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

export class TelemetryRepository implements FaultRecordReader {
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
	 * MySQL 5.7：在 InnoDB 只读一致性快照内，按 (timestamp, id) 游标逐批读取。
	 * 不用 OFFSET，不丢弃正常值 '0'，也不合并 / 修正多码或未知字符串。
	 *
	 * 一次只持有一批记录；消费完当前批次才查下一批。整个迭代独占一个池连接，
	 * 正常结束 / for-await break 后回滚并释放，取消 / 超时 / 失败时销毁连接。
	 * 消费方必须用 for-await 或显式 return() 收尾；总预算也会关闭被遗弃的快照。
	 */
	async *iterateFaultRecords(
		request: FaultRecordQuery,
		options: FaultRecordReadOptions = {},
	): AsyncGenerator<RawFaultRecord, void, unknown> {
		const { table, startTime, endTime } = request;
		if (!FAULT_TABLES.has(table)) throw new Error("故障记录查询的设备表未登记，必须使用设备注册表中的表名。");
		const quotedTable = quoteIdentifier(table);
		if (!isTimestamp(startTime) || !isTimestamp(endTime) || startTime >= endTime) {
			throw new Error("故障记录查询时间必须是有效的 YYYY-MM-DD HH:MM:SS，且结束时间晚于起始时间。");
		}
		const batchSize = boundedOption(options.batchSize ?? 1000, 5000, "batchSize");
		const queryTimeoutMs = boundedOption(options.queryTimeoutMs ?? 10_000, 60_000, "queryTimeoutMs");
		const scanTimeoutMs = boundedOption(options.scanTimeoutMs ?? 120_000, 600_000, "scanTimeoutMs");
		options.signal?.throwIfAborted();

		const budget = new AbortController();
		const signal = options.signal ? AbortSignal.any([options.signal, budget.signal]) : budget.signal;
		const scanTimer = setTimeout(() => budget.abort(new DOMException("故障记录读取超过整次扫描时间预算。", "TimeoutError")), scanTimeoutMs);
		let connection: PoolConnection | undefined;
		let destroyed = false;
		let transactionStarted = false;
		const destroy = () => {
			clearTimeout(scanTimer);
			if (!destroyed) {
				destroyed = true;
				connection?.destroy();
			}
		};
		// 即使生成器暂停在 yield，也及时关闭已取消 / 超时的快照。
		signal.addEventListener("abort", destroy, { once: true });
		const query = async (sql: string, params: readonly unknown[] = []): Promise<RowDataPacket[]> => {
			const [records] = await faultReadOperation(
				() => connection!.query<RowDataPacket[]>(sql, [...params]), queryTimeoutMs, signal, destroy,
			);
			return records;
		};
		try {
			await faultReadOperation(async () => {
				const acquired = await this.poolProvider().getConnection();
				// 连接池等待无法撤销；取消 / 超时后迟到的连接须立即归还，不能泄漏。
				if (destroyed) acquired.release();
				else connection = acquired;
			}, queryTimeoutMs, signal, destroy);
			const [metadata] = await query(
				"SELECT ENGINE AS engine FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?", [table],
			);
			if (metadata?.engine !== "InnoDB") throw new Error("故障记录一致性读取要求已登记设备表使用 InnoDB 存储引擎。");
			// 只影响下一次事务，不修改池连接的会话默认隔离级别。
			await query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
			await query("START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY");
			transactionStarted = true;

			let cursor: RawFaultRecord | undefined;
			while (true) {
				const continuation = cursor ? "AND (`timestamp` > ? OR (`timestamp` = ? AND `id` > ?))" : "";
				const params = cursor ? [startTime, endTime, cursor.timestamp, cursor.timestamp, cursor.id] : [startTime, endTime];
				const batch = await query(
					`SELECT /*+ MAX_EXECUTION_TIME(${queryTimeoutMs}) */ CAST(\`id\` AS CHAR) AS \`record_id\`,
						\`timestamp\`, \`fault_code\`, \`alarm_code\` FROM ${quotedTable}
						WHERE \`timestamp\` >= ? AND \`timestamp\` <= ? ${continuation}
						ORDER BY \`timestamp\` ASC, \`id\` ASC LIMIT ${batchSize}`, params,
				);
				for (const row of batch) {
					signal.throwIfAborted();
					const id = toTextOrNull(row.record_id) ?? "";
					const timestamp = toTextOrNull(row.timestamp) ?? "";
					if (!/^[1-9]\d*$/.test(id) || !isTimestamp(timestamp) || timestamp < startTime || timestamp > endTime) {
						throw new Error("故障记录含无效主键或时间戳，无法可靠推进读取游标。");
					}
					if (cursor && (timestamp < cursor.timestamp || (timestamp === cursor.timestamp && BigInt(id) <= BigInt(cursor.id)))) {
						throw new Error("故障记录未按 timestamp、id 严格递增，已停止读取以免遗漏或重复。");
					}
					cursor = { id, timestamp, faultCode: toTextOrNull(row.fault_code), alarmCode: toTextOrNull(row.alarm_code) };
					yield cursor;
				}
				signal.throwIfAborted();
				if (batch.length < batchSize) break;
			}
		} catch (error) {
			destroy();
			if (signal.aborted) throw signal.reason;
			if (error instanceof DOMException && error.name === "TimeoutError") throw error;
			throw describeError(error);
		} finally {
			try {
				if (connection && !destroyed) {
					try {
						if (transactionStarted) await query("ROLLBACK");
					} catch (error) {
						destroy();
						if (signal.aborted) throw signal.reason;
						if (error instanceof DOMException && error.name === "TimeoutError") throw error;
						throw describeError(error);
					}
					if (!destroyed) connection.release();
				}
			} finally {
				clearTimeout(scanTimer);
				signal.removeEventListener("abort", destroy);
			}
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
	 * 状态列的取值极少，分组结果给出每种值的出现次数和首末观测，且行数有界。
	 * 同码多次出现会被合并；这些首末时间不能作为连续故障事件的发生 / 恢复时刻。
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
	async latestTimestamp(table: string, options?: FaultRecordReadOptions): Promise<string | undefined> {
		if (options) {
			// 默认故障事件窗口的前置查询同样支持超时和取消，不能只保护后面的扫描。
			if (!FAULT_TABLES.has(table)) throw new Error("最新采样时间查询的设备表未登记。");
			const quotedTable = quoteIdentifier(table);
			const timeoutMs = boundedOption(options.queryTimeoutMs ?? 10_000, 60_000, "queryTimeoutMs");
			const signal = options.signal ?? new AbortController().signal;
			let connection: PoolConnection | undefined;
			let destroyed = false;
			const destroy = () => {
				if (!destroyed) { destroyed = true; connection?.destroy(); }
			};
			try {
				return await faultReadOperation(async () => {
					const acquired = await this.poolProvider().getConnection();
					if (destroyed) { acquired.release(); return undefined; }
					connection = acquired;
					signal.throwIfAborted();
					const [records] = await connection.query<RowDataPacket[]>(
						`SELECT /*+ MAX_EXECUTION_TIME(${timeoutMs}) */ MAX(\`timestamp\`) AS \`last_ts\` FROM ${quotedTable}`,
					);
					return toTextOrNull(records[0]?.last_ts) ?? undefined;
				}, timeoutMs, signal, destroy);
			} catch (error) {
				destroy();
				if (signal.aborted) throw signal.reason;
				if (error instanceof DOMException && error.name === "TimeoutError") throw error;
				throw describeError(error);
			} finally {
				if (connection && !destroyed) connection.release();
			}
		}
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
