import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";

let configured = false;

/** SDK 入口不会执行 pi CLI 的 HTTP 初始化，需在依赖加载后显式配置代理。 */
export function configureHttpProxy(): void {
	if (configured) return;
	if (!["http_proxy", "HTTP_PROXY", "https_proxy", "HTTPS_PROXY"].some((key) => process.env[key])) return;

	setGlobalDispatcher(new EnvHttpProxyAgent({
		proxyTunnel: true,
		// 本地 embedding / Qdrant 默认直连；用户设置的 NO_PROXY 优先。
		noProxy: process.env.no_proxy ?? process.env.NO_PROXY ?? "localhost,127.0.0.1,::1",
	}));
	configured = true;
}
