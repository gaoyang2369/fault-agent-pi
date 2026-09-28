import assert from "node:assert/strict";
import test from "node:test";
import { createChunks, parseFaultManual, parseMarkdown } from "../scripts/knowledge/parse.ts";
import type { KnowledgeDocument } from "../src/domain/knowledge/definition.ts";

const document: KnowledgeDocument = {
	id: "manual", file: "manual.pdf", title: "测试手册", version: "06/2020", documentNumber: "manual-1",
	manufacturer: "Siemens", language: "zh-CN", sourceType: "fault_manual",
	declaredProducts: ["S120"], applicableProducts: ["G120"], applicabilityNote: "测试登记", contentHash: "fixture",
};
const page = (body: string, footer: string) => `4 故障和报警\n4.2 故障和报警列表\n\n${body}\n\nSINAMICS S120/S150\n${footer}\n`;

test("跨页条目保留两种页码、类别码和完整处理，附录不混入正文", () => {
	const text = page(`F01011 (N)    下载中断\n信息值： %1\n信息类别： 配置错误\n驱动对象： 所有目标\n组件： 无    传播： GLOBAL\n反应： 无\n应答： 立即`, "参数手册 , 06/2020, manual-1       2491") + "\f" +
		page(`原因： 项目下载已中断。\n2: 通讯电缆断开。\n处理： - 检查通讯电缆。\n- 重新下载项目。\n在 … 时应答 N: 无\n\nA01013    风扇达到使用寿命\n信息值： %1\n驱动对象： 所有目标\n原因： 风扇超过使用寿命。\n处理： 更换风扇。`, "2492     参数手册 , 06/2020, manual-1") + "\f附录\n这不是故障条目的正文";
	const entries = parseFaultManual(text, document);
	assert.equal(entries.length, 2);
	const first = entries[0]!;
	assert.deepEqual(first.pdfPages, [1, 2]);
	assert.deepEqual(first.printedPages, ["2491", "2492"]);
	assert.deepEqual(first.faultCodes, ["F01011", "N01011"]);
	assert.equal(first.fields["组件"], "无");
	assert.equal(first.fields["传播"], "GLOBAL");
	assert.match(first.fields["处理"]!, /重新下载项目/);
	assert.match(first.text, /F01011 \(N\)/);
	assert.equal(first.fields["在 … 时应答 N"], "无");
	assert.ok(!entries[1]!.text.includes("附录"));
});

test("保留同码不同驱动对象的条目，正文引用码不产生伪条目", () => {
	const entries = parseFaultManual(page(`F01040    重新上电\n信息值： -\n驱动对象： SERVO\n原因： 更改参数。\nA06206 的报警值可详细说明原因。\n处理： 重新上电。\nF01040    重新上电\n信息值： -\n驱动对象： VECTOR\n原因： 更改另一参数。\n处理： 备份后重新上电。`, "参数手册 , 06/2020, manual-1      2500"), document);
	assert.equal(entries.length, 2);
	assert.notEqual(entries[0]!.id, entries[1]!.id);
	assert.equal(entries[1]!.fields["驱动对象"], "VECTOR");
	assert.match(entries[0]!.fields["原因"]!, /A06206/);
});

test("不完整条目和无文本扫描件不会发布成有效手册", () => {
	assert.throws(() => parseFaultManual(page("F01011 下载中断\n信息值： %1\n原因： 项目下载中断", "2491 参数手册 , 06/2020"), document), /缺少原因或处理/);
	assert.throws(() => parseFaultManual("", document), /没有解析到故障条目/);
});

test("长条目分块保留父条目，短条目不与其他故障混合", () => {
	const entries = parseFaultManual(page(`F01011 下载中断\n信息值： %1\n原因： ${"条件\n".repeat(1500)}\n处理： 检查通讯电缆。\nA01013 风扇寿命\n信息值： %1\n原因： 超时。\n处理： 更换风扇。`, "2491 参数手册 , 06/2020"), document);
	const chunks = createChunks(entries, [document]);
	assert.ok(chunks.filter((chunk) => chunk.entryId === entries[0]!.id).length > 1);
	assert.equal(chunks.filter((chunk) => chunk.entryId === entries[1]!.id).length, 1);
	assert.ok(chunks.every((chunk) => chunk.text.length < 1500));
	assert.deepEqual(chunks, createChunks(entries, [document]));
});

test("Markdown 按章节解析，代码块中的井号不成为标题", () => {
	const entries = parseMarkdown("# 检查风扇\n检查送风。\n```sh\n# 这是一条注释\necho ok\n```\n## 更换\n停止设备后更换。", { ...document, sourceType: "maintenance_guide", file: "guide.md" });
	assert.equal(entries.length, 2);
	assert.equal(entries[0]!.title, "检查风扇");
	assert.match(entries[0]!.text, /这是一条注释/);
	assert.deepEqual(entries[0]!.pdfPages, []);
});
