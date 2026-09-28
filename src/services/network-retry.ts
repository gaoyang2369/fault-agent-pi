import { setTimeout as delay } from "node:timers/promises";

/** 仅用于可安全重放的请求；处理连接复用断开，不重试 HTTP 错误、超时或取消。 */
export async function retryNetworkRequest<T>(request: () => Promise<T>, signal?: AbortSignal): Promise<T> {
	for (let attempt = 0; ; attempt++) {
		signal?.throwIfAborted();
		try {
			return await request();
		} catch (error) {
			signal?.throwIfAborted();
			if (!(error instanceof TypeError) || attempt === 2) throw error;
			await delay(500 * (attempt + 1), undefined, { signal });
		}
	}
}
