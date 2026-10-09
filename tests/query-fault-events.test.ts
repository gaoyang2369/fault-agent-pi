import assert from "node:assert/strict";
import test from "node:test";
import { Check } from "typebox/value";
import { DatasetStore } from "../src/domain/dataset/store.ts";
import type { FaultEventResult } from "../src/domain/diagnosis/definition.ts";
import type { FaultRecordQuery, FaultRecordReadOptions, RawFaultRecord } from "../src/repositories/telemetry-repository.ts";
import { FaultEventService, type FaultEventDataset, type FaultEventSource, type FaultEventQuery } from "../src/services/fault-event-service.ts";
import { createCustomTools } from "../src/tools/index.ts";
import { createQueryFaultEventsTool, formatFaultEventResult, queryFaultEventsParameters, type QueryFaultEventsParams } from "../src/tools/query-fault-events.ts";

const period = { startTime: "2026-09-14 10:00:00", endTime: "2026-09-14 11:00:00" };
function row(id: number, seconds: number, faultCode: string | null = "0", alarmCode: string | null = "0"): RawFaultRecord {
	const date = new Date("2026-09-14T10:00:00Z");
	date.setUTCSeconds(seconds);
	return { id: String(id), timestamp: date.toISOString().slice(0, 19).replace("T", " "), faultCode, alarmCode };
}

class Source implements FaultEventSource {
	readonly windows: FaultRecordQuery[] = [];
	readonly latestCalls: { table: string; options?: FaultRecordReadOptions }[] = [];
	constructor(readonly records: RawFaultRecord[], readonly latest = records.at(-1)?.timestamp) {}
	async latestTimestamp(table: string, options?: FaultRecordReadOptions) {
		this.latestCalls.push({ table, options });
		return this.latest;
	}
	async *iterateFaultRecords(request: FaultRecordQuery) {
		this.windows.push(request);
		for (const record of this.records) if (record.timestamp >= request.startTime && record.timestamp <= request.endTime) yield record;
	}
}

function setup(records: RawFaultRecord[] = [], latest?: string) {
	const source = new Source(records, latest);
	const datasets = new DatasetStore<FaultEventDataset>();
	const service = new FaultEventService(source, datasets);
	return { source, datasets, service, tool: createQueryFaultEventsTool(service) };
}

async function execute(tool: ReturnType<typeof createQueryFaultEventsTool>, params: QueryFaultEventsParams, signal?: AbortSignal) {
	return tool.execute("test-call", params, signal, undefined, {} as never);
}

test("工具 schema 仅提供设备、时间两端和 limit，约束设备白名单、格式和整数范围", () => {
	assert.deepEqual(Object.keys(queryFaultEventsParameters.properties), ["device", "startTime", "endTime", "limit"]);
	assert.deepEqual(queryFaultEventsParameters.required, ["device"]);
	for (const params of [{ device: "g120_01" }, { device: "g120_02", ...period, limit: 100 }]) assert.equal(Check(queryFaultEventsParameters, params), true);
	for (const params of [
		{}, { device: "real_data_04" }, { device: "电机1" }, { device: "g120_01", limit: 0 },
		{ device: "g120_01", limit: 101 }, { device: "g120_01", limit: 1.5 },
		{ device: "g120_01", startTime: "2026-09-14T10:00:00Z" },
	]) assert.equal(Check(queryFaultEventsParameters, params), false);
});

test("直接执行工具即可识别事件，中文正文和 details 包含编码、缺口、未知值与观测依据", async () => {
	const state = setup([
		row(1, 0, "F30899", "A07089"), row(2, 4, "F30899"), row(3, 20, "F30899", null),
		row(4, 24, "F3O899"), row(5, 28, "0", "N01011"),
	]);
	const result = await execute(state.tool, { device: "g120_01", ...period });
	assert.equal(state.tool.name, "query_fault_events");
	assert.equal(result.content[0]!.type, "text");
	const text = (result.content[0] as { text: string }).text;
	for (const expected of ["G120电机1", period.startTime, period.endTime, "F30899", "A07089", "N01011", "evt-001", "观测 2 次", "断档共 1 处", "F3O899", "原值 null", "事件列表截断：否"]) assert.ok(text.includes(expected), expected);
	const details = result.details as FaultEventResult;
	assert.equal(details.rowCount, 5);
	assert.equal(details.eventCount, 4);
	assert.equal(details.unknownValues.length, 2);
	const { datasetId, ...snapshot } = details;
	assert.deepEqual(state.datasets.get(datasetId), snapshot);
	assert.equal(state.source.latestCalls.length, 0);
});

test("limit 映射为 maxEvents，列表截断后仍保留整个窗口的事件总数", async () => {
	const state = setup([row(1, 0, "F30899"), row(2, 4), row(3, 8, "0", "A07089"), row(4, 12)]);
	const result = await execute(state.tool, { device: "g120_01", ...period, limit: 1 });
	const details = result.details as FaultEventResult;
	assert.equal(details.rowCount, 4);
	assert.equal(details.eventCount, 2);
	assert.equal(details.events.length, 1);
	assert.equal(details.eventsTruncated, true);
	const text = (result.content[0] as { text: string }).text;
	assert.match(text, /事件列表截断：是/);
	assert.match(text, /报警码：未在返回列表中观测到/);
	assert.match(text, /不能据此排除未返回事件中的其他故障码或报警码/);
});

test("适配层传递时间、默认数量和原始取消信号，不解析业务窗口", async () => {
	const snapshot = await setup().service.query({ device: "g120_01", ...period });
	const calls: { request: FaultEventQuery; options?: FaultRecordReadOptions }[] = [];
	const tool = createQueryFaultEventsTool({ query: async (request, options) => { calls.push({ request, options }); return snapshot; } });
	const controller = new AbortController();
	await execute(tool, { device: "g120_01" }, controller.signal);
	assert.deepEqual(calls[0], { request: { device: "g120_01", maxEvents: 20 }, options: { signal: controller.signal } });
	await execute(tool, { device: "g120_01", ...period, limit: 7 });
	assert.deepEqual(calls[1]!.request, { device: "g120_01", ...period, maxEvents: 7 });
});

test("省略两端时使用历史最新采样的前一小时，与机器当前时间无关", async () => {
	const state = setup([row(1, 0, "F30899"), row(2, 4)]);
	const result = await execute(state.tool, { device: "g120_01" });
	assert.deepEqual((result.details as FaultEventResult).period, { startTime: "2026-09-14 09:00:04", endTime: "2026-09-14 10:00:04" });
	assert.deepEqual(state.source.windows[0], { table: "real_data_01", startTime: "2026-09-14 09:00:04", endTime: "2026-09-14 10:00:04" });
	assert.equal(state.source.latestCalls[0]!.table, "real_data_01");
});

test("默认窗口正确跨越日期与月份边界，Service 本身可独立调用", async () => {
	const state = setup([], "2026-10-01 00:15:00");
	const result = await state.service.query({ device: "二号电机" });
	assert.deepEqual(result.period, { startTime: "2026-09-30 23:15:00", endTime: "2026-10-01 00:15:00" });
	assert.equal(state.source.latestCalls[0]!.table, "real_data_02");
});

test("仅传一端或传入不存在的日期时抛错，不查询最新时间或读取记录", async () => {
	for (const params of [
		{ device: "g120_01", startTime: period.startTime }, { device: "g120_01", endTime: period.endTime },
		{ device: "g120_01", startTime: "2026-02-31 00:00:00", endTime: period.endTime },
	]) {
		const state = setup();
		await assert.rejects(execute(state.tool, params), /故障事件查询失败/);
		assert.equal(state.source.windows.length, 0);
		assert.equal(state.source.latestCalls.length, 0);
	}
});

test("默认窗口缺少数据或最新时间无效时失败，明确空窗口返回无数据说明", async () => {
	const empty = setup();
	await assert.rejects(execute(empty.tool, { device: "g120_01" }), /没有采样数据/);
	assert.equal(empty.datasets.size, 0);
	assert.equal(empty.source.windows.length, 0);
	const invalid = setup([], "2026-02-31 00:00:00");
	await assert.rejects(execute(invalid.tool, { device: "g120_01" }), /不存在的日期/);
	const result = await execute(empty.tool, { device: "g120_01", ...period });
	assert.match((result.content[0] as { text: string }).text, /没有采样记录，无法判断是否发生故障/);
	assert.equal((result.details as FaultEventResult).rowCount, 0);
});

test("全清除值和隐藏未知值示例的正文不输出设备健康结论", async () => {
	const clear = await execute(setup([row(1, 0)]).tool, { device: "g120_01", ...period });
	assert.match((clear.content[0] as { text: string }).text, /不能据此认定设备健康/);
	const unknown = await setup([row(1, 0, null)]).service.query({ device: "g120_01", ...period, maxUnknownValues: 0 });
	const text = formatFaultEventResult(unknown);
	assert.match(text, /无返回示例/);
	assert.match(text, /无法解释或缺失的编码观测共 1 条/);
});

test("最新时间查询失败或取消不生成事件摘要，Tool 保留取消和超时类型", async () => {
	const state = setup();
	const controller = new AbortController();
	const reason = new Error("用户取消");
	state.source.latestTimestamp = async () => { controller.abort(reason); return period.endTime; };
	await assert.rejects(execute(state.tool, { device: "g120_01" }, controller.signal), (error) => error === reason);
	assert.equal(state.datasets.size, 0);
	assert.equal(state.source.windows.length, 0);
	for (const error of [new DOMException("查询超时", "TimeoutError"), new DOMException("查询取消", "AbortError")]) {
		const tool = createQueryFaultEventsTool({ query: async () => { throw error; } });
		await assert.rejects(execute(tool, { device: "g120_01" }), (actual) => actual === error);
	}
	const tool = createQueryFaultEventsTool({ query: async () => { throw new Error("数据库断连"); } });
	await assert.rejects(execute(tool, { device: "g120_01" }), /故障事件查询失败：数据库断连/);
});

test("工具注册表包含四项工具，无需创建 Pi 会话或模型", () => {
	const state = setup();
	const tools = createCustomTools({} as never, {} as never, {} as never, state.service);
	assert.deepEqual(tools.map((tool) => tool.name), ["query_data", "analyze_data", "search_knowledge", "query_fault_events"]);
});
