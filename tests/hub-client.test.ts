import assert from "node:assert/strict";
import { once } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import {
	connectContextRailHub,
	resolveHubCliPath,
	resolveNodeExecutable,
} from "../src/hub-client.ts";
import { readHubDiscovery } from "../src/hub-discovery.ts";
import {
	applyRenderStatePatch,
	decodeRenderStatePatchChunks,
	type ChunkedRenderStatePatch,
} from "../src/hub-delta.ts";
import type { ContextRailSessionSource } from "../src/hub-types.ts";
import type { RenderState } from "../src/render.ts";

interface RecordedRequest {
	path: string;
	body: string;
	bytes: number;
	json: unknown;
}

interface PublishDeltaBody extends ChunkedRenderStatePatch {
	source: ContextRailSessionSource;
	transferId: string;
	baseVersion: number;
}

async function startMockHub(
	onRequest: (request: RecordedRequest, response: ServerResponse) => void | Promise<void>,
): Promise<{ close: () => Promise<void> }> {
	const directory = mkdtempSync(join(tmpdir(), "context-rail-client-"));
	const discoveryPath = join(directory, "hub.json");
	const previousDiscoveryPath = process.env.CONTEXT_RAIL_DISCOVERY_FILE;
	const instanceId = `mock-hub-${Date.now()}-${Math.random()}`;
	const server = createServer(async (request, response) => {
		if (request.url === "/health") {
			response.setHeader("Content-Type", "application/json");
			response.end(JSON.stringify({ ok: true, instanceId }));
			return;
		}

		try {
			const body = await readRequestBody(request);
			await onRequest(
				{
					path: request.url ?? "",
					body,
					bytes: Buffer.byteLength(body),
					json: body ? JSON.parse(body) : undefined,
				},
				response,
			);
			if (!response.writableEnded) {
				response.statusCode = 202;
				response.end();
			}
		} catch (error) {
			response.statusCode = 500;
			response.end(error instanceof Error ? error.message : String(error));
		}
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address() as AddressInfo;
	writeFileSync(
		discoveryPath,
		JSON.stringify({
			version: 1,
			instanceId,
			pid: process.pid,
			port: address.port,
				url: `http://127.0.0.1:${address.port}/`,
				token: "m".repeat(43),
				viewerToken: "v".repeat(43),
				startedAt: Date.now(),
		}),
		{ mode: 0o600 },
	);
	process.env.CONTEXT_RAIL_DISCOVERY_FILE = discoveryPath;

	return {
		async close() {
			if (previousDiscoveryPath === undefined) delete process.env.CONTEXT_RAIL_DISCOVERY_FILE;
			else process.env.CONTEXT_RAIL_DISCOVERY_FILE = previousDiscoveryPath;
			await new Promise<void>((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
			});
			rmSync(directory, { force: true, recursive: true });
		},
	};
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	return Buffer.concat(chunks).toString("utf8");
}

async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await condition()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assert.fail("Condition was not met before timeout");
}

function source(sessionId = "session-a"): ContextRailSessionSource {
	return {
		processId: "process-a",
		processLabel: "Process A",
		sessionId,
		sessionLabel: sessionId,
		active: true,
	};
}

test("bounds acknowledged streams by LRU recency", async (t) => {
	const deltas: PublishDeltaBody[] = [];
	let targetCount = 0;
	let resolveTarget: (() => void) | undefined;
	const waitForCount = (count: number): Promise<void> => {
		targetCount = count;
		if (deltas.length >= count) return Promise.resolve();
		return new Promise((resolve) => {
			resolveTarget = resolve;
		});
	};
	const mock = await startMockHub((request) => {
		if (request.path !== "/api/publish-delta") return;
		assert.ok(isPublishDeltaBody(request.json));
		deltas.push(request.json);
		if (deltas.length >= targetCount) resolveTarget?.();
	});
	const viewer = await connectContextRailHub({ processId: "process-a" });
	t.after(async () => {
		await viewer?.stop();
		await mock.close();
	});
	assert.ok(viewer);

	for (let index = 0; index < 100; index += 1) {
		viewer.publish(renderState(`initial-${index}`, 1), source(`session-${index}`));
	}
	await waitForCount(100);

	viewer.publish(renderState("session-0-touched", 2), source("session-0"));
	await waitForCount(101);
	viewer.publish(renderState("session-100", 1), source("session-100"));
	await waitForCount(102);
	viewer.publish(renderState("session-0-retained", 3), source("session-0"));
	await waitForCount(103);
	viewer.publish(renderState("session-1-evicted", 2), source("session-1"));
	await viewer.stop();

	const resetFlags = (sessionId: string) => deltas
		.filter((delta) => delta.source.sessionId === sessionId)
		.map((delta) => Boolean(decodeRenderStatePatchChunks([delta]).reset));
	assert.deepEqual(resetFlags("session-0"), [true, false, false]);
	assert.deepEqual(resetFlags("session-1"), [true, true]);
});

function renderState(model: string, historyItems: number, toolNameBytes = 0): RenderState {
	const history = Array.from({ length: historyItems }, (_, index) => ({
		id: `message-${index}`,
		kind: index % 2 === 0 ? "user" as const : "assistant" as const,
		order: index,
		firstSeenAt: index,
		lastSeenAt: index,
		...(toolNameBytes > 0 ? { toolName: `${index}-${"x".repeat(toolNameBytes)}` } : {}),
	}));
	const active = history.at(-1) ?? {
		id: "message-empty",
		kind: "user" as const,
		order: 0,
		firstSeenAt: 0,
		lastSeenAt: 0,
	};
	return {
		phase: "context",
		activeTools: [],
		snapshot: {
			createdAt: historyItems,
			model,
			items: [{ id: active.id, kind: active.kind }],
		},
		timeline: {
			revision: historyItems,
			history,
			activeIds: [active.id],
			enteredIds: [active.id],
			retainedIds: [],
			exitedIds: [],
			observedIds: [],
			confirmedIds: [],
			pendingIds: [],
			summaryEdges: [],
		},
	};
}

function isPublishDeltaBody(value: unknown): value is PublishDeltaBody {
	if (!value || typeof value !== "object") return false;
	return "source" in value && "transferId" in value && "index" in value && "data" in value && "complete" in value;
}

function writeNodeFixture(path: string, version: string): void {
	writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' '${version}'\n`);
	chmodSync(path, 0o700);
}

test("resolves the Hub CLI beside source and compiled modules", (t) => {
	const directory = mkdtempSync(join(tmpdir(), "context-rail-cli-"));
	t.after(() => rmSync(directory, { force: true, recursive: true }));
	const sourceClient = join(directory, "hub-client.ts");
	const sourceCli = join(directory, "hub-cli.ts");
	writeFileSync(sourceClient, "");
	writeFileSync(sourceCli, "");
	assert.equal(resolveHubCliPath(pathToFileURL(sourceClient).href), sourceCli);

	rmSync(sourceCli);
	const compiledClient = join(directory, "hub-client.js");
	const compiledCli = join(directory, "hub-cli.js");
	writeFileSync(compiledClient, "");
	writeFileSync(compiledCli, "");
	assert.equal(resolveHubCliPath(pathToFileURL(compiledClient).href), compiledCli);

	rmSync(compiledCli);
	assert.throws(
		() => resolveHubCliPath(pathToFileURL(compiledClient).href),
		(error: unknown) =>
			error instanceof Error &&
			error.message.includes(join(directory, "hub-cli.js")) &&
			error.message.includes(join(directory, "hub-cli.ts")),
	);
});

test("resolves Node for a Bun-like host and validates an explicit override", (t) => {
	const directory = mkdtempSync(join(tmpdir(), "context-rail-node-"));
	t.after(() => rmSync(directory, { force: true, recursive: true }));
	const node = join(directory, "node");
	writeNodeFixture(node, "v22.6.0");

	assert.equal(resolveNodeExecutable("/opt/homebrew/bin/omp", { NVM_BIN: directory, PATH: "" }), node);
	assert.equal(
		resolveNodeExecutable("/opt/homebrew/bin/omp", { CONTEXT_RAIL_NODE: node, PATH: "" }),
		node,
	);
	assert.throws(
		() =>
			resolveNodeExecutable("/opt/homebrew/bin/omp", {
				CONTEXT_RAIL_NODE: join(directory, "missing"),
				PATH: "",
			}),
		/CONTEXT_RAIL_NODE is not executable/,
	);
});

test("skips older Node candidates and selects a Node 22.6 runtime", (t) => {
	const directory = mkdtempSync(join(tmpdir(), "context-rail-node-version-"));
	t.after(() => rmSync(directory, { force: true, recursive: true }));
	const oldDirectory = join(directory, "old");
	const currentDirectory = join(directory, "current");
	const oldNode = join(oldDirectory, "node");
	const currentNode = join(currentDirectory, "node");
	mkdirSync(oldDirectory);
	mkdirSync(currentDirectory);
	writeNodeFixture(oldNode, "v20.19.0");
	writeNodeFixture(currentNode, "v22.6.1");

	assert.equal(
		resolveNodeExecutable("/opt/homebrew/bin/omp", {
			NVM_BIN: oldDirectory,
			PATH: `${oldDirectory}${delimiter}${currentDirectory}`,
		}),
		currentNode,
	);
});

test("rejects an explicit pre-22.6 Node runtime with its path and version", (t) => {
	const directory = mkdtempSync(join(tmpdir(), "context-rail-node-old-"));
	t.after(() => rmSync(directory, { force: true, recursive: true }));
	const node = join(directory, "node");
	writeNodeFixture(node, "v22.5.1");

	assert.throws(
		() =>
			resolveNodeExecutable("/opt/homebrew/bin/omp", {
				CONTEXT_RAIL_NODE: node,
				PATH: "",
			}),
		(error: unknown) =>
			error instanceof Error &&
			error.message.includes(node) &&
			error.message.includes("v22.5.1") &&
			error.message.includes("22.6.0"),
	);
});

test("chunks an initial large timeline into bounded delta requests without losing state", async (t) => {
	const requests: RecordedRequest[] = [];
	const mock = await startMockHub((request) => {
		requests.push(request);
	});
	const viewer = await connectContextRailHub({ processId: "process-a" });
	t.after(async () => {
		await viewer?.stop();
		await mock.close();
	});
	assert.ok(viewer);

	const expected = renderState("large-model", 4_000, 600);
	assert.ok(Buffer.byteLength(JSON.stringify({ source: source(), state: expected })) > 2 * 1024 * 1024);
	viewer.publish(expected, source());
	await viewer.stop();

	const deltaRequests = requests.filter((request) => request.path === "/api/publish-delta");
	const deltas = deltaRequests.map((request) => {
		assert.ok(isPublishDeltaBody(request.json));
		return request.json;
	});
	assert.ok(deltas.length > 1, "large initial history should require multiple requests");
	assert.ok(
		deltaRequests.every((request) => request.bytes <= 258 * 1024),
		`largest delta request was ${Math.max(...deltaRequests.map((request) => request.bytes))} bytes`,
	);
	assert.ok(deltaRequests.every((request) => request.bytes < 2 * 1024 * 1024));
	assert.ok(deltas.slice(0, -1).every((delta) => !delta.complete));
	assert.equal(deltas.at(-1)?.complete, true);

	const reconstructed = applyRenderStatePatch(undefined, decodeRenderStatePatchChunks(deltas));
	assert.deepEqual(reconstructed, expected);
});

test("coalesces queued publishes for one stream to the latest state", async (t) => {
	const deltas: PublishDeltaBody[] = [];
	let releaseFirstResponse = () => {};
	let markFirstReceived = () => {};
	const firstResponseGate = new Promise<void>((resolve) => {
		releaseFirstResponse = resolve;
	});
	const firstReceived = new Promise<void>((resolve) => {
		markFirstReceived = resolve;
	});
	const mock = await startMockHub(async (request) => {
		if (request.path !== "/api/publish-delta") return;
		assert.ok(isPublishDeltaBody(request.json));
		deltas.push(request.json);
		if (deltas.length === 1) {
			markFirstReceived();
			await firstResponseGate;
		}
	});
	const viewer = await connectContextRailHub({ processId: "process-a" });
	t.after(async () => {
		releaseFirstResponse();
		await viewer?.stop();
		await mock.close();
	});
	assert.ok(viewer);

	const first = renderState("model-v1", 1);
	const intermediate = renderState("model-v2", 2);
	const latest = renderState("model-v3", 3);
	viewer.publish(first, source());
	await firstReceived;
	viewer.publish(intermediate, source());
	viewer.publish(latest, source());
	releaseFirstResponse();
	await viewer.stop();

	assert.equal(deltas.length, 2);
	const patches = deltas.map((delta) => decodeRenderStatePatchChunks([delta]));
	assert.deepEqual(
		patches.map((patch) => patch.snapshot?.model),
		["model-v1", "model-v3"],
	);
	let reconstructed: RenderState | undefined;
	for (const patch of patches) reconstructed = applyRenderStatePatch(reconstructed, patch);
	assert.deepEqual(reconstructed, latest);
});

test("retries a failed delta while idle and clears the transient unhealthy state", async (t) => {
	let publishRequests = 0;
	let publishedState: RenderState | undefined;
	const mock = await startMockHub((request, response) => {
		if (request.path !== "/api/publish-delta") return;
		publishRequests += 1;
		if (publishRequests === 1) {
			response.statusCode = 503;
			response.end("unavailable");
			return;
		}
		assert.ok(isPublishDeltaBody(request.json));
		publishedState = applyRenderStatePatch(
			publishedState,
			decodeRenderStatePatchChunks([request.json]),
		);
		response.setHeader("Content-Type", "application/json");
		response.end(JSON.stringify({ ok: true, version: 1 }));
	});
	const viewer = await connectContextRailHub({ processId: "process-a" });
	t.after(async () => {
		await viewer?.stop();
		await mock.close();
	});
	assert.ok(viewer);
	assert.equal(await viewer.healthy(), true);

	const expected = renderState("recovered-model", 1);
	viewer.publish(expected, source());
	await waitFor(() => publishRequests >= 1);
	assert.equal(await viewer.healthy(), false);
	await waitFor(() => publishRequests >= 2);
	await waitFor(() => viewer.healthy());

	assert.equal(publishRequests, 2);
	assert.deepEqual(publishedState, expected);
	assert.equal((await fetch(`${viewer.url}health`)).status, 200);
	assert.equal(await viewer.healthy(), true);
});

test("retries the latest state when it supersedes a failed in-flight delta", async (t) => {
	let publishRequests = 0;
	let publishedState: RenderState | undefined;
	let markFirstReceived = () => {};
	let releaseFirstResponse = () => {};
	const firstReceived = new Promise<void>((resolve) => {
		markFirstReceived = resolve;
	});
	const firstResponseGate = new Promise<void>((resolve) => {
		releaseFirstResponse = resolve;
	});
	const mock = await startMockHub(async (request, response) => {
		if (request.path !== "/api/publish-delta") return;
		publishRequests += 1;
		if (publishRequests === 1) {
			markFirstReceived();
			await firstResponseGate;
			response.statusCode = 503;
			response.end("unavailable");
			return;
		}
		assert.ok(isPublishDeltaBody(request.json));
		publishedState = applyRenderStatePatch(
			publishedState,
			decodeRenderStatePatchChunks([request.json]),
		);
		response.setHeader("Content-Type", "application/json");
		response.end(JSON.stringify({ ok: true, version: 1 }));
	});
	const viewer = await connectContextRailHub({ processId: "process-a" });
	t.after(async () => {
		releaseFirstResponse();
		await viewer?.stop();
		await mock.close();
	});
	assert.ok(viewer);

	viewer.publish(renderState("failed-model", 1), source());
	await firstReceived;
	const latest = renderState("latest-model", 2);
	viewer.publish(latest, source());
	releaseFirstResponse();
	await waitFor(() => publishRequests >= 2);
	await waitFor(() => viewer.healthy());

	assert.equal(publishRequests, 2);
	assert.deepEqual(publishedState, latest);
});

test("stop cancels a scheduled publish retry", { timeout: 2_000 }, async (t) => {
	let publishRequests = 0;
	const mock = await startMockHub((request, response) => {
		if (request.path !== "/api/publish-delta") return;
		publishRequests += 1;
		response.statusCode = 503;
		response.end("unavailable");
	});
	const viewer = await connectContextRailHub({ processId: "process-a" });
	t.after(async () => {
		await viewer?.stop();
		await mock.close();
	});
	assert.ok(viewer);

	viewer.publish(renderState("stopping-model", 1), source());
	await waitFor(() => publishRequests === 1);
	await waitFor(async () => !(await viewer.healthy()));
	await viewer.stop();
	await new Promise((resolve) => setTimeout(resolve, 350));

	assert.equal(publishRequests, 1);
});

test("dispose cancels retries without sending a process disconnect", async (t) => {
	const paths: string[] = [];
	const mock = await startMockHub((request, response) => {
		paths.push(request.path);
		if (request.path === "/api/publish-delta") {
			response.statusCode = 503;
			response.end("unavailable");
		}
	});
	t.after(() => mock.close());
	const viewer = await connectContextRailHub({ processId: "process-a" });
	assert.ok(viewer);

	viewer.publish(renderState("failed", 1), source());
	await waitFor(() => paths.includes("/api/publish-delta"));
	viewer.dispose?.();
	await new Promise((resolve) => setTimeout(resolve, 300));

	assert.deepEqual(paths, ["/api/publish-delta"]);
});

test("waits for in-flight controls before disconnecting and rejects work after stop", async (t) => {
	const paths: string[] = [];
	let releaseHeartbeat = () => {};
	let markHeartbeat = () => {};
	const heartbeatGate = new Promise<void>((resolve) => {
		releaseHeartbeat = resolve;
	});
	const heartbeatReceived = new Promise<void>((resolve) => {
		markHeartbeat = resolve;
	});
	const mock = await startMockHub(async (request) => {
		paths.push(request.path);
		if (request.path === "/api/heartbeat") {
			markHeartbeat();
			await heartbeatGate;
		}
	});
	const viewer = await connectContextRailHub({ processId: "process-a" });
	t.after(async () => {
		releaseHeartbeat();
		await viewer?.stop();
		await mock.close();
	});
	assert.ok(viewer);

	viewer.heartbeat("process-a");
	viewer.disconnect("process-a");
	await heartbeatReceived;
	const stopping = viewer.stop();
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.deepEqual(paths, ["/api/heartbeat"]);

	releaseHeartbeat();
	await stopping;
	assert.deepEqual(paths, ["/api/heartbeat", "/api/disconnect", "/api/disconnect"]);
	viewer.heartbeat("process-a");
	viewer.publish(renderState("ignored", 1), source());
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.deepEqual(paths, ["/api/heartbeat", "/api/disconnect", "/api/disconnect"]);
	assert.equal(await viewer.healthy(), false);
});

test("retries a version conflict as a full reset and removes foreign history", async (t) => {
	let serverState = renderState("foreign", 1);
	serverState.timeline!.history[0]!.id = "ghost";
	serverState.timeline!.activeIds = ["ghost"];
	serverState.snapshot!.items = [{ id: "ghost", kind: "user" }];
	let version = 1;
	const requests: PublishDeltaBody[] = [];
	let successfulPublishes = 0;
	let markPublished = () => {};
	let published = new Promise<void>((resolve) => {
		markPublished = resolve;
	});

	const mock = await startMockHub((request, response) => {
		if (request.path !== "/api/publish-delta") return;
		assert.ok(isPublishDeltaBody(request.json));
		const delta = request.json;
		requests.push(delta);
		assert.equal(delta.complete, true);
		response.setHeader("Content-Type", "application/json");
		if (delta.baseVersion !== version) {
			response.statusCode = 409;
			response.end(JSON.stringify({ ok: false, error: "version_conflict", version }));
			return;
		}
		serverState = applyRenderStatePatch(serverState, decodeRenderStatePatchChunks([delta]));
		version += 1;
		successfulPublishes += 1;
		response.statusCode = 202;
		response.end(JSON.stringify({ ok: true, version }));
		markPublished();
	});
	const viewer = await connectContextRailHub({ processId: "process-a" });
	t.after(async () => {
		await viewer?.stop();
		await mock.close();
	});
	assert.ok(viewer);

	const first = renderState("local-v1", 1);
	viewer.publish(first, source());
	await published;
	assert.deepEqual(serverState, first);

	serverState = renderState("foreign-v2", 1);
	serverState.timeline!.history[0]!.id = "ghost-v2";
	serverState.timeline!.activeIds = ["ghost-v2"];
	serverState.snapshot!.items = [{ id: "ghost-v2", kind: "user" }];
	version += 1;
	published = new Promise<void>((resolve) => {
		markPublished = resolve;
	});
	const second = renderState("local-v2", 2);
	viewer.publish(second, source());
	await published;
	assert.deepEqual(serverState, second);
	assert.equal(successfulPublishes, 2);

	const patches = requests.map((delta) => decodeRenderStatePatchChunks([delta]));
	assert.deepEqual(requests.map(({ baseVersion }) => baseVersion), [0, 1, 2, 3]);
	assert.deepEqual(patches.map(({ reset }) => reset ?? false), [true, true, false, true]);
});

test("starts a detached Hub and connects through its discovery file", async (t) => {
	const directory = mkdtempSync(join(tmpdir(), "context-rail-start-"));
	const discoveryPath = join(directory, "hub.json");
	const previousDiscoveryPath = process.env.CONTEXT_RAIL_DISCOVERY_FILE;
	process.env.CONTEXT_RAIL_DISCOVERY_FILE = discoveryPath;

	t.after(async () => {
		const discovery = await readHubDiscovery();
		if (discovery) {
			try {
				process.kill(discovery.pid, "SIGTERM");
			} catch {
				// The Hub may already have completed shutdown.
			}
		}
		for (let index = 0; index < 20; index += 1) {
			if (!(await readHubDiscovery())) break;
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		if (previousDiscoveryPath === undefined) delete process.env.CONTEXT_RAIL_DISCOVERY_FILE;
		else process.env.CONTEXT_RAIL_DISCOVERY_FILE = previousDiscoveryPath;
		rmSync(directory, { force: true, recursive: true });
	});

	const viewer = await connectContextRailHub({
		processId: "hub-client-test",
		startIfMissing: true,
		timeoutMs: 5_000,
	});
	assert.ok(viewer);
	assert.equal(await viewer.healthy(), true);
	assert.match(viewer.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
	const discovery = await readHubDiscovery();
	assert.ok(discovery);
	assert.equal(viewer.viewerUrl, `${viewer.url}#token=${encodeURIComponent(discovery.viewerToken)}`);
});
