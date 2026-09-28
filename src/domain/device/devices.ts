import type { DeviceDefinition } from "./definition.ts";

/**
 * `dcma` 库中登记的电机设备。每台设备一张独立表，表结构完全相同。
 *
 * 两处刻意的取舍：
 *
 * 1. **不登记 `real_data`。** 那张表（567 行）的 `timestamp` 存的是 epoch 毫秒字符串
 *    （形如 "1768371161277"），与 `_01`~`_04` 的 "YYYY-MM-DD HH:MM:SS" 无法做字典序比较。
 *    放进来会让时间范围查询静默返回空结果或错误区间。将来真要用，应该给
 *    DeviceDefinition 加一个时间格式字段，而不是现在为几百行历史数据准备两套比较逻辑。
 *
 * 2. **查询不额外加 `WHERE device_name = ?`。** 表本身就是设备，再加一遍既冗余，又会
 *    在出现空值或异名行时静默少返回数据（`real_data` 里就有一行 device_name 为 NULL）。
 *    过滤条件就是表名，仅此而已。
 *
 * 当前只开放 `real_data_01`~`_03`。`real_data_04` 在库中同样存在、schema 也一致，但
 * 不在本项目范围内，故不登记——登记即等于对 agent 开放。将来要放开，在这里加一条即可。
 */
export const DEVICE_DEFINITIONS: readonly DeviceDefinition[] = [
	{
		key: "g120_01",
		table: "real_data_01",
		displayName: "G120电机1",
		aliases: ["电机1", "1号电机", "一号电机", "G120电机1", "G120-1"],
	},
	{
		key: "g120_02",
		table: "real_data_02",
		displayName: "G120电机2",
		aliases: ["电机2", "2号电机", "二号电机", "G120电机2", "G120-2"],
	},
	{
		key: "g120_03",
		table: "real_data_03",
		displayName: "G120电机3",
		aliases: ["电机3", "3号电机", "三号电机", "G120电机3", "G120-3"],
	},
];
