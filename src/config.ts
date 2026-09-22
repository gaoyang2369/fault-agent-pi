/**
 * 运行参数配置。
 *
 * 全部通过环境变量覆盖，便于在不同环境切换模型而不改代码。
 */

/** pi 支持的思考级别。 */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/** 默认模型：~/.pi/agent/models.json 中已配置密钥的 DeepSeek。 */
const DEFAULT_MODEL = "deepseek/deepseek-chat";

/** 诊断只做读取与观察，因此阶段一只开放只读工具，不开放 bash / edit / write。 */
export const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"] as const;

/** 模型标识，形如 "provider/modelId"。可用 PI_MODEL 覆盖。 */
export function resolveModelSpec(): string {
	const spec = process.env.PI_MODEL?.trim();
	return spec || DEFAULT_MODEL;
}

/** 拆分 "provider/modelId"；格式非法时返回 undefined。 */
export function splitModelSpec(spec: string): { provider: string; modelId: string } | undefined {
	const separator = spec.indexOf("/");
	if (separator <= 0 || separator === spec.length - 1) return undefined;
	return { provider: spec.slice(0, separator), modelId: spec.slice(separator + 1) };
}

/** 思考级别，可用 PI_THINKING 覆盖；非法值回退到 off。 */
export function resolveThinkingLevel(): ThinkingLevel {
	const raw = process.env.PI_THINKING?.trim() as ThinkingLevel | undefined;
	return raw && THINKING_LEVELS.includes(raw) ? raw : "off";
}
