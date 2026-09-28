import { QdrantClient } from "@qdrant/js-client-rest";
import type { RankedChunk } from "../domain/knowledge/definition.ts";

export interface KnowledgeVectorSearch {
	search(collection: string, vector: number[], entryIds: string[], limit: number, signal?: AbortSignal): Promise<RankedChunk[]>;
}

/** 查询端只提供读取方法。用 entry_id 限定候选，与词法召回使用同一份适用性过滤。 */
export class KnowledgeVectorRepository implements KnowledgeVectorSearch {
	private readonly client: QdrantClient;

	constructor(config: { url: string; apiKey?: string }) {
		// SDK 的默认超时中间件会覆盖调用方的 signal，使用底层 typed API 合并取消和超时。
		this.client = new QdrantClient({ ...config, timeout: Infinity, checkCompatibility: false });
	}

	async search(collection: string, vector: number[], entryIds: string[], limit: number, signal?: AbortSignal): Promise<RankedChunk[]> {
		signal?.throwIfAborted();
		if (!entryIds.length) return [];
		const response = await this.client.api().queryPoints({
			collection_name: collection,
			query: vector,
			filter: { must: [{ key: "entry_id", match: { any: entryIds } }] },
			limit, with_payload: false, with_vector: false, timeout: 10,
		}, { signal: AbortSignal.any([AbortSignal.timeout(15_000), ...(signal ? [signal] : [])]) });
		signal?.throwIfAborted();
		const result = response.data.result;
		if (!result) throw new Error("向量服务没有返回查询结果。");
		return result.points.map((point) => ({ chunkId: String(point.id), score: point.score }));
	}
}
