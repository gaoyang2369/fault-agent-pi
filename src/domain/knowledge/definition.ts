import { Type, type Static } from "typebox";

export const sourceTypes = ["fault_manual", "maintenance_guide", "case", "faq"] as const;
const nonEmpty = () => Type.String({ minLength: 1 });

/** 入库脚本和查询端共享的契约。适用产品由维护者登记，不由模型猜测。 */
export const knowledgeSourceSchema = Type.Object({
	id: nonEmpty(),
	file: nonEmpty(),
	title: nonEmpty(),
	version: nonEmpty(),
	documentNumber: Type.String(),
	manufacturer: nonEmpty(),
	language: nonEmpty(),
	sourceType: Type.Unsafe<(typeof sourceTypes)[number]>({ type: "string", enum: [...sourceTypes] }),
	declaredProducts: Type.Array(nonEmpty(), { minItems: 1 }),
	applicableProducts: Type.Array(nonEmpty(), { minItems: 1 }),
	applicabilityNote: Type.String(),
});
export type KnowledgeSource = Static<typeof knowledgeSourceSchema>;

const documentSchema = Type.Intersect([
	knowledgeSourceSchema,
	Type.Object({ contentHash: nonEmpty() }),
]);
export type KnowledgeDocument = Static<typeof documentSchema>;

const entrySchema = Type.Object({
	id: nonEmpty(),
	documentId: nonEmpty(),
	title: nonEmpty(),
	/** 包含主码，以及手册标题括号中明确允许的可切换类别码。 */
	faultCodes: Type.Array(nonEmpty()),
	primaryFaultCode: Type.Optional(nonEmpty()),
	fields: Type.Record(Type.String(), Type.String()),
	text: nonEmpty(),
	/** PDF 页码从 1 开始；印刷页码单独保留。Markdown 的两组页码为空。 */
	pdfPages: Type.Array(Type.Integer({ minimum: 1 })),
	printedPages: Type.Array(nonEmpty()),
});
export type KnowledgeEntry = Static<typeof entrySchema>;

const chunkSchema = Type.Object({
	id: nonEmpty(),
	entryId: nonEmpty(),
	text: nonEmpty(),
});
export type KnowledgeChunk = Static<typeof chunkSchema>;

export const knowledgeSnapshotSchema = Type.Object({
	schemaVersion: Type.Literal(1),
	builtAt: nonEmpty(),
	documents: Type.Array(documentSchema, { minItems: 1 }),
	entries: Type.Array(entrySchema, { minItems: 1 }),
	chunks: Type.Array(chunkSchema, { minItems: 1 }),
	/** 新 collection 完整写入后才发布快照，避免半成品和新旧索引混用。 */
	vectorIndex: Type.Optional(Type.Object({
		collection: nonEmpty(),
		model: nonEmpty(),
		dimensions: Type.Integer({ minimum: 1 }),
	})),
});
export type KnowledgeSnapshot = Static<typeof knowledgeSnapshotSchema>;

export interface KnowledgeFilter {
	productFamily?: string;
	sourceTypes?: readonly KnowledgeSource["sourceType"][];
	driveObject?: string;
}

export interface RankedChunk {
	chunkId: string;
	score: number;
}

export interface KnowledgeEvidence {
	evidenceId: string;
	entryId: string;
	match: "exact" | "category_alias" | "hybrid" | "lexical";
	primaryFaultCode?: string;
	title: string;
	text: string;
	fields: Record<string, string>;
	truncated: boolean;
	source: KnowledgeDocument & { pdfPages: number[]; printedPages: string[] };
}

export interface CodeLookup {
	code: string;
	status: "matched" | "needs_context" | "not_found";
	candidateCount: number;
	evidenceIds: string[];
}

export interface SearchKnowledgeResult {
	status: "matched" | "candidates" | "needs_context" | "not_found";
	retrievalMode: "exact" | "hybrid" | "lexical";
	codeLookups: CodeLookup[];
	evidence: KnowledgeEvidence[];
	warnings: string[];
}

/** 只规范化书写，不补零、不纠正 O/0，也不猜测 F/A/N 类别。 */
export function extractFaultCodes(text: string): string[] {
	return [...new Set(text.normalize("NFKC").toUpperCase().match(/(?<![A-Z0-9])[FAN]\d{5}(?![A-Z0-9])/g) ?? [])];
}
