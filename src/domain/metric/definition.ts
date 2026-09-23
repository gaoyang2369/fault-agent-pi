/**
 * 领域指标的类型定义。
 *
 * 指标（Metric）是诊断 agent 操作数据的唯一词汇：agent 只说 key，由数据服务通过
 * column 落到真实的数据库列上。数据库改列名、换表时只改这里，agent 与提示词不动。
 */

/** 所有指标共有的字段。 */
interface MetricBase {
	/** 领域唯一标识。agent、工具参数与业务代码只用这个。 */
	readonly key: string;
	/** 对应的物理数据库列名。只有数据服务需要关心。 */
	readonly column: string;
	/** 中文名称，给人和 LLM 看。 */
	readonly displayName: string;
	/**
	 * 语义说明。
	 *
	 * 凡是不确定的地方都要写在正文里（例如「单位未确认」），不要留给读者猜——
	 * 这里的信息会直接进入 LLM 的上下文，含糊等于放任它编。
	 */
	readonly description: string;
}

/**
 * 数值型测量量：可做趋势、统计与异常判定。
 *
 * 与状态量的区别是真实存在的，不只是标注：只有它能进统计分析，也只有它有单位。
 */
export interface MeasurementDefinition extends MetricBase {
	readonly kind: "measurement";
	/** 单位。省略表示单位尚未确认，消费方不得自行猜测。 */
	readonly unit?: string;
}

/**
 * 状态 / 编码型量：可查询、可分组、可用来筛选时间段，但不做数值统计。
 */
export interface StateDefinition extends MetricBase {
	readonly kind: "state";
}

export type MetricDefinition = MeasurementDefinition | StateDefinition;

export type MetricKind = MetricDefinition["kind"];
