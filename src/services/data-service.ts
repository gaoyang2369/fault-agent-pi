import { DatasetStore } from "../domain/dataset/store.ts";
import { isMeasurement, type MetricDefinition } from "../domain/metric/definition.ts";
import { metricCatalog } from "../domain/metric/catalog.ts";
import { deviceRegistry } from "../domain/device/registry.ts";
import type { DeviceDefinition } from "../domain/device/definition.ts";
import type { TelemetryRepository, TimeWindow } from "../repositories/telemetry-repository.ts";

/**
 * 数据查询服务：业务校验 + 编排。
 *
 * 校验放在这里而不是工具里，是因为将来还会有非工具的调用方（REST、后台任务）；
 * 工具只是它的一层适配。凡是 schema 能表达的（枚举取值、整数范围、时间格式）都不在
 * 这里重复校验——SDK 会在调用 execute 之前挡掉，并给出模型能自己修正的报错。
 * 这里只做 schema 表达不了的业务规则。
 */

/** 单个数值指标的统计摘要。 */
export interface MeasurementSummary {
	readonly metricKey: string;
	readonly displayName: string;
	readonly unit?: string;
	readonly totalCount: number;
	readonly valueCount: number;
	readonly min: number | null;
	readonly max: number | null;
	readonly avg: number | null;
	readonly stddev: number | null;
}

/** 状态量的一种取值及其出现区间。 */
export interface StateGroupSummary {
	readonly metricKey: string;
	readonly displayName: string;
	readonly value: string;
	readonly count: number;
	readonly firstTimestamp: string;
	readonly lastTimestamp: string;
}

/** 一条原始采样点，键是领域指标 key（物理列名不出服务层）。 */
export interface SamplePoint {
	readonly timestamp: string;
	readonly values: Readonly<Record<string, number | string | null>>;
}

export interface QueryDataResult {
	readonly deviceKey: string;
	readonly deviceName: string;
	readonly startTime: string;
	readonly endTime: string;
	/** 窗口内命中的采样条数。 */
	readonly rowCount: number;
	readonly firstTimestamp: string | null;
	readonly lastTimestamp: string | null;
	readonly measurements: readonly MeasurementSummary[];
	readonly states: readonly StateGroupSummary[];
	/** 状态取值分组触顶被截断时为 true，提示结果不完整。 */
	readonly statesTruncated: boolean;
	readonly sample: {
		readonly requested: number;
		readonly points: readonly SamplePoint[];
	};
}

export interface QueryDataRequest {
	/** 设备 key、中文名或别名。 */
	readonly device: string;
	/** 指标 key 列表；为空表示全部。 */
	readonly metrics: readonly string[];
	/** 省略则默认取「有数据的最新 1 小时」。 */
	readonly startTime?: string;
	readonly endTime?: string;
	/** 额外返回的原始采样点数，0 表示只要统计值。 */
	readonly sampleLimit: number;
}

/** 时间范围未指定时，默认往前取多久。 */
const DEFAULT_WINDOW_HOURS = 1;

/** 单个状态量最多返回多少种取值。 */
const MAX_STATE_GROUPS = 20;

const TIMESTAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;

/** 时间戳按无时区的墙上时间处理，统一借 UTC 承载，避免宿主机时区影响结果。 */
function formatTimestamp(date: Date): string {
	const pad = (value: number): string => String(value).padStart(2, "0");
	return (
		`${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ` +
		`${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`
	);
}

function shiftHours(timestamp: string, hours: number): string {
	const date = new Date(`${timestamp.replace(" ", "T")}Z`);
	date.setUTCHours(date.getUTCHours() + hours);
	return formatTimestamp(date);
}

/**
 * 校验时间戳。schema 的正则只保证了**形状**，保证不了日期真实存在。
 *
 * `2026-02-31 00:00:00` 能通过正则，MySQL 却会把它强转成 NULL，于是
 * `timestamp >= NULL` 一行不匹配——表现为"该时段无数据"，与"设备停机"无法区分。
 * 所以这里做一次构造后回读比对，把不存在的日期挡在查询之前。
 */
function parseTimestamp(input: string, label: string): string {
	const match = TIMESTAMP_PATTERN.exec(input);
	if (!match) {
		throw new Error(`${label} 格式不正确："${input}"，应为 YYYY-MM-DD HH:MM:SS。`);
	}

	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	const hour = Number(match[4]);
	const minute = Number(match[5]);
	const second = Number(match[6]);

	if (!(month >= 1 && month <= 12) || !(day >= 1 && day <= 31) || hour > 23 || minute > 59 || second > 59) {
		throw new Error(`${label} 不是有效时间："${input}"。`);
	}

	const probe = new Date(Date.UTC(year, month - 1, day));
	if (
		probe.getUTCFullYear() !== year ||
		probe.getUTCMonth() !== month - 1 ||
		probe.getUTCDate() !== day
	) {
		throw new Error(`${label} 不是真实存在的日期："${input}"（该月没有这一天）。`);
	}

	return input;
}

function listMetricKeys(): string {
	return metricCatalog.list().map((definition) => definition.key).join("、");
}

function listDeviceNames(): string {
	return deviceRegistry
		.list()
		.map((device) => `${device.key}（${device.displayName}）`)
		.join("、");
}

/** 把请求里的指标 key 解析成定义；未登记的立即报错并列出合法取值。 */
function resolveMetrics(keys: readonly string[]): readonly MetricDefinition[] {
	if (keys.length === 0) return metricCatalog.list();

	const resolved: MetricDefinition[] = [];
	for (const key of keys) {
		const definition = metricCatalog.get(key);
		if (!definition) {
			throw new Error(`未知的指标 "${key}"。可用指标：${listMetricKeys()}。`);
		}
		resolved.push(definition);
	}
	return resolved;
}

function resolveDevice(input: string): DeviceDefinition {
	const device = deviceRegistry.resolve(input);
	if (!device) {
		throw new Error(`未知的设备 "${input}"。可用设备：${listDeviceNames()}。`);
	}
	return device;
}

export class DataService {
	/** 查询结果写入共享句柄表，原始采样点不进入 LLM 上下文。 */
	constructor(
		private readonly repository: TelemetryRepository,
		private readonly datasets: DatasetStore<QueryDataResult>,
	) {}

	async query(request: QueryDataRequest): Promise<{ datasetId: string; result: QueryDataResult }> {
		const device = resolveDevice(request.device);
		const definitions = resolveMetrics(request.metrics);
		const window = await this.resolveWindow(device, request);

		const measurementDefinitions = definitions.filter(isMeasurement);
		const measurementColumns = measurementDefinitions.map((definition) => definition.column);
		const stateDefinitions = definitions.filter(
			(definition): definition is Extract<MetricDefinition, { kind: "state" }> =>
				definition.kind === "state",
		);

		// 三条查询互不依赖，并发跑；每条都是对被索引列的全表扫描，串行会把延迟叠成三倍。
		const [aggregation, stateGroups, sampleRows] = await Promise.all([
			this.repository.aggregate(device.table, window, measurementColumns),
			Promise.all(
				stateDefinitions.map((definition) =>
					this.repository.groupState(device.table, window, definition.column, MAX_STATE_GROUPS),
				),
			),
			this.repository.sample(
				device.table,
				window,
				definitions.map((definition) => definition.column),
				request.sampleLimit,
			),
		]);

		if (aggregation.coverage.rowCount === 0) {
			// 落空必须能一步自救：把该设备真实的数据覆盖范围告诉模型，它会自己换窗口重试。
			const coverage = await this.repository.describeTable(device.table);
			throw new Error(
				`设备 ${device.displayName}（${device.key}）在 ${window.startTime} ~ ${window.endTime} 无数据。` +
					`该设备数据覆盖范围：${coverage.firstTimestamp ?? "无"} ~ ${coverage.lastTimestamp ?? "无"}` +
					`（共 ${coverage.rowCount} 条），且为历史归档数据而非实时数据。请改用覆盖范围内的窗口重试。`,
			);
		}

		const keyByColumn = new Map(definitions.map((definition) => [definition.column, definition.key]));
		const definitionByColumn = new Map(definitions.map((definition) => [definition.column, definition]));
		const measurementByColumn = new Map(
			measurementDefinitions.map((definition) => [definition.column, definition]),
		);

		const measurements = aggregation.aggregates.map<MeasurementSummary>((aggregate) => {
			const definition = measurementByColumn.get(aggregate.column);
			if (!definition) {
				throw new Error(`聚合结果中出现了未请求的列：${aggregate.column}`);
			}
			return {
				metricKey: definition.key,
				displayName: definition.displayName,
				...(definition.unit === undefined ? {} : { unit: definition.unit }),
				totalCount: aggregate.totalCount,
				valueCount: aggregate.valueCount,
				min: aggregate.min,
				max: aggregate.max,
				avg: aggregate.avg,
				stddev: aggregate.stddev,
			};
		});

		const states: StateGroupSummary[] = [];
		let statesTruncated = false;
		stateGroups.forEach((groups) => {
			if (groups.length >= MAX_STATE_GROUPS) statesTruncated = true;
			for (const group of groups) {
				const definition = definitionByColumn.get(group.column);
				states.push({
					metricKey: keyByColumn.get(group.column) ?? group.column,
					displayName: definition?.displayName ?? group.column,
					value: group.value,
					count: group.count,
					firstTimestamp: group.firstTimestamp,
					lastTimestamp: group.lastTimestamp,
				});
			}
		});

		const result: QueryDataResult = {
			deviceKey: device.key,
			deviceName: device.displayName,
			startTime: window.startTime,
			endTime: window.endTime,
			rowCount: aggregation.coverage.rowCount,
			firstTimestamp: aggregation.coverage.firstTimestamp,
			lastTimestamp: aggregation.coverage.lastTimestamp,
			measurements,
			states,
			statesTruncated,
			sample: {
				requested: request.sampleLimit,
				points: sampleRows.map((row) => ({
					timestamp: row.timestamp,
					values: Object.fromEntries(
						Object.entries(row.values).map(([column, value]) => [
							keyByColumn.get(column) ?? column,
							value,
						]),
					),
				})),
			},
		};

		return { datasetId: this.datasets.put(result), result };
	}

	/**
	 * 确定查询窗口。
	 *
	 * 两端都省略时默认取「**有数据的**最新 1 小时」，而不是相对当前墙钟——本库是历史
	 * 归档数据（覆盖到 2026-09-14），按墙钟算「最近一小时」永远查出空结果，而空结果
	 * 在诊断场景里是最危险的失败模式：它会让人得出「这段时间没有异常」的结论。
	 */
	private async resolveWindow(device: DeviceDefinition, request: QueryDataRequest): Promise<TimeWindow> {
		if (request.startTime === undefined && request.endTime === undefined) {
			const latest = await this.repository.latestTimestamp(device.table);
			if (latest === undefined) {
				throw new Error(`设备 ${device.displayName}（${device.key}）的数据表为空，无法推断时间范围。`);
			}
			return { startTime: shiftHours(latest, -DEFAULT_WINDOW_HOURS), endTime: latest };
		}

		if (request.startTime === undefined || request.endTime === undefined) {
			throw new Error("startTime 与 endTime 必须同时给出，或同时省略（省略时默认查有数据的最新 1 小时）。");
		}

		const startTime = parseTimestamp(request.startTime, "startTime");
		const endTime = parseTimestamp(request.endTime, "endTime");

		// 时间列存的是 "YYYY-MM-DD HH:MM:SS"，字典序与时间序一致，因此可以直接比字符串。
		if (startTime >= endTime) {
			throw new Error(`startTime 必须早于 endTime（收到 ${startTime} ~ ${endTime}）。`);
		}

		return { startTime, endTime };
	}
}
