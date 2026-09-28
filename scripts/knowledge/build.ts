import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { parseArgs, promisify } from "node:util";
import { QdrantClient } from "@qdrant/js-client-rest";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { resolveKnowledgeConfig } from "../../src/config.ts";
import { knowledgeSourceSchema, type KnowledgeSnapshot } from "../../src/domain/knowledge/definition.ts";
import { validateSnapshot } from "../../src/repositories/knowledge-repository.ts";
import { EmbeddingClient } from "../../src/services/embedding-client.ts";
import { retryNetworkRequest } from "../../src/services/network-retry.ts";
import { createChunks, parseFaultManual, parseMarkdown } from "./parse.ts";

const run = promisify(execFile);

/** 所有写入业务都在独立脚本中；未来后端 worker 可直接迁移此流程。 */
async function main() {
	const { values } = parseArgs({ options: {
		sources: { type: "string", default: "knowledge/sources.json" },
		output: { type: "string" },
		vectors: { type: "boolean", default: false },
	} });
	const config = resolveKnowledgeConfig();
	if (values.vectors && !config.embedding) throw new Error("构建向量索引需要 KNOWLEDGE_EMBEDDING_BASE_URL（例如 http://127.0.0.1:11434/v1）。");
	const sources: unknown = JSON.parse(await readFile(resolve(values.sources), "utf8"));
	if (!Value.Check(Type.Array(knowledgeSourceSchema, { minItems: 1 }), sources)) throw new Error("sources.json 格式错误，请参考 knowledge/sources.json。");
	if (new Set(sources.map((source) => source.id)).size !== sources.length) throw new Error("sources.json 的文档 ID 不能重复。");
	const snapshot: KnowledgeSnapshot = { schemaVersion: 1, builtAt: new Date().toISOString(), documents: [], entries: [], chunks: [] };
	for (const source of sources) {
		const filename = resolve(source.file);
		const content = await readFile(filename);
		const document = { ...source, contentHash: createHash("sha256").update(content).digest("hex") };
		let entries;
		if (extname(filename).toLowerCase() === ".pdf" && source.sourceType === "fault_manual") {
			let text;
			try {
				text = (await run("pdftotext", ["-layout", "-enc", "UTF-8", filename, "-"], { maxBuffer: 64 * 1024 * 1024 })).stdout;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("缺少 pdftotext，请安装 poppler-utils。当前手册具有文本层，无需额外 OCR 模型。");
				throw error;
			}
			entries = parseFaultManual(text, document);
		} else if ([".md", ".markdown"].includes(extname(filename).toLowerCase()) && source.sourceType !== "fault_manual") {
			entries = parseMarkdown(content.toString("utf8"), document);
		} else {
			throw new Error(`${source.file} 类型不受支持：故障手册使用此格式的文本 PDF，指南/案例/FAQ 使用 Markdown。`);
		}
		snapshot.documents.push(document);
		snapshot.entries.push(...entries);
		process.stdout.write(`[解析] ${source.title}：${entries.length} 条；${new Set(entries.flatMap((entry) => entry.primaryFaultCode ?? [])).size} 个主故障码\n`);
	}
	snapshot.chunks = createChunks(snapshot.entries, snapshot.documents);
	validateSnapshot(snapshot);
	const output = resolve(values.output ?? config.snapshotPath);
	await mkdir(dirname(output), { recursive: true });
	const temporary = `${output}.${randomUUID()}.tmp`;
	let client: QdrantClient | undefined;
	let collection: string | undefined;
	try {
		if (values.vectors) {
			const embedding = new EmbeddingClient(config.embedding!);
			client = new QdrantClient({ ...config.qdrant, timeout: 30_000, checkCompatibility: false });
			const [first] = await embedding.embed([snapshot.chunks[0]!.text]);
			const dimensions = first!.length;
			collection = `pi_learning_knowledge_${randomUUID().replaceAll("-", "")}`;
			await client.createCollection(collection, { vectors: { size: dimensions, distance: "Cosine" } });
			await client.createPayloadIndex(collection, { field_name: "entry_id", field_schema: "keyword", wait: true });
			const entries = new Map(snapshot.entries.map((entry) => [entry.id, entry]));
			const documents = new Map(snapshot.documents.map((document) => [document.id, document]));
			// 小批量兼顾本地 CPU embedding 和外部接口的输入限制。
			for (let offset = 0; offset < snapshot.chunks.length; offset += 8) {
				const batch = snapshot.chunks.slice(offset, offset + 8);
				let vectors;
				try {
					vectors = offset === 0
						? [first!, ...await embedding.embed(batch.slice(1).map((chunk) => chunk.text))]
						: await embedding.embed(batch.map((chunk) => chunk.text));
				} catch (error) {
					throw new Error(`第 ${offset + 1}–${offset + batch.length} 块 embedding 失败：${error instanceof Error ? error.message : String(error)}`);
				}
				if (vectors.some((vector) => vector.length !== dimensions)) throw new Error("入库过程中 embedding 维度改变，未发布新索引。");
				const points = batch.map((chunk, index) => {
					const entry = entries.get(chunk.entryId)!;
					const document = documents.get(entry.documentId)!;
					return { id: chunk.id, vector: vectors[index]!, payload: {
						entry_id: entry.id, document_id: document.id, content_hash: document.contentHash,
						fault_codes: entry.faultCodes, applicable_products: document.applicableProducts,
						source_type: document.sourceType,
					} };
				});
				try {
					// 固定 point ID 的 upsert 可安全重放，即使首次请求已写入但响应丢失。
					await retryNetworkRequest(() => client!.upsert(collection!, { wait: true, points }));
				} catch (error) {
					throw new Error(`第 ${offset + 1}–${offset + batch.length} 块 Qdrant 写入失败：${error instanceof Error ? error.message : String(error)}`);
				}
				if (offset % 80 === 0 || offset + batch.length === snapshot.chunks.length) process.stdout.write(`[向量] ${offset + batch.length}/${snapshot.chunks.length}\n`);
			}
			const count = await retryNetworkRequest(() => client!.count(collection!, { exact: true }));
			if (count.count !== snapshot.chunks.length) throw new Error("Qdrant 写入数量校验失败，未发布新索引。");
			snapshot.vectorIndex = { collection, model: config.embedding!.model, dimensions };
		}
		validateSnapshot(snapshot);
		await writeFile(temporary, `${JSON.stringify(snapshot)}\n`, "utf8");
		await rename(temporary, output);
	} catch (error) {
		if (client && collection) await retryNetworkRequest(() => client!.deleteCollection(collection!)).catch(() => undefined);
		throw error;
	} finally {
		await rm(temporary, { force: true });
	}
	process.stdout.write(`[发布] ${snapshot.entries.length} 条、${snapshot.chunks.length} 块 → ${output}\n检索模式：${snapshot.vectorIndex ? "精确查码 + BM25/dense 混合检索" : "精确查码 + BM25（尚未构建语义索引）"}\n`);
}

main().catch((error: unknown) => {
	process.stderr.write(`入库失败：${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
});
