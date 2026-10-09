import assert from "node:assert/strict";
import test from "node:test";
import type { RowDataPacket } from "mysql2/promise";
import { deviceRegistry } from "../src/domain/device/registry.ts";
import { getPool, closePool } from "../src/repositories/pool.ts";
import { TelemetryRepository } from "../src/repositories/telemetry-repository.ts";

/** 显式启用，只读现有设备表；不建表、不插入、不修改索引。 */
test("真实 MySQL：三个设备跨批扫描与独立统计一致", { skip: process.env.TELEMETRY_TEST_MYSQL !== "1" }, async (t) => {
	t.after(closePool);
	const pool = getPool();
	const repository = new TelemetryRepository(() => pool);
	const startTime = "2026-10-08 11:26:04";
	const endTime = "2026-10-09 21:14:16";
	for (const device of deviceRegistry.list()) {
		await t.test(device.key, async () => {
			// 固定历史窗口，避免把正在追加的新数据混进两个不同查询的对比。
			const [rows] = await pool.query<RowDataPacket[]>(
				`SELECT COUNT(*) AS row_count, MIN(\`timestamp\`) AS first_ts, MAX(\`timestamp\`) AS last_ts,
					SUM(CASE WHEN fault_code <> '0' THEN 1 ELSE 0 END) AS fault_count,
					SUM(CASE WHEN alarm_code <> '0' THEN 1 ELSE 0 END) AS alarm_count
					FROM \`${device.table}\` WHERE \`timestamp\` >= ? AND \`timestamp\` <= ?`, [startTime, endTime],
			);
			const expected = rows[0]!;
			let count = 0;
			let faults = 0;
			let alarms = 0;
			let first: string | null = null;
			let last: { timestamp: string; id: string } | undefined;
			for await (const record of repository.iterateFaultRecords({ table: device.table, startTime, endTime }, { batchSize: 257 })) {
				if (last) assert.ok(record.timestamp > last.timestamp || (record.timestamp === last.timestamp && BigInt(record.id) > BigInt(last.id)));
				first ??= record.timestamp;
				last = record;
				count++;
				if (record.faultCode !== null && record.faultCode !== "0") faults++;
				if (record.alarmCode !== null && record.alarmCode !== "0") alarms++;
			}
			assert.equal(count, Number(expected.row_count));
			assert.equal(first, expected.first_ts);
			assert.equal(last?.timestamp ?? null, expected.last_ts);
			assert.equal(faults, Number(expected.fault_count));
			assert.equal(alarms, Number(expected.alarm_count));
			t.diagnostic(`${device.key}: ${count} 条，故障编码 ${faults} 条，报警编码 ${alarms} 条。`);
		});
	}
});
