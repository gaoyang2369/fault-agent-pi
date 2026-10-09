/** 独立查询入口：只调用业务服务，不导入 Pi SDK、创建会话或调用 LLM。 */
import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { parseArgs } from "node:util";
import { DatasetStore } from "../../src/domain/dataset/store.ts";
import { TelemetryRepository } from "../../src/repositories/telemetry-repository.ts";
import { getPool, closePool } from "../../src/repositories/pool.ts";
import { FaultEventService, type FaultEventDataset } from "../../src/services/fault-event-service.ts";

async function main(): Promise<void> {
	const { values } = parseArgs({ options: {
		device: { type: "string" }, start: { type: "string" }, end: { type: "string" }, limit: { type: "string" },
	} });
	if (!values.device) throw new Error('请指定 --device，例如 npm run fault-events:query -- --device g120_01 --limit 5。');
	if (existsSync(".env")) loadEnvFile(".env");
	const controller = new AbortController();
	const cancel = () => controller.abort();
	process.once("SIGINT", cancel);
	process.once("SIGTERM", cancel);
	try {
		const service = new FaultEventService(new TelemetryRepository(getPool), new DatasetStore<FaultEventDataset>());
		const result = await service.query({
			device: values.device, startTime: values.start, endTime: values.end,
			...(values.limit === undefined ? {} : { maxEvents: Number(values.limit) }),
		}, { signal: controller.signal });
		process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
	} finally {
		process.removeListener("SIGINT", cancel);
		process.removeListener("SIGTERM", cancel);
		await closePool();
	}
}

main().catch((error: unknown) => {
	process.stderr.write(`查询失败：${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
});
