import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { DatasetStore } from "../src/domain/dataset/store.ts";
import type { FaultEventResult } from "../src/domain/diagnosis/definition.ts";
import { getPool, closePool } from "../src/repositories/pool.ts";
import { TelemetryRepository } from "../src/repositories/telemetry-repository.ts";
import { FaultEventService, type FaultEventDataset, type FaultEventSource } from "../src/services/fault-event-service.ts";
import { createQueryFaultEventsTool } from "../src/tools/query-fault-events.ts";

const run = promisify(execFile);
const period = { startTime: "2026-10-08 11:26:04", endTime: "2026-10-09 21:14:16" };

/** 只读验收：直接执行 Tool 和独立 CLI，不创建 AgentSession，不调用 LLM。 */
test("真实 MySQL：query_fault_events 与独立命令行入口无需 Pi 会话即可识别事件", { skip: process.env.TELEMETRY_TEST_MYSQL !== "1" }, async (t) => {
	t.after(closePool);
	const repository = new TelemetryRepository(getPool);
	const service = new FaultEventService(repository, new DatasetStore<FaultEventDataset>());
	const tool = createQueryFaultEventsTool(service);
	for (const [device, code] of [["g120_01", "A07089"], ["g120_02", "F30899"], ["g120_03", "F07016"]] as const) {
		await t.test(device, async () => {
			const reference = await service.query({ device, ...period, maxEvents: 100 });
			const result = await tool.execute("integration", { device, ...period, limit: 2 }, undefined, undefined, {} as never);
			const details = result.details as FaultEventResult;
			assert.equal(details.rowCount, 30_421);
			assert.equal(details.eventCount, reference.eventCount);
			assert.equal(details.eventsTruncated, true);
			assert.deepEqual(details.events, reference.events.slice(0, 2));
			assert.ok(details.events.every((event) => event.code === code));
			assert.match((result.content[0] as { text: string }).text, /事件列表截断：是/);
			t.diagnostic(`${device}: ${details.rowCount} 条采样，${details.eventCount} 个观测事件，返回 ${details.events.length} 个。`);
		});
	}
	await t.test("默认窗口锚定查询时的设备最新采样", async () => {
		let latest: string | undefined;
		const source: FaultEventSource = {
			latestTimestamp: async (table, options) => { latest = await repository.latestTimestamp(table, options); return latest; },
			iterateFaultRecords: (request, options) => repository.iterateFaultRecords(request, options),
		};
		const direct = createQueryFaultEventsTool(new FaultEventService(source, new DatasetStore<FaultEventDataset>()));
		const result = await direct.execute("default-window", { device: "g120_02", limit: 2 }, undefined, undefined, {} as never);
		const details = result.details as FaultEventResult;
		assert.equal(details.period.endTime, latest);
		assert.equal(Date.parse(`${latest!.replace(" ", "T")}Z`) - Date.parse(`${details.period.startTime.replace(" ", "T")}Z`), 3_600_000);
		assert.ok(details.rowCount > 0);
	});
	await t.test("独立 CLI 只调用 Service，输出有界 JSON", async () => {
		const { stdout, stderr } = await run(process.execPath, [
			"--import", "tsx", resolve("scripts/diagnosis/fault-events.ts"),
			"--device", "g120_02", "--start", period.startTime, "--end", period.endTime, "--limit", "2",
		]);
		const result = JSON.parse(stdout) as FaultEventResult;
		assert.equal(stderr, "");
		assert.equal(result.deviceKey, "g120_02");
		assert.equal(result.rowCount, 30_421);
		assert.equal(result.events.length, 2);
		assert.equal(result.eventsTruncated, true);
		assert.ok(stdout.length < 4000);
	});
});
