import assert from "node:assert/strict";
import { setImmediate as nextTurn, setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import type { Pool } from "mysql2/promise";
import { TelemetryRepository, type FaultRecordQuery, type RawFaultRecord } from "../src/repositories/telemetry-repository.ts";

const request: FaultRecordQuery = {
	table: "real_data_01", startTime: "2026-10-08 11:26:04", endTime: "2026-10-08 11:27:04",
};

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}

function record(id: string, timestamp = request.startTime, faultCode: string | null = "0", alarmCode: string | null = "0"): RawFaultRecord {
	return { id, timestamp, faultCode, alarmCode };
}

/** 模拟一个有快照的连接；分页按实际请求游标筛选，而不是按调用次数返回预设批次。 */
class FakeConnection {
	readonly calls: { sql: string; params: unknown[] }[] = [];
	releaseCount = 0;
	destroyCount = 0;
	engine = "InnoDB";
	snapshot: RawFaultRecord[] = [];
	onPage?: () => Promise<void> | void;
	onRollback?: () => Promise<void> | void;
	onLatest?: () => Promise<void> | void;

	constructor(readonly live: RawFaultRecord[] = []) {}

	async query(sql: string, params: unknown[] = []): Promise<[unknown[], unknown[]]> {
		this.calls.push({ sql, params });
		if (sql.includes("information_schema.TABLES")) return [[{ engine: this.engine }], []];
		if (sql.includes("MAX(`timestamp`) AS `last_ts`")) {
			await this.onLatest?.();
			return [[{ last_ts: this.live.map((row) => row.timestamp).sort().at(-1) ?? null }], []];
		}
		if (sql.startsWith("START TRANSACTION")) this.snapshot = this.live.map((item) => ({ ...item }));
		if (sql === "ROLLBACK") await this.onRollback?.();
		if (!sql.includes("AS `record_id`")) return [[], []];
		await this.onPage?.();
		const limit = Number(sql.match(/LIMIT (\d+)$/)?.[1]);
		assert.ok(limit > 0 && limit <= 5000);
		const [start, end, cursorTime, _sameTime, cursorId] = params as string[];
		const rows = this.snapshot.filter((item) => item.timestamp >= start! && item.timestamp <= end! &&
			(!cursorTime || item.timestamp > cursorTime || (item.timestamp === cursorTime && BigInt(item.id) > BigInt(cursorId!))))
			.sort((a, b) => a.timestamp.localeCompare(b.timestamp) || (BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0))
			.slice(0, limit)
			.map((item) => ({ record_id: item.id, timestamp: item.timestamp, fault_code: item.faultCode, alarm_code: item.alarmCode }));
		return [rows, []];
	}

	release() { this.releaseCount++; }
	destroy() { this.destroyCount++; }
	get pages() { return this.calls.filter((call) => call.sql.includes("AS `record_id`")); }
}

function harness(connection = new FakeConnection(), acquire?: () => Promise<FakeConnection>) {
	let acquisitions = 0;
	const pool = { getConnection: async () => { acquisitions++; return acquire ? acquire() : connection; } } as unknown as Pool;
	return { connection, repository: new TelemetryRepository(() => pool), get acquisitions() { return acquisitions; } };
}

async function collect(iterator: AsyncIterable<RawFaultRecord>) {
	const rows: RawFaultRecord[] = [];
	for await (const row of iterator) rows.push(row);
	return rows;
}

test("跨批重复时间戳、大整数 id 与非时间顺序 id：不遗漏、不重复并保留原始编码", async () => {
	const expected = [
		record("9007199254740993", request.startTime, "F30899"),
		record("9007199254740994", request.startTime, null, ""),
		record("9007199254740995", request.startTime, " F30899;A07089 ", "N01011"),
		record("2", "2026-10-08 11:26:08", "0", "A07089"),
		record("1", request.endTime),
	];
	const state = harness(new FakeConnection([...expected].reverse()));
	const actual = await collect(state.repository.iterateFaultRecords(request, { batchSize: 2 }));
	assert.deepEqual(actual, expected);
	assert.equal(state.connection.pages.length, 3);
	assert.deepEqual(state.connection.pages[1]!.params, [request.startTime, request.endTime, request.startTime, request.startTime, expected[1]!.id]);
	assert.match(state.connection.pages[0]!.sql, /ORDER BY `timestamp` ASC, `id` ASC/);
	assert.match(state.connection.pages[0]!.sql, /CAST\(`id` AS CHAR\)/);
	assert.ok(state.connection.pages.every(({ sql }) => !/OFFSET|ROW_NUMBER|LAG\(|LEAD\(/.test(sql)));
	assert.deepEqual(state.connection.calls.filter(({ sql }) => !sql.startsWith("SELECT")).map(({ sql }) => sql), [
		"SET TRANSACTION ISOLATION LEVEL REPEATABLE READ", "START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY", "ROLLBACK",
	]);
	assert.equal(state.acquisitions, 1);
	assert.equal(state.connection.releaseCount, 1);
	assert.equal(state.connection.destroyCount, 0);
});

test("消费方推进才读取下一批；提前 break 回滚释放连接", async () => {
	const state = harness(new FakeConnection([record("1"), record("2"), record("3")]));
	const iterator = state.repository.iterateFaultRecords(request, { batchSize: 2 });
	assert.equal(state.acquisitions, 0);
	await iterator.next();
	await nextTurn();
	assert.equal(state.connection.pages.length, 1);
	await iterator.next();
	assert.equal(state.connection.pages.length, 1);
	await iterator.next();
	assert.equal(state.connection.pages.length, 2);
	await iterator.return();
	assert.equal(state.connection.releaseCount, 1);
	assert.equal(state.connection.calls.at(-1)?.sql, "ROLLBACK");

	const early = harness(new FakeConnection([record("1"), record("2")]));
	for await (const _row of early.repository.iterateFaultRecords(request, { batchSize: 1 })) break;
	assert.equal(early.connection.pages.length, 1);
	assert.equal(early.connection.releaseCount, 1);
});

test("整批数量恰好触顶及空窗口都正确结束，不把空窗口变成错误", async () => {
	for (const rows of [[], [record("1"), record("2")]]) {
		const state = harness(new FakeConnection(rows));
		assert.deepEqual(await collect(state.repository.iterateFaultRecords(request, { batchSize: 2 })), rows);
		assert.equal(state.connection.pages.length, rows.length ? 2 : 1);
		assert.equal(state.connection.releaseCount, 1);
	}
});

test("同一快照排除扫描中途插入和修改，下一次读取才看到变更", async () => {
	const state = harness(new FakeConnection([record("1"), record("3", "2026-10-08 11:26:08")]));
	const iterator = state.repository.iterateFaultRecords(request, { batchSize: 1 });
	const first = await iterator.next();
	state.connection.live[1] = record("3", "2026-10-08 11:26:08", "F30899");
	state.connection.live.push(record("2"));
	const rest = await collect(iterator);
	assert.deepEqual([first.value, ...rest], [record("1"), record("3", "2026-10-08 11:26:08")]);
	assert.deepEqual(await collect(state.repository.iterateFaultRecords(request)), state.connection.live.toSorted((a, b) => a.timestamp.localeCompare(b.timestamp) || Number(BigInt(a.id) - BigInt(b.id))));
});

test("白名单、真实日期与读取参数在获取连接之前校验", async () => {
	const state = harness();
	for (const invalid of [
		{ ...request, table: "real_data_04" }, { ...request, table: "real_data_01; DROP TABLE x" },
		{ ...request, startTime: "2026-02-31 00:00:00" }, { ...request, startTime: request.endTime },
		{ ...request, startTime: "2026-10-08T11:26:04Z" },
	]) await assert.rejects(collect(state.repository.iterateFaultRecords(invalid)));
	for (const options of [
		{ batchSize: 0 }, { batchSize: 5001 }, { batchSize: 1.5 }, { batchSize: NaN },
		{ queryTimeoutMs: 0 }, { queryTimeoutMs: 60_001 }, { scanTimeoutMs: 600_001 },
	]) await assert.rejects(collect(state.repository.iterateFaultRecords(request, options)));
	assert.equal(state.acquisitions, 0);
});

test("非 InnoDB 表拒绝冒充一致性快照", async () => {
	const state = harness();
	state.connection.engine = "MyISAM";
	await assert.rejects(collect(state.repository.iterateFaultRecords(request)), /InnoDB/);
	assert.equal(state.connection.pages.length, 0);
	assert.equal(state.connection.destroyCount, 1);
});

test("预先取消不连接数据库；等待连接期间取消，迟到连接被归还", async () => {
	const pre = new AbortController();
	pre.abort();
	const state = harness();
	await assert.rejects(collect(state.repository.iterateFaultRecords(request, { signal: pre.signal })), { name: "AbortError" });
	assert.equal(state.acquisitions, 0);

	const waiting = deferred<FakeConnection>();
	const late = harness(new FakeConnection(), () => waiting.promise);
	const controller = new AbortController();
	const pending = late.repository.iterateFaultRecords(request, { signal: controller.signal }).next();
	await nextTurn();
	const reason = new Error("用户取消此次扫描");
	controller.abort(reason);
	await assert.rejects(pending, (error) => error === reason);
	waiting.resolve(late.connection);
	await nextTurn();
	assert.equal(late.connection.releaseCount, 1);
	assert.equal(late.connection.calls.length, 0);
});

test("等待连接超时会拒绝，迟到的连接不会泄漏", async () => {
	const waiting = deferred<FakeConnection>();
	const state = harness(new FakeConnection(), () => waiting.promise);
	await assert.rejects(state.repository.iterateFaultRecords(request, { queryTimeoutMs: 20 }).next(), { name: "TimeoutError" });
	waiting.resolve(state.connection);
	await nextTurn();
	assert.equal(state.connection.releaseCount, 1);
});

test("查询过程中取消会销毁专用连接，底层迟到的拒绝被观察", async () => {
	const page = deferred<void>();
	const entered = deferred<void>();
	const state = harness();
	state.connection.onPage = () => { entered.resolve(); return page.promise; };
	const controller = new AbortController();
	const pending = state.repository.iterateFaultRecords(request, { signal: controller.signal }).next();
	await entered.promise;
	controller.abort();
	await assert.rejects(pending, { name: "AbortError" });
	assert.equal(state.connection.destroyCount, 1);
	assert.equal(state.connection.releaseCount, 0);
	assert.ok(!state.connection.calls.some(({ sql }) => sql === "ROLLBACK"));
	page.reject(new Error("连接关闭后的迟到错误"));
	await nextTurn();
});

test("单次查询超时销毁连接，不把错误当作迭代结束", async () => {
	const state = harness();
	state.connection.onPage = () => new Promise(() => {});
	await assert.rejects(state.repository.iterateFaultRecords(request, { queryTimeoutMs: 20 }).next(), { name: "TimeoutError" });
	assert.equal(state.connection.destroyCount, 1);
	assert.equal(state.connection.releaseCount, 0);
});

test("暂停在 yield 时也响应取消或整次扫描超时", async () => {
	for (const abort of [true, false]) {
		const state = harness(new FakeConnection([record("1"), record("2")]));
		const controller = new AbortController();
		const iterator = state.repository.iterateFaultRecords(request, { signal: controller.signal, scanTimeoutMs: 30 });
		await iterator.next();
		if (abort) controller.abort();
		else await delay(50);
		assert.equal(state.connection.destroyCount, 1);
		await assert.rejects(iterator.next(), { name: abort ? "AbortError" : "TimeoutError" });
		assert.equal(state.connection.releaseCount, 0);
	}
});

test("部分记录之后的数据库错误向上传播，不暴露驱动的完整 SQL 字段", async () => {
	const state = harness(new FakeConnection([record("1"), record("2")]));
	const iterator = state.repository.iterateFaultRecords(request, { batchSize: 1 });
	await iterator.next();
	state.connection.onPage = () => { throw { code: "ER_UNKNOWN_ERROR", sqlMessage: "连接失败", sql: "SECRET_SQL_TEXT" }; };
	await assert.rejects(iterator.next(), (error: unknown) => error instanceof Error && /ER_UNKNOWN_ERROR/.test(error.message) && !error.message.includes("SECRET_SQL_TEXT"));
	assert.equal(state.connection.destroyCount, 1);
	assert.equal(state.connection.releaseCount, 0);
});

test("无效时间戳和重复游标终止读取，避免事件被错误合并或无限循环", async () => {
	for (const rows of [
		[record("1", "2026-10-08 11:26:05junk")], [record("1"), record("1")],
	]) {
		const state = harness(new FakeConnection(rows));
		await assert.rejects(collect(state.repository.iterateFaultRecords(request)), /无效主键或时间戳|严格递增/);
		assert.equal(state.connection.destroyCount, 1);
	}
});

test("回滚失败或超时销毁连接且报告失败，不能将带事务的连接归还池", async () => {
	for (const timeout of [false, true]) {
		const state = harness();
		state.connection.onRollback = () => {
			if (timeout) return new Promise(() => {});
			throw new Error("回滚断连");
		};
		await assert.rejects(collect(state.repository.iterateFaultRecords(request, { queryTimeoutMs: 20 })), timeout ? { name: "TimeoutError" } : /回滚断连/);
		assert.equal(state.connection.destroyCount, 1);
		assert.equal(state.connection.releaseCount, 0);
	}
});

test("最新时间前置查询有截止时间和取消支持；健康连接归还，异常连接销毁", async () => {
	const success = harness(new FakeConnection([record("1"), record("2", request.endTime)]));
	assert.equal(await success.repository.latestTimestamp(request.table, {}), request.endTime);
	assert.equal(success.connection.releaseCount, 1);
	const empty = harness();
	assert.equal(await empty.repository.latestTimestamp(request.table, {}), undefined);
	assert.equal(empty.connection.releaseCount, 1);
	for (const abort of [false, true]) {
		const state = harness();
		const entered = deferred<void>();
		state.connection.onLatest = () => { entered.resolve(); return new Promise(() => {}); };
		const controller = new AbortController();
		const pending = state.repository.latestTimestamp(request.table, { queryTimeoutMs: 20, signal: controller.signal });
		await entered.promise;
		if (abort) controller.abort();
		await assert.rejects(pending, { name: abort ? "AbortError" : "TimeoutError" });
		assert.equal(state.connection.destroyCount, 1);
		assert.equal(state.connection.releaseCount, 0);
	}
});

test("最新时间查询在连接等待超时后归还迟到连接，白名单拒绝发生在连接之前", async () => {
	const waiting = deferred<FakeConnection>();
	const state = harness(new FakeConnection(), () => waiting.promise);
	await assert.rejects(state.repository.latestTimestamp(request.table, { queryTimeoutMs: 20 }), { name: "TimeoutError" });
	waiting.resolve(state.connection);
	await nextTurn();
	assert.equal(state.connection.releaseCount, 1);
	const invalid = harness();
	await assert.rejects(invalid.repository.latestTimestamp("real_data_04", {}), /未登记/);
	assert.equal(invalid.acquisitions, 0);
});
