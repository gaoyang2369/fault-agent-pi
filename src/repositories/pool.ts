import { createPool, type Pool } from "mysql2/promise";
import { resolveMysqlConfig } from "../config.ts";

let pool: Pool | undefined;

/**
 * 懒加载的 MySQL 连接池。
 *
 * 懒加载是有意的：数据库没配好或连不上时，agent 照常启动，`read` / `grep` 等本地工具
 * 仍可用，只有 query_data 会返回可读的错误——而不是整个 CLI 起不来。
 *
 * 并发上限取 8：一次 query_data 会并发跑「1 条聚合 + 若干个状态分组 + 可选 1 条采样」，
 * 默认查询全部指标时状态分组最多 6 条。
 */
export function getPool(): Pool {
	if (pool) return pool;

	const config = resolveMysqlConfig();
	pool = createPool({
		...config,
		connectionLimit: 8,
		connectTimeout: 10_000,
		waitForConnections: true,
		charset: "utf8mb4",
		// 时间列一律按字符串取回，避免驱动按本地时区做换算。
		dateStrings: true,
	});

	// 空闲连接被服务端掐断时会发 'error' 事件，EventEmitter 上没有监听器会把整个进程带崩。
	// promise 版的 Pool 类型没声明 'error' 重载，要挂到底层的回调版连接池上。
	pool.pool.on("error", (error: unknown) => {
		process.stderr.write(`[db] 连接池错误：${String(error)}\n`);
	});

	pool.on("connection", (connection) => {
		// 纵深防御，不是主控制手段：真正的保证是给这个数据库账号只授 SELECT 权限。
		// 服务端不支持时只告警，不影响查询。
		//
		// 注意这里必须自己包一层：类型声明说回调收到的是 promise 版连接，实测是**回调版**
		// （query() 返回 Query 而不是 Promise），直接 .catch() 会抛「not a promise」。
		const callbackConnection = connection as unknown as {
			promise(): { query(sql: string): Promise<unknown> };
		};
		callbackConnection
			.promise()
			.query("SET SESSION TRANSACTION READ ONLY")
			.catch((error: unknown) => {
				process.stderr.write(`[db] 只读会话设置失败（不影响查询）：${String(error)}\n`);
			});
	});

	return pool;
}

/** 关闭连接池。未创建过连接池时是空操作。 */
export async function closePool(): Promise<void> {
	const current = pool;
	pool = undefined;
	if (current) await current.end();
}
