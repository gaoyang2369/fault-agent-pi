import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { EmbeddingClient } from "../src/services/embedding-client.ts";
import { KnowledgeVectorRepository } from "../src/repositories/knowledge-vector-repository.ts";

test("embedding 响应按 index 排序，校验数量、维度、零向量和错误码", async (t) => {
	let response: unknown = { data: [{ index: 1, embedding: [3, 4] }, { index: 0, embedding: [1, 2] }] };
	let status = 200;
	const server = createServer(async (request, reply) => {
		assert.equal(request.url, "/v1/embeddings");
		assert.equal(request.headers.authorization, "Bearer test-token");
		const chunks = [];
		for await (const chunk of request) chunks.push(chunk as Buffer);
		assert.equal(JSON.parse(Buffer.concat(chunks).toString()).model, "test-model");
		reply.writeHead(status, { "Content-Type": "application/json" });
		reply.end(JSON.stringify(response));
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	t.after(() => { server.closeAllConnections(); server.close(); });
	const address = server.address() as { port: number };
	const client = new EmbeddingClient({ baseUrl: `http://127.0.0.1:${address.port}/v1/`, model: "test-model", apiKey: "test-token" });
	assert.deepEqual(await client.embed(["a", "b"]), [[1, 2], [3, 4]]);
	response = { data: [{ index: 0, embedding: [1, 2] }] };
	await assert.rejects(client.embed(["a", "b"]), /数量/);
	response = { data: [{ index: 0, embedding: [0, 0] }] };
	await assert.rejects(client.embed(["a"]), /无效向量/);
	response = { data: [{ index: 0, embedding: [1] }, { index: 1, embedding: [1, 2] }] };
	await assert.rejects(client.embed(["a", "b"]), /维度/);
	status = 401;
	response = { secret: "must not be echoed" };
	await assert.rejects(client.embed(["a"]), (error: unknown) => error instanceof Error && error.message.includes("HTTP 401") && !error.message.includes("secret"));
});

test("向量请求接收工具取消信号，不等待服务超时", async (t) => {
	const controller = new AbortController();
	const server = createServer((request) => {
		assert.equal(new URL(request.url!, "http://localhost").pathname, "/collections/fixture/points/query");
		controller.abort();
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	t.after(() => { server.closeAllConnections(); server.close(); });
	const repository = new KnowledgeVectorRepository({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}` });
	await assert.rejects(repository.search("fixture", [1, 0], ["entry"], 5, controller.signal), { name: "AbortError" });
});

test("embedding 瞬时断连有限重试，恢复后按正常结果返回", async (t) => {
	let calls = 0;
	const server = createServer((request, response) => {
		calls++;
		if (calls === 1) { request.socket.destroy(); return; }
		response.writeHead(200, { "Content-Type": "application/json" });
		response.end(JSON.stringify({ data: [{ index: 0, embedding: [1, 2] }] }));
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	t.after(() => { server.closeAllConnections(); server.close(); });
	const client = new EmbeddingClient({ baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, model: "test" });
	assert.deepEqual(await client.embed(["query"]), [[1, 2]]);
	assert.equal(calls, 2);
});
