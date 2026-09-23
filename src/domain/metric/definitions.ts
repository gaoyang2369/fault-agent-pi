import type { MetricDefinition } from "./definition.ts";

/**
 * 电机 + 变频器数据表的指标目录，是数据库列到领域指标的唯一映射。
 *
 * 数据来源是现场采集表（单表、字段固定、多台电机共用同一套列）。各条含义由列名
 * 推断而来，尚未与设备手册或现场人员逐条核对，因此凡有疑问都写在 description 里。
 *
 * 不在本目录内的列都不是指标：
 *   - id / create_time           主键与入库时间，属于存储细节；
 *   - timestamp / date / time    时间坐标轴，由 query_data 的时间参数承载；
 *   - device_name / inverter_name 设备筛选维度，由 query_data 的设备参数承载。
 */
export const METRIC_DEFINITIONS: readonly MetricDefinition[] = [
	// ---- 电气 ----
	{
		kind: "measurement",
		key: "dc_voltage",
		column: "dc_voltage",
		displayName: "直流母线电压",
		unit: "V",
		description: "变频器直流母线（DC Link）电压。",
	},
	{
		kind: "measurement",
		key: "current_actual",
		column: "current_actual",
		displayName: "实际电流",
		unit: "A RMS",
		description: "电机总电流有效值，不区分励磁与转矩分量。",
	},
	{
		kind: "measurement",
		key: "field_current",
		column: "field_current",
		displayName: "励磁电流（Id）",
		unit: "A RMS",
		description: "定子电流的 d 轴分量，用于建立磁场，不产生转矩。",
	},
	{
		kind: "measurement",
		key: "torque_current",
		column: "torque_current",
		displayName: "转矩电流（Iq）",
		unit: "A RMS",
		description: "定子电流的 q 轴分量，与输出转矩成正比，是负载的直接反映。",
	},

	// ---- 转速与转矩 ----
	{
		kind: "measurement",
		key: "speed_setpoint",
		column: "speed_setpoint",
		displayName: "转速设定值",
		unit: "r/min",
		description: "控制器下发的目标转速。与实际转速的差值反映跟随性能。",
	},
	{
		kind: "measurement",
		key: "speed_actual",
		column: "speed_actual",
		displayName: "实际转速",
		unit: "r/min",
		description: "电机实际转速。",
	},
	{
		kind: "measurement",
		key: "torque_setpoint",
		column: "torque_setpoint",
		displayName: "转矩设定值",
		unit: "N·m",
		description: "控制器下发的目标转矩。",
	},
	{
		kind: "measurement",
		key: "torque_actual",
		column: "torque_actual",
		displayName: "实际转矩",
		unit: "N·m",
		description: "实际输出转矩，为估算或反馈值，具体来源（观测器估算 / 转矩传感器）未确认。",
	},

	// ---- 温度 ----
	{
		kind: "measurement",
		key: "motor_temp",
		column: "motor_temp",
		displayName: "电机温度",
		unit: "℃",
		description: "电机温度。可能是变频器热模型的估算值而非实测值，未确认，解读时需留意。",
	},
	{
		kind: "measurement",
		key: "inverter_temp",
		column: "inverter_temp",
		displayName: "变频器温度",
		unit: "℃",
		description: "变频器功率单元温度，通常是 IGBT 模块的测量值。",
	},
	{
		kind: "measurement",
		key: "inverter_radiator_temp",
		column: "inverter_radiator_temp",
		displayName: "变频器散热器温度",
		unit: "℃",
		description: "PM240 功率模块散热器温度，与散热条件直接相关。",
	},
	{
		kind: "measurement",
		key: "air_intake_temp",
		column: "air_intake_temp",
		displayName: "变频器进风温度",
		unit: "℃",
		description: "变频器进风口温度，接近环境温度，可作为其他温度测点的参考基准。",
	},

	// ---- 功率与负载 ----
	{
		kind: "measurement",
		key: "actual_power",
		column: "actual_power",
		displayName: "实际有功功率",
		unit: "kW",
		description: "电机实际消耗的有功功率。",
	},
	{
		kind: "measurement",
		key: "motor_power",
		column: "motor_power",
		displayName: "电机功率",
		description:
			"电机功率。与 actual_power 的区别未确认（可能是额定功率、机械功率或另一个测量口径），单位也未确认，使用前需先与现场核对。",
	},
	{
		kind: "measurement",
		key: "feedback_power",
		column: "feedback_power",
		displayName: "回馈功率",
		description:
			"回馈功率。含义与单位均未确认（可能是再生制动回馈电网的功率，也可能是负向的 actual_power），使用前需先与现场核对。",
	},
	{
		kind: "measurement",
		key: "motor_load_rate",
		column: "motor_load_rate",
		displayName: "电机负载率",
		unit: "%",
		description: "电机负载率。很可能是电机热模型的利用率而非转矩占比，未确认。",
	},
	{
		kind: "measurement",
		key: "inverter_load_rate",
		column: "inverter_load_rate",
		displayName: "变频器负载率",
		unit: "%",
		description: "变频器负载率。很可能是功率单元的 I²t 利用率而非电流占比，未确认。",
	},
	{
		kind: "measurement",
		key: "pulse_frequency",
		column: "pulse_frequency",
		displayName: "PWM 脉冲频率",
		unit: "kHz",
		description: "变频器实际开关频率。",
	},
	{
		kind: "measurement",
		key: "system_run_time",
		column: "system_run_time",
		displayName: "系统累计运行时间",
		description:
			"系统累计运行时间。存储类型与单位均未确认（可能是毫秒数、天数或格式化字符串），使用前需先确认。",
	},

	// ---- 状态与故障 ----
	{
		kind: "state",
		key: "status",
		column: "status",
		displayName: "运行状态",
		description: "设备运行状态（运行 / 停止 / 故障等）。具体取值编码未确认。",
	},
	{
		kind: "state",
		key: "fault_code",
		column: "fault_code",
		displayName: "故障代码",
		description:
			"Siemens 故障码，形如 F30015。此处只登记该列的存在与格式，具体含义需查故障手册——那是知识库的职责，不在本目录内。",
	},
	{
		kind: "state",
		key: "alarm_code",
		column: "alarm_code",
		displayName: "报警代码",
		description: "Siemens 报警码，形如 Axxxx。报警不触发停机，含义需查故障手册。",
	},
	{
		kind: "state",
		key: "control_word",
		column: "control_word",
		displayName: "控制字",
		description: "变频器控制字，位域编码。需按位解码才有意义，当前未实现解码逻辑。",
	},
	{
		kind: "state",
		key: "status_word",
		column: "status_word",
		displayName: "状态字",
		description: "变频器状态字，位域编码。需按位解码才有意义，当前未实现解码逻辑。",
	},
];
