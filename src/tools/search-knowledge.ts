import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { deviceRegistry } from "../domain/device/registry.ts";
import { sourceTypes, type SearchKnowledgeResult } from "../domain/knowledge/definition.ts";
import type { KnowledgeService } from "../services/knowledge-service.ts";
import { stringEnum } from "./schema.ts";

export const searchKnowledgeParameters = Type.Object({
	query: Type.String({ minLength: 1, maxLength: 2000, description: "要查的故障码、现象或技术问题。工具会自动识别 F/A/N + 五位数字的故障码；没有故障码时按现象检索。" }),
	device: Type.Optional(stringEnum(deviceRegistry.list().map((device) => device.key), { description: "针对某台已登记设备诊断时填写，服务会使用其产品系列过滤手册。单纯查询手册可省略。" })),
	faultCodes: Type.Optional(Type.Array(Type.String({ pattern: "^[FANfan][0-9]{5}$" }), { minItems: 1, maxItems: 5, description: "可选的明确故障码列表；也可直接写在 query 中。每个码分别报告查询状态。" })),
	productFamily: Type.Optional(Type.String({ minLength: 1, maxLength: 60, description: "手册适用产品系列，如 G120、S120。与指定设备的登记信息冲突时会报错。" })),
	driveObject: Type.Optional(Type.String({ minLength: 1, maxLength: 60, description: "仅在已知驱动对象或工具返回多版本候选时填写，如 VECTOR、SERVO、CU_S120_DP。不要猜测。" })),
	sourceTypes: Type.Optional(Type.Array(stringEnum(sourceTypes), { minItems: 1, maxItems: 4, description: "可选来源类型过滤：故障手册、维护指南、案例、FAQ。默认查询所有已发布资料。" })),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 8, description: "现象检索最多返回几条证据，默认 5；精确查码独立返回逐码候选。" })),
});
export type SearchKnowledgeParams = Static<typeof searchKnowledgeParameters>;

export function formatKnowledgeResult(result: SearchKnowledgeResult): string {
	const lines = [`知识查询状态：${result.status}；检索模式：${result.retrievalMode}`];
	if (result.status === "candidates") lines.push("现象检索返回相似候选，相关性尚未确认。请核对与问题及设备的关联；无适用证据时明确说明，不能用无关条目作答。");
	for (const lookup of result.codeLookups) lines.push(`故障码 ${lookup.code}：${lookup.status}，${lookup.candidateCount} 个候选`);
	for (const warning of result.warnings) lines.push(`说明：${warning}`);
	for (const item of result.evidence) {
		const source = item.source;
		lines.push("", `[${item.evidenceId}] ${item.title}（${item.match}${item.truncated ? "；节选" : ""}）`,
			`来源：${source.title}；版本 ${source.version}；文档编号 ${source.documentNumber || "未登记"}；类型 ${source.sourceType}`,
			`原文标注产品：${source.declaredProducts.join("/")}；登记适用产品：${source.applicableProducts.join("/")}`,
			`文件：${source.file}；PDF 页码：${source.pdfPages.join("、") || "不适用"}；印刷页码：${source.printedPages.join("、") || "不适用"}`,
			...(source.applicabilityNote ? [`适用说明：${source.applicabilityNote}`] : []),
			...(item.fields["驱动对象"] ? [`驱动对象：${item.fields["驱动对象"]}`] : []),
			"证据正文：", item.text);
	}
	if (!result.evidence.length) lines.push("没有找到适用的知识证据。请核对故障码、产品系列和知识库覆盖范围，不能补造手册内容。");
	return lines.join("\n");
}

export function createSearchKnowledgeTool(service: KnowledgeService) {
	return defineTool({
		name: "search_knowledge", label: "查询故障手册与知识库",
		description: "只读查询已发布的故障手册、维护指南、维修案例和 FAQ。明确故障码时优先精确查询完整条目并过滤适用范围；现象查询使用 BM25 与可用的语义索引。返回原文证据、适用范围、版本和页码。查故障码含义可以直接调用，不必先查运行数据。同码多版本时须确认驱动对象，不能合并处理方法；未找到时不能以相似码替代。",
		parameters: searchKnowledgeParameters,
		execute: async (_toolCallId, params: SearchKnowledgeParams, signal) => {
			try {
				const result = await service.search(params, signal);
				return {
					content: [{ type: "text" as const, text: formatKnowledgeResult(result) }],
					details: { ...result, evidence: result.evidence.map(({ text: _text, ...item }) => item) },
				};
			} catch (error) {
				throw new Error(`知识查询失败：${error instanceof Error ? error.message : String(error)}`);
			}
		},
	});
}
