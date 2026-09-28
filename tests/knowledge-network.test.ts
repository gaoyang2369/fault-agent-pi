import assert from "node:assert/strict";
import test from "node:test";
import { retryNetworkRequest } from "../src/services/network-retry.ts";

test("网络重试最多三次；普通 HTTP 错误及超时不会重试", async () => {
	let calls = 0;
	await assert.rejects(retryNetworkRequest(async () => { calls++; throw new TypeError("fetch failed"); }), /fetch failed/);
	assert.equal(calls, 3);
	for (const error of [new Error("HTTP 401"), new DOMException("timeout", "TimeoutError")]) {
		calls = 0;
		await assert.rejects(retryNetworkRequest(async () => { calls++; throw error; }), (actual) => actual === error);
		assert.equal(calls, 1);
	}
});

test("取消在重试等待期间立即终止，不发起下一次请求", async () => {
	const controller = new AbortController();
	let calls = 0;
	const pending = retryNetworkRequest(async () => {
		calls++;
		setTimeout(() => controller.abort(), 10);
		throw new TypeError("fetch failed");
	}, controller.signal);
	await assert.rejects(pending, { name: "AbortError" });
	assert.equal(calls, 1);
});
