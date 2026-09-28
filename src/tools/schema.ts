import { Type } from "typebox";
import type { TUnsafe } from "typebox";

/**
 * 构造字符串枚举 schema。
 *
 * 不用 `Type.Union([Type.Literal(...)])`：那会生成 anyOf/const 的组合，部分供应商不支持。
 * 也不用 pi-ai 的 `StringEnum`：它不在本仓库的直接依赖里（嵌在 pi-coding-agent 内部），
 * 拿不到；而它的实现本身就是把 `{ type: "string", enum }` 交给 `Type.Unsafe`，这里照做。
 *
 * 枚举的实际价值是**约束被 SDK 在调用 execute 之前强制校验**：传错取值会在进入业务代码
 * 前就被挡下，而不是等查一次库才发现。
 */
export function stringEnum<T extends readonly string[]>(
	values: T,
	options: { description?: string } = {},
): TUnsafe<T[number]> {
	return Type.Unsafe<T[number]>({
		type: "string",
		enum: [...values],
		...(options.description === undefined ? {} : { description: options.description }),
	});
}
