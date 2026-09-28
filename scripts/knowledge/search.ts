import { parseArgs } from "node:util";
import { resolveKnowledgeConfig } from "../../src/config.ts";
import { KnowledgeRepository } from "../../src/repositories/knowledge-repository.ts";
import { KnowledgeVectorRepository } from "../../src/repositories/knowledge-vector-repository.ts";
import { EmbeddingClient } from "../../src/services/embedding-client.ts";
import { KnowledgeService } from "../../src/services/knowledge-service.ts";
import { formatKnowledgeResult } from "../../src/tools/search-knowledge.ts";

async function main() {
	const { values, positionals } = parseArgs({ allowPositionals: true, options: {
		device: { type: "string" }, product: { type: "string" }, "drive-object": { type: "string" },
	} });
	const config = resolveKnowledgeConfig();
	const service = new KnowledgeService(new KnowledgeRepository(config.snapshotPath),
		config.embedding ? new EmbeddingClient(config.embedding) : undefined,
		new KnowledgeVectorRepository(config.qdrant));
	const result = await service.search({ query: positionals.join(" "), device: values.device,
		productFamily: values.product, driveObject: values["drive-object"] });
	process.stdout.write(`${formatKnowledgeResult(result)}\n`);
}

main().catch((error: unknown) => {
	process.stderr.write(`查询失败：${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
});
