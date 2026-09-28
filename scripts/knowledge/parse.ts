import { createHash } from "node:crypto";
import type { KnowledgeChunk, KnowledgeDocument, KnowledgeEntry } from "../../src/domain/knowledge/definition.ts";

export function stableId(value: string): string {
	const hex = createHash("sha256").update(value).digest("hex").slice(0, 32);
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const headingPattern = /^([FAN]\d{5})\s+(?:\(([FAN,\s]+)\)\s*)?(.+)$/;
const fieldPattern = /^(信息值|信息类别|驱动对象|组件|传播|反应|应答|原因|处理|在\s*[….]+\s*时(?:的反应|应答)\s*[FAN])\s*[：:]\s*(.*)$/;

function readFields(lines: readonly string[]): Record<string, string> {
	const fields: Record<string, string> = {};
	let current: string | undefined;
	for (const original of lines) {
		// 组件和传播在 PDF 同一行的不同列，不能把 GLOBAL 当成组件的一部分。
		const parts = original.replace(/\s+传播[：:]/, "\n传播：").split("\n");
		for (const part of parts) {
			const match = part.trim().match(fieldPattern);
			if (match) {
				current = match[1]!;
				fields[current] = match[2]!;
			} else if (current) {
				fields[current] += `\n${part.trim()}`;
			}
		}
	}
	return fields;
}

/** 面向 Siemens 此类可提取文本手册的适配器，不宣称能解析任意 PDF 或扫描件。 */
export function parseFaultManual(layoutText: string, document: KnowledgeDocument): KnowledgeEntry[] {
	const entries: KnowledgeEntry[] = [];
	let active: { code: string; aliases: string[]; title: string; heading: string; lines: string[]; pages: number[]; printed: string[] } | undefined;
	const finish = () => {
		if (!active) return;
		const fields = readFields(active.lines);
		if (!fields["原因"]?.trim() || !fields["处理"]?.trim()) {
			throw new Error(`${active.code}（PDF 第 ${active.pages.join("、")} 页）缺少原因或处理，请检查解析结果；未发布。`);
		}
		entries.push({
			id: stableId(`${document.id}:${document.contentHash}:${entries.length}:${active.code}`),
			documentId: document.id,
			title: active.title,
			primaryFaultCode: active.code,
			faultCodes: [active.code, ...active.aliases],
			fields,
			text: [active.heading, ...active.lines].join("\n"),
			pdfPages: active.pages,
			printedPages: active.printed,
		});
		active = undefined;
	};

	for (const [pageIndex, page] of layoutText.split("\f").entries()) {
		const lines = page.split(/\r?\n/);
		// 只消费 4.2 节，避免把附录、索引或书目接到最后一个故障条目中。
		if (!lines.slice(0, 8).some((line) => /^4\.2\s*故障和报警列表\s*$/.test(line.trim()))) continue;
		let footer = lines.length;
		for (let i = Math.max(0, lines.length - 12); i < lines.length; i++) {
			if (/^SINAMICS\s+S120\/S150\s*$/.test(lines[i]!.trim()) || /^参数手册\s*[,，]/.test(lines[i]!.trim())) {
				footer = i;
				break;
			}
		}
		const footerText = lines.slice(Math.max(0, footer - 2)).join("\n");
		const printed = footerText.split("\n").map((line) =>
			line.match(/^\s*(\d{4})\s+参数手册/)?.[1] ?? line.match(/(?:^|\s)(\d{4})\s*$/)?.[1]
		).find(Boolean);
		const body = lines.slice(0, footer);
		for (const [lineIndex, raw] of body.entries()) {
			const line = raw.trim();
			if (!line || /^4\s+故障和报警$/.test(line) || /^4\.2\s*故障和报警列表$/.test(line)) continue;
			const match = line.normalize("NFKC").match(headingPattern);
			// 正文里的“故障码 + 描述”不是新条目；必须随后出现条目字段。
			const following = body.slice(lineIndex + 1, lineIndex + 5).find((next) => next.trim());
			const isHeading = match && following && /^信息值\s*[：:]/.test(following.trim());
			if (isHeading) {
				finish();
				const code = match[1]!;
				active = {
					code,
					heading: line.replace(/\s{2,}/g, " "),
					aliases: (match[2]?.match(/[FAN]/g) ?? []).filter((prefix) => prefix !== code[0]).map((prefix) => prefix + code.slice(1)),
					title: match[3]!,
					lines: [], pages: [], printed: [],
				};
			} else if (active) {
				active.lines.push(line.replace(/\s{2,}/g, " "));
			}
			if (active) {
				if (!active.pages.includes(pageIndex + 1)) active.pages.push(pageIndex + 1);
				if (printed && !active.printed.includes(printed)) active.printed.push(printed);
			}
		}
	}
	finish();
	if (entries.length === 0) throw new Error("没有解析到故障条目。当前适配器要求可提取文本的 Siemens 4.2 节，请勿把扫描件当成成功入库。");
	return entries;
}

/** 后续指南、FAQ、维修案例可以先用 Markdown；来源信息仍由 sources.json 登记。 */
export function parseMarkdown(text: string, document: KnowledgeDocument): KnowledgeEntry[] {
	const entries: KnowledgeEntry[] = [];
	let title = document.title;
	let lines: string[] = [];
	let fence: string | undefined;
	const finish = () => {
		const body = lines.join("\n").trim();
		if (body) entries.push({
			id: stableId(`${document.id}:${document.contentHash}:${entries.length}`),
			documentId: document.id, title, faultCodes: [], fields: {}, text: body,
			pdfPages: [], printedPages: [],
		});
		lines = [];
	};
	for (const line of text.split(/\r?\n/)) {
		const marker = line.match(/^\s*(`{3,}|~{3,})/);
		if (marker) {
			if (!fence) fence = marker[1]![0];
			else if (marker[1]![0] === fence) fence = undefined;
			lines.push(line);
			continue;
		}
		const heading = !fence && line.match(/^#{1,6}\s+(.+)$/);
		if (heading) { finish(); title = heading[1]!; }
		else lines.push(line);
	}
	finish();
	if (!entries.length) throw new Error(`${document.file} 没有正文。`);
	return entries;
}

/** 不跨条目合并；短条目整块、长条目按行拆分，命中后查询端回取父条目。 */
export function createChunks(entries: readonly KnowledgeEntry[], documents: readonly KnowledgeDocument[]): KnowledgeChunk[] {
	const byId = new Map(documents.map((document) => [document.id, document]));
	return entries.flatMap((entry) => {
		const document = byId.get(entry.documentId)!;
		const prefix = `${document.title}；版本 ${document.version}；产品 ${document.declaredProducts.join("/")}\n${entry.primaryFaultCode ?? ""} ${entry.title}\n`;
		const bodies: string[] = [];
		let current = "";
		for (const original of entry.text.split("\n")) {
			// 少数超长行也必须有限长，不能让 embedding 接口静默截断。
			const parts = original.match(/.{1,1200}/gu) ?? [];
			for (const line of parts) {
				if (current && current.length + line.length + 1 > 1200) {
					bodies.push(current);
					current = "";
				}
				current += `${current ? "\n" : ""}${line}`;
			}
		}
		if (current) bodies.push(current);
		return bodies.map((body, index) => ({ id: stableId(`${entry.id}:${index}:${body}`), entryId: entry.id, text: prefix + body }));
	});
}
