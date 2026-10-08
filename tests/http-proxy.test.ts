import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { connect } from "node:net";
import { promisify } from "node:util";
import { test } from "node:test";

const exec = promisify(execFile);

for (const bypass of [false, true]) {
	test(bypass ? "NO_PROXY 使本地请求绕过代理" : "SDK 加载后初始化代理，请求通过 CONNECT 隧道", async () => {
		const target = createServer((_request, response) => response.end("ok"));
		const proxy = createServer();
		let tunnels = 0;
		proxy.on("connect", (request, socket, head) => {
			tunnels++;
			const destination = new URL(`http://${request.url}`);
			const upstream = connect(Number(destination.port), destination.hostname, () => {
				socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
				upstream.write(head);
				socket.pipe(upstream);
				upstream.pipe(socket);
			});
			socket.on("error", () => upstream.destroy());
			upstream.on("error", () => socket.destroy());
			socket.on("close", () => upstream.destroy());
		});
		await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
		await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
		try {
			const targetAddress = target.address();
			const proxyAddress = proxy.address();
			assert(targetAddress && typeof targetAddress !== "string");
			assert(proxyAddress && typeof proxyAddress !== "string");
			const proxyUrl = `http://127.0.0.1:${proxyAddress.port}`;
			const { stdout } = await exec(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
				import '@earendil-works/pi-coding-agent';
				import { configureHttpProxy } from './src/services/http-proxy.ts';
				configureHttpProxy();
				configureHttpProxy();
				const response = await fetch('http://127.0.0.1:${targetAddress.port}', {
					signal: AbortSignal.timeout(5000),
				});
				console.log(await response.text());
			`], {
				timeout: 10_000,
				env: {
					...process.env,
					HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl,
					http_proxy: proxyUrl, https_proxy: proxyUrl,
					NO_PROXY: bypass ? "127.0.0.1" : "",
					no_proxy: bypass ? "127.0.0.1" : "",
				},
			});
			assert.equal(stdout.trim(), "ok");
			assert.equal(tunnels, bypass ? 0 : 1);
		} finally {
			await Promise.all([
				new Promise<void>((resolve) => target.close(() => resolve())),
				new Promise<void>((resolve) => proxy.close(() => resolve())),
			]);
		}
	});
}
