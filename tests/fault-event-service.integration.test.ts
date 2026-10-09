import assert from "node:assert/strict";
import test from "node:test";
import type { RowDataPacket } from "mysql2/promise";
import { DatasetStore } from "../src/domain/dataset/store.ts";
import { deviceRegistry } from "../src/domain/device/registry.ts";
import { getPool, closePool } from "../src/repositories/pool.ts";
import { TelemetryRepository } from "../src/repositories/telemetry-repository.ts";
import { FaultEventService, type FaultEventDataset } from "../src/services/fault-event-service.ts";

/** 显式启用；只读固定历史窗口，不建表、不修改采集数据。 */
test("真实 MySQL：事件观测次数与数据库独立统计一致，默认摘要截断仍保留完整总数", { skip: process.env.TELEMETRY_TEST_MYSQL !== "1" }, async (t) => {
	t.after(closePool);
	const pool = getPool();
	const service = new FaultEventService(new TelemetryRepository(() => pool), new DatasetStore<FaultEventDataset>());
	const startTime = "2026-10-08 11:26:04";
	const endTime = "2026-10-09 21:14:16";
	for (const device of deviceRegistry.list()) {
		await t.test(device.key, async () => {
			const [rows] = await pool.query<RowDataPacket[]>(
				`SELECT COUNT(*) AS row_count,
					SUM(CASE WHEN fault_code <> '0' THEN 1 ELSE 0 END) AS fault_count,
					SUM(CASE WHEN alarm_code <> '0' THEN 1 ELSE 0 END) AS alarm_count
					FROM \`${device.table}\` WHERE \`timestamp\` >= ? AND \`timestamp\` <= ?`, [startTime, endTime],
			);
			const expected = rows[0]!;
			const query = { device: device.key, startTime, endTime };
			const full = await service.query({ ...query, maxEvents: 100 }, { batchSize: 257 });
			assert.equal(full.rowCount, Number(expected.row_count));
			assert.equal(full.processedRowCount, full.rowCount);
			assert.equal(full.eventsTruncated, false);
			assert.equal(full.eventCount, full.events.length);
			assert.deepEqual(full.unknownValues, []);
			for (const [metric, count] of [["fault_code", expected.fault_count], ["alarm_code", expected.alarm_count]] as const) {
				assert.equal(full.events.filter((event) => event.sourceMetric === metric).reduce((sum, event) => sum + event.observationCount, 0), Number(count));
			}
			const summary = await service.query(query);
			assert.equal(summary.rowCount, full.rowCount);
			assert.equal(summary.eventCount, full.eventCount);
			assert.equal(summary.eventsTruncated, full.eventCount > 20);
			assert.deepEqual(summary.events, full.events.slice(0, 20));
			t.diagnostic(`${device.key}: ${full.rowCount} 条采样，${full.eventCount} 个连续观测事件，默认返回 ${summary.events.length} 个。`);
		});
	}
});
