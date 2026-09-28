import { readFile, stat } from "node:fs/promises";
import { Value } from "typebox/value";
import { Bm25Index } from "../domain/knowledge/bm25.ts";
import { knowledgeSnapshotSchema, type KnowledgeSnapshot } from "../domain/knowledge/definition.ts";

export function validateSnapshot(value: unknown): asserts value is KnowledgeSnapshot {
	if (!Value.Check(knowledgeSnapshotSchema, value)) throw new Error("知识快照格式无效，请重新执行 knowledge:build。");
	const documents = new Set(value.documents.map((document) => document.id));
	const entries = new Set(value.entries.map((entry) => entry.id));
	const chunks = new Set(value.chunks.map((chunk) => chunk.id));
	if (documents.size !== value.documents.length || entries.size !== value.entries.length || chunks.size !== value.chunks.length ||
		value.entries.some((entry) => !documents.has(entry.documentId)) || value.chunks.some((chunk) => !entries.has(chunk.entryId))) {
		throw new Error("知识快照存在重复 ID 或失效关联，请重新入库。");
	}
}

function prepare(snapshot: KnowledgeSnapshot) {
	return {
		snapshot,
		documents: new Map(snapshot.documents.map((document) => [document.id, document])),
		entries: new Map(snapshot.entries.map((entry) => [entry.id, entry])),
		chunks: new Map(snapshot.chunks.map((chunk) => [chunk.id, chunk])),
		lexical: new Bm25Index(snapshot.chunks, new Map(snapshot.entries.map((entry) => [entry.id, entry.title]))),
	};
}
export type KnowledgeCatalog = ReturnType<typeof prepare>;

/** 只读、懒加载；检测原子替换后的 inode/mtime，正在查询的请求继续使用旧快照。 */
export class KnowledgeRepository {
	private cache?: { revision: string; catalog: KnowledgeCatalog };

	constructor(private readonly filename: string) {}

	async load(): Promise<KnowledgeCatalog> {
		let info;
		try { info = await stat(this.filename); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("知识库尚未构建，请先执行 npm run knowledge:build。");
			throw error;
		}
		const revision = `${info.ino}:${info.mtimeMs}:${info.size}`;
		if (this.cache?.revision === revision) return this.cache.catalog;
		const snapshot: unknown = JSON.parse(await readFile(this.filename, "utf8"));
		validateSnapshot(snapshot);
		const catalog = prepare(snapshot);
		this.cache = { revision, catalog };
		return catalog;
	}
}
