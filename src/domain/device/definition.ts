/**
 * 设备定义。
 *
 * 设备身份目前只编码在物理表名里——`dcma` 库中每台设备一张表，表内的
 * `device_name` / `inverter_name` 是常量且彼此相等，属于冗余列。所以「领域设备 →
 * 物理表」这层映射必须显式登记，不能靠表名规律去猜。
 */

export interface DeviceDefinition {
	/** 领域唯一标识。工具入参与业务代码只用这个。 */
	readonly key: string;
	/** 物理表名。只有仓储层需要关心，且只能来源于本定义。 */
	readonly table: string;
	/** 中文名称，给人和 LLM 看。 */
	readonly displayName: string;
	/** 别名，用于把用户口语映射到 key。不进入 SQL。 */
	readonly aliases: readonly string[];
	/** 用于知识检索适用性过滤；组件和固件没有登记时不能猜测。 */
	readonly productFamily: string;
}
