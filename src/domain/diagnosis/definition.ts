import type { CodeLookup, KnowledgeEvidence } from "../knowledge/definition.ts";

/**
 * 故障诊断领域契约：原始观测 → 连续编码事件 → 知识匹配 / 特征核对 → 诊断结论。
 *
 * 这里只定义业务语义，不读取数据库、不调用工具，也不依赖 services。
 * readonly 用于表达结果是证据快照；它不会在运行时冻结对象或校验字段。
 */

/** 按实际观测码的 F / A / N 前缀分类，不由所在列名推断类别。 */
export type MessageKind = "fault" | "alarm" | "notification";

/** 编码的采集来源；列名与消息类别是两个不同维度。 */
export type FaultMetricKey = "fault_code" | "alarm_code";

/**
 * 与现有数据查询一致：YYYY-MM-DD HH:MM:SS，闭区间，两端均含。
 * 表示采集数据的墙上时间，不隐式转换成 UTC 或宿主机时区。
 */
export interface DiagnosisPeriod {
	readonly startTime: string;
	readonly endTime: string;
}

/** 单个编码字段在一个采样时刻的原始观测，尚未解释为故障或清除状态。 */
export interface FaultObservation {
	readonly timestamp: string;
	readonly sourceMetric: FaultMetricKey;
	/** 保留原值；null 是缺失，不能直接当作无故障。 */
	readonly rawValue: string | number | null;
}

/**
 * 同一设备、同一编码字段中，一段连续采样观测到的同码事件。
 *
 * 必须由有序序列识别；同码取值分组的 MIN / MAX 不能证明连续。
 * 首末时间是实际观测时刻，不是已确认的故障发生 / 恢复时刻；不据此推算真实持续时长。
 * 缺失、未知值及超过已确认采样间隔的断档应打断连续性，规则和局限由服务记录。
 */
export interface FaultEvent {
	/** 在所属事件结果中唯一，供诊断发现引用。 */
	readonly eventId: string;
	readonly deviceKey: string;
	readonly sourceMetric: FaultMetricKey;
	/** 规范化的完整编码，如 F30015；不补零、不猜测类别或纠正 O / 0。 */
	readonly code: string;
	readonly kind: MessageKind;
	readonly firstObservedAt: string;
	readonly lastObservedAt: string;
	/** 本事件实际观测到该码的采样次数，不是故障发生次数。 */
	readonly observationCount: number;
	/** 结束的是本段观测，不一定意味着故障已恢复。 */
	readonly endReason:
		| "cleared_observed" // 后续观测到已确认语义的清除值，不代表根因已消除。
		| "code_replaced" // 后续观测到另一有效编码，不能认定前一个故障已恢复。
		| "window_boundary" // 已处理到查询窗口末端，窗口之外未知。
		| "observation_boundary" // 采样 / 处理提前停止，尚未覆盖整个窗口。
		| "data_gap"; // 缺失、未知值或采样断档使连续性无法确认。
}

/** 一次编码事件识别的结果；它只描述观测，不解释故障根因。 */
export interface FaultEventResult {
	/** 关联本次编码查询的数据集；不应指向后续另一窗口的指标查询。 */
	readonly datasetId: string;
	readonly deviceKey: string;
	readonly period: DiagnosisPeriod;
	/** 本次实际检查了哪些编码字段；未查询的字段不能当作没有编码。 */
	readonly sourceMetrics: readonly FaultMetricKey[];
	/** 查询窗口内命中的总行数，含空值。 */
	readonly rowCount: number;
	/** 实际用于事件识别的行数，按采样行计数，不按编码字段计数。 */
	readonly processedRowCount: number;
	readonly events: readonly FaultEvent[];
	/** 已处理行中识别出的事件总数，截断前计数；不是整个窗口的估算总数。 */
	readonly eventCount: number;
	/** 仅表示 events 列表截断；采样是否完整另看 processedRowCount / rowCount。 */
	readonly eventsTruncated: boolean;
	/** 无法解释的原始观测，保留来源与时刻；若只保留示例，须在 limitations 说明。 */
	readonly unknownValues: readonly FaultObservation[];
	/** 缺失、截断、断档、清除值语义未确认等影响结论的限制。 */
	readonly limitations: readonly string[];
}

/**
 * 编码识别结论，与手册是否匹配、根因是否已确定相互独立。
 * 已观测到有效编码时保留该事实，同时在 limitations 报告不完整性。
 * 无有效编码且覆盖不足、存在无法解释的值或没有数据时应为 inconclusive。
 */
export type DiagnosisStatus =
	| "fault_observed" // 观测到 F 类消息；可同时存在报警和通知。
	| "alarm_only" // 观测到 A 类消息、未观测到 F 类；可同时存在通知。
	| "notification_only" // 仅观测到 N 类消息。
	| "no_code_observed" // 已充分检查的编码字段未见有效编码，不代表设备健康。
	| "inconclusive"; // 数据不足以作出编码识别结论。

/** 复用知识服务的逐码状态，避免诊断与知识检索定义两套匹配语义。 */
export type KnowledgeMatchStatus = CodeLookup["status"];

/** 运行数据证据，既能引用全窗口统计，也能引用局部采样分析。 */
export interface TelemetryDiagnosisEvidence {
	readonly kind: "telemetry";
	/** 在本次诊断中唯一，且不能与知识证据 ID 冲突。 */
	readonly evidenceId: string;
	/** 来自 query_data / analyze_data 的真实数据集 ID，不能自行拼造。 */
	readonly datasetId: string;
	readonly deviceKey: string;
	/** 源数据集的查询窗口；采样证据只代表该窗口中的实际采样片段。 */
	readonly period: DiagnosisPeriod;
	readonly metricKeys: readonly string[];
	readonly scope: "window_aggregate" | "sample";
	/** 对真实查询 / 分析结果的摘要，数值、单位和阈值依据须可追溯。 */
	readonly summary: string;
	readonly limitations: readonly string[];
}

/** 知识证据直接复用原有结构，保留正文、匹配方式、适用产品、版本与页码。 */
export type DiagnosisEvidence =
	| (KnowledgeEvidence & { readonly kind: "knowledge" })
	| TelemetryDiagnosisEvidence;

/**
 * 一项手册条件与运行特征的核对；支持或矛盾都不等于根因已被证明。
 * 服务须核对设备、测点映射、时间关联和阈值来源；全窗口极值不能证明事件时刻也越界。
 */
export interface DiagnosisCrossCheck {
	/** 具体核对的条件，例如“功率单元温度是否达到手册明确给出的阈值”。 */
	readonly description: string;
	readonly status: "supports" | "contradicts" | "inconclusive";
	/** 引用 DiagnosisResult.evidence；阈值 / 条件与运行数据都应保留依据。 */
	readonly evidenceIds: readonly string[];
	readonly limitations: readonly string[];
}

/** 同一编码的诊断发现共有的信息；同码多次出现可关联多个连续事件。 */
interface DiagnosisFindingBase {
	readonly code: string;
	readonly kind: MessageKind;
	/** 引用 DiagnosisResult.observation.events 中实际返回的事件。 */
	readonly eventIds: readonly string[];
	/** 逐码查询结果；matched 表示手册适用条目匹配，不表示根因确证。 */
	readonly knowledgeStatus: KnowledgeMatchStatus;
	/** 引用 DiagnosisResult.evidence 中的知识及运行数据证据。 */
	readonly evidenceIds: readonly string[];
	/** 未执行核对时为空；做过但数据不足时用 inconclusive。 */
	readonly crossChecks: readonly DiagnosisCrossCheck[];
}

/** 当前仅表达未确定或假设；提出假设时必须给出具体内容，依据由 evidenceIds 引用。 */
export type DiagnosisFinding = DiagnosisFindingBase & (
	| {
		readonly rootCauseStatus: "undetermined";
		readonly rootCauseHypothesis?: never;
	}
	| {
		readonly rootCauseStatus: "hypothesis";
		readonly rootCauseHypothesis: string;
	}
);

/** 规则或未来模型辅助判断的统一结果，可供 skill 解释及报告引用。 */
export interface DiagnosisResult {
	readonly deviceKey: string;
	readonly period: DiagnosisPeriod;
	readonly status: DiagnosisStatus;
	/** 预留模型辅助方法，避免未来实现被固定的 fault_code_rule 字面量挡住。 */
	readonly method: "fault_code_rule" | "model_assisted";
	/** 规则或模型判断流程的版本，便于复现与对比。 */
	readonly methodVersion: string;
	/** 保留编码识别来源与覆盖信息；设备和窗口须与本结果一致。 */
	readonly observation: FaultEventResult;
	readonly findings: readonly DiagnosisFinding[];
	/** 本次诊断引用的证据快照；所有 evidenceIds 都应在这里有对应记录。 */
	readonly evidence: readonly DiagnosisEvidence[];
	/** 合并观测、知识匹配、特征核对的限制，供输出与报告明确披露。 */
	readonly limitations: readonly string[];
}

/**
 * 判断器契约；TInput 由具体规则 / 模型实现定义，输出保持统一。
 * Promise 允许未来模型推理；这个接口本身不会注册工具或驱动 skill 执行。
 */
export interface FaultJudge<TInput> {
	judge(input: TInput): Promise<DiagnosisResult>;
}
