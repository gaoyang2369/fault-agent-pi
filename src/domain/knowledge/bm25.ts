import type { KnowledgeChunk, RankedChunk } from "./definition.ts";

const segmenter = new Intl.Segmenter("zh-CN", { granularity: "word" });
// 问句/连接词不能压过部件和故障现象；保留“不、无、过热”等有诊断意义的词。
const stopWords = new Set(["的", "了", "是", "有", "或", "与", "和", "在", "将", "请", "可能", "问题", "怎么", "如何", "什么", "进行", "可以"]);

/** 技术标识完整保留；中文使用 ICU 分词。入库和查询共用，避免分词配置漂移。 */
export function tokenize(text: string): string[] {
	const normalized = text.normalize("NFKC").toLowerCase();
	const identifiers = normalized.match(/[a-z][a-z0-9]*(?:[-_.][a-z0-9]+)*(?:\[\d+\])?/g) ?? [];
	const words = [...segmenter.segment(normalized.replace(/[a-z][a-z0-9]*(?:[-_.][a-z0-9]+)*(?:\[\d+\])?/g, " "))]
		.filter((part) => part.isWordLike && !stopWords.has(part.segment))
		.map((part) => part.segment);
	// ICU 会将“控制单元”拆为“控制/单元”、将“风扇”拆为单字。
	// 相邻汉字特征补回部件短语的区分能力，仍使用同一套 BM25 排名。
	const pairs = (normalized.match(/\p{Script=Han}{2,}/gu) ?? []).flatMap((run) => {
		const chars = [...run];
		return chars.slice(1).flatMap((char, index) => {
			const pair = chars[index]! + char;
			return stopWords.has(pair) || stopWords.has(chars[index]!) || stopWords.has(char) ? [] : [`zh2:${pair}`];
		});
	});
	return [...identifiers, ...words, ...pairs];
}

/** 当前规模只有几千块，内存倒排索引足够；未来可替换为后端词法检索。 */
export class Bm25Index {
	private readonly postings = new Map<string, Map<string, number>>();
	private readonly lengths = new Map<string, number>();
	private readonly averageLength: number;
	private readonly titles?: Bm25Index;

	constructor(chunks: readonly KnowledgeChunk[], titles?: ReadonlyMap<string, string>) {
		let totalLength = 0;
		for (const chunk of chunks) {
			const tokens = tokenize(chunk.text);
			this.lengths.set(chunk.id, tokens.length);
			totalLength += tokens.length;
			for (const token of tokens) {
				const posting = this.postings.get(token) ?? new Map<string, number>();
				posting.set(chunk.id, (posting.get(chunk.id) ?? 0) + 1);
				this.postings.set(token, posting);
			}
		}
		this.averageLength = totalLength / Math.max(chunks.length, 1);
		// 故障标题里的部件/现象比正文中的泛化检查项更能说明条目主题。
		if (titles) this.titles = new Bm25Index(chunks.map((chunk) => ({ ...chunk, text: titles.get(chunk.entryId) ?? "" })));
	}

	search(query: string, allowed: ReadonlySet<string>, limit: number): RankedChunk[] {
		const scores = new Map<string, number>();
		for (const token of new Set(tokenize(query))) {
			const posting = this.postings.get(token);
			if (!posting) continue;
			const idf = Math.log(1 + (this.lengths.size - posting.size + 0.5) / (posting.size + 0.5));
			for (const [id, frequency] of posting) {
				if (!allowed.has(id)) continue;
				const length = this.lengths.get(id) ?? 0;
				const normalization = 1.2 * (0.25 + 0.75 * length / Math.max(this.averageLength, 1));
				const score = idf * frequency * 2.2 / (frequency + normalization);
				scores.set(id, (scores.get(id) ?? 0) + score);
			}
		}
		for (const hit of this.titles?.search(query, allowed, allowed.size) ?? []) {
			scores.set(hit.chunkId, (scores.get(hit.chunkId) ?? 0) + 2 * hit.score);
		}
		return [...scores].map(([chunkId, score]) => ({ chunkId, score }))
			.sort((a, b) => b.score - a.score || a.chunkId.localeCompare(b.chunkId))
			.slice(0, limit);
	}
}

/** 分数只用于排名，不表示故障概率。每路列表中的重复项只计一次。 */
export function reciprocalRankFusion(rankings: readonly RankedChunk[][]): RankedChunk[] {
	const scores = new Map<string, number>();
	for (const ranking of rankings) {
		const seen = new Set<string>();
		ranking.forEach(({ chunkId }, rank) => {
			if (seen.has(chunkId)) return;
			seen.add(chunkId);
			scores.set(chunkId, (scores.get(chunkId) ?? 0) + 1 / (60 + rank + 1));
		});
	}
	return [...scores].map(([chunkId, score]) => ({ chunkId, score }))
		.sort((a, b) => b.score - a.score || a.chunkId.localeCompare(b.chunkId));
}
