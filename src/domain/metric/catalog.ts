import type { MetricDefinition } from "./definition.ts";
import { METRIC_DEFINITIONS } from "./definitions.ts";

/**
 * 指标目录：把指标定义按 key 索引起来，回答「这个 key 是什么」。
 *
 * 它刻意不暴露内部的 Map，只给 get / has / list 三个方法——将来定义改成从配置文件
 * 或数据库加载时，调用方不用跟着改。它也不负责格式化输出：怎么把指标讲给 LLM 听
 * 是工具层的事，不是领域对象的事。
 */
export class MetricCatalog {
	private readonly byKey: ReadonlyMap<string, MetricDefinition>;
	private readonly all: readonly MetricDefinition[];

	constructor(definitions: readonly MetricDefinition[]) {
		const byKey = new Map<string, MetricDefinition>();
		for (const definition of definitions) {
			// 定义表是手写的，重复 key 多半是复制粘贴时忘了改，早失败比晚出错好。
			if (byKey.has(definition.key)) {
				throw new Error(`指标目录中存在重复的 key：${definition.key}`);
			}
			byKey.set(definition.key, definition);
		}
		this.byKey = byKey;
		this.all = [...definitions];
	}

	/** 按键取定义；未登记时返回 undefined。 */
	get(key: string): MetricDefinition | undefined {
		return this.byKey.get(key);
	}

	/** 判断 key 是否已登记，用于校验工具入参。 */
	has(key: string): boolean {
		return this.byKey.has(key);
	}

	/** 全部指标，保持定义表中的顺序。 */
	list(): readonly MetricDefinition[] {
		return this.all;
	}
}

/** 全局唯一的指标目录，由 definitions.ts 中的定义表构建。 */
export const metricCatalog = new MetricCatalog(METRIC_DEFINITIONS);
