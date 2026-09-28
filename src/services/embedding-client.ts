import { retryNetworkRequest } from "./network-retry.ts";

/** 与 Ollama /v1/embeddings 及同协议的独立 embedding 服务兼容。 */
export interface EmbeddingConfig {
	baseUrl: string;
	model: string;
	apiKey?: string;
}

export class EmbeddingClient {
	constructor(readonly config: EmbeddingConfig) {
		const url = new URL(config.baseUrl);
		if (!["http:", "https:"].includes(url.protocol)) throw new Error("embedding 地址必须使用 HTTP(S)。");
		if (!config.model.trim()) throw new Error("embedding 模型不能为空。");
	}

	async embed(texts: readonly string[], signal?: AbortSignal): Promise<number[][]> {
		signal?.throwIfAborted();
		if (!texts.length) return [];
		const body = await retryNetworkRequest(async () => {
			const response = await fetch(`${this.config.baseUrl.replace(/\/$/, "")}/embeddings`, {
				method: "POST",
				headers: { "Content-Type": "application/json", ...(this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {}) },
				body: JSON.stringify({ model: this.config.model, input: texts, encoding_format: "float" }),
				signal: AbortSignal.any([AbortSignal.timeout(120_000), ...(signal ? [signal] : [])]),
			});
			// 不输出服务端响应正文，避免错误消息携带密钥或文档内容。
			if (!response.ok) throw new Error(`embedding 服务返回 HTTP ${response.status}。`);
			return await response.json() as { data?: Array<{ index: number; embedding: number[] }> };
		}, signal);
		if (!Array.isArray(body.data) || body.data.length !== texts.length) throw new Error("embedding 返回的向量数量不正确。");
		const ordered = [...body.data].sort((a, b) => a.index - b.index);
		let dimensions = 0;
		for (const [index, item] of ordered.entries()) {
			if (item.index !== index || !Array.isArray(item.embedding) || !item.embedding.length ||
				!item.embedding.every((number) => typeof number === "number" && Number.isFinite(number)) ||
				item.embedding.every((number) => number === 0)) throw new Error("embedding 服务返回了无效向量。");
			dimensions ||= item.embedding.length;
			if (dimensions !== item.embedding.length) throw new Error("embedding 向量维度不一致。");
		}
		return ordered.map((item) => item.embedding);
	}
}
