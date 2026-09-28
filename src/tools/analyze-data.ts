import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { metricCatalog } from "../domain/metric/catalog.ts";
import { isMeasurement } from "../domain/metric/definition.ts";
import type { AnalysisService, AnalyzeDataResult } from "../services/analysis-service.ts";
import { stringEnum } from "./schema.ts";

const MEASUREMENT_KEYS = metricCatalog.list().filter(isMeasurement).map((metric) => metric.key);

export const analyzeDataParameters = Type.Object({
	datasetId: Type.String({
		description: "query_data 返回的 datasetId。分析使用同一份查询结果，不要自行拼造。",
		minLength: 1,
	}),
	thresholds: Type.Optional(
		Type.Array(
			Type.Object({
				metricKey: stringEnum(MEASUREMENT_KEYS, { description: "要设置阈值的数值指标 key" }),
				min: Type.Optional(Type.Number({ description: "下限；低于此值算越界" })),
				max: Type.Optional(Type.Number({ description: "上限；高于此值算越界" })),
			}),
			{
				description: "可选的指标阈值。建议使用用户或设备规范给出的合理范围；不提供时不做阈值越界判断。",
			},
		),
	),
});

type AnalyzeDataParams = Static<typeof analyzeDataParameters>;

function formatAnalysis(result: AnalyzeDataResult): string {
	const lines = [
		`设备：${result.deviceName}（${result.deviceKey}）`,
		`时间范围：${result.startTime} ~ ${result.endTime}`, 
		`数据集：${result.datasetId}；全窗口记录 ${result.rowCount} 点；本次采样 ${result.sampleCount} 点${result.sampleIsPartial ? "（部分数据）" : "（覆盖全部记录）"}`,
		"说明：count/mean/min/max/std 为全窗口统计；median、变化率、趋势、阈值越界与异常点基于 query_data 采样。",
	];

	for (const metric of result.measurements) {
		const unit = metric.unit ? ` ${metric.unit}` : "";
		lines.push(
			"",
			`- ${metric.displayName}（${metric.metricKey}）：count ${metric.count}，mean ${formatNumber(metric.mean)}${unit}，min ${formatNumber(metric.min)}${unit}，max ${formatNumber(metric.max)}${unit}，std ${formatNumber(metric.stddev)}${unit}`,
			`  采样 ${metric.sampleCount} 点；median ${formatNumber(metric.median)}${unit}；首末值 ${formatNumber(metric.firstValue)} → ${formatNumber(metric.lastValue)}${unit}；变化 ${formatNumber(metric.change)}${unit}；变化率 ${metric.changeRatePercent === null ? "—" : `${metric.changeRatePercent.toFixed(2)}%`}；趋势 ${metric.trend}`,
		);
		if (metric.threshold) {
			const range = `${metric.threshold.min === undefined ? "无下限" : `下限 ${metric.threshold.min}`}, ${metric.threshold.max === undefined ? "无上限" : `上限 ${metric.threshold.max}`}`;
			const examples = metric.threshold.examples.length === 0
				? "无越界点"
				: metric.threshold.examples.map((point) => `${point.timestamp}=${point.value}`).join("，");
			lines.push(`  阈值（${range}）：采样中 ${metric.threshold.exceededCount} 点越界；示例：${examples}`);
		}
		const anomalies = metric.anomalies.length === 0
			? "无（采样点不足或未发现 |z| ≥ 3 的点）"
			: metric.anomalies.map((point) => `${point.timestamp}=${point.value}（z=${point.zScore.toFixed(2)}）`).join("，");
		lines.push(`  简单异常点：${anomalies}`);
	}

	return lines.join("\n");
}

function formatNumber(value: number | null): string {
	return value === null ? "—" : Number(value.toFixed(3)).toString();
}

export function createAnalyzeDataTool(service: AnalysisService) {
	return defineTool({
		name: "analyze_data",
		label: "分析设备数据",
		description:
			"对 query_data 返回的 datasetId 做轻量数值分析，输出 count、mean、min、max、std、median、首末变化率、趋势、可选阈值越界及简单 3σ 异常点。" +
			"全窗口 count/mean/min/max/std 来自数据库聚合；其余序列特征基于 query_data 的原始采样（最多 200 点，且采样是窗口最早的一段）。如需序列分析，请先用 query_data 设置 sampleLimit: 200。阈值请依据用户提供或设备规范中的范围，不要臆造。",
		parameters: analyzeDataParameters,
		execute: async (_toolCallId, params: AnalyzeDataParams, _signal) => {
			try {
				const result = service.analyze(params.datasetId, params.thresholds ?? []);
				return {
					content: [{ type: "text" as const, text: formatAnalysis(result) }],
					details: result,
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				throw new Error(`分析失败：${message}`);
			}
		},
	});
}
