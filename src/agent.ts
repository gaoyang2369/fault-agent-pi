/**
 * Agent 组装：把模型、系统提示词、工具与会话拼成一个可用的故障诊断 agent。
 *
 * 这是后续扩展的主要入口——新增工具时在 config.ts 的工具列表与 createAgentSession
 * 的 customTools 中登记即可。
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

	const { session } = await createAgentSession({
		cwd,
		model,
		modelRuntime,
		thinkingLevel: resolveThinkingLevel(),
		resourceLoader,
		tools: [...READ_ONLY_TOOLS],
		sessionManager: SessionManager.inMemory(cwd),
	});

	return session;
}
