/**
 * 命令行入口。
 *
 *   npm start                 交互式问答
 *   npm start -- "问题"       单次问答后退出
 */

import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { createDiagnosisAgent } from "./agent.ts";

/** 把会话事件渲染成终端输出：正文流式打印，工具调用与重试各打印一行。 */
function renderEvent(event: AgentSessionEvent): void {
	switch (event.type) {
		case "message_update":
			if (event.assistantMessageEvent.type === "text_delta") {
				stdout.write(event.assistantMessageEvent.delta);
			}
			break;
		case "tool_execution_start":
			stdout.write(`\n[工具] ${event.toolName} 执行中\n`);
			break;
		case "tool_execution_end":
			stdout.write(`[工具] ${event.toolName} ${event.isError ? "失败" : "完成"}\n`);
			break;
		case "auto_retry_start":
			stdout.write(
				`\n[重试] 第 ${event.attempt}/${event.maxAttempts} 次：${event.errorMessage}\n`,
			);
			break;
		default:
			break;
	}
}

/** 发送一轮提问并等待回答结束。 */
async function ask(session: AgentSession, question: string): Promise<void> {
	await session.prompt(question);
	stdout.write("\n");

	// 请求失败（鉴权、网络、限流等）不会让 prompt() 抛错，而是记录在 agent 状态里。
	const error = session.agent.state.errorMessage;
	if (error) process.stderr.write(`[错误] ${error}\n`);
}

/** 交互式问答循环，直到用户输入 exit/quit 或按下 Ctrl+C / Ctrl+D。 */
async function runRepl(session: AgentSession): Promise<void> {
	const rl = createInterface({ input: stdin, output: stdout });
	const modelName = session.model ? `${session.model.provider}/${session.model.id}` : "未知";
	stdout.write(`故障诊断 Agent 已就绪（模型：${modelName}）。输入 exit 退出。\n`);

	try {
		while (true) {
			const input = (await rl.question("\n> ")).trim();
			if (!input) continue;
			if (input === "exit" || input === "quit") break;
			await ask(session, input);
		}
	} catch {
		// Ctrl+C / Ctrl+D：正常退出。
	} finally {
		rl.close();
	}
}

async function main(): Promise<void> {
	const question = process.argv.slice(2).join(" ").trim();
	const session = await createDiagnosisAgent();
	const unsubscribe = session.subscribe(renderEvent);

	try {
		if (question) {
			await ask(session, question);
			return;
		}
		await runRepl(session);
	} finally {
		unsubscribe();
		session.dispose();
	}
}

main().catch((error: unknown) => {
	const message = error instanceof Error ? error.message : String(error);
	process.stderr.write(`启动失败：${message}\n`);
	process.exitCode = 1;
});
