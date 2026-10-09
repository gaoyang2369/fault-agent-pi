import { DatasetStore } from "../domain/dataset/store.ts";
import { deviceRegistry } from "../domain/device/registry.ts";
import type {
	DiagnosisPeriod, FaultEvent, FaultEventResult, FaultMetricKey, FaultObservation, MessageKind,
} from "../domain/diagnosis/definition.ts";
import type {
	FaultRecordReader, FaultRecordReadOptions, RawFaultRecord,
} from "../repositories/telemetry-repository.ts";

export interface FaultEventQuery {
	/** 已登记设备的 key、中文名或别名；物理表名不由调用方指定。 */
	readonly device: string;
	/** 两端同时给出或同时省略；省略时取设备有数据的最新一小时。 */
	readonly startTime?: string;
	readonly endTime?: string;
	/** 保留最早开始的事件，默认 20，上限 100；不限制扫描或总数统计。 */
	readonly maxEvents?: number;
	/** 保留最早的未知观测示例，默认 10，上限 50；0 表示只在 limitations 报告数量。 */
	readonly maxUnknownValues?: number;
}

/** 由维护者配置采集规则，不能根据故障码含义或采样结果临时猜测。 */
export interface FaultEventPolicy {
	/** 当前模拟数据只确认字符串 '0' 表示无编码；null 和空串默认都是未知。 */
	readonly noCodeValues?: ReadonlySet<string>;
	/** 当前模拟数据正常间隔为 4 秒，默认 4000；超过此间隔即打断观测段。 */
	readonly maxGapMs?: number;
}

/** 只保存有界的观测摘要，不保存原始全量记录。句柄由 DatasetStore 分配。 */
export type FaultEventDataset = Omit<FaultEventResult, "datasetId">;

/** 明确窗口的调用只需迭代接口；使用默认窗口时还需读取设备最新采样时间。 */
export interface FaultEventSource extends FaultRecordReader {
	latestTimestamp?(table: string, options?: FaultRecordReadOptions): Promise<string | undefined>;
}

type ParsedMessageCode =
	| { readonly status: "code"; readonly code: string; readonly kind: MessageKind }
	| { readonly status: "clear" }
	| { readonly status: "unknown" };

const SOURCE_METRICS = ["fault_code", "alarm_code"] as const;
const CODE_PATTERN = /^[FAN]\d{5}$/;

function normalizeCode(value: string): string {
	return value.normalize("NFKC").trim().toUpperCase();
}

/** 规范化书写后匹配整个字段，不补零、不纠正 O / 0、不拆分或局部提取多码值。 */
function parseMessageCode(rawValue: string | null, noCodeValues: ReadonlySet<string>): ParsedMessageCode {
	if (rawValue === null) return { status: "unknown" };
	const code = normalizeCode(rawValue);
	if (noCodeValues.has(code)) return { status: "clear" };
	if (!CODE_PATTERN.test(code)) return { status: "unknown" };
	const kind: MessageKind = code[0] === "F" ? "fault" : code[0] === "A" ? "alarm" : "notification";
	return { status: "code", code, kind };
}

/** UTC 仅用于无时区墙上时间的校验与相减，不改变输出时间或按宿主机时区解释。 */
function timestampMillis(value: string): number {
	if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) {
		throw new Error("故障事件时间必须使用 YYYY-MM-DD HH:MM:SS 格式。");
	}
	const date = new Date(`${value.replace(" ", "T")}Z`);
	if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 19).replace("T", " ") !== value) {
		throw new Error("故障事件时间包含不存在的日期或无效时刻。");
	}
	return date.getTime();
}

function boundedCount(value: number, minimum: number, maximum: number, label: string): number {
	if (!Number.isInteger(value) || value < minimum || value > maximum) {
		throw new Error(`${label} 必须是 ${minimum}–${maximum} 的整数。`);
	}
	return value;
}

/** 可变状态仅存在于单次扫描；返回给调用方的是独立的事件快照。 */
interface ActiveEvent {
	readonly sequence: number;
	readonly sourceMetric: FaultMetricKey;
	readonly code: string;
	readonly kind: MessageKind;
	readonly firstObservedAt: string;
	lastObservedAt: string;
	observationCount: number;
}

/**
 * 逐条提取连续观测，两个编码字段独立推进。
 * 空间上只保留两个活动事件、有界的已结束事件和未知值示例；没有全量记录缓存。
 */
class FaultEventAccumulator {
	private readonly active = new Map<FaultMetricKey, ActiveEvent>();
	private readonly retained = new Map<number, FaultEvent>();
	private readonly unknownValues: FaultObservation[] = [];
	private previous?: { readonly timestamp: string; readonly millis: number; readonly id: bigint };
	private firstTimestamp?: string;
	private rowCount = 0;
	private eventCount = 0;
	private unknownCount = 0;
	private gapCount = 0;
	private duplicateTimestampCount = 0;
	private codeReplaced = false;
	private firstRowHadCode = false;

	constructor(
		private readonly deviceKey: string,
		private readonly request: DiagnosisPeriod,
		private readonly noCodeValues: ReadonlySet<string>,
		private readonly maxGapMs: number,
		private readonly maxEvents: number,
		private readonly maxUnknownValues: number,
	) {}

	accept(record: RawFaultRecord): void {
		const millis = timestampMillis(record.timestamp);
		if (!/^[1-9]\d*$/.test(record.id) || record.timestamp < this.request.startTime || record.timestamp > this.request.endTime) {
			throw new Error("故障事件读取结果含无效主键或窗口之外的记录。");
		}
		const id = BigInt(record.id);
		if (this.previous) {
			const interval = millis - this.previous.millis;
			if (interval < 0 || (interval === 0 && id <= this.previous.id)) {
				throw new Error("故障事件记录必须按 timestamp、id 严格递增，不能可靠处理乱序或重复主键。");
			}
			if (interval > this.maxGapMs || interval === 0) {
				if (interval === 0) this.duplicateTimestampCount++;
				else this.gapCount++;
				// 重复时刻不能证明时间连续，即使同码也分段；按 id 处理不等于真实状态切换顺序。
				for (const metric of SOURCE_METRICS) this.close(metric, "data_gap");
			}
		}
		this.firstTimestamp ??= record.timestamp;
		this.rowCount++;
		for (const metric of SOURCE_METRICS) {
			const rawValue = metric === "fault_code" ? record.faultCode : record.alarmCode;
			const parsed = parseMessageCode(rawValue, this.noCodeValues);
			const current = this.active.get(metric);
			if (parsed.status === "unknown") {
				this.unknownCount++;
				if (this.unknownValues.length < this.maxUnknownValues) {
					this.unknownValues.push({ timestamp: record.timestamp, sourceMetric: metric, rawValue });
				}
				this.close(metric, "data_gap");
			} else if (parsed.status === "clear") {
				this.close(metric, "cleared_observed");
			} else if (current?.code === parsed.code) {
				current.lastObservedAt = record.timestamp;
				current.observationCount++;
			} else {
				if (current) {
					this.close(metric, "code_replaced");
					this.codeReplaced = true;
				}
				this.eventCount++;
				this.active.set(metric, {
					sequence: this.eventCount, sourceMetric: metric, code: parsed.code, kind: parsed.kind,
					firstObservedAt: record.timestamp, lastObservedAt: record.timestamp, observationCount: 1,
				});
				if (this.rowCount === 1) this.firstRowHadCode = true;
			}
		}
		this.previous = { timestamp: record.timestamp, millis, id };
	}

	private close(metric: FaultMetricKey, endReason: FaultEvent["endReason"]): void {
		const event = this.active.get(metric);
		if (!event) return;
		if (event.sequence <= this.maxEvents) {
			this.retained.set(event.sequence, {
				eventId: `evt-${String(event.sequence).padStart(3, "0")}`,
				deviceKey: this.deviceKey, sourceMetric: metric, code: event.code, kind: event.kind,
				firstObservedAt: event.firstObservedAt, lastObservedAt: event.lastObservedAt,
				observationCount: event.observationCount, endReason,
			});
		}
		this.active.delete(metric);
	}

	/** 只能在读取正常完成后调用；失败和取消没有“已完整读取”的结果。 */
	finish(): FaultEventDataset {
		const lastRowHadCode = this.active.size > 0;
		for (const metric of SOURCE_METRICS) this.close(metric, "window_boundary");
		const limitations = [
			"事件首末时间来自离散采样，不能确认物理故障的精确发生、恢复或持续时间。",
			"清除值仅表示采集编码已清除，不能据此确证设备健康或故障根因已消除。",
		];
		if (!this.rowCount) limitations.push("查询窗口无采样记录，不能据此判断没有故障。");
		if (this.firstRowHadCode) limitations.push("首条采样已含有效编码，该事件可能在首条采样之前开始。");
		if (lastRowHadCode) limitations.push("读取结束时仍有有效编码，窗口之外的状态未知；window_boundary 不表示故障已恢复。");
		if (this.rowCount && (this.firstTimestamp !== this.request.startTime || this.previous!.timestamp !== this.request.endTime)) {
			limitations.push(`实际采样覆盖 ${this.firstTimestamp} ~ ${this.previous!.timestamp}，窗口边缘的无采样区间不能解释为正常运行。`);
		}
		if (this.gapCount) limitations.push(`相邻采样超过 ${this.maxGapMs} 毫秒的断档共 ${this.gapCount} 处；断档两侧的同码观测已分段。`);
		if (this.duplicateTimestampCount) limitations.push(`重复时间戳记录共 ${this.duplicateTimestampCount} 条，已打断连续观测；id 顺序不能证明同一时刻的真实状态切换顺序。`);
		if (this.unknownCount) limitations.push(`无法解释或缺失的编码观测共 ${this.unknownCount} 条，按 data_gap 打断相关字段；unknownValues 保留最早 ${this.unknownValues.length} 条示例。`);
		if (this.codeReplaced) limitations.push("编码被其他码替代仅表示采集值变化，不能据此认定前一个物理故障已恢复。");
		if (this.eventCount > this.maxEvents) limitations.push(`共识别 ${this.eventCount} 个观测事件，仅返回最早开始的 ${this.maxEvents} 个；列表截断未中断全窗口扫描。`);
		return {
			deviceKey: this.deviceKey, period: { startTime: this.request.startTime, endTime: this.request.endTime },
			sourceMetrics: [...SOURCE_METRICS], rowCount: this.rowCount, processedRowCount: this.rowCount,
			events: [...this.retained.entries()].sort(([a], [b]) => a - b).map(([, event]) => event),
			eventCount: this.eventCount, eventsTruncated: this.eventCount > this.maxEvents,
			unknownValues: this.unknownValues, limitations,
		};
	}
}

/** 事件查询服务：业务校验 → 流式识别 → 有界摘要入库；不查询手册或推断根因。 */
export class FaultEventService {
	private readonly noCodeValues: ReadonlySet<string>;
	private readonly maxGapMs: number;

	constructor(
		private readonly reader: FaultEventSource,
		private readonly datasets: DatasetStore<FaultEventDataset>,
		policy: FaultEventPolicy = {},
	) {
		this.maxGapMs = boundedCount(policy.maxGapMs ?? 4000, 1, Number.MAX_SAFE_INTEGER, "maxGapMs");
		const noCodeValues = new Set([...(policy.noCodeValues ?? new Set(["0"]))].map(normalizeCode));
		if ([...noCodeValues].some((value) => CODE_PATTERN.test(value))) {
			throw new Error("noCodeValues 不能包含有效 F/A/N 编码，否则会丢弃真实观测。");
		}
		this.noCodeValues = noCodeValues;
	}

	async query(request: FaultEventQuery, options: FaultRecordReadOptions = {}): Promise<FaultEventResult> {
		// 复制请求，避免调用方在异步解析默认窗口或扫描期间修改参数。
		const input = { ...request };
		const readOptions = { ...options };
		const device = deviceRegistry.resolve(input.device);
		if (!device) throw new Error(`未知设备：${input.device}。请使用已登记设备的 key、中文名或别名。`);
		const maxEvents = boundedCount(input.maxEvents ?? 20, 1, 100, "maxEvents");
		const maxUnknownValues = boundedCount(input.maxUnknownValues ?? 10, 0, 50, "maxUnknownValues");
		readOptions.signal?.throwIfAborted();
		const period = await this.resolveWindow(device.table, input, readOptions);
		readOptions.signal?.throwIfAborted();
		const accumulator = new FaultEventAccumulator(device.key, period, this.noCodeValues, this.maxGapMs, maxEvents, maxUnknownValues);
		for await (const record of this.reader.iterateFaultRecords({
			table: device.table, ...period,
		}, readOptions)) {
			readOptions.signal?.throwIfAborted();
			accumulator.accept(record);
		}
		readOptions.signal?.throwIfAborted();
		const result = accumulator.finish();
		return { datasetId: this.datasets.put(result), ...result };
	}

	private async resolveWindow(table: string, request: FaultEventQuery, options: FaultRecordReadOptions): Promise<DiagnosisPeriod> {
		if ((request.startTime === undefined) !== (request.endTime === undefined)) {
			throw new Error("startTime 与 endTime 必须同时给出，或同时省略（默认查询设备有数据的最新一小时）。");
		}
		let startTime = request.startTime;
		let endTime = request.endTime;
		if (startTime === undefined || endTime === undefined) {
			if (!this.reader.latestTimestamp) throw new Error("当前读取器不支持默认窗口，请同时提供 startTime 与 endTime。");
			const latest = await this.reader.latestTimestamp(table, options);
			options.signal?.throwIfAborted();
			if (latest === undefined) throw new Error("设备没有采样数据，无法确定默认查询窗口。请检查数据来源。");
			endTime = latest;
			startTime = new Date(timestampMillis(latest) - 3_600_000).toISOString().slice(0, 19).replace("T", " ");
		}
		if (timestampMillis(startTime) >= timestampMillis(endTime)) {
			throw new Error("故障事件查询的 startTime 必须早于 endTime。");
		}
		return { startTime, endTime };
	}
}
