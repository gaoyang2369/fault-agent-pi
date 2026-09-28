/**
 * Agent 组装：把模型、系统提示词、工具与会话拼成一个可用的故障诊断 agent。
 *
 * 这里也是依赖装配的地方：连接池 → 仓储 → 服务 → 工具，依赖方向单向向下，
 * 工具层拿不到池和 SQL。新增工具只需在 tools/index.ts 里登记。
 */

import {
	type AgentSession,
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	ModelRuntime,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import {
	READ_ONLY_TOOLS,
	resolveModelSpec,
	resolveThinkingLevel,
	splitModelSpec,
} from "./config.ts";
import { DIAGNOSIS_SYSTEM_PROMPT } from "./prompt.ts";
import { DatasetStore } from "./domain/dataset/store.ts";
import { getPool } from "./repositories/pool.ts";
import { TelemetryRepository } from "./repositories/telemetry-repository.ts";
import { DataService, type QueryDataResult } from "./services/data-service.ts";
import { AnalysisService } from "./services/analysis-service.ts";
import { createCustomTools } from "./tools/index.ts";

/**
 * 按 PI_MODEL 指定的模型解析；解析不到则回退到第一个已配置密钥的可用模型。
 */
async function pickModel(modelRuntime: ModelRuntime) {
	const spec = resolveModelSpec();
	const parsed = splitModelSpec(spec);
	const configured = parsed ? modelRuntime.getModel(parsed.provider, parsed.modelId) : undefined;
	if (configured) return configured;

	const [fallback] = await modelRuntime.getAvailable();
	if (!fallback) {
		throw new Error(
			`模型 ${spec} 不可用，且没有任何已配置密钥的模型。请检查 ~/.pi/agent/models.json，或用 PI_MODEL 指定模型。`,
		);
	}

	process.stderr.write(
		`[config] 模型 ${spec} 不可用，已回退到 ${fallback.provider}/${fallback.id}\n`,
	);
	return fallback;
}

export interface CreateDiagnosisAgentOptions {
	/** 工作目录，决定内置工具与资源发现的根路径。默认当前目录。 */
	cwd?: string;
}

/** 创建一个故障诊断 agent 会话。调用方负责在结束时 dispose。 */
export async function createDiagnosisAgent(
	options: CreateDiagnosisAgentOptions = {},
): Promise<AgentSession> {
	const cwd = options.cwd ?? process.cwd();
	const modelRuntime = await ModelRuntime.create();
	const model = await pickModel(modelRuntime);

	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir: getAgentDir(),
		systemPromptOverride: () => DIAGNOSIS_SYSTEM_PROMPT,
		// 不追加 ~/.pi/agent/APPEND_SYSTEM.md 或项目内的追加提示词，
		// 保证 agent 的行为只由本仓库的 DIAGNOSIS_SYSTEM_PROMPT 决定。
		appendSystemPromptOverride: () => [],
	});
	await resourceLoader.reload();

	// 传的是 getPool 函数本身而非调用结果：连接池要等第一次查询才创建，
	// 数据库没配好时 agent 仍能启动。
	const datasets = new DatasetStore<QueryDataResult>();
	const dataService = new DataService(new TelemetryRepository(getPool), datasets);
	const analysisService = new AnalysisService(datasets);
	const customTools = createCustomTools(dataService, analysisService);

	const { session } = await createAgentSession({
		cwd,
		model,
		modelRuntime,
		thinkingLevel: resolveThinkingLevel(),
		resourceLoader,
		// 两个清单都要：customTools 注册，tools 是允许列表，漏登记会被静默过滤。
		tools: [...READ_ONLY_TOOLS, ...customTools.map((tool) => tool.name)],
		customTools,
		sessionManager: SessionManager.inMemory(cwd),
	});

	return session;
}
