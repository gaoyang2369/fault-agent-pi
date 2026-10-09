import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { deviceRegistry } from "../domain/device/registry.ts";
import type { FaultEvent, FaultEventResult, MessageKind } from "../domain/diagnosis/definition.ts";
import type { FaultEventService } from "../services/fault-event-service.ts";
import { stringEnum } from "./schema.ts";

const DEVICE_HINT = deviceRegistry.list()
	.map((device) => `${device.key}（${device.displayName}；别名：${device.aliases.join("、")}）`).join("；");
const TIME_PATTERN = "^\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}$";

export const queryFaultEventsParameters = Type.Object({
	device: stringEnum(deviceRegistry.list().map((device) => device.key), { description: `设备。可选值：${DEVICE_HINT}` }),
	startTime: Type.Optional(Type.String({
		pattern: TIME_PATTERN,
		description: "起始时间（含），格式 YYYY-MM-DD HH:MM:SS。与 endTime 同时给出或同时省略；省略时查询设备有数据的最新一小时。",
	})),
	endTime: Type.Optional(Type.String({ pattern: TIME_PATTERN, description: "结束时间（含），格式同 startTime，必须晚于 startTime。" })),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: "返回最早开始的事件数量，默认 20，上限 100。仅限制返回列表，仍扫描整个窗口并统计事件总数。" })),
});

export type QueryFaultEventsParams = Static<typeof queryFaultEventsParameters>;

const KIND_LABELS: Record<MessageKind, string> = { fault: "故障", alarm: "报警", notification: "通知" };
const END_REASON_LABELS: Record<FaultEvent["endReason"], string> = {
	cleared_observed: "观测到清除值",
	code_replaced: "编码被替换（不代表物理故障恢复）",
	window_boundary: "查询窗口边界（窗口之外未知）",
	observation_boundary: "读取边界（未覆盖整个窗口）",
	data_gap: "数据缺失、未知值或采样断档",
};

/** 仅渲染已计算的有界摘要；不重新解释原始记录或推算真实故障持续时间。 */
export function formatFaultEventResult(result: FaultEventResult): string {
	const deviceName = deviceRegistry.get(result.deviceKey)?.displayName ?? result.deviceKey;
	const lines = [
		`事件数据集 ID：${result.datasetId}`,
		`设备：${deviceName}（${result.deviceKey}）`,
		`时间范围：${result.period.startTime} ~ ${result.period.endTime}（两端均含）`,
		`采样记录：${result.rowCount} 条；已处理 ${result.processedRowCount} 条；检查字段：${result.sourceMetrics.join("、")}`,
		`观测事件：共 ${result.eventCount} 个；返回 ${result.events.length} 个；事件列表截断：${result.eventsTruncated ? "是" : "否"}`,
		"说明：事件首末时间是离散采样的观测边界，不能当作物理故障的精确发生、恢复或持续时间。",
		"", "返回事件中的编码：",
	];
	for (const kind of ["fault", "alarm", "notification"] as const) {
		const codes = [...new Set(result.events.filter((event) => event.kind === kind).map((event) => event.code))];
		lines.push(`- ${KIND_LABELS[kind]}码：${codes.join("、") || "未在返回列表中观测到"}`);
	}
	if (result.eventsTruncated) lines.push("编码清单仅覆盖返回的事件列表，不能据此排除未返回事件中的其他故障码或报警码。请提高 limit 或收窄窗口继续查询。");
	lines.push("", "观测事件摘要：");
	for (const event of result.events) {
		lines.push(`- [${event.eventId}] ${event.code}（${KIND_LABELS[event.kind]}；来源 ${event.sourceMetric}）：` +
			`${event.firstObservedAt} ~ ${event.lastObservedAt}，观测 ${event.observationCount} 次；结束原因：${END_REASON_LABELS[event.endReason]}。`);
	}
	if (!result.events.length) lines.push(result.rowCount === 0
		? "窗口内没有采样记录，无法判断是否发生故障。"
		: "未识别出有效编码观测事件；请结合数据缺口和未知值判断，不能据此认定设备健康。");
	lines.push("", "未识别取值（有界示例）：");
	for (const observation of result.unknownValues) {
		lines.push(`- ${observation.timestamp}，${observation.sourceMetric}，原值 ${JSON.stringify(observation.rawValue)}`);
	}
	if (!result.unknownValues.length) lines.push("无返回示例；是否存在未展示的未知观测以局限说明为准。");
	lines.push("", "数据缺口、边界与局限：", ...result.limitations.map((limitation) => `- ${limitation}`));
	return lines.join("\n");
}

/** 参数适配 → Service → 中文正文和结构化 details；不访问仓储或连接池。 */
export function createQueryFaultEventsTool(service: Pick<FaultEventService, "query">) {
	return defineTool({
		name: "query_fault_events", label: "查询故障与报警观测事件",
		description: "只读查询设备窗口内完整的故障码和报警码采样序列，识别连续编码观测事件，返回事件首末时间、观测次数、结束原因、数据缺口、未知值及截断说明。" +
			"时间两端同时给出或同时省略，省略时取设备有数据的最新一小时。limit 只限制事件列表，事件总数仍来自整个窗口。" +
			"结果不证明物理故障持续时间或根因；查含义请用 search_knowledge，查运行指标请用 query_data。事件数据集 ID 不能传给 analyze_data。",
		parameters: queryFaultEventsParameters,
		execute: async (_toolCallId, params: QueryFaultEventsParams, signal) => {
			try {
				const result = await service.query({
					device: params.device,
					...(params.startTime === undefined ? {} : { startTime: params.startTime }),
					...(params.endTime === undefined ? {} : { endTime: params.endTime }),
					maxEvents: params.limit ?? 20,
				}, { signal });
				return { content: [{ type: "text" as const, text: formatFaultEventResult(result) }], details: result };
			} catch (error) {
				signal?.throwIfAborted();
				if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) throw error;
				throw new Error(`故障事件查询失败：${error instanceof Error ? error.message : String(error)}`);
			}
		},
	});
}
