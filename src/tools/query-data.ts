import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { deviceRegistry } from "../domain/device/registry.ts";
import { metricCatalog } from "../domain/metric/catalog.ts";
import { isMeasurement } from "../domain/metric/definition.ts";
import type { DataService, QueryDataResult } from "../services/data-service.ts";
import { stringEnum } from "./schema.ts";

/**
 * query_data：查询电机/变频器的历史采集数据。
 *
 * 只做三件事——把参数交给服务、把结果渲染成文本、把可引用的结构化信息放进 details。
 * 任何校验、拼 SQL、算统计都不在这里（分别在 services / repositories）。
 */

const DEVICE_KEYS: readonly string[] = deviceRegistry.list().map((device) => device.key);
const METRIC_KEYS: readonly string[] = metricCatalog.list().map((definition) => definition.key);

/** 把 key 与中文名、别名一起讲给模型，它据此把「一号电机」这类说法映射到 key。 */
const DEVICE_HINT = deviceRegistry
	.list()
	.map((device) => `${device.key}（${device.displayName}；别名：${device.aliases.join("、")}）`)
	.join("；");

const MEASUREMENT_COUNT = metricCatalog.list().filter(isMeasurement).length;

export const queryDataParameters = Type.Object({
	device: stringEnum(DEVICE_KEYS, {
		description: `设备。可选值：${DEVICE_HINT}`,
	}),
	metrics: Type.Optional(
		Type.Array(stringEnum(METRIC_KEYS, { description: "指标 key，见系统提示词中的指标目录" }), {
			description:
				`要查询的指标 key 列表。数值型指标返回统计值，状态型指标返回取值分组。` +
				`省略则返回全部 ${METRIC_KEYS.length} 个指标（其中 ${MEASUREMENT_COUNT} 个数值型）。`,
			minItems: 1,
		}),
	),
	startTime: Type.Optional(
		Type.String({
			description:
				"起始时间（含），格式 YYYY-MM-DD HH:MM:SS。与 endTime 必须同时给出或同时省略。",
			pattern: "^\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}$",
		}),
	),
	endTime: Type.Optional(
		Type.String({
			description: "结束时间（含），格式同上，必须晚于 startTime。",
			pattern: "^\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}$",
		}),
	),
	sampleLimit: Type.Optional(
		Type.Integer({
			minimum: 0,
			maximum: 200,
			description:
				"额外返回窗口内最早的 N 条原始采样点，上限 200，默认 0（只要统计值）。" +
				"采样只覆盖窗口开头的一小段，看具体点迹前请先把时间窗口收窄。",
		}),
	),
});

export type QueryDataParams = Static<typeof queryDataParameters>;

/** 保留三位小数：float 列原样输出会得到 38.20000076293945 这种假精度。 */
function round(value: number | null): number | null {
	return value === null ? null : Number(value.toFixed(3));
}

function formatMeasurement(summary: QueryDataResult["measurements"][number]): string {
	const unit = summary.unit === undefined ? "" : `，单位 ${summary.unit}`;
	return (
		`- ${summary.displayName}（${summary.metricKey}${unit}）：` +
		`命中 ${summary.totalCount} 点，有效 ${summary.valueCount} 点，` +
		`均值 ${round(summary.avg) ?? "—"}，最小 ${round(summary.min) ?? "—"}，` +
		`最大 ${round(summary.max) ?? "—"}，标准差 ${round(summary.stddev) ?? "—"}`
	);
}

function formatStateGroup(group: QueryDataResult["states"][number]): string {
	return `  - 取值 "${group.value}"：${group.count} 点，${group.firstTimestamp} ~ ${group.lastTimestamp}`;
}

/** 渲染成给模型看的中文文本。刻意不走 JSON.stringify：列名重复几百次既费 token 又难读。 */
export function formatQueryDataResult(result: QueryDataResult): string {
	const lines: string[] = [
		`设备：${result.deviceName}（${result.deviceKey}）`,
		`时间范围：${result.startTime} ~ ${result.endTime}（两端均含）`,
		`命中记录：${result.rowCount} 点，实际覆盖 ${result.firstTimestamp ?? "—"} ~ ${result.lastTimestamp ?? "—"}`,
	];

	if (result.measurements.length > 0) {
		lines.push("", "数值指标统计：");
		lines.push(...result.measurements.map(formatMeasurement));
	}

	if (result.states.length > 0) {
		lines.push("", result.statesTruncated ? "状态指标取值分组（已截断，结果不完整）：" : "状态指标取值分组：");
		const byMetric = new Map<string, QueryDataResult["states"]>();
		for (const group of result.states) {
			const existing = byMetric.get(group.metricKey) ?? [];
			byMetric.set(group.metricKey, [...existing, group]);
		}
		for (const [metricKey, groups] of byMetric) {
			const first = groups[0];
			lines.push(`- ${first?.displayName ?? metricKey}（${metricKey}）：${groups.length} 种取值`);
			lines.push(...groups.map(formatStateGroup));
		}
	}

	if (result.sample.points.length > 0) {
		const sampleKeys = Object.keys(result.sample.points[0]?.values ?? {});
		lines.push(
			"",
			`原始采样：窗口内最早 ${result.sample.points.length} 条（仅代表窗口开头片段，请勿外推到整个窗口）`,
			["timestamp", ...sampleKeys].join(","),
			...result.sample.points.map((point) =>
				[point.timestamp, ...sampleKeys.map((key) => point.values[key] ?? "")].join(","),
			),
		);
	}

	return lines.join("\n");
}

/**
 * `details` 刻意不含采样点：它会被写进会话记录，几百行数据留在那里只有坏处。
 * 这里放的是「可被后续步骤引用的句柄」——尤其是 datasetId，证据链要靠它指回数据。
 */
function toDetails(datasetId: string, result: QueryDataResult) {
	return {
		datasetId,
		deviceKey: result.deviceKey,
		startTime: result.startTime,
		endTime: result.endTime,
		rowCount: result.rowCount,
		measurements: result.measurements,
		states: result.states,
		statesTruncated: result.statesTruncated,
		sampleRowCount: result.sample.points.length,
	};
}

/**
 * 构造 query_data 工具。
 *
 * 服务由外部注入而不是在这里 new，好处是工具层不必知道连接池、仓储的存在，
 * 依赖方向保持单向：tools → services → repositories。
 *
 * 不设 promptSnippet / promptGuidelines：本项目的 agent.ts 用了 systemPromptOverride，
 * 而 SDK 在 customPrompt 存在时会跳过拼装「Available tools」段落，这两个字段不会生效。
 * 工具的可发现性靠 description（随工具 schema 发给模型）与 prompt.ts 里的指标目录。
 */
export function createQueryDataTool(service: DataService) {
	return defineTool({
		name: "query_data",
		label: "查询设备数据",
		description:
			"查询 G120 电机/变频器的历史采集数据。返回数值指标的统计值（命中点数/有效点数/均值/极值/标准差）、" +
			"状态指标的取值分组（每种取值一行，含首末时间，可据此定位状态变化的时刻），以及可选的少量原始采样点。" +
			"数据是历史归档数据，不是实时数据；省略时间范围时默认查「有数据的最新 1 小时」。",
		parameters: queryDataParameters,
		execute: async (_toolCallId, params: QueryDataParams, _signal) => {
			try {
				const { datasetId, result } = await service.query({
					device: params.device,
					metrics: params.metrics ?? [],
					...(params.startTime === undefined ? {} : { startTime: params.startTime }),
					...(params.endTime === undefined ? {} : { endTime: params.endTime }),
					// schema 里的 default 不会被运行时应用，兜底必须写在这里。
					sampleLimit: params.sampleLimit ?? 0,
				});

				return {
					content: [{ type: "text" as const, text: formatQueryDataResult(result) }],
					details: toDetails(datasetId, result),
				};
			} catch (error) {
				// 按 SDK 约定，只有抛错才会把这次调用标记为失败；在返回值里写什么是没用的。
				const message = error instanceof Error ? error.message : String(error);
				throw new Error(`查询失败：${message}`);
			}
		},
	});
}
