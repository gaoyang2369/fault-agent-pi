import { deviceRegistry } from "../domain/device/registry.ts";
import { reciprocalRankFusion } from "../domain/knowledge/bm25.ts";
import {
	extractFaultCodes, sourceTypes,
	type KnowledgeEntry, type KnowledgeFilter, type KnowledgeEvidence,
	type SearchKnowledgeResult, type CodeLookup,
} from "../domain/knowledge/definition.ts";
import type { KnowledgeCatalog, KnowledgeRepository } from "../repositories/knowledge-repository.ts";
import type { KnowledgeVectorSearch } from "../repositories/knowledge-vector-repository.ts";
import type { EmbeddingClient } from "./embedding-client.ts";

export interface SearchKnowledgeRequest extends KnowledgeFilter {
	query: string;
	device?: string;
	faultCodes?: readonly string[];
	limit?: number;
}

function driveObjects(entry: KnowledgeEntry): string[] {
	return (entry.fields["驱动对象"] ?? "").split(/[,，\s]+/).filter(Boolean).map((value) => value.toUpperCase());
}

function applies(entry: KnowledgeEntry, catalog: KnowledgeCatalog, filter: KnowledgeFilter): boolean {
	const document = catalog.documents.get(entry.documentId)!;
	if (filter.productFamily && !document.applicableProducts.some((product) => product.toUpperCase() === filter.productFamily)) return false;
	if (filter.sourceTypes?.length && !filter.sourceTypes.includes(document.sourceType)) return false;
	if (filter.driveObject && document.sourceType === "fault_manual") {
		const objects = driveObjects(entry);
		if (!objects.includes("所有目标") && !objects.includes(filter.driveObject)) return false;
	}
	return true;
}

function matchingChunk(entry: KnowledgeEntry, catalog: KnowledgeCatalog, query: string): string | undefined {
	const allowed = new Set([...catalog.chunks.values()].filter((chunk) => chunk.entryId === entry.id).map((chunk) => chunk.id));
	const [hit] = catalog.lexical.search(query, allowed, 1);
	return hit ? catalog.chunks.get(hit.chunkId)?.text : undefined;
}

/** 长条目保留原因、处理各自的证据；截断明确标记，不能把局部文本当成完整手册。 */
function toEvidence(entry: KnowledgeEntry, catalog: KnowledgeCatalog, match: KnowledgeEvidence["match"], ambiguous = false, budget = 8000, matchedText?: string): KnowledgeEvidence {
	const maxLength = Math.min(ambiguous ? 1800 : 8000, budget);
	const truncated = entry.text.length > maxLength;
	let text = entry.text;
	if (truncated) {
		const matched = matchedText?.slice(0, Math.max(0, Math.floor((maxLength - 300) / 2)));
		const sectionBudget = Math.floor((maxLength - 300 - (matched?.length ?? 0)) / 2);
		text = entry.fields["原因"] && entry.fields["处理"]
			? `${entry.primaryFaultCode ?? ""} ${entry.title}\n${matched ? `命中片段：\n${matched}\n` : ""}原因（节选）：\n${entry.fields["原因"].slice(0, Math.max(sectionBudget, 0))}\n处理（节选）：\n${entry.fields["处理"].slice(0, Math.max(sectionBudget, 0))}`
			: matchedText?.slice(0, maxLength) ?? entry.text.slice(0, maxLength);
		text = text.slice(0, maxLength);
	}
	return {
		evidenceId: `K-${entry.id}`, entryId: entry.id, match,
		primaryFaultCode: entry.primaryFaultCode, title: entry.title, text,
		// 原因/处理已经出现在 text，不重复发送完整大段文本到会话 details。
		fields: Object.fromEntries(Object.entries(entry.fields).filter(([key]) => !["原因", "处理"].includes(key))),
		truncated,
		source: { ...catalog.documents.get(entry.documentId)!, pdfPages: entry.pdfPages, printedPages: entry.printedPages },
	};
}

/** 只读查询门面。精确查码独立于 embedding/Qdrant；自然语言采用 BM25 + dense + RRF。 */
export class KnowledgeService {
	constructor(
		private readonly repository: Pick<KnowledgeRepository, "load">,
		private readonly embedding?: Pick<EmbeddingClient, "config" | "embed">,
		private readonly vectors?: KnowledgeVectorSearch,
	) {}

	async search(request: SearchKnowledgeRequest, signal?: AbortSignal): Promise<SearchKnowledgeResult> {
		signal?.throwIfAborted();
		const query = request.query.trim();
		if (!query || query.length > 2000) throw new Error("query 必须是 1–2000 字符的查询。");
		const malformedCodes = (query.normalize("NFKC").toUpperCase().match(/(?<![A-Z0-9])[FAN]\d[0-9OIL]{2,}(?![A-Z0-9])/g) ?? [])
			.filter((code) => !/^[FAN]\d{5}$/.test(code));
		if (malformedCodes.length) throw new Error(`请核对故障码 ${malformedCodes.join("、")}：本手册使用 F/A/N + 五位数字，不能补零或自动纠正混淆字母。`);
		const limit = request.limit ?? 5;
		if (!Number.isInteger(limit) || limit < 1 || limit > 8) throw new Error("limit 必须是 1–8 的整数。");
		if (request.sourceTypes?.some((value) => !sourceTypes.includes(value))) throw new Error("未知的知识来源类型。");
		let productFamily = request.productFamily?.normalize("NFKC").trim().toUpperCase();
		if (request.device) {
			const device = deviceRegistry.resolve(request.device);
			if (!device) throw new Error(`未知设备：${request.device}`);
			if (productFamily && productFamily !== device.productFamily.toUpperCase()) throw new Error("指定产品系列与设备登记不一致。");
			productFamily = device.productFamily.toUpperCase();
		}
		const filter: KnowledgeFilter = { productFamily, sourceTypes: request.sourceTypes, driveObject: request.driveObject?.trim().toUpperCase() };
		const explicitCodes = (request.faultCodes ?? []).map((value) => {
			const codes = extractFaultCodes(value.trim());
			if (codes.length !== 1 || codes[0] !== value.normalize("NFKC").trim().toUpperCase()) throw new Error(`故障码格式无效：${value}，应为 F/A/N + 五位数字。`);
			return codes[0]!;
		});
		const codes = [...new Set([...explicitCodes, ...extractFaultCodes(query)])];
		if (codes.length > 5) throw new Error("一次最多查询 5 个故障码，请分批查询。");
		const catalog = await this.repository.load();
		signal?.throwIfAborted();
		const entries = [...catalog.entries.values()].filter((entry) => applies(entry, catalog, filter));
		const warnings: string[] = [];
		let evidence: KnowledgeEvidence[] = [];
		const codeLookups: CodeLookup[] = [];
		let retrievalMode: SearchKnowledgeResult["retrievalMode"] = codes.length ? "exact" : "lexical";

		if (codes.length) {
			for (const code of codes) {
				// 主码优先；只有主码不存在时，才查手册明确列出的类别切换码。
				const primary = entries.filter((entry) => entry.primaryFaultCode === code);
				const matches = primary.length ? primary : entries.filter((entry) => entry.faultCodes.includes(code));
				const ambiguous = matches.length > 1;
				const selected = matches.slice(0, 6).map((entry) => toEvidence(entry, catalog, primary.length ? "exact" : "category_alias", ambiguous,
					8000, entry.text.length > 8000 ? matchingChunk(entry, catalog, query) : undefined));
				evidence.push(...selected);
				codeLookups.push({ code, status: ambiguous ? "needs_context" : matches.length ? "matched" : "not_found", candidateCount: matches.length, evidenceIds: selected.map((item) => item.evidenceId) });
				if (ambiguous) warnings.push(`${code} 有 ${matches.length} 个适用条目，请确认驱动对象（driveObject）、组件或产品系列；不能合并各版本的处理方法。`);
				if (matches.length > selected.length) warnings.push(`${code} 候选过多，仅展示前 ${selected.length} 条，请缩小检索范围。`);
				if (!matches.length) warnings.push(`${code} 在当前适用范围内未找到，不以相似故障码替代。`);
			}
			// 查码请求不混入其他故障码；需要背景知识时可发起后续现象查询。
		} else if (entries.length) {
			const entryIds = new Set(entries.map((entry) => entry.id));
			const allowedChunks = new Set([...catalog.chunks.values()].filter((chunk) => entryIds.has(chunk.entryId)).map((chunk) => chunk.id));
			const lexical = catalog.lexical.search(query, allowedChunks, 40);
			let ranking = lexical;
			const vectorIndex = catalog.snapshot.vectorIndex;
			if (vectorIndex && this.embedding && this.vectors) {
				try {
					if (this.embedding.config.model !== vectorIndex.model) throw new Error("embedding 模型与已发布索引不一致，请重新构建向量索引。");
					const [vector] = await this.embedding.embed([query], signal);
					if (!vector || vector.length !== vectorIndex.dimensions) throw new Error("查询 embedding 维度与索引不一致。");
					const semantic = (await this.vectors.search(vectorIndex.collection, vector, [...entryIds], 40, signal)).filter((hit) => allowedChunks.has(hit.chunkId));
					ranking = reciprocalRankFusion([lexical, semantic]);
					retrievalMode = "hybrid";
				} catch (error) {
					signal?.throwIfAborted();
					const reason = error instanceof Error && /模型|维度/.test(error.message) ? error.message : "embedding 或向量服务不可用";
					warnings.push(`语义召回失败（${reason}），本次使用 BM25 词法检索，结果可能不完整。`);
				}
			} else {
				warnings.push("当前未启用语义索引或 embedding 服务，本次仅使用 BM25 词法检索。可执行 knowledge:build -- --vectors 构建混合索引。");
			}
			const seen = new Set<string>();
			for (const hit of ranking) {
				const entry = catalog.entries.get(catalog.chunks.get(hit.chunkId)!.entryId)!;
				if (seen.has(entry.id)) continue;
				seen.add(entry.id);
				evidence.push(toEvidence(entry, catalog, retrievalMode === "hybrid" ? "hybrid" : "lexical", false,
					Math.floor(24_000 / limit), catalog.chunks.get(hit.chunkId)!.text));
				if (evidence.length === limit) break;
			}
		}
		// 批量主码及别名可能命中同一条目，内容只返回一次。
		evidence = [...new Map(evidence.map((item) => [item.evidenceId, item])).values()];
		if (codes.length) {
			const budget = Math.floor(24_000 / Math.max(evidence.length, 1));
			evidence = evidence.map((item) => item.text.length > budget
				? toEvidence(catalog.entries.get(item.entryId)!, catalog, item.match, false, budget,
					matchingChunk(catalog.entries.get(item.entryId)!, catalog, query)) : item);
		}
		if (evidence.some((item) => item.truncated)) warnings.push("部分长条目为节选，条件和步骤可能不完整；请按返回页码核对原文。");
		signal?.throwIfAborted();
		return {
			status: codeLookups.some((lookup) => lookup.status === "needs_context") ? "needs_context"
				: !evidence.length ? "not_found" : codes.length ? "matched" : "candidates",
			retrievalMode, codeLookups, evidence, warnings,
		};
	}
}
