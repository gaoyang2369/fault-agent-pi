import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { QdrantClient } from "@qdrant/js-client-rest";
import { KnowledgeRepository } from "../src/repositories/knowledge-repository.ts";
import { KnowledgeVectorRepository } from "../src/repositories/knowledge-vector-repository.ts";
import { EmbeddingClient } from "../src/services/embedding-client.ts";
import { KnowledgeService } from "../src/services/knowledge-service.ts";

const run = promisify(execFile);
const qdrantUrl = process.env.KNOWLEDGE_TEST_QDRANT_URL;

test("真实 Qdrant：断连重放、脚本发布、适用性过滤及失败恢复", { skip: !qdrantUrl }, async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pi-knowledge-integration-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	let calls = 0;
	let failAfter = Infinity;
	const server = createServer(async (request, response) => {
		calls++;
		if (calls >= failAfter) { response.writeHead(503); response.end("unavailable"); return; }
		const parts: Buffer[] = [];
		for await (const part of request) parts.push(part as Buffer);
		const body = JSON.parse(Buffer.concat(parts).toString()) as { input: string[] };
		response.writeHead(200, { "Content-Type": "application/json" });
		response.end(JSON.stringify({ data: body.input.map((_text, index) => ({ index, embedding: [1, 0, 0] })) }));
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	t.after(() => { server.closeAllConnections(); server.close(); });
	const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
	// 模拟 Qdrant 已完成写入、客户端却未收到响应；重放不能增加重复 point。
	let lostWriteResponses = 0;
	const proxy = createServer(async (request, response) => {
		const parts: Buffer[] = [];
		for await (const part of request) parts.push(part as Buffer);
		const body = Buffer.concat(parts);
		const upstream = await fetch(`${qdrantUrl}${request.url}`, {
			method: request.method,
			headers: { "Content-Type": "application/json" },
			...(body.length ? { body } : {}),
		});
		const result = Buffer.from(await upstream.arrayBuffer());
		if (request.method === "PUT" && request.url?.includes("/points?") && !lostWriteResponses) {
			lostWriteResponses++;
			request.socket.destroy();
			return;
		}
		response.writeHead(upstream.status, { "Content-Type": "application/json" });
		response.end(result);
	});
	proxy.listen(0, "127.0.0.1");
	await once(proxy, "listening");
	t.after(() => { proxy.closeAllConnections(); proxy.close(); });
	const proxyUrl = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
	const sourceBase = { version: "v1", documentNumber: "", manufacturer: "Siemens", language: "zh-CN", sourceType: "maintenance_guide", declaredProducts: ["G120"], applicabilityNote: "" };
	await writeFile(join(directory, "guide.md"), "# 控制单元散热\n检查风扇和送风。\n# 电缆\n检查通讯电缆。");
	await writeFile(join(directory, "other.md"), "# 不适用的指南\n另一产品的风扇。");
	const sources = join(directory, "sources.json");
	await writeFile(sources, JSON.stringify([
		{ ...sourceBase, id: "guide", file: join(directory, "guide.md"), title: "G120 指南", applicableProducts: ["G120"] },
		{ ...sourceBase, id: "other", file: join(directory, "other.md"), title: "其他指南", applicableProducts: ["S150"] },
	]));
	const filename = join(directory, "snapshot.json");
	const command = [resolve("node_modules/tsx/dist/cli.mjs"), resolve("scripts/knowledge/build.ts"), "--sources", sources, "--output", filename, "--vectors"];
	const env = { ...process.env, KNOWLEDGE_EMBEDDING_BASE_URL: baseUrl, KNOWLEDGE_EMBEDDING_MODEL: "fixture", KNOWLEDGE_EMBEDDING_API_KEY: "", KNOWLEDGE_QDRANT_URL: proxyUrl, KNOWLEDGE_QDRANT_API_KEY: "" };
	await run(process.execPath, command, { env });
	assert.equal(lostWriteResponses, 1);
	const repository = new KnowledgeRepository(filename);
	const published = (await repository.load()).snapshot;
	assert.ok(published.vectorIndex);
	const client = new QdrantClient({ url: qdrantUrl, checkCompatibility: false });
	t.after(() => client.deleteCollection(published.vectorIndex!.collection));
	assert.equal((await client.count(published.vectorIndex.collection, { exact: true })).count, 3);
	const service = new KnowledgeService(repository, new EmbeddingClient({ baseUrl, model: "fixture" }), new KnowledgeVectorRepository({ url: qdrantUrl! }));
	const result = await service.search({ query: "热量排不出去", device: "g120_01" });
	assert.equal(result.retrievalMode, "hybrid");
	assert.ok(result.evidence.length > 0);
	assert.ok(result.evidence.every((item) => item.source.id === "guide"));
	const oldSnapshot = await readFile(filename, "utf8");
	const oldCollections = (await client.getCollections()).collections.map((collection) => collection.name).sort();
	calls = 0;
	failAfter = 2; // 第一次 embedding 成功且创建了 collection，后续批次失败。
	await assert.rejects(run(process.execPath, command, { env }), /入库失败/);
	assert.equal(await readFile(filename, "utf8"), oldSnapshot);
	assert.deepEqual((await client.getCollections()).collections.map((collection) => collection.name).sort(), oldCollections);
});
