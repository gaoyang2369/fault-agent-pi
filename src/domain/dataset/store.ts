import { randomUUID } from "node:crypto";

/**
 * 会话内的一次查询结果暂存。
 *
 * 存在的理由不是"省内存"，而是**给一次查询一个有身份的句柄**：原始采样点不随工具结果
 * 进入 LLM 上下文，后续步骤（分析、报告、证据链）通过 `dataset_id` 引用同一份数据，
 * 而不是把数据或查询参数再传一遍。
 *
 * 刻意做成泛型：它只是"句柄表"，不该知道业务结果长什么样，免得领域层反过来依赖服务层。
 * 上限默认 5，避免长会话无限堆积。
 */
export class DatasetStore<T> {
	private readonly entries = new Map<string, T>();

	constructor(private readonly maxEntries: number = 5) {}

	/** 存入一份结果，返回它的 dataset_id。 */
	put(value: T): string {
		const id = `ds_${randomUUID().slice(0, 8)}`;
		this.entries.set(id, value);

		// Map 保持插入顺序，超出上限就丢最旧的那个。
		while (this.entries.size > this.maxEntries) {
			const oldest = this.entries.keys().next();
			if (oldest.done) break;
			this.entries.delete(oldest.value);
		}

		return id;
	}

	get(id: string): T | undefined {
		return this.entries.get(id);
	}

	get size(): number {
		return this.entries.size;
	}
}
