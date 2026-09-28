import { DatasetStore } from "../domain/dataset/store.ts";
import type { QueryDataResult } from "./data-service.ts";

export interface AnalysisThreshold {
	readonly metricKey: string;
	readonly min?: number;
	readonly max?: number;
}

export interface MeasurementAnalysis {
	readonly metricKey: string;
	readonly displayName: string;
	readonly unit?: string;
	/** 全窗口数据库聚合统计。 */
	readonly count: number;
	readonly mean: number | null;
	readonly min: number | null;
	readonly max: number | null;
	readonly stddev: number | null;
	/** 基于 query_data 保存的采样点计算。 */
	readonly sampleCount: number;
	readonly median: number | null;
	readonly firstValue: number | null;
	readonly lastValue: number | null;
	readonly change: number | null;
	readonly changeRatePercent: number | null;
	readonly trend: "上升" | "下降" | "稳定" | "数据不足";
	readonly threshold?: {
		readonly min?: number;
		readonly max?: number;
		readonly exceededCount: number;
		readonly examples: readonly { readonly timestamp: string; readonly value: number }[];
	};
	readonly anomalies: readonly {
		readonly timestamp: string;
		readonly value: number;
		readonly zScore: number;
	}[];
}

export interface AnalyzeDataResult {
	readonly datasetId: string;
	readonly deviceKey: string;
	readonly deviceName: string;
	readonly startTime: string;
	readonly endTime: string;
	readonly rowCount: number;
	readonly sampleCount: number;
	readonly sampleIsPartial: boolean;
	readonly measurements: readonly MeasurementAnalysis[];
}

function getMedian(sortedValues: readonly number[]): number | null {
	if (sortedValues.length === 0) return null;
	const middle = Math.floor(sortedValues.length / 2);
	const lower = sortedValues[middle - 1];
	const upper = sortedValues[middle];
	return sortedValues.length % 2 === 0
		? ((lower ?? 0) + (upper ?? 0)) / 2
		: (upper ?? null);
}

/** 分析 query_data 保存的数据集；原始采样点只在进程内处理，不返回给模型。 */
export class AnalysisService {
	constructor(private readonly datasets: DatasetStore<QueryDataResult>) {}

	analyze(datasetId: string, thresholds: readonly AnalysisThreshold[] = []): AnalyzeDataResult {
		const result = this.datasets.get(datasetId);
		if (!result) {
			throw new Error(`找不到数据集 ${datasetId}。它可能已过期，请重新调用 query_data。`);
		}
		for (const threshold of thresholds) {
			if (threshold.min === undefined && threshold.max === undefined) {
				throw new Error(`指标 ${threshold.metricKey} 的阈值至少要提供 min 或 max。`);
			}
			if (!result.measurements.some((measurement) => measurement.metricKey === threshold.metricKey)) {
				throw new Error(`数据集 ${datasetId} 未包含数值指标 ${threshold.metricKey}，请先在 query_data 中查询该指标。`);
			}
		}

		const thresholdByMetric = new Map(thresholds.map((threshold) => [threshold.metricKey, threshold]));
		const measurements = result.measurements.map<MeasurementAnalysis>((summary) => {
			const points = result.sample.points.flatMap((point) => {
				const value = point.values[summary.metricKey];
				return typeof value === "number" && Number.isFinite(value)
					? [{ timestamp: point.timestamp, value }]
					: [];
			});
			const values = points.map((point) => point.value);
			const median = getMedian([...values].sort((a, b) => a - b));
			const firstValue = values[0] ?? null;
			const lastValue = values.at(-1) ?? null;
			const change = firstValue === null || lastValue === null ? null : lastValue - firstValue;
			const changeRatePercent = firstValue === null || lastValue === null || firstValue === 0
				? null
				: ((lastValue - firstValue) / Math.abs(firstValue)) * 100;
			const sampleMean = values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
			const sampleStddev = values.length < 2 || sampleMean === null
				? null
				: Math.sqrt(values.reduce((sum, value) => sum + (value - sampleMean) ** 2, 0) / (values.length - 1));
			const tolerance = firstValue === null || lastValue === null
				? 0
				: Math.max(Math.abs(firstValue), Math.abs(lastValue), 1) * 0.01;
			const trend = change === null
				? "数据不足"
				: Math.abs(change) <= tolerance
					? "稳定"
					: change > 0 ? "上升" : "下降";

			const threshold = thresholdByMetric.get(summary.metricKey);
			const thresholdResult = threshold
				? {
					...(threshold.min === undefined ? {} : { min: threshold.min }),
					...(threshold.max === undefined ? {} : { max: threshold.max }),
					exceededCount: points.filter((point) =>
						(threshold.min !== undefined && point.value < threshold.min) ||
						(threshold.max !== undefined && point.value > threshold.max),
					).length,
					examples: points
						.filter((point) =>
							(threshold.min !== undefined && point.value < threshold.min) ||
							(threshold.max !== undefined && point.value > threshold.max),
						)
						.slice(0, 5),
				}
				: undefined;
			const anomalies = sampleMean === null || sampleStddev === null || sampleStddev === 0
				? []
				: points
						.map((point) => ({ ...point, zScore: (point.value - sampleMean) / sampleStddev }))
						.filter((point) => Math.abs(point.zScore) >= 3)
						.slice(0, 5)
						.map(({ timestamp, value, zScore }) => ({ timestamp, value, zScore }));

			return {
				metricKey: summary.metricKey,
				displayName: summary.displayName,
				...(summary.unit === undefined ? {} : { unit: summary.unit }),
				count: summary.valueCount,
				mean: summary.avg,
				min: summary.min,
				max: summary.max,
				stddev: summary.stddev,
				sampleCount: points.length,
				median,
				firstValue,
				lastValue,
				change,
				changeRatePercent,
				trend,
				...(thresholdResult === undefined ? {} : { threshold: thresholdResult }),
				anomalies,
			};
		});

		return {
			datasetId,
			deviceKey: result.deviceKey,
			deviceName: result.deviceName,
			startTime: result.startTime,
			endTime: result.endTime,
			rowCount: result.rowCount,
			sampleCount: result.sample.points.length,
			sampleIsPartial: result.sample.points.length < result.rowCount,
			measurements,
		};
	}
}
