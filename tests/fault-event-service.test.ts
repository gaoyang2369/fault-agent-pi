import assert from "node:assert/strict";
import test from "node:test";
import { DatasetStore } from "../src/domain/dataset/store.ts";
import type { FaultRecordQuery, FaultRecordReader, FaultRecordReadOptions, RawFaultRecord } from "../src/repositories/telemetry-repository.ts";
import { FaultEventService, type FaultEventDataset, type FaultEventPolicy, type FaultEventQuery } from "../src/services/fault-event-service.ts";

const startTime = "2026-10-08 11:26:04";
const request: FaultEventQuery = { device: "g120_01", startTime, endTime: "2026-10-08 12:26:04" };

function time(seconds: number): string {
	const date = new Date(`${startTime.replace(" ", "T")}Z`);
	date.setUTCSeconds(date.getUTCSeconds() + seconds);
	return date.toISOString().slice(0, 19).replace("T", " ");
}

function row(index: number, faultCode: string | null = "0", alarmCode: string | null = "0", seconds = index * 4): RawFaultRecord {
	return { id: String(index + 1), timestamp: time(seconds), faultCode, alarmCode };
}

class FakeReader implements FaultRecordReader {
	readonly calls: { request: FaultRecordQuery; options?: FaultRecordReadOptions }[] = [];
	produced = 0;
	closed = 0;
	constructor(private readonly source: () => AsyncIterable<RawFaultRecord>) {}
	async *iterateFaultRecords(request: FaultRecordQuery, options?: FaultRecordReadOptions) {
		this.calls.push({ request, options });
		try {
			for await (const record of this.source()) {
				this.produced++;
				yield record;
			}
		} finally { this.closed++; }
	}
}

function harness(rows: readonly RawFaultRecord[] = [], policy: FaultEventPolicy = {}, source?: () => AsyncIterable<RawFaultRecord>) {
	const reader = new FakeReader(source ?? (async function* () { yield* rows; }));
	const datasets = new DatasetStore<FaultEventDataset>();
	return { reader, datasets, service: new FaultEventService(reader, datasets, policy) };
}

test("规范化完整编码，类别取决于实际前缀；缺位、混淆字母及多码值不猜测", async (t) => {
	for (const [raw, code, kind] of [
		[" f30899 ", "F30899", "fault"], ["Ｆ３０８９９", "F30899", "fault"],
		["a07089", "A07089", "alarm"], ["N01011", "N01011", "notification"],
	] as const) {
		await t.test(raw, async () => {
			const { service } = harness([row(0, raw), row(1)]);
			const result = await service.query(request);
			assert.equal(result.eventCount, 1);
			assert.equal(result.events[0]!.code, code);
			assert.equal(result.events[0]!.kind, kind);
			assert.equal(result.events[0]!.endReason, "cleared_observed");
		});
	}
	for (const raw of [null, "", " ", "F3089", "F3O899", "F308990", "XF30899", "F30899,A07089", "F30899;A07089", "F30899 故障"]) {
		await t.test(`未知 ${String(raw)}`, async () => {
			const { service } = harness([row(0, raw), row(1)]);
			const result = await service.query(request);
			assert.equal(result.eventCount, 0);
			assert.deepEqual(result.unknownValues, [{ timestamp: startTime, sourceMetric: "fault_code", rawValue: raw }]);
		});
	}
	for (const raw of ["0", "０", " 0 "]) {
		const result = await harness([row(0, raw)]).service.query(request);
		assert.equal(result.eventCount, 0);
		assert.deepEqual(result.unknownValues, []);
	}
});

test("连续同码合并；清除后再次出现产生新事件，首末边界保持不确定性", async () => {
	const state = harness([row(0, "F30899"), row(1, "F30899"), row(2), row(3, "F30899"), row(4, "F30899")]);
	const result = await state.service.query({ ...request, endTime: time(16) });
	assert.deepEqual(result.events, [
		{ eventId: "evt-001", deviceKey: "g120_01", sourceMetric: "fault_code", code: "F30899", kind: "fault", firstObservedAt: time(0), lastObservedAt: time(4), observationCount: 2, endReason: "cleared_observed" },
		{ eventId: "evt-002", deviceKey: "g120_01", sourceMetric: "fault_code", code: "F30899", kind: "fault", firstObservedAt: time(12), lastObservedAt: time(16), observationCount: 2, endReason: "window_boundary" },
	]);
	assert.equal(result.rowCount, 5);
	assert.equal(result.processedRowCount, 5);
	assert.equal(result.eventCount, 2);
	assert.equal(result.eventsTruncated, false);
	assert.ok(result.limitations.some((text) => text.includes("首条采样之前")));
	assert.ok(result.limitations.some((text) => text.includes("不表示故障已恢复")));
	const { datasetId, ...summary } = result;
	assert.deepEqual(state.datasets.get(datasetId), summary);
	assert.equal(state.reader.closed, 1);
});

test("编码替换结束旧观测，但不声明旧物理故障已经恢复", async () => {
	const result = await harness([row(0, "F30899"), row(1, "F07016"), row(2)]).service.query(request);
	assert.deepEqual(result.events.map((event) => [event.code, event.endReason]), [["F30899", "code_replaced"], ["F07016", "cleared_observed"]]);
	assert.ok(result.limitations.some((text) => text.includes("前一个物理故障")));
});

test("两个字段独立分段，同时出现的故障和报警都保留", async () => {
	const result = await harness([row(0, "F30899", "A07089"), row(1, "0", "A07089"), row(2, "F30899")]).service.query(request);
	assert.deepEqual(result.sourceMetrics, ["fault_code", "alarm_code"]);
	assert.deepEqual(result.events.map((event) => [event.sourceMetric, event.observationCount, event.endReason]), [
		["fault_code", 1, "cleared_observed"], ["alarm_code", 2, "cleared_observed"], ["fault_code", 1, "window_boundary"],
	]);
	assert.equal(result.rowCount, 3);
});

test("消息类别不由列名推断，报警列中的 F 仍然是故障类消息", async () => {
	const result = await harness([row(0, "0", "F30899"), row(1)]).service.query(request);
	assert.equal(result.events[0]!.sourceMetric, "alarm_code");
	assert.equal(result.events[0]!.kind, "fault");
});

test("16 秒断档两侧的同码分段；断档后的清除值不能证明旧事件何时清除", async () => {
	const result = await harness([row(0, "F30899"), row(1, "F30899"), row(2, "F30899", "0", 20), row(3, "0", "0", 24)]).service.query(request);
	assert.deepEqual(result.events.map((event) => [event.firstObservedAt, event.lastObservedAt, event.observationCount, event.endReason]), [
		[time(0), time(4), 2, "data_gap"], [time(20), time(20), 1, "cleared_observed"],
	]);
	assert.ok(result.limitations.some((text) => text.includes("断档共 1 处")));
	const cleared = await harness([row(0, "F30899"), row(1, "0", "0", 16)]).service.query(request);
	assert.equal(cleared.events[0]!.endReason, "data_gap");
});

test("null 和未知格式打断所在字段，另一个字段仍可连续", async () => {
	const result = await harness([
		row(0, "F30899", "A07089"), row(1, null, "A07089"), row(2, "F30899", "A07089"),
		row(3, "F3O899", "A07089"), row(4, "F30899", "A07089"), row(5),
	]).service.query(request);
	const faults = result.events.filter((event) => event.sourceMetric === "fault_code");
	assert.deepEqual(faults.map((event) => event.endReason), ["data_gap", "data_gap", "cleared_observed"]);
	assert.equal(result.events.find((event) => event.sourceMetric === "alarm_code")!.observationCount, 5);
	assert.deepEqual(result.unknownValues.map((item) => item.rawValue), [null, "F3O899"]);
});

test("重复时间戳以 id 排序，但保守分段并说明同一时刻的状态不确定性", async () => {
	const result = await harness([
		{ ...row(0, "F30899"), id: "9007199254740993" },
		{ ...row(1, "F30899", "0", 0), id: "9007199254740994" }, row(2, "F30899", "0", 4), row(3, "0", "0", 8),
	]).service.query(request);
	assert.deepEqual(result.events.map((event) => [event.observationCount, event.endReason]), [[1, "data_gap"], [2, "cleared_observed"]]);
	assert.ok(result.limitations.some((text) => text.includes("重复时间戳记录共 1 条")));
});

test("空窗口和全清除值窗口返回观测摘要，不输出健康结论", async () => {
	for (const records of [[], [row(0), row(1)]]) {
		const result = await harness(records).service.query(request);
		assert.equal(result.rowCount, records.length);
		assert.equal(result.eventCount, 0);
		assert.deepEqual(result.events, []);
		assert.ok(!("status" in result));
		if (!records.length) assert.ok(result.limitations.some((text) => text.includes("无采样记录")));
	}
});

test("未对齐窗口的实际采样边界进入 limitations，不把末次采样当作恢复时刻", async () => {
	const result = await harness([row(0, "F30899", "0", 20)]).service.query(request);
	assert.equal(result.events[0]!.firstObservedAt, time(20));
	assert.equal(result.events[0]!.endReason, "window_boundary");
	assert.ok(result.limitations.some((text) => text.includes(`实际采样覆盖 ${time(20)} ~ ${time(20)}`)));
});

test("最早开始的长期事件不会被先结束的短事件挤掉；截断后仍精确计数", async () => {
	const rows = Array.from({ length: 101 }, (_, index) => row(index, "F30899", index % 2 ? "A07089" : "0"));
	const state = harness(rows);
	const result = await state.service.query({ ...request, maxEvents: 2 });
	assert.equal(state.reader.produced, 101);
	assert.equal(result.rowCount, 101);
	assert.equal(result.processedRowCount, 101);
	assert.equal(result.eventCount, 51);
	assert.equal(result.events.length, 2);
	assert.equal(result.eventsTruncated, true);
	assert.deepEqual(result.events.map((event) => [event.eventId, event.sourceMetric, event.observationCount]), [
		["evt-001", "fault_code", 101], ["evt-002", "alarm_code", 1],
	]);
	assert.ok(result.limitations.some((text) => text.includes("51 个观测事件")));
});

test("未知观测示例有上限，全部出现次数仍报告；可配置不保留原值", async () => {
	for (const maxUnknownValues of [0, 3]) {
		const result = await harness(Array.from({ length: 50 }, (_, index) => row(index, `未知-${index}`))).service.query({ ...request, maxUnknownValues });
		assert.equal(result.unknownValues.length, maxUnknownValues);
		assert.ok(result.limitations.some((text) => text.includes("共 50 条")));
	}
});

test("10 万条流式记录产生有界摘要，事件列表截断不影响总数", async () => {
	const size = 100_000;
	const state = harness([], {}, async function* () {
		for (let index = 0; index < size; index++) yield row(index, index % 2 ? "0" : "F30899", `未知-${index}`);
	});
	const result = await state.service.query({ ...request, endTime: time(size * 4), maxEvents: 3, maxUnknownValues: 2 });
	assert.equal(result.rowCount, size);
	assert.equal(result.eventCount, size / 2);
	assert.equal(result.events.length, 3);
	assert.equal(result.unknownValues.length, 2);
	assert.ok(JSON.stringify(result).length < 4000);
	assert.equal(state.datasets.size, 1);
});

test("断档和清除值规则可配置，构造时复制清除集合避免中途漂移", async () => {
	const noCodeValues = new Set(["0", "正常"]);
	const state = harness([row(0, "F30899"), row(1, "F30899", "0", 8), row(2, " 正常 ", "0", 12)], { maxGapMs: 8000, noCodeValues });
	noCodeValues.clear();
	const result = await state.service.query(request);
	assert.equal(result.eventCount, 1);
	assert.equal(result.events[0]!.observationCount, 2);
	assert.equal(result.events[0]!.endReason, "cleared_observed");
	assert.deepEqual(result.unknownValues, []);
	assert.throws(() => harness([], { noCodeValues: new Set(["f30899"]) }), /不能包含有效/);
	assert.throws(() => harness([], { maxGapMs: 0 }), /maxGapMs/);
});

test("设备别名解析为白名单表，读取选项传递给仓储", async () => {
	const state = harness([row(0)]);
	const options = { batchSize: 17, queryTimeoutMs: 1000, scanTimeoutMs: 5000, signal: new AbortController().signal };
	const result = await state.service.query({ ...request, device: "二号电机" }, options);
	assert.equal(result.deviceKey, "g120_02");
	assert.deepEqual(state.reader.calls[0], { request: { table: "real_data_02", startTime: request.startTime, endTime: request.endTime }, options });
});

test("非法设备、日期、窗口和摘要上限在读取之前拒绝", async () => {
	const state = harness();
	for (const invalid of [
		{ ...request, device: "real_data_04" }, { ...request, startTime: "2026-02-31 00:00:00" },
		{ ...request, startTime: request.endTime }, { ...request, startTime: "2026-10-08T11:26:04Z" },
		{ ...request, maxEvents: 0 }, { ...request, maxEvents: 101 }, { ...request, maxEvents: 1.5 },
		{ ...request, maxUnknownValues: -1 }, { ...request, maxUnknownValues: 51 },
	]) await assert.rejects(state.service.query(invalid));
	assert.equal(state.reader.calls.length, 0);
	assert.equal(state.datasets.size, 0);
});

test("替代读取器返回乱序、重复主键或越界时间时失败，不存入摘要", async () => {
	for (const rows of [
		[row(1), row(0)], [row(0), row(0)], [row(0, "F30899", "0", -4)],
		[{ ...row(0), timestamp: "2026-02-31 00:00:00" }],
	]) {
		const state = harness(rows);
		await assert.rejects(state.service.query(request));
		assert.equal(state.reader.closed, 1);
		assert.equal(state.datasets.size, 0);
	}
});

test("部分读取后的错误原样传播，不返回或保存貌似完整的部分摘要", async () => {
	const reason = new Error("读取第二批失败");
	const state = harness([], {}, async function* () { yield row(0, "F30899"); throw reason; });
	await assert.rejects(state.service.query(request), (error) => error === reason);
	assert.equal(state.reader.closed, 1);
	assert.equal(state.datasets.size, 0);
});

test("取消在读取之前和处理过程中均生效，即使替代读取器不检查 signal", async () => {
	const controller = new AbortController();
	const state = harness([], {}, async function* () { yield row(0, "F30899"); controller.abort(); yield row(1); });
	await assert.rejects(state.service.query(request, { signal: controller.signal }), { name: "AbortError" });
	assert.equal(state.reader.closed, 1);
	assert.equal(state.datasets.size, 0);
	const pre = harness();
	await assert.rejects(pre.service.query(request, { signal: controller.signal }), { name: "AbortError" });
	assert.equal(pre.reader.calls.length, 0);
});

test("并发查询的观测段、事件序号与有界结果不会互相污染", async () => {
	const state = harness([row(0, "F30899"), row(1)]);
	const results = await Promise.all([
		state.service.query(request), state.service.query({ ...request, device: "g120_02" }),
	]);
	assert.notEqual(results[0]!.datasetId, results[1]!.datasetId);
	assert.deepEqual(results.map((result) => [result.deviceKey, result.eventCount, result.events[0]!.eventId]), [
		["g120_01", 1, "evt-001"], ["g120_02", 1, "evt-001"],
	]);
});
