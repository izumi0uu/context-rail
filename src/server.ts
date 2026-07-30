import { readFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import type { RenderState } from "./render.ts";

const DEFAULT_HTML_PATH = fileURLToPath(new URL("../web/index.html", import.meta.url));

export interface ContextRailWebPayload extends RenderState {
	sequence: number;
	publishedAt: number;
}

export interface ContextRailViewer {
	readonly port: number;
	readonly url: string;
	publish(state: RenderState): void;
	stop(): Promise<void>;
}

export interface StartContextRailServerOptions {
	html?: string;
	port?: number;
}

function eventChunk(data: string): string {
	return `event: snapshot\ndata: ${data}\n\n`;
}

export async function startContextRailServer(
	options: StartContextRailServerOptions = {},
): Promise<ContextRailViewer> {
	const html = options.html ?? (await readFile(DEFAULT_HTML_PATH, "utf8"));
	const clients = new Set<ServerResponse>();
	let origin = "";
	let latest: string | undefined;
	let sequence = 0;
	let stopped = false;

	const server = createServer((request, response) => {
		const requestOrigin = request.headers.origin;
		if (requestOrigin && requestOrigin !== origin) {
			response.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
			response.end("Forbidden");
			return;
		}

		if (request.method !== "GET") {
			response.writeHead(405, { Allow: "GET" });
			response.end();
			return;
		}

		const pathname = new URL(request.url ?? "/", origin || "http://127.0.0.1").pathname;
		if (pathname === "/") {
			response.writeHead(200, {
				"Cache-Control": "no-store",
				"Content-Security-Policy":
					"default-src 'self'; connect-src 'self'; form-action 'none'; img-src 'self' data:; object-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
				"Content-Type": "text/html; charset=utf-8",
				"Referrer-Policy": "no-referrer",
				"X-Content-Type-Options": "nosniff",
			});
			response.end(html);
			return;
		}

		if (pathname === "/health") {
			response.writeHead(200, {
				"Cache-Control": "no-store",
				"Content-Type": "application/json; charset=utf-8",
			});
			response.end(JSON.stringify({ ok: true, clients: clients.size }));
			return;
		}

		if (pathname === "/events") {
			response.writeHead(200, {
				"Cache-Control": "no-cache, no-transform",
				Connection: "keep-alive",
				"Content-Type": "text/event-stream; charset=utf-8",
				"X-Accel-Buffering": "no",
			});
			response.write("retry: 1000\n\n");
			if (latest) response.write(eventChunk(latest));
			clients.add(response);

			const heartbeat = setInterval(() => response.write(": keepalive\n\n"), 15_000);
			request.on("close", () => {
				clearInterval(heartbeat);
				clients.delete(response);
			});
			return;
		}

		response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
		response.end("Not found");
	});

	await new Promise<void>((resolve, reject) => {
		const onError = (error: Error): void => reject(error);
		server.once("error", onError);
		server.listen(options.port ?? 0, "127.0.0.1", () => {
			server.off("error", onError);
			resolve();
		});
	});

	const address = server.address() as AddressInfo;
	origin = `http://127.0.0.1:${address.port}`;

	return {
		port: address.port,
		url: `${origin}/`,
		publish(state) {
			if (stopped) return;
			const payload: ContextRailWebPayload = {
				sequence: ++sequence,
				publishedAt: Date.now(),
				...state,
			};
			latest = JSON.stringify(payload);
			const chunk = eventChunk(latest);
			for (const client of clients) client.write(chunk);
		},
		async stop() {
			if (stopped) return;
			stopped = true;
			for (const client of clients) client.end();
			clients.clear();
			await new Promise<void>((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
			});
		},
	};
}
