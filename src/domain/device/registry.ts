import type { DeviceDefinition } from "./definition.ts";
import { DEVICE_DEFINITIONS } from "./devices.ts";

/** 别名查表用的规范化形式：去掉首尾空白并忽略大小写。 */
function normalize(name: string): string {
	return name.trim().toLowerCase();
}

/**
 * 设备注册表：把设备定义索引起来，并负责把用户/LLM 的说法解析成设备。
 *
 * 与 MetricCatalog 同构——不暴露内部 Map，只给方法；将来定义改成从配置或数据库加载时，
 * 调用方不用改。
 */
export class DeviceRegistry {
	private readonly byKey: ReadonlyMap<string, DeviceDefinition>;
	private readonly byName: ReadonlyMap<string, DeviceDefinition>;
	private readonly all: readonly DeviceDefinition[];

	constructor(definitions: readonly DeviceDefinition[]) {
		const byKey = new Map<string, DeviceDefinition>();
		const byName = new Map<string, DeviceDefinition>();

		for (const definition of definitions) {
			if (byKey.has(definition.key)) {
				throw new Error(`设备注册表中存在重复的 key：${definition.key}`);
			}
			byKey.set(definition.key, definition);

			// key、中文名、别名都进同一张表，解析时不必分情况。
			for (const name of [definition.key, definition.displayName, ...definition.aliases]) {
				const normalized = normalize(name);
				const existing = byName.get(normalized);
				if (existing && existing.key !== definition.key) {
					throw new Error(
						`设备的名称或别名冲突："${name}" 同时指向 ${existing.key} 与 ${definition.key}`,
					);
				}
				byName.set(normalized, definition);
			}
		}

		this.byKey = byKey;
		this.byName = byName;
		this.all = [...definitions];
	}

	/** 按 key 取定义；未登记时返回 undefined。 */
	get(key: string): DeviceDefinition | undefined {
		return this.byKey.get(key);
	}

	/** 判断 key 是否已登记。 */
	has(key: string): boolean {
		return this.byKey.has(key);
	}

	/**
	 * 按 key、中文名或别名解析设备。只做规范化后的精确匹配，**不做模糊匹配**——
	 * 猜错设备比查不到设备更危险。解析不到时由调用方报错并列出合法取值。
	 */
	resolve(input: string): DeviceDefinition | undefined {
		return this.byName.get(normalize(input));
	}

	/** 全部设备，保持定义表中的顺序。 */
	list(): readonly DeviceDefinition[] {
		return this.all;
	}
}

/** 全局唯一的设备注册表，由 devices.ts 中的定义表构建。 */
export const deviceRegistry = new DeviceRegistry(DEVICE_DEFINITIONS);
