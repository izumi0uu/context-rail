import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createContextRailExtension } from "../src/index.ts";
import type {
	OmpEventHandler,
	OmpEventMap,
	OmpExtensionApi,
	OmpExtensionContext,
} from "../src/omp-types.ts";
import type { ContextRailSessionSource } from "../src/hub-types.ts";
import type { RenderState } from "../src/render.ts";

test("publishes separate compiled extension entries for OMP and Pi", () => {
	const packageJson = JSON.parse(
		readFileSync(new URL("../package.json", import.meta.url), "utf8"),
	) as {
		files?: unknown;
		omp?: { extensions?: unknown };
		pi?: { extensions?: unknown };
	};
	assert.deepEqual(packageJson.omp?.extensions, ["./dist/index.js"]);
	assert.deepEqual(packageJson.pi?.extensions, ["./dist/pi.js"]);
	assert.ok(Array.isArray(packageJson.files) && packageJson.files.includes("dist"));
});

test("connects OMP lifecycle events to status and widget UI", async () => {
	const handlers = new Map<keyof OmpEventMap, OmpEventHandler<keyof OmpEventMap>>();
	let commandHandler: ((args: string, ctx: OmpExtensionContext) => Promise<void> | void) | undefined;
	let commandName: string | undefined;
	const publications: Array<{ state: RenderState; source?: ContextRailSessionSource }> = [];
	let viewerStarts = 0;
	let viewerStops = 0;
	let hubAvailable = false;
	let staleViewer = 0;
	let sessionId = "session-a";
	let sessionName = "Main build";

	const api = {
		on(event: keyof OmpEventMap, handler: OmpEventHandler<keyof OmpEventMap>) {
			handlers.set(event, handler);
		},
		registerCommand(
			name: string,
			options: { handler: (args: string, ctx: OmpExtensionContext) => Promise<void> | void },
		) {
			commandName = name;
			commandHandler = options.handler;
		},
	} as OmpExtensionApi;

	const statuses: Array<string | undefined> = [];
	const widgets: Array<string[] | undefined> = [];
	const notifications: string[] = [];
	const ctx: OmpExtensionContext = {
		cwd: "/projects/context-rail",
		model: { id: "test-model" },
		sessionManager: {
			getSessionId: () => sessionId,
			getSessionFile: () => `/sessions/${sessionId}.jsonl`,
			getSessionName: () => sessionName,
			getCwd: () => "/projects/context-rail",
		},
		getContextUsage: () => ({ tokens: 8_000, contextWindow: 32_000, percent: 25 }),
		getSystemPrompt: () => ["base", "project"],
		ui: {
			setStatus: (_key, value) => statuses.push(value),
			setWidget: (_key, value) => widgets.push(value),
			notify: (message) => notifications.push(message),
		},
	};

	const contextRailExtension = createContextRailExtension({
		processId: "process-test",
		connectHub: async (startIfMissing) => {
			if (!hubAvailable && !startIfMissing) return undefined;
			hubAvailable = true;
			viewerStarts += 1;
			const viewerId = viewerStarts;
			return {
			instanceId: "hub-test",
			port: 4317,
			url: "http://127.0.0.1:4317/",
			viewerUrl: "http://127.0.0.1:4317/",
			healthy: async () => viewerId !== staleViewer,
			publish: (state, source) =>
					publications.push({
						state: {
						snapshot: state.snapshot,
						timeline: state.timeline,
						phase: state.phase,
						activeTools: [...state.activeTools],
						},
						...(source ? { source: { ...source } } : {}),
					}),
			heartbeat: () => undefined,
			disconnect: () => undefined,
			stop: async () => {
				viewerStops += 1;
			},
			};
		},
	});
	contextRailExtension(api);
	assert.equal(commandName, "context-rail");
	assert.ok(commandHandler);

	await handlers.get("context")?.(
		{
			type: "context",
			messages: [{ role: "user" }, { role: "assistant" }, { role: "toolResult", toolName: "read" }],
		},
		ctx,
	);
	assert.equal(statuses.at(-1), "ctx 25% | 8.0k/32.0k | 4 items");
	assert.equal(widgets.at(-1), undefined);

	await commandHandler?.("show", ctx);
	assert.deepEqual(widgets.at(-1), [
		"Context window | test-model",
		"8.0k / 32.0k tokens | 25%",
		"[SYS][USR][AST][TOL]",
		"phase: context",
	]);

	const publicationsBeforeWeb = publications.length;
	await commandHandler?.("web", ctx);
	assert.equal(viewerStarts, 1);
	assert.equal(publications.length, publicationsBeforeWeb + 1);
	assert.equal(notifications.at(-1), "ContextRail viewer: http://127.0.0.1:4317/");
	assert.equal(publications.at(-1)?.state.phase, "context");
	assert.equal(publications.at(-1)?.state.timeline?.history.length, 4);
	assert.equal(publications.at(-1)?.source?.sessionId, "session-a");
	assert.equal(publications.at(-1)?.source?.active, true);
	assert.deepEqual(publications.at(-1)?.state.timeline?.activeIds, [
		"system-prompt",
		"message-local-1",
		"message-local-2",
		"message-local-3",
	]);

	await handlers.get("message_end")?.(
		{ type: "message_end", message: { role: "user", timestamp: 42 } },
		ctx,
	);
	assert.deepEqual(publications.at(-1)?.state.timeline?.pendingIds, ["message-local-4"]);
	assert.equal(publications.at(-1)?.state.timeline?.history.length, 5);
	assert.equal(publications.at(-1)?.state.timeline?.activeIds.length, 4);
	assert.equal(publications.at(-1)?.state.snapshot?.items.length, 4);

	await handlers.get("context")?.(
		{
			type: "context",
			messages: [
				{ role: "user" },
				{ role: "assistant" },
				{ role: "toolResult", toolName: "read" },
				{ role: "user", timestamp: 42 },
			],
		},
		ctx,
	);
	assert.deepEqual(publications.at(-1)?.state.timeline?.pendingIds, []);
	assert.deepEqual(publications.at(-1)?.state.timeline?.confirmedIds, ["message-local-4"]);
	assert.equal(
		publications.at(-1)?.state.timeline?.history.filter((item) => item.id === "message-local-4").length,
		1,
	);
	assert.ok(publications.at(-1)?.state.timeline?.activeIds.includes("message-local-4"));

	staleViewer = 1;
	const publicationsBeforeRecovery = publications.length;
	await commandHandler?.("web", ctx);
	assert.equal(viewerStarts, 2);
	assert.ok(publications.length > publicationsBeforeRecovery);

	await handlers.get("tool_execution_start")?.(
		{ type: "tool_execution_start", toolCallId: "call-1", toolName: "bash" },
		ctx,
	);
	assert.match(statuses.at(-1) ?? "", /1 tool$/);

	await handlers.get("auto_compaction_start")?.(
		{ type: "auto_compaction_start", reason: "threshold", action: "context-full" },
		ctx,
	);
	assert.equal(publications.at(-1)?.state.phase, "compacting");
	await handlers.get("context")?.(
		{ type: "context", messages: [{ role: "assistant", timestamp: 99 }] },
		ctx,
	);
	assert.equal(
		publications.at(-1)?.state.timeline?.history.filter((item) => item.synthetic).length,
		0,
		"compaction start alone must not arm provenance",
	);
	await handlers.get("auto_compaction_end")?.(
		{
			type: "auto_compaction_end",
			action: "context-full",
			result: undefined,
			aborted: true,
			willRetry: false,
		},
		ctx,
	);

	const nonSummaryCompactions = [
		{
			label: "aborted compaction",
			action: "context-full" as const,
			end: {
				type: "auto_compaction_end" as const,
				action: "context-full" as const,
				result: undefined,
				aborted: true,
				willRetry: false,
			},
		},
		{
			label: "skipped compaction",
			action: "context-full" as const,
			end: {
				type: "auto_compaction_end" as const,
				action: "context-full" as const,
				result: undefined,
				aborted: false,
				willRetry: false,
				skipped: true,
			},
		},
		{
			label: "shake",
			action: "shake" as const,
			end: {
				type: "auto_compaction_end" as const,
				action: "shake" as const,
				result: undefined,
				aborted: false,
				willRetry: false,
			},
		},
		{
			label: "handoff",
			action: "handoff" as const,
			end: {
				type: "auto_compaction_end" as const,
				action: "handoff" as const,
				result: undefined,
				aborted: false,
				willRetry: false,
			},
		},
	];
	for (const [index, compaction] of nonSummaryCompactions.entries()) {
		await handlers.get("auto_compaction_start")?.(
			{ type: "auto_compaction_start", reason: "threshold", action: compaction.action },
			ctx,
		);
		assert.equal(publications.at(-1)?.state.phase, "compacting");
		await handlers.get("auto_compaction_end")?.(compaction.end, ctx);
		assert.equal(publications.at(-1)?.state.phase, "context");
		await handlers.get("context")?.(
			{ type: "context", messages: [{ role: "assistant", timestamp: 100 + index }] },
			ctx,
		);
		const timeline = publications.at(-1)?.state.timeline;
		assert.equal(
			timeline?.history.filter((item) => item.synthetic).length,
			0,
			`${compaction.label} must not create a synthetic summary`,
		);
		assert.deepEqual(
			timeline?.summaryEdges,
			[],
			`${compaction.label} must not create provenance edges`,
		);
	}

	await handlers.get("context")?.(
		{
			type: "context",
			messages: [
				{ role: "user", timestamp: 200 },
				{ role: "assistant", timestamp: 201 },
				{ role: "toolResult", toolName: "read", timestamp: 202 },
			],
		},
		ctx,
	);
	await handlers.get("session_compact")?.(
		{
			type: "session_compact",
			compactionEntry: { type: "compaction", summary: "Authoritative summary" },
			fromExtension: false,
		},
		ctx,
	);
	await handlers.get("context")?.(
		{ type: "context", messages: [{ role: "assistant", timestamp: 203 }] },
		ctx,
	);
	let timeline = publications.at(-1)?.state.timeline;
	assert.equal(timeline?.history.filter((item) => item.synthetic).length, 1);
	assert.ok((timeline?.summaryEdges.length ?? 0) >= 3);

	await handlers.get("context")?.(
		{
			type: "context",
			messages: [
				{ role: "user", timestamp: 300 },
				{ role: "assistant", timestamp: 301 },
				{ role: "toolResult", toolName: "bash", timestamp: 302 },
			],
		},
		ctx,
	);
	const syntheticSummariesBeforeFallback =
		publications.at(-1)?.state.timeline?.history.filter((item) => item.synthetic).length ?? 0;
	const summaryEdgesBeforeFallback =
		publications.at(-1)?.state.timeline?.summaryEdges.length ?? 0;
	await handlers.get("auto_compaction_start")?.(
		{ type: "auto_compaction_start", reason: "threshold", action: "context-full" },
		ctx,
	);
	await handlers.get("auto_compaction_end")?.(
		{
			type: "auto_compaction_end",
			action: "context-full",
			result: {
				summary: "Compatibility fallback summary",
				firstKeptEntryId: "entry-302",
				tokensBefore: 12_000,
			},
			aborted: false,
			willRetry: false,
		},
		ctx,
	);
	await handlers.get("context")?.(
		{ type: "context", messages: [{ role: "assistant", timestamp: 303 }] },
		ctx,
	);
	timeline = publications.at(-1)?.state.timeline;
	assert.equal(
		timeline?.history.filter((item) => item.synthetic).length,
		syntheticSummariesBeforeFallback + 1,
	);
	assert.ok((timeline?.summaryEdges.length ?? 0) > summaryEdgesBeforeFallback);
	const sessionAHistory = publications.at(-1)?.state.timeline?.history.length;

	sessionId = "session-b";
	sessionName = "Hub protocol";
	await handlers.get("session_switch")?.({ type: "session_switch", reason: "resume" }, ctx);
	assert.equal(publications.at(-1)?.state.timeline?.history.length, 0);
	assert.equal(publications.at(-1)?.source?.sessionId, "session-b");
	assert.equal(publications.at(-1)?.source?.activity, true);
	assert.equal(publications.at(-2)?.source?.sessionId, "session-a");
	assert.equal(publications.at(-2)?.source?.active, false);

	await handlers.get("context")?.({ type: "context", messages: [{ role: "user" }] }, ctx);
	assert.equal(publications.at(-1)?.state.timeline?.history.length, 2);

	sessionId = "session-a";
	sessionName = "Main build";
	await handlers.get("session_switch")?.({ type: "session_switch", reason: "resume" }, ctx);
	assert.equal(publications.at(-1)?.state.timeline?.history.length, sessionAHistory);

	const publicationsBeforeBranch = publications.length;
	sessionId = "session-c";
	sessionName = "Branch lifecycle";
	await handlers.get("session_branch")?.(
		{ type: "session_branch", previousSessionFile: "/sessions/session-a.jsonl" },
		ctx,
	);
	assert.deepEqual(
		publications.slice(publicationsBeforeBranch).map((publication) => ({
			sessionId: publication.source?.sessionId,
			active: publication.source?.active,
			activity: publication.source?.activity,
		})),
		[
			{ sessionId: "session-a", active: false, activity: false },
			{ sessionId: "session-c", active: true, activity: true },
		],
	);
	assert.equal(publications.at(-1)?.state.timeline?.history.length, 0);

	await commandHandler?.("stop", ctx);
	assert.equal(viewerStops, 1);
	const publicationsAfterStop = publications.length;
	await handlers.get("context")?.({ type: "context", messages: [{ role: "assistant" }] }, ctx);
	assert.equal(viewerStarts, 2);
	assert.equal(publications.length, publicationsAfterStop);

	await commandHandler?.("web", ctx);
	assert.equal(viewerStarts, 3);
	assert.ok(publications.length > publicationsAfterStop);

	await handlers.get("session_shutdown")?.({ type: "session_shutdown" }, ctx);
	assert.equal(statuses.at(-1), undefined);
	assert.equal(widgets.at(-1), undefined);
	assert.equal(viewerStops, 2);
});

test("heartbeat reconnects an unhealthy viewer and replays the latest idle state", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const handlers = new Map<keyof OmpEventMap, OmpEventHandler<keyof OmpEventMap>>();
	const publications: Array<{ viewerId: number; state: RenderState }> = [];
	let viewerStarts = 0;
	let unhealthyViewer: number | undefined;
	let disposedViewers = 0;

	const api = {
		on(event: keyof OmpEventMap, handler: OmpEventHandler<keyof OmpEventMap>) {
			handlers.set(event, handler);
		},
		registerCommand() {},
	} as OmpExtensionApi;
	const ctx: OmpExtensionContext = {
		cwd: "/projects/context-rail",
		model: { id: "test-model" },
		sessionManager: {
			getSessionId: () => "session-a",
			getSessionFile: () => "/sessions/session-a.jsonl",
			getSessionName: () => "Session A",
		},
		getContextUsage: () => undefined,
		getSystemPrompt: () => [],
		ui: {
			setStatus: () => undefined,
			setWidget: () => undefined,
			notify: () => undefined,
		},
	};

	createContextRailExtension({
		processId: "reconnect-process",
		connectHub: async () => {
			const viewerId = ++viewerStarts;
			return {
				instanceId: "hub-test",
				port: 4317,
				url: "http://127.0.0.1:4317/",
				viewerUrl: "http://127.0.0.1:4317/",
				healthy: async () => viewerId !== unhealthyViewer,
				publish: (state) => {
					if (viewerId === unhealthyViewer) return;
					publications.push({ viewerId, state: structuredClone(state) });
				},
				heartbeat: () => undefined,
				disconnect: () => undefined,
				dispose: () => {
					disposedViewers += 1;
				},
				stop: async () => undefined,
			};
		},
	})(api);

	await handlers.get("context")?.(
		{ type: "context", messages: [{ role: "user", timestamp: 1 }] },
		ctx,
	);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(viewerStarts, 1);
	assert.deepEqual(publications.at(-1)?.state.timeline?.activeIds, ["message-local-1"]);

	unhealthyViewer = 1;
	await handlers.get("context")?.(
		{ type: "context", messages: [{ role: "assistant", timestamp: 2 }] },
		ctx,
	);
	assert.equal(publications.length, 1, "the failed viewer drops the final state before health polling");

	t.mock.timers.tick(10_000);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(disposedViewers, 1);
	assert.equal(viewerStarts, 2);
	assert.deepEqual(publications.at(-1)?.state.timeline?.activeIds, ["message-local-2"]);

	await handlers.get("session_shutdown")?.({ type: "session_shutdown" }, ctx);
});

test("bounds session runtimes by LRU and rebuilds an evicted session", async () => {
	const handlers = new Map<keyof OmpEventMap, OmpEventHandler<keyof OmpEventMap>>();
	let commandHandler: ((args: string, ctx: OmpExtensionContext) => Promise<void> | void) | undefined;
	let sessionId = "session-a";
	const publications: Array<{ state: RenderState; source?: ContextRailSessionSource }> = [];

	const api = {
		on(event: keyof OmpEventMap, handler: OmpEventHandler<keyof OmpEventMap>) {
			handlers.set(event, handler);
		},
		registerCommand(
			_name: string,
			options: { handler: (args: string, ctx: OmpExtensionContext) => Promise<void> | void },
		) {
			commandHandler = options.handler;
		},
	} as OmpExtensionApi;

	const ctx: OmpExtensionContext = {
		cwd: "/projects/context-rail",
		sessionManager: {
			getSessionId: () => sessionId,
			getSessionFile: () => `/sessions/${sessionId}.jsonl`,
			getSessionName: () => sessionId,
			getCwd: () => "/projects/context-rail",
		},
		getContextUsage: () => undefined,
		getSystemPrompt: () => [],
		ui: {
			setStatus: () => undefined,
			setWidget: () => undefined,
			notify: () => undefined,
		},
	};

	createContextRailExtension({
		processId: "bounded-process",
		maxSessionRuntimes: 2,
		startViewer: async () => ({
			instanceId: "bounded-hub",
			port: 4317,
			url: "http://127.0.0.1:4317/",
			viewerUrl: "http://127.0.0.1:4317/",
			healthy: async () => true,
			publish: (state, source) =>
				publications.push({
					state: {
						snapshot: state.snapshot,
						timeline: state.timeline,
						phase: state.phase,
						activeTools: [...state.activeTools],
					},
					...(source ? { source: { ...source } } : {}),
				}),
			heartbeat: () => undefined,
			disconnect: () => undefined,
			stop: async () => undefined,
		}),
	})(api);

	await handlers.get("context")?.(
		{ type: "context", messages: [{ role: "user", timestamp: 1 }] },
		ctx,
	);
	await commandHandler?.("web", ctx);

	sessionId = "session-b";
	await handlers.get("session_switch")?.({ type: "session_switch", reason: "resume" }, ctx);
	await handlers.get("context")?.(
		{ type: "context", messages: [{ role: "assistant", timestamp: 2 }] },
		ctx,
	);

	// Touch A again so B is the least-recently-used inactive runtime.
	sessionId = "session-a";
	await handlers.get("session_switch")?.({ type: "session_switch", reason: "resume" }, ctx);

	sessionId = "session-c";
	await handlers.get("session_branch")?.(
		{ type: "session_branch", previousSessionFile: "/sessions/session-a.jsonl" },
		ctx,
	);

	publications.length = 0;
	await commandHandler?.("web", ctx);
	assert.deepEqual(
		publications.map((publication) => publication.source?.sessionId),
		["session-c", "session-a"],
		"the active runtime and the most recently used inactive runtime are retained",
	);

	sessionId = "session-b";
	await handlers.get("session_switch")?.({ type: "session_switch", reason: "resume" }, ctx);
	assert.equal(publications.at(-1)?.source?.sessionId, "session-b");
	assert.equal(publications.at(-1)?.state.timeline?.history.length, 0);

	await handlers.get("context")?.(
		{ type: "context", messages: [{ role: "assistant", timestamp: 3 }] },
		ctx,
	);
	assert.deepEqual(publications.at(-1)?.state.timeline?.activeIds, ["message-local-1"]);
	assert.equal(publications.at(-1)?.state.timeline?.history.length, 1);

	publications.length = 0;
	await commandHandler?.("web", ctx);
	assert.deepEqual(publications.map((publication) => publication.source?.sessionId), [
		"session-b",
		"session-c",
	]);

	await handlers.get("session_shutdown")?.({ type: "session_shutdown" }, ctx);
});
