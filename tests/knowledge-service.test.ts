import assert from "node:assert/strict";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Bm25Index, reciprocalRankFusion, tokenize } from "../src/domain/knowledge/bm25.ts";
import { extractFaultCodes, type KnowledgeSnapshot } from "../src/domain/knowledge/definition.ts";
import { KnowledgeRepository } from "../src/repositories/knowledge-repository.ts";
import { KnowledgeService } from "../src/services/knowledge-service.ts";
import { createSearchKnowledgeTool, formatKnowledgeResult } from "../src/tools/search-knowledge.ts";

function fixture(): KnowledgeSnapshot {
	const document = { id: "manual", file: "manual.pdf", title: "手册", version: "v1", documentNumber: "M1", manufacturer: "Siemens", language: "zh-CN", sourceType: "fault_manual" as const, declaredProducts: ["S120"], applicableProducts: ["G120"], applicabilityNote: "项目登记", contentHash: "hash" };
	return {
		schemaVersion: 1, builtAt: "fixture", documents: [document, { ...document, id: "other", applicableProducts: ["S150"] }],
		entries: [
			{ id: "heat", documentId: "manual", title: "控制单元过热", primaryFaultCode: "A01009", faultCodes: ["A01009", "N01009"], fields: { "原因": "控制单元温度高", "处理": "检查风扇与送风", "驱动对象": "所有目标" }, text: "A01009 控制单元过热\n原因：控制单元温度高\n处理：检查风扇与送风", pdfPages: [4], printedPages: ["2491"] },
			...(["SERVO", "VECTOR"] as const).map((object) => ({ id: object.toLowerCase(), documentId: "manual", title: "重新上电", primaryFaultCode: "F01040", faultCodes: ["F01040"], fields: { "驱动对象": object }, text: `F01040 ${object} 重新上电`, pdfPages: [11], printedPages: ["2498"] })),
			{ id: "wrong-product", documentId: "other", title: "另一产品", primaryFaultCode: "A01009", faultCodes: ["A01009"], fields: {}, text: "另一产品的风扇", pdfPages: [2], printedPages: ["2"] },
		],
		chunks: [{ id: "heat-chunk", entryId: "heat", text: "控制单元过热 温度高 检查风扇与送风" }, { id: "other-chunk", entryId: "wrong-product", text: "另一产品的风扇" }],
	};
}

async function setup(t: { after(fn: () => Promise<void>): void }, snapshot = fixture()) {
	const directory = await mkdtemp(join(tmpdir(), "pi-knowledge-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const filename = join(directory, "snapshot.json");
	await writeFile(filename, JSON.stringify(snapshot));
	return { repository: new KnowledgeRepository(filename), filename, directory };
}

test("主故障码自动规范化，拒绝缺位或混淆字母", () => {
	assert.deepEqual(extractFaultCodes("ａ０１００９、F01011 和 N01004"), ["A01009", "F01011", "N01004"]);
	assert.deepEqual(extractFaultCodes("XA01009 F010110 F0101 F01O11"), []);
});

test("精确查询不调用语义服务，产品过滤和双页码进入模型正文", async (t) => {
	const { repository } = await setup(t);
	const service = new KnowledgeService(repository, { config: { baseUrl: "http://unused", model: "unused" }, embed: async () => { throw new Error("不能调用 embedding"); } });
	const result = await service.search({ query: "a01009 原因", device: "g120_01" });
	assert.equal(result.status, "matched");
	assert.equal(result.retrievalMode, "exact");
	assert.deepEqual(result.evidence.map((item) => item.entryId), ["heat"]);
	const text = formatKnowledgeResult(result);
	assert.match(text, /PDF 页码：4；印刷页码：2491/);
	assert.match(text, /检查风扇与送风/);
	assert.match(text, /K-heat/);
});

test("同码变体要求上下文，已知驱动对象可收敛为唯一条目", async (t) => {
	const { repository } = await setup(t);
	const service = new KnowledgeService(repository);
	const ambiguous = await service.search({ query: "F01040", device: "g120_01" });
	assert.equal(ambiguous.status, "needs_context");
	assert.equal(ambiguous.codeLookups[0]!.candidateCount, 2);
	const result = await service.search({ query: "F01040", driveObject: "vector", device: "g120_01" });
	assert.deepEqual(result.evidence.map((item) => item.entryId), ["vector"]);
	assert.equal(result.status, "matched");
});

test("超长精确条目保留查询命中的子条件，并明确标记节选", async (t) => {
	const snapshot = fixture();
	const entry = snapshot.entries[0]!;
	entry.fields["原因"] = `${"其他条件。".repeat(2500)}\n故障值 123456：通讯电缆断开。`;
	entry.text = `A01009 控制单元过热\n原因：${entry.fields["原因"]}\n处理：检查风扇与送风`;
	snapshot.chunks.push({ id: "condition-chunk", entryId: entry.id, text: "A01009 故障值 123456：通讯电缆断开。" });
	const { repository } = await setup(t, snapshot);
	const result = await new KnowledgeService(repository).search({ query: "A01009 故障值123456", device: "g120_01" });
	assert.equal(result.evidence[0]!.truncated, true);
	assert.match(result.evidence[0]!.text, /123456：通讯电缆断开/);
	assert.match(result.evidence[0]!.text, /检查风扇与送风/);
	assert.ok(result.evidence[0]!.text.length <= 8000);
});

test("批量多变体查码的证据正文不超过总预算", async (t) => {
	const snapshot = fixture();
	const template = snapshot.entries[0]!;
	const codes = ["F00001", "F00002", "F00003", "F00004", "F00005"];
	snapshot.entries = codes.flatMap((code) => Array.from({ length: 6 }, (_, variant) => ({
		...template, id: `${code}-${variant}`, primaryFaultCode: code, faultCodes: [code],
		fields: { "原因": "条件".repeat(1000), "处理": "检查".repeat(1000), "驱动对象": `OBJECT_${variant}` },
		text: `${code} ${"条件".repeat(2000)}`,
	})));
	snapshot.chunks = snapshot.entries.map((entry) => ({ id: `${entry.id}-chunk`, entryId: entry.id, text: `${entry.primaryFaultCode} ${"条件".repeat(500)}` }));
	const { repository } = await setup(t, snapshot);
	const result = await new KnowledgeService(repository).search({ query: codes.join("、"), device: "g120_01" });
	assert.equal(result.evidence.length, 30);
	assert.ok(result.evidence.reduce((sum, item) => sum + item.text.length, 0) <= 24_000);
	assert.ok(result.evidence.every((item) => item.truncated));
});

test("明确类别切换码可以查到主条目，未知码不以相近码替代", async (t) => {
	const { repository } = await setup(t);
	const service = new KnowledgeService(repository);
	const result = await service.search({ query: "N01009 和 A99999", device: "g120_01" });
	assert.equal(result.evidence[0]!.match, "category_alias");
	assert.deepEqual(result.codeLookups.map((lookup) => lookup.status), ["matched", "not_found"]);
	assert.equal((await service.search({ query: "A01008", device: "g120_01" })).evidence.length, 0);
});

test("服务层也验证参数，不允许冲突型号和非法故障码", async (t) => {
	const { repository } = await setup(t);
	const service = new KnowledgeService(repository);
	await assert.rejects(service.search({ query: " ", device: "g120_01" }), /query/);
	await assert.rejects(service.search({ query: "风扇", device: "g120_01", productFamily: "S150" }), /不一致/);
	await assert.rejects(service.search({ query: "风扇", faultCodes: ["A1009"] }), /故障码格式/);
	await assert.rejects(service.search({ query: "F01O11 是什么意思" }), /请核对故障码/);
	await assert.rejects(service.search({ query: "F010110 是什么意思" }), /请核对故障码/);
	await assert.rejects(service.search({ query: "风扇", limit: 50 }), /limit/);
});

test("混合召回只融合已发布且适用的块，同父条目只返回一次", async (t) => {
	const snapshot = fixture();
	snapshot.vectorIndex = { collection: "fixture", model: "embed", dimensions: 2 };
	const { repository } = await setup(t, snapshot);
	const service = new KnowledgeService(repository,
		{ config: { baseUrl: "http://unused", model: "embed" }, embed: async () => [[1, 2]] },
		{ search: async (_collection, vector, allowed) => {
			assert.deepEqual(vector, [1, 2]);
			assert.ok(!allowed.includes("wrong-product"));
			return [{ chunkId: "other-chunk", score: 100 }, { chunkId: "stale-chunk", score: 100 }, { chunkId: "heat-chunk", score: 1 }];
		} });
	const result = await service.search({ query: "风扇", device: "g120_01" });
	assert.equal(result.status, "candidates");
	assert.equal(result.retrievalMode, "hybrid");
	assert.deepEqual(result.evidence.map((item) => item.entryId), ["heat"]);
});

test("服务故障或模型改变时明确降级，取消不被伪装成降级", async (t) => {
	const snapshot = fixture();
	snapshot.vectorIndex = { collection: "fixture", model: "embed", dimensions: 2 };
	const { repository } = await setup(t, snapshot);
	const broken = new KnowledgeService(repository,
		{ config: { baseUrl: "http://unused", model: "embed" }, embed: async () => { throw new Error("secret service error"); } },
		{ search: async () => [] });
	const result = await broken.search({ query: "风扇", device: "g120_01" });
	assert.equal(result.retrievalMode, "lexical");
	assert.ok(result.warnings.some((warning) => warning.includes("语义召回失败")));
	assert.ok(!result.warnings.join().includes("secret"));
	const changedModel = new KnowledgeService(repository,
		{ config: { baseUrl: "http://unused", model: "new-model" }, embed: async () => { throw new Error("模型不一致时不能调用 embedding"); } },
		{ search: async () => [] });
	assert.ok((await changedModel.search({ query: "风扇", device: "g120_01" })).warnings.some((warning) => warning.includes("模型与已发布索引不一致")));
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(broken.search({ query: "风扇" }, controller.signal), { name: "AbortError" });
});

test("快照原子替换后更新缓存，损坏的关联不会进入检索", async (t) => {
	const { repository, filename } = await setup(t);
	assert.equal((await repository.load()).snapshot.documents[0]!.version, "v1");
	const updated = fixture();
	updated.documents[0]!.version = "v2";
	await writeFile(`${filename}.tmp`, JSON.stringify(updated));
	await rename(`${filename}.tmp`, filename);
	assert.equal((await repository.load()).snapshot.documents[0]!.version, "v2");
	updated.chunks[0]!.entryId = "missing";
	await writeFile(`${filename}.tmp`, JSON.stringify(updated));
	await rename(`${filename}.tmp`, filename);
	await assert.rejects(repository.load(), /失效关联/);
});

test("中文词法检索保留参数/故障码，无词命中不返回凑数证据", () => {
	const tokens = tokenize("检查 DRIVE-CLiQ 和 r0037[0]，故障 A01009");
	assert.ok(tokens.includes("drive-cliq"));
	assert.ok(tokens.includes("r0037[0]"));
	assert.ok(tokens.includes("a01009"));
	const index = new Bm25Index(fixture().chunks);
	assert.deepEqual(index.search("火星天气", new Set(["heat-chunk"]), 5), []);
	assert.deepEqual(reciprocalRankFusion([[{ chunkId: "a", score: 1 }, { chunkId: "b", score: 2 }], [{ chunkId: "b", score: 500 }]]).map((hit) => hit.chunkId), ["b", "a"]);
});

test("现象检索区分控制单元和功率单元，不让通用风扇检查淹没部件主题", async (t) => {
	const snapshot = fixture();
	for (const [index, title] of ["功率单元内部空间过热", "功率单元风扇损坏", "功率单元电容器出风口过热"].entries()) {
		const id = `power-${index}`;
		const text = `${title}。功率单元发热时，检查通风情况及风扇，可能有散热问题。`;
		snapshot.entries.push({ ...snapshot.entries[0]!, id, title, primaryFaultCode: `F3000${index}`, faultCodes: [`F3000${index}`], text });
		snapshot.chunks.push({ id: `${id}-chunk`, entryId: id, text });
	}
	const { repository } = await setup(t, snapshot);
	const result = await new KnowledgeService(repository).search({ query: "控制单元发热，风扇或通风可能有问题", device: "g120_01" });
	assert.equal(result.evidence[0]!.primaryFaultCode, "A01009");
});

test("工具暴露给模型的正文包含证据，未构建属于执行失败", async (t) => {
	const { repository, directory } = await setup(t);
	const tool = createSearchKnowledgeTool(new KnowledgeService(repository));
	assert.equal(tool.name, "search_knowledge");
	const result = await tool.execute("tool-1", { query: "A01009", device: "g120_01" }, undefined, undefined, {} as never);
	assert.equal(result.content[0]!.type, "text");
	assert.match((result.content[0] as { text: string }).text, /检查风扇/);
	const missing = createSearchKnowledgeTool(new KnowledgeService(new KnowledgeRepository(join(directory, "missing.json"))));
	await assert.rejects(missing.execute("tool-2", { query: "A01009" }, undefined, undefined, {} as never), /尚未构建/);
});
