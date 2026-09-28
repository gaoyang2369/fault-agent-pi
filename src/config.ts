/**
 * 运行参数配置。
 *
 * 全部通过环境变量覆盖，便于在不同环境切换模型而不改代码。真实取值写在仓库根目录的
 * `.env`（已在 .gitignore 中），仓库里只出现变量名。
 */

// Node 22 内置能力，不需要 dotenv。文件不存在时静默跳过——变量也可能由外部环境注入。
// 放在模块顶层是为了让任何入口（main.ts、临时冒烟脚本）都自动生效。
try {
	process.loadEnvFile();
} catch {
	// 没有 .env：继续用 process.env。
}

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

/** MySQL 连接参数。 */
export interface MysqlConfig {
	readonly host: string;
	readonly port: number;
	readonly user: string;
	readonly password: string;
	readonly database: string;
}

/** 变量名统一加库名前缀：同一台服务器上还有别的项目的库，DB_HOST 这种名字太容易撞。 */
const MYSQL_ENV_KEYS = {
	host: "DCMA_DB_HOST",
	port: "DCMA_DB_PORT",
	user: "DCMA_DB_USER",
	password: "DCMA_DB_PASSWORD",
	database: "DCMA_DB_NAME",
} as const;

/**
 * 解析 MySQL 连接参数；缺少必需变量时抛出带变量名的错误。
 *
 * 刻意不在模块加载时调用，而是由连接池在首次查询时懒调用——这样数据库没配好时
 * agent 仍能正常启动，只是 query_data 会返回可读的错误，而不是整个 CLI 起不来。
 *
 * 建议给这个数据库账号只授 SELECT 权限：本 agent 只观察不写入，权限是最可靠的兜底。
 */
export function resolveMysqlConfig(): MysqlConfig {
	// 一次报出所有缺失项，省得配一个报一个。
	const missing: string[] = [];
	const read = (key: string): string => {
		const value = process.env[key]?.trim();
		if (!value) {
			missing.push(key);
			return "";
		}
		return value;
	};

	const host = read(MYSQL_ENV_KEYS.host);
	const user = read(MYSQL_ENV_KEYS.user);
	const password = read(MYSQL_ENV_KEYS.password);

	if (missing.length > 0) {
		throw new Error(
			`缺少数据库配置：${missing.join("、")}。请写在仓库根目录的 .env 中（可参考 .env.example）。`,
		);
	}

	const rawPort = process.env[MYSQL_ENV_KEYS.port]?.trim();
	const port = rawPort ? Number.parseInt(rawPort, 10) : 3306;
	if (!Number.isInteger(port) || port <= 0 || port > 65535) {
		throw new Error(`${MYSQL_ENV_KEYS.port} 不是合法端口：${rawPort}`);
	}

	return {
		host,
		port,
		user,
		password,
		database: process.env[MYSQL_ENV_KEYS.database]?.trim() || "dcma",
	};
}
