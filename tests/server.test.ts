import assert from "node:assert/strict";
import { connect } from "node:net";
import test from "node:test";
import {
	applyRenderStatePatch,
	chunkRenderStatePatch,
	decodeRenderStatePatchChunks,
	diffRenderState,
} from "../src/hub-delta.ts";
import {
	streamIdFor,
	type ContextRailHubUpdate,
	type ContextRailSessionSource,
} from "../src/hub-types.ts";
import type { RenderState } from "../src/render.ts";
import { startContextRailServer, type ContextRailViewer } from "../src/server.ts";

const JSON_HEADERS = { "Content-Type": "application/json" };

function state(model: string, id: string): RenderState {
	return {
		phase: "context",
		activeTools: [],
		snapshot: {
			createdAt: 1,
			model,
			items: [{ id, kind: "user" }],
		},
		timeline: {
			revision: 1,
			history: [{ id, kind: "user", order: 0, firstSeenAt: 1, lastSeenAt: 1 }],
			activeIds: [id],
			enteredIds: [id],
			retainedIds: [],
			exitedIds: [],
			observedIds: [],
			confirmedIds: [],
			pendingIds: [],
			summaryEdges: [],
		},
	};
}

function source(processId: string, sessionId: string, active = true): ContextRailSessionSource {
	return {
		processId,
		processLabel: processId,
		sessionId,
		sessionLabel: sessionId,
		active,
	};
}

test("builds collision-free stream ids without changing ordinary ids", () => {
	assert.equal(streamIdFor(source("process", "session")), "process:session");
	assert.notEqual(
		streamIdFor(source("process:one", "session")),
		streamIdFor(source("process", "one:session")),
	);
	assert.equal(streamIdFor(source("process:one", "session%two")), "process%3Aone:session%25two");
});

async function readSse(reader: ReadableStreamDefaultReader<Uint8Array>, pattern: RegExp): Promise<string> {
	let result = "";
	const deadline = Date.now() + 5_000;
	while (!pattern.test(result) && Date.now() < deadline) {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const chunk = await Promise.race([
			reader.read(),
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error("Timed out waiting for SSE data")), deadline - Date.now());
			}),
		]).finally(() => {
			if (timer) clearTimeout(timer);
		});
		if (chunk.done) break;
		result += new TextDecoder().decode(chunk.value);
		if (result.length > 16 * 1024 * 1024) throw new Error("SSE test payload exceeded 16 MiB");
	}
	if (!pattern.test(result)) throw new Error(`SSE stream ended before ${pattern} was received`);
	return result;
}

function sseData<T>(text: string, event: string): T {
	for (const block of text.split("\n\n")) {
		if (!block.includes(`event: ${event}`)) continue;
		const data = block
			.split("\n")
			.find((line) => line.startsWith("data: "))
			?.slice(6);
		if (data) return JSON.parse(data) as T;
	}
	assert.fail(`Missing ${event} SSE event`);
}

function sseDataAll<T>(text: string, event: string): T[] {
	const payloads: T[] = [];
	for (const block of text.split("\n\n")) {
		if (!block.includes(`event: ${event}`)) continue;
		const data = block
			.split("\n")
			.find((line) => line.startsWith("data: "))
			?.slice(6);
		if (data) payloads.push(JSON.parse(data) as T);
	}
	return payloads;
}

async function health(viewerUrl: string): Promise<{ clients: number; sessions: number }> {
	const response = await fetch(`${viewerUrl}health`);
	return await response.json() as { clients: number; sessions: number };
}

function eventsUrl(viewer: ContextRailViewer): string {
	const url = new URL("events", viewer.url);
	const token = new URLSearchParams(new URL(viewer.viewerUrl).hash.slice(1)).get("token");
	if (token) url.searchParams.set("token", token);
	return url.href;
}

async function waitFor(
	condition: () => Promise<boolean>,
	timeoutMs = 500,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await condition()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	assert.fail("Condition was not met before timeout");
}

async function postDelta(
	viewerUrl: string,
	token: string,
	body: Record<string, unknown>,
): Promise<Response> {
	return fetch(`${viewerUrl}api/publish-delta`, {
		method: "POST",
		headers: { Authorization: `Bearer ${token}`, ...JSON_HEADERS },
		body: JSON.stringify(body),
	});
}

function largeState(count: number, padding = 0): RenderState {
	const history = Array.from({ length: count }, (_, index) => ({
		id: `message-${index}`,
		kind: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
		order: index,
		firstSeenAt: index + 1,
		lastSeenAt: index + 1,
		confirmedAt: index + 1,
		...(padding > 0 ? { toolName: `${index}-${"x".repeat(padding)}` } : {}),
	}));
	const activeIds = history.slice(-4).map(({ id }) => id);
	return {
		phase: "context",
		activeTools: [],
		snapshot: {
			createdAt: count,
			model: "large-model",
			items: history.slice(-4).map(({ id, kind }) => ({ id, kind })),
		},
		timeline: {
			revision: count,
			history,
			activeIds,
			enteredIds: activeIds,
			retainedIds: [],
			exitedIds: history.slice(0, -4).map(({ id }) => id),
			observedIds: [],
			confirmedIds: activeIds,
			pendingIds: [],
			summaryEdges: [],
		},
	};
}

test("serves a multi-session bootstrap and publishes authenticated updates", async (t) => {
	const token = "test-token";
	const viewerToken = "viewer-test-token";
	const viewer = await startContextRailServer({
		html: "<!doctype html><title>test viewer</title>",
		token,
		viewerToken,
		instanceId: "hub-test",
	});
	t.after(() => viewer.stop());

	viewer.publish(state("model-a", "message-a"), source("process-a", "session-a"));
	viewer.publish(state("model-b", "message-b"), source("process-b", "session-b"));

	const page = await fetch(viewer.url);
	assert.equal(page.status, 200);
	const pageHtml = await page.text();
	assert.match(pageHtml, /test viewer/);
	assert.doesNotMatch(pageHtml, /test-token/);
	assert.equal(page.headers.get("cache-control"), "no-store");
	assert.match(page.headers.get("content-security-policy") ?? "", /connect-src 'self'/);
	assert.equal(viewer.url.includes(token), false);
	assert.equal(viewer.viewerUrl, `${viewer.url}#token=viewer-test-token`);

	const coreAsset = await fetch(`${viewer.url}assets/scene-core.js`);
	assert.equal(coreAsset.status, 200);
	assert.match(coreAsset.headers.get("content-type") ?? "", /text\/javascript/);
	assert.equal(coreAsset.headers.get("x-content-type-options"), "nosniff");
	assert.match(await coreAsset.text(), /ContextRailCore/);
	const coreAssetWithQuery = await fetch(`${viewer.url}assets/scene-core.js?revision=test`);
	assert.equal(coreAssetWithQuery.status, 200);
	const coreSourceMap = await fetch(`${viewer.url}assets/scene-core.js.map`);
	assert.equal(coreSourceMap.status, 404);
	const nestedCoreAsset = await fetch(`${viewer.url}assets/scene-core.js/extra`);
	assert.equal(nestedCoreAsset.status, 404);

	const rendererAsset = await fetch(`${viewer.url}assets/pixi-history.js`);
	assert.equal(rendererAsset.status, 200);
	assert.match(rendererAsset.headers.get("content-type") ?? "", /text\/javascript/);
	assert.equal(rendererAsset.headers.get("x-content-type-options"), "nosniff");
	assert.match(await rendererAsset.text(), /ContextRailPixi/);
	const rendererAssetWithQuery = await fetch(`${viewer.url}assets/pixi-history.js?revision=test`);
	assert.equal(rendererAssetWithQuery.status, 200);
	const rendererSourceMap = await fetch(`${viewer.url}assets/pixi-history.js.map`);
	assert.equal(rendererSourceMap.status, 404);
	const unknownRendererAsset = await fetch(`${viewer.url}assets/other-renderer.js`);
	assert.equal(unknownRendererAsset.status, 404);
	const nestedRendererAsset = await fetch(`${viewer.url}assets/pixi-history.js/extra`);
	assert.equal(nestedRendererAsset.status, 404);

	const missingToken = await fetch(`${viewer.url}events`);
	assert.equal(missingToken.status, 401);
	const wrongToken = await fetch(`${viewer.url}events?token=wrong-token`);
	assert.equal(wrongToken.status, 401);
	const producerTokenOnEvents = await fetch(`${viewer.url}events?token=${encodeURIComponent(token)}`);
	assert.equal(producerTokenOnEvents.status, 401);

	const stream = await fetch(eventsUrl(viewer));
	assert.equal(stream.status, 200);
	assert.match(stream.headers.get("content-type") ?? "", /text\/event-stream/);
	assert.ok(stream.body);
	const reader = stream.body.getReader();
	const bootstrap = await readSse(reader, /event: bootstrap/);
	assert.match(bootstrap, /event: bootstrap/);
	assert.match(bootstrap, /"model":"model-a"/);
	assert.match(bootstrap, /"model":"model-b"/);
	assert.match(bootstrap, /"sessionId":"session-a"/);
	await reader.cancel();

	const unauthorized = await fetch(`${viewer.url}api/publish`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ source: source("process-c", "session-c"), state: state("model-c", "message-c") }),
	});
	assert.equal(unauthorized.status, 401);
	const viewerTokenOnApi = await fetch(`${viewer.url}api/publish`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${viewerToken}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ source: source("process-c", "session-c"), state: state("model-c", "message-c") }),
	});
	assert.equal(viewerTokenOnApi.status, 401);

	const published = await fetch(`${viewer.url}api/publish`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ source: source("process-c", "session-c"), state: state("model-c", "message-c") }),
	});
	assert.equal(published.status, 202);

	const health = await fetch(`${viewer.url}health`);
	assert.deepEqual(await health.json(), { ok: true, instanceId: "hub-test", clients: 0, sessions: 3 });
});

test("uses a distinct CSP nonce for every viewer response", async (t) => {
	const viewer = await startContextRailServer({
		html: '<!doctype html><script src="/assets/scene-core.js"></script><script>globalThis.ready = true;</script>',
	});
	t.after(() => viewer.stop());

	const first = await fetch(viewer.url);
	const second = await fetch(viewer.url);
	const firstPolicy = first.headers.get("content-security-policy") ?? "";
	const secondPolicy = second.headers.get("content-security-policy") ?? "";
	const firstNonce = firstPolicy.match(/'nonce-([^']+)'/)?.[1];
	const secondNonce = secondPolicy.match(/'nonce-([^']+)'/)?.[1];
	assert.ok(firstNonce);
	assert.ok(secondNonce);
	assert.notEqual(firstNonce, secondNonce);
	assert.doesNotMatch(firstPolicy, /script-src[^;]*'unsafe-inline'/);
	assert.ok((await first.text()).includes(`<script nonce="${firstNonce}">`));
	assert.ok((await second.text()).includes(`<script nonce="${secondNonce}">`));
});

test("starts and serves the DOM fallback when the optional Pixi asset is unavailable", async (t) => {
	const assetReads: string[] = [];
	const viewer = await startContextRailServer({
		html: "<!doctype html><script src='./assets/scene-core.js'></script><script src='./assets/pixi-history.js'></script>",
		webAssetLoader: async (path) => {
			assetReads.push(path);
			if (path.endsWith("/pixi-history.js")) throw new Error("optional Pixi asset unavailable");
			return Buffer.from("var ContextRailCore = {};", "utf8");
		},
	});
	t.after(() => viewer.stop());

	const page = await fetch(viewer.url);
	assert.equal(page.status, 200);
	const coreAsset = await fetch(`${viewer.url}assets/scene-core.js`);
	assert.equal(coreAsset.status, 200);
	assert.match(await coreAsset.text(), /ContextRailCore/);
	assert.equal((await fetch(`${viewer.url}assets/scene-core.js?again=1`)).status, 200);
	const pixiAsset = await fetch(`${viewer.url}assets/pixi-history.js`);
	assert.equal(pixiAsset.status, 404);
	assert.equal(await pixiAsset.text(), "Not found");
	assert.equal((await fetch(`${viewer.url}health`)).status, 200);
	assert.equal(assetReads.filter((path) => path.endsWith("/scene-core.js")).length, 1);
	assert.equal(assetReads.filter((path) => path.endsWith("/pixi-history.js")).length, 1);
});

test("refuses to start without the required scene core", async () => {
	await assert.rejects(
		startContextRailServer({
			html: "<!doctype html>",
			webAssetLoader: async () => {
				throw new Error("required scene core unavailable");
			},
		}),
		/required scene core unavailable/,
	);
});

test("rejects a shared producer and viewer capability", async () => {
	await assert.rejects(
		startContextRailServer({ html: "ok", token: "shared-token", viewerToken: "shared-token" }),
		/read and write capabilities must be different/i,
	);
});

test("projects published state onto the allowlisted detail schema before streaming", async (t) => {
	const token = "projection-token";
	const viewer = await startContextRailServer({ html: "ok", token });
	t.after(() => viewer.stop());
	const stream = await fetch(eventsUrl(viewer));
	assert.ok(stream.body);
	const reader = stream.body.getReader();
	await readSse(reader, /event: bootstrap/);

	const unsafeState = state("safe-model", "message-safe") as unknown as Record<string, unknown>;
	unsafeState.content = "top-level-secret";
	const snapshot = unsafeState.snapshot as { items: Array<Record<string, unknown>> };
	snapshot.items[0]!.content = "snapshot-secret";
	const timeline = unsafeState.timeline as { history: Array<Record<string, unknown>> };
	timeline.history[0]!.content = "history-secret";
	timeline.history[0]!.detail = {
		sourceRole: "user",
		modelMessages: [{
			modelRole: "user",
			blocks: [{ type: "text", text: "visible context", signature: "block-secret" }],
		}],
		private: "detail-secret",
	};
	const response = await fetch(`${viewer.url}api/publish`, {
		method: "POST",
		headers: { Authorization: `Bearer ${token}`, ...JSON_HEADERS },
		body: JSON.stringify({
			source: { ...source("process-safe", "session-safe"), content: "source-secret" },
			state: unsafeState,
		}),
	});
	assert.equal(response.status, 202);

	const text = await readSse(reader, /"model":"safe-model"/);
	await reader.cancel();
	assert.doesNotMatch(text, /secret/);
	const update = sseData<ContextRailHubUpdate>(text, "update");
	const expected = state("safe-model", "message-safe");
	expected.timeline!.history[0]!.detail = {
		sourceRole: "user",
		modelMessages: [{
			modelRole: "user",
			blocks: [{ type: "text", text: "visible context" }],
		}],
	};
	assert.deepEqual(update.changed?.state, expected);

	const invalid = await fetch(`${viewer.url}api/publish`, {
		method: "POST",
		headers: { Authorization: `Bearer ${token}`, ...JSON_HEADERS },
		body: JSON.stringify({
			source: { ...source("process-invalid", "session-invalid"), active: "yes" },
			state: { phase: "context", activeTools: [] },
		}),
	});
	assert.equal(invalid.status, 400);
	assert.equal((await health(viewer.url)).sessions, 1);
});

test("re-encodes delta events from the allowlisted detail patch", async (t) => {
	const token = "delta-projection-token";
	const viewer = await startContextRailServer({ html: "ok", token });
	t.after(() => viewer.stop());
	const stream = await fetch(eventsUrl(viewer));
	assert.ok(stream.body);
	const reader = stream.body.getReader();
	await readSse(reader, /event: bootstrap/);

	const expected = state("safe-delta-model", "safe-delta-message");
	const unsafePatch = diffRenderState(undefined, expected) as unknown as Record<string, unknown>;
	unsafePatch.content = "top-level-delta-secret";
	const snapshot = unsafePatch.snapshot as { items: Array<Record<string, unknown>> };
	snapshot.items[0]!.content = "snapshot-delta-secret";
	const timeline = unsafePatch.timeline as { historyUpserts: Array<Record<string, unknown>> };
	timeline.historyUpserts[0]!.content = "history-delta-secret";
	timeline.historyUpserts[0]!.detail = {
		sourceRole: "user",
		modelMessages: [{
			modelRole: "user",
			blocks: [{ type: "text", text: "visible delta context", signature: "block-delta-secret" }],
		}],
	};
	expected.timeline!.history[0]!.detail = {
		sourceRole: "user",
		modelMessages: [{
			modelRole: "user",
			blocks: [{ type: "text", text: "visible delta context" }],
		}],
	};
	const chunks = chunkRenderStatePatch(unsafePatch);
	for (const chunk of chunks) {
		const response = await postDelta(viewer.url, token, {
			source: source("process-delta-safe", "session-delta-safe"),
			transferId: "safe-transfer",
			baseVersion: 0,
			...chunk,
		});
		assert.equal(response.status, 202);
	}

	const text = await readSse(reader, /"complete":true/);
	await reader.cancel();
	assert.doesNotMatch(text, /secret/);
	const updates = sseDataAll<ContextRailHubUpdate>(text, "update");
	const streamedChunks = updates.flatMap(({ delta }) => delta ? [delta] : []);
	assert.ok(streamedChunks.length > 0);
	assert.deepEqual(
		applyRenderStatePatch(undefined, decodeRenderStatePatchChunks(streamedChunks)),
		expected,
	);
});

test("commits a chunked delta atomically and streams reconstructable patches", async (t) => {
	const token = "delta-token";
	const viewer = await startContextRailServer({ html: "ok", token });
	t.after(() => viewer.stop());
	const stream = await fetch(eventsUrl(viewer));
	assert.ok(stream.body);
	const reader = stream.body.getReader();
	await readSse(reader, /event: bootstrap/);

	const target = largeState(400);
	const chunks = chunkRenderStatePatch(diffRenderState(undefined, target), 4 * 1024);
	assert.ok(chunks.length > 2);
	for (const [index, chunk] of chunks.entries()) {
		const response = await fetch(`${viewer.url}api/publish-delta`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				source: source("process-delta", "session-delta"),
				transferId: "transfer-delta",
				baseVersion: 0,
				...chunk,
			}),
		});
		assert.equal(response.status, 202);
		if (index === 0) {
			const health = await fetch(`${viewer.url}health`);
			assert.equal((await health.json() as { sessions: number }).sessions, 0);
		}
	}

	const text = await readSse(reader, /"complete":true/);
	const updates = sseDataAll<{
		activity?: boolean;
		sessions?: Array<{ historyItems: number }>;
		delta?: { streamId: string; transferId: string; index: number; data: string; complete: boolean };
		changed?: unknown;
	}>(text, "update");
	await reader.cancel();
	assert.equal(updates.length, chunks.length);
	assert.ok(updates.every(({ changed }) => changed === undefined));
	assert.deepEqual(updates.map(({ delta }) => delta?.complete), chunks.map(({ complete }) => complete));
	assert.ok(updates.slice(0, -1).every(({ activity }) => activity === undefined));
	assert.equal(updates.at(-1)?.activity, true);
	assert.ok(updates.slice(0, -1).every(({ sessions }) => sessions === undefined));
	assert.equal(updates.at(-1)?.sessions?.[0]?.historyItems, 400);

	const bootstrapStream = await fetch(eventsUrl(viewer));
	assert.ok(bootstrapStream.body);
	const bootstrapReader = bootstrapStream.body.getReader();
	const bootstrapText = await readSse(bootstrapReader, /event: bootstrap/);
	const bootstrap = sseData<{
		states: Array<{ streamId: string; state: RenderState }>;
	}>(bootstrapText, "bootstrap");
	await bootstrapReader.cancel();
	assert.equal(bootstrap.states[0]?.streamId, "process-delta:session-delta");
	assert.deepEqual(bootstrap.states[0]?.state, target);
});

test("streams a multi-megabyte delta without disconnecting a healthy SSE client", { timeout: 5_000 }, async (t) => {
	const token = "large-sse-token";
	const viewer = await startContextRailServer({ html: "ok", token });
	t.after(() => viewer.stop());
	const stream = await fetch(eventsUrl(viewer));
	assert.ok(stream.body);
	const reader = stream.body.getReader();
	await readSse(reader, /event: bootstrap/);

	const target = largeState(2_000, 600);
	const chunks = chunkRenderStatePatch(diffRenderState(undefined, target));
	assert.ok(chunks.length > 4);
	for (const chunk of chunks) {
		const response = await postDelta(viewer.url, token, {
			source: source("process-large", "session-large"),
			transferId: "transfer-large",
			baseVersion: 0,
			...chunk,
		});
		assert.equal(response.status, 202);
	}

	const text = await readSse(reader, /"complete":true/);
	assert.match(text, /"complete":true/);
	assert.equal((await health(viewer.url)).clients, 1);
	await reader.cancel();
});

test(
	"isolates a new SSE client from an older client's backlog",
	{ timeout: 8_000 },
	async (t) => {
		const viewer = await startContextRailServer({
			html: "ok",
			sseClientMaxQueuedBytes: 16 * 1024 * 1024,
			sseBroadcastMaxQueuedBytes: 64 * 1024 * 1024,
			sseDrainTimeoutMs: 30_000,
		});
		t.after(() => viewer.stop());

		const slow = connect(viewer.port, "127.0.0.1");
		t.after(() => slow.destroy());
		await new Promise<void>((resolve, reject) => {
			slow.once("connect", resolve);
			slow.once("error", reject);
		});
		slow.write(
			"GET /events HTTP/1.1\r\nHost: 127.0.0.1\r\nAccept: text/event-stream\r\nConnection: keep-alive\r\n\r\n",
		);
		await waitFor(async () => (await health(viewer.url)).clients === 1);

		for (let index = 0; index < 12; index += 1) {
			const backlog = largeState(1_200, 500);
			if (backlog.snapshot) backlog.snapshot.model = `backlog-${index}`;
			viewer.publish(backlog, source("process-backlog", "session-backlog"));
		}

		const stream = await fetch(eventsUrl(viewer));
		assert.ok(stream.body);
		const reader = stream.body.getReader();
		const bootstrapText = await readSse(reader, /event: bootstrap[\s\S]*\n\n/);
		const bootstrap = sseData<{
			sequence: number;
			states: Array<{ state: RenderState }>;
		}>(bootstrapText, "bootstrap");
		assert.equal(bootstrap.sequence, 12);
		assert.equal(bootstrap.states[0]?.state.snapshot?.model, "backlog-11");

		viewer.publish(state("after-bootstrap", "message-after"), source("process-backlog", "session-backlog"));
		const updateText = await readSse(reader, /"model":"after-bootstrap"[\s\S]*\n\n/);
		const updates = sseDataAll<{ changed?: { state: RenderState } }>(updateText, "update");
		assert.equal(updates.length, 1);
		assert.equal(updates[0]?.changed?.state.snapshot?.model, "after-bootstrap");
		assert.doesNotMatch(updateText, /"model":"backlog-/);
		await reader.cancel();
	},
);

test("marks a process offline without removing its session history", async (t) => {
	const viewer = await startContextRailServer({ html: "ok" });
	t.after(() => viewer.stop());
	viewer.publish(state("model-a", "message-a"), source("process-a", "session-a"));
	viewer.disconnect("process-a");

	const stream = await fetch(eventsUrl(viewer));
	assert.ok(stream.body);
	const reader = stream.body.getReader();
	const bootstrap = await readSse(reader, /event: bootstrap/);
	assert.match(bootstrap, /"connected":false/);
	assert.match(bootstrap, /"historyItems":1/);
	await reader.cancel();
});

test("keeps heartbeat, update, and activity clocks independent", async (t) => {
	let time = 1_000;
	const viewer = await startContextRailServer({ html: "ok", now: () => time });
	t.after(() => viewer.stop());

	viewer.publish(state("model-b", "message-b"), source("process-a", "session-b", false));
	time = 1_001;
	viewer.publish(state("model-a", "message-a"), source("process-a", "session-a"));
	time = 1_002;
	viewer.publish(state("model-b", "message-b"), {
		...source("process-a", "session-b"),
		activity: false,
	});
	time = 1_003;
	viewer.heartbeat("process-a");

	const stream = await fetch(eventsUrl(viewer));
	assert.ok(stream.body);
	const reader = stream.body.getReader();
	const text = await readSse(reader, /event: bootstrap/);
	const payload = sseData<{
		activeStreamId?: string;
		sessions: Array<{
			sessionId: string;
			active: boolean;
			lastActivityAt: number;
			updatedAt: number;
		}>;
	}>(text, "bootstrap");
	await reader.cancel();

	assert.equal(payload.activeStreamId, "process-a:session-b");
	assert.deepEqual(
		payload.sessions.map(({ sessionId }) => sessionId),
		["session-a", "session-b"],
	);
	const sessionA = payload.sessions.find(({ sessionId }) => sessionId === "session-a");
	const sessionB = payload.sessions.find(({ sessionId }) => sessionId === "session-b");
	assert.ok(sessionA);
	assert.ok(sessionB);
	assert.deepEqual({
		sessionId: sessionA.sessionId,
		active: sessionA.active,
		lastActivityAt: sessionA.lastActivityAt,
		updatedAt: sessionA.updatedAt,
	}, {
		sessionId: "session-a",
		active: false,
		lastActivityAt: 1_001,
		updatedAt: 1_001,
	});
	assert.deepEqual({
		sessionId: sessionB.sessionId,
		active: sessionB.active,
		lastActivityAt: sessionB.lastActivityAt,
		updatedAt: sessionB.updatedAt,
	}, {
		sessionId: "session-b",
		active: true,
		lastActivityAt: 1_000,
		updatedAt: 1_002,
	});
});

test("activity-free reconnect publishes do not replace the most recently active stream", async (t) => {
	let time = 2_000;
	const viewer = await startContextRailServer({ html: "ok", now: () => time });
	t.after(() => viewer.stop());

	viewer.publish(state("model-a", "message-a"), source("process-a", "session-a"));
	time = 2_001;
	viewer.publish(state("model-b", "message-b"), source("process-b", "session-b"));
	time = 2_002;
	viewer.publish(state("model-a", "message-a"), {
		...source("process-a", "session-a"),
		activity: false,
	});
	time = 2_003;
	viewer.publish(state("model-c", "message-c"), {
		...source("process-c", "session-c"),
		activity: false,
	});

	const stream = await fetch(eventsUrl(viewer));
	assert.ok(stream.body);
	const reader = stream.body.getReader();
	const text = await readSse(reader, /event: bootstrap/);
	const bootstrap = sseData<{
		activeStreamId?: string;
		sessions: Array<{ sessionId: string; active: boolean; lastActivityAt: number }>;
	}>(text, "bootstrap");
	await reader.cancel();

	assert.equal(bootstrap.activeStreamId, "process-b:session-b");
	assert.deepEqual(
		bootstrap.sessions.map(({ sessionId, active, lastActivityAt }) => ({ sessionId, active, lastActivityAt })),
		[
			{ sessionId: "session-b", active: true, lastActivityAt: 2_001 },
			{ sessionId: "session-a", active: true, lastActivityAt: 2_000 },
			{ sessionId: "session-c", active: true, lastActivityAt: 0 },
		],
	);
});

test("marks only foreground direct and completed delta updates as activity", async (t) => {
	const token = "activity-token";
	const viewer = await startContextRailServer({ html: "ok", token });
	t.after(() => viewer.stop());
	const stream = await fetch(eventsUrl(viewer));
	assert.ok(stream.body);
	const reader = stream.body.getReader();
	await readSse(reader, /event: bootstrap/);

	viewer.publish(state("background", "message-background"), {
		...source("process-activity", "session-background"),
		activity: false,
	});
	const backgroundText = await readSse(reader, /"activity":false/);
	const background = sseData<ContextRailHubUpdate>(backgroundText, "update");
	assert.equal(background.activity, false);
	assert.equal(background.changed?.streamId, "process-activity:session-background");

	viewer.publish(
		state("foreground", "message-foreground"),
		source("process-activity", "session-foreground"),
	);
	const foregroundText = await readSse(reader, /"activity":true/);
	const foreground = sseData<ContextRailHubUpdate>(foregroundText, "update");
	assert.equal(foreground.activity, true);
	assert.equal(foreground.changed?.streamId, "process-activity:session-foreground");

	const chunks = chunkRenderStatePatch(diffRenderState(undefined, largeState(80)), 512);
	assert.ok(chunks.length > 1);
	for (const chunk of chunks) {
		const response = await postDelta(viewer.url, token, {
			source: {
				...source("process-activity", "session-delta"),
				activity: false,
			},
			transferId: "background-delta",
			baseVersion: 0,
			...chunk,
		});
		assert.equal(response.status, 202);
	}
	const deltaText = await readSse(reader, /"complete":true/);
	const deltaUpdates = sseDataAll<ContextRailHubUpdate>(deltaText, "update");
	assert.ok(deltaUpdates.slice(0, -1).every(({ activity }) => activity === undefined));
	assert.equal(deltaUpdates.at(-1)?.activity, false);
	assert.equal(deltaUpdates.at(-1)?.delta?.complete, true);
	await reader.cancel();
});

test(
	"expires a process after its heartbeat TTL without changing session timestamps",
	{ timeout: 1_000 },
	async (t) => {
		let time = 5_000;
		const viewer = await startContextRailServer({
			html: "ok",
			heartbeatTtlMs: 10,
			heartbeatSweepIntervalMs: 1,
			now: () => time,
		});
		t.after(() => viewer.stop());
		viewer.publish(state("model-a", "message-a"), source("process-a", "session-a"));
		time = 5_005;
		viewer.heartbeat("process-a");

		const stream = await fetch(eventsUrl(viewer));
		assert.ok(stream.body);
		const reader = stream.body.getReader();
		const bootstrapText = await readSse(reader, /event: bootstrap/);
		const bootstrap = sseData<{
			sessions: Array<{ connected: boolean; lastActivityAt: number; updatedAt: number }>;
		}>(bootstrapText, "bootstrap");
		const initial = bootstrap.sessions[0];
		assert.ok(initial);
		assert.deepEqual({
			connected: initial.connected,
			lastActivityAt: initial.lastActivityAt,
			updatedAt: initial.updatedAt,
		}, {
			connected: true,
			lastActivityAt: 5_000,
			updatedAt: 5_000,
		});

		time = 5_016;
		const updateText = await readSse(reader, /"connected":false/);
		const update = sseData<{
			activeStreamId?: string;
			sessions: Array<{ connected: boolean; active: boolean; lastActivityAt: number; updatedAt: number }>;
		}>(updateText, "update");
		await reader.cancel();

		assert.equal(update.activeStreamId, undefined);
		const expired = update.sessions[0];
		assert.ok(expired);
		assert.deepEqual({
			connected: expired.connected,
			active: expired.active,
			lastActivityAt: expired.lastActivityAt,
			updatedAt: expired.updatedAt,
		}, {
			connected: false,
			active: false,
			lastActivityAt: 5_000,
			updatedAt: 5_000,
		});
	},
);

test("rejects cross-origin reads", async (t) => {
	const viewer = await startContextRailServer({ html: "ok" });
	t.after(() => viewer.stop());

	const response = await fetch(`${viewer.url}health`, {
		headers: { Origin: "https://example.com" },
	});
	assert.equal(response.status, 403);
});

test("concurrent stop calls abort an incomplete request and share one shutdown", { timeout: 1_000 }, async (t) => {
	const viewer = await startContextRailServer({ html: "ok", token: "stop-token" });
	const blocker = connect(viewer.port, "127.0.0.1");
	t.after(() => blocker.destroy());
	await new Promise<void>((resolve, reject) => {
		blocker.once("connect", resolve);
		blocker.once("error", reject);
	});
	await new Promise<void>((resolve, reject) => {
		let response = "";
		const onData = (chunk: Buffer): void => {
			response += chunk.toString("utf8");
			if (!response.includes("HTTP/1.1 100 Continue")) return;
			blocker.off("data", onData);
			blocker.off("error", onError);
			resolve();
		};
		const onError = (error: Error): void => {
			blocker.off("data", onData);
			reject(error);
		};
		blocker.on("data", onData);
		blocker.once("error", onError);
		blocker.write(
			"POST /api/heartbeat HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer stop-token\r\nContent-Type: application/json\r\nContent-Length: 100\r\nExpect: 100-continue\r\n\r\n",
		);
		});
	const blockerClosed = new Promise<void>((resolve) => blocker.once("close", () => resolve()));

	let firstResolved = false;
	let secondResolved = false;
	const first = viewer.stop().then(() => {
		firstResolved = true;
	});
	const second = viewer.stop().then(() => {
		secondResolved = true;
	});

	await Promise.race([
		Promise.all([first, second]),
		new Promise<never>((_, reject) => {
			setTimeout(() => reject(new Error("Hub shutdown remained blocked by a partial body")), 300);
		}),
	]);
	assert.equal(firstResolved, true);
	assert.equal(secondResolved, true);
	await blockerClosed;
	assert.equal(blocker.destroyed, true);

	const replacement = await startContextRailServer({ html: "ok", port: viewer.port });
	assert.equal(replacement.port, viewer.port);
	await replacement.stop();
});

test("closes an incomplete authenticated request after the body deadline", { timeout: 1_000 }, async (t) => {
	const viewer = await startContextRailServer({
		html: "ok",
		token: "body-timeout-token",
		requestBodyTimeoutMs: 25,
	});
	t.after(() => viewer.stop());
	const socket = connect(viewer.port, "127.0.0.1");
	t.after(() => socket.destroy());
	await new Promise<void>((resolve, reject) => {
		socket.once("connect", resolve);
		socket.once("error", reject);
	});
	const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
	socket.write(
		"POST /api/heartbeat HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer body-timeout-token\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{",
	);

	await Promise.race([
		closed,
		new Promise<never>((_, reject) => {
			setTimeout(() => reject(new Error("Partial request exceeded its body deadline")), 300);
		}),
	]);
	assert.equal(socket.destroyed, true);
});

test("destroys an oversized request before the declared body finishes", { timeout: 1_000 }, async (t) => {
	const viewer = await startContextRailServer({ html: "ok", token: "oversized-body-token" });
	t.after(() => viewer.stop());
	const socket = connect(viewer.port, "127.0.0.1");
	t.after(() => socket.destroy());
	await new Promise<void>((resolve, reject) => {
		socket.once("connect", resolve);
		socket.once("error", reject);
	});
	const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
	const declaredBytes = 4 * 1024 * 1024;
	socket.write(
		"POST /api/heartbeat HTTP/1.1\r\n"
		+ "Host: 127.0.0.1\r\n"
		+ "Authorization: Bearer oversized-body-token\r\n"
		+ "Content-Type: application/json\r\n"
		+ `Content-Length: ${declaredBytes}\r\n\r\n`,
	);
	socket.write(Buffer.alloc(2 * 1024 * 1024 + 1, 0x20));

	await Promise.race([
		closed,
		new Promise<never>((_, reject) => {
			setTimeout(() => reject(new Error("Oversized request stream remained open")), 300);
		}),
	]);
	assert.equal(socket.destroyed, true);
});

test("disconnects an SSE client when one outbound event exceeds its queue budget", async (t) => {
	const viewer = await startContextRailServer({
		html: "ok",
		sseClientMaxQueuedBytes: 64,
	});
	t.after(() => viewer.stop());

	const stream = await fetch(eventsUrl(viewer));
	assert.ok(stream.body);
	const reader = stream.body.getReader();
	await readSse(reader, /event: bootstrap/);
	assert.equal((await health(viewer.url)).clients, 1);

	viewer.publish(state("larger-than-budget", "message-a"), source("process-a", "session-a"));
	await waitFor(async () => (await health(viewer.url)).clients === 0);
	await reader.cancel().catch(() => undefined);
});

test("disconnects affected SSE clients when the broadcast queue budget is exceeded", async (t) => {
	const viewer = await startContextRailServer({
		html: "ok",
		sseClientMaxQueuedBytes: 1024 * 1024,
		sseBroadcastMaxQueuedBytes: 1024,
	});
	t.after(() => viewer.stop());

	const stream = await fetch(eventsUrl(viewer));
	assert.ok(stream.body);
	const reader = stream.body.getReader();
	await readSse(reader, /event: bootstrap/);
	assert.equal((await health(viewer.url)).clients, 1);

	viewer.publish(
		state(`larger-than-broadcast-budget-${"x".repeat(2_000)}`, "message-a"),
		source("process-a", "session-a"),
	);
	await waitFor(async () => (await health(viewer.url)).clients === 0);
	await reader.cancel().catch(() => undefined);
});

test("evicts disconnected sessions by count and retention TTL", async (t) => {
	let time = 10_000;
	const viewer = await startContextRailServer({
		html: "ok",
		now: () => time,
		maxRetainedSessions: 2,
		disconnectedSessionTtlMs: 10,
		heartbeatSweepIntervalMs: 1,
	});
	t.after(() => viewer.stop());

	for (const sessionId of ["session-a", "session-b", "session-c"]) {
		viewer.publish(state(sessionId, `message-${sessionId}`), source(sessionId, sessionId));
		viewer.disconnect(sessionId);
		time += 1;
	}
	assert.equal((await health(viewer.url)).sessions, 2);

	const stream = await fetch(eventsUrl(viewer));
	assert.ok(stream.body);
	const reader = stream.body.getReader();
	const text = await readSse(reader, /event: bootstrap/);
	const bootstrap = sseData<{ sessions: Array<{ sessionId: string }> }>(text, "bootstrap");
	await reader.cancel();
	assert.deepEqual(bootstrap.sessions.map(({ sessionId }) => sessionId).sort(), ["session-b", "session-c"]);

	time += 11;
	await waitFor(async () => (await health(viewer.url)).sessions === 0);
});

test("hard-caps retained sessions even when every process has an active session", async (t) => {
	let time = 30_000;
	const viewer = await startContextRailServer({
		html: "ok",
		now: () => time,
		maxRetainedSessions: 2,
	});
	t.after(() => viewer.stop());

	for (const sessionId of ["session-a", "session-b", "session-c"]) {
		viewer.publish(state(sessionId, `message-${sessionId}`), source("process-online", sessionId));
		time += 1;
	}
	assert.equal((await health(viewer.url)).sessions, 2);

	let stream = await fetch(eventsUrl(viewer));
	assert.ok(stream.body);
	let reader = stream.body.getReader();
	let text = await readSse(reader, /event: bootstrap/);
	let bootstrap = sseData<{ sessions: Array<{ sessionId: string; active: boolean }> }>(text, "bootstrap");
	await reader.cancel();
	assert.deepEqual(
		bootstrap.sessions.map(({ sessionId, active }) => ({ sessionId, active })),
		[
			{ sessionId: "session-c", active: true },
			{ sessionId: "session-b", active: false },
		],
	);

	viewer.publish(state("model-x", "message-x"), source("process-x", "session-x"));
	time += 1;
	viewer.publish(state("model-y", "message-y"), source("process-y", "session-y"));
	assert.equal((await health(viewer.url)).sessions, 2);

	stream = await fetch(eventsUrl(viewer));
	assert.ok(stream.body);
	reader = stream.body.getReader();
	text = await readSse(reader, /event: bootstrap/);
	bootstrap = sseData<{ sessions: Array<{ sessionId: string; active: boolean }> }>(text, "bootstrap");
	await reader.cancel();
	assert.deepEqual(
		bootstrap.sessions.map(({ sessionId }) => sessionId),
		["session-y", "session-x"],
	);
	assert.ok(bootstrap.sessions.every(({ active }) => active));
});

test("bounds pending delta bytes, chunk count, and lifetime independently", async (t) => {
	let time = 20_000;
	const token = "bounded-delta-token";
	const viewer = await startContextRailServer({
		html: "ok",
		token,
		now: () => time,
		maxPendingDeltaBytes: 12,
		maxPendingDeltaChunks: 2,
		pendingDeltaTtlMs: 10,
		heartbeatSweepIntervalMs: 1,
	});
	t.after(() => viewer.stop());
	const deltaSource = source("process-bounds", "session-bounds");

	const oversized = await postDelta(viewer.url, token, {
		source: deltaSource,
		transferId: "oversized",
		baseVersion: 0,
		index: 0,
		data: "A".repeat(13),
		complete: false,
	});
	assert.equal(oversized.status, 400);

	for (const index of [0, 1]) {
		const response = await postDelta(viewer.url, token, {
			source: deltaSource,
			transferId: "too-many",
			baseVersion: 0,
			index,
			data: "e30=",
			complete: false,
		});
		assert.equal(response.status, 202);
	}
	const tooMany = await postDelta(viewer.url, token, {
		source: deltaSource,
		transferId: "too-many",
		baseVersion: 0,
		index: 2,
		data: "e30=",
		complete: true,
	});
	assert.equal(tooMany.status, 400);

	const chunks = chunkRenderStatePatch(diffRenderState(undefined, state("model", "message")), 12);
	assert.ok(chunks.length > 1);
	const first = await postDelta(viewer.url, token, {
		source: deltaSource,
		transferId: "expired",
		baseVersion: 0,
		...chunks[0],
	});
	assert.equal(first.status, 202);
	time += 11;
	const expired = await postDelta(viewer.url, token, {
		source: deltaSource,
		transferId: "expired",
		baseVersion: 0,
		...chunks[1],
	});
	assert.equal(expired.status, 409);
});

test("bounds pending delta transfer count and aggregate bytes", async (t) => {
	const token = "aggregate-delta-token";
	const viewer = await startContextRailServer({
		html: "ok",
		token,
		maxPendingDeltaBytes: 16,
		maxPendingDeltaChunks: 4,
		maxPendingDeltas: 2,
		maxPendingDeltaAggregateBytes: 8,
	});
	t.after(() => viewer.stop());
	const deltaSource = source("process-aggregate", "session-aggregate");

	for (const transferId of ["first", "second"]) {
		const response = await postDelta(viewer.url, token, {
			source: deltaSource,
			transferId,
			baseVersion: 0,
			index: 0,
			data: "e30=",
			complete: false,
		});
		assert.equal(response.status, 202);
	}

	const overCount = await postDelta(viewer.url, token, {
		source: deltaSource,
		transferId: "third",
		baseVersion: 0,
		index: 0,
		data: "e30=",
		complete: false,
	});
	assert.equal(overCount.status, 400);
	assert.equal(await overCount.text(), "Too many pending delta transfers");

	const overAggregate = await postDelta(viewer.url, token, {
		source: deltaSource,
		transferId: "first",
		baseVersion: 0,
		index: 1,
		data: "e30=",
		complete: false,
	});
	assert.equal(overAggregate.status, 400);
	assert.equal(await overAggregate.text(), "Pending delta transfers exceed aggregate byte limit");

	const recovered = await postDelta(viewer.url, token, {
		source: deltaSource,
		transferId: "third",
		baseVersion: 0,
		index: 0,
		data: "e30=",
		complete: false,
	});
	assert.equal(recovered.status, 202);
});

test("rejects a stale delta version and accepts a reset against the returned version", async (t) => {
	const token = "version-token";
	const viewer = await startContextRailServer({ html: "ok", token });
	t.after(() => viewer.stop());
	const deltaSource = source("process-version", "session-version");
	viewer.publish(state("foreign", "ghost"), deltaSource);

	const desired = state("desired", "message-current");
	const staleChunks = chunkRenderStatePatch(diffRenderState(undefined, desired));
	assert.equal(staleChunks.length, 1);
	const conflict = await postDelta(viewer.url, token, {
		source: deltaSource,
		transferId: "stale",
		baseVersion: 0,
		...staleChunks[0],
	});
	assert.equal(conflict.status, 409);
	assert.deepEqual(await conflict.json(), { ok: false, error: "version_conflict", version: 1 });

	const accepted = await postDelta(viewer.url, token, {
		source: deltaSource,
		transferId: "reset",
		baseVersion: 1,
		...staleChunks[0],
	});
	assert.equal(accepted.status, 202);
	assert.deepEqual(await accepted.json(), { ok: true, version: 2 });

	const stream = await fetch(eventsUrl(viewer));
	assert.ok(stream.body);
	const reader = stream.body.getReader();
	const text = await readSse(reader, /event: bootstrap/);
	const bootstrap = sseData<{ states: Array<{ state: RenderState }> }>(text, "bootstrap");
	await reader.cancel();
	assert.deepEqual(bootstrap.states[0]?.state, desired);
});

test("resolves interleaved same-stream transfers with commit-time CAS", async (t) => {
	const token = "interleaved-token";
	const viewer = await startContextRailServer({ html: "ok", token });
	t.after(() => viewer.stop());
	const deltaSource = source("process-interleaved", "session-interleaved");
	const firstState = state("first-writer", "message-first");
	const secondState = state("second-writer", "message-second");
	const firstChunks = chunkRenderStatePatch(diffRenderState(undefined, firstState), 64);
	const secondChunks = chunkRenderStatePatch(diffRenderState(undefined, secondState), 64);
	assert.ok(firstChunks.length > 1);
	assert.ok(secondChunks.length > 1);

	for (const [transferId, chunk] of [
		["writer-a", firstChunks[0]],
		["writer-b", secondChunks[0]],
	] as const) {
		const response = await postDelta(viewer.url, token, {
			source: deltaSource,
			transferId,
			baseVersion: 0,
			...chunk,
		});
		assert.equal(response.status, 202);
	}

	for (const chunk of firstChunks.slice(1)) {
		const response = await postDelta(viewer.url, token, {
			source: deltaSource,
			transferId: "writer-a",
			baseVersion: 0,
			...chunk,
		});
		assert.equal(response.status, 202);
	}

	for (const [index, chunk] of secondChunks.slice(1).entries()) {
		const response = await postDelta(viewer.url, token, {
			source: deltaSource,
			transferId: "writer-b",
			baseVersion: 0,
			...chunk,
		});
		if (index === secondChunks.length - 2) {
			assert.equal(response.status, 409);
			assert.deepEqual(await response.json(), { ok: false, error: "version_conflict", version: 1 });
		} else {
			assert.equal(response.status, 202);
		}
	}

	for (const chunk of secondChunks) {
		const response = await postDelta(viewer.url, token, {
			source: deltaSource,
			transferId: "writer-b-reset",
			baseVersion: 1,
			...chunk,
		});
		assert.equal(response.status, 202);
	}

	const stream = await fetch(eventsUrl(viewer));
	assert.ok(stream.body);
	const reader = stream.body.getReader();
	const text = await readSse(reader, /event: bootstrap/);
	const bootstrap = sseData<{ states: Array<{ state: RenderState }> }>(text, "bootstrap");
	await reader.cancel();
	assert.deepEqual(bootstrap.states[0]?.state, secondState);
});
