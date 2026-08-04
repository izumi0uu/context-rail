import assert from "node:assert/strict";
import test from "node:test";
import {
	createContextRailProcessState,
	createContextRailRuntime,
} from "../src/extension-runtime.ts";
import type { ContextRailSessionSource } from "../src/hub-types.ts";
import { createPiContextRailExtension } from "../src/pi-extension.ts";
import type {
	PiEventHandler,
	PiEventMap,
	PiExtensionApi,
	PiExtensionContext,
} from "../src/pi-types.ts";
import type { RenderState } from "../src/render.ts";

interface Publication {
	state: RenderState;
	source?: ContextRailSessionSource;
}

function deferred<T>(): {
	promise: Promise<T>;
	resolve(value: T): void;
	reject(reason?: unknown): void;
} {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((next, fail) => {
		resolve = next;
		reject = fail;
	});
	return { promise, resolve, reject };
}

function clonePublication(
	state: RenderState,
	source?: ContextRailSessionSource,
): Publication {
	return {
		state: structuredClone(state),
		...(source ? { source: { ...source } } : {}),
	};
}

test("connects Pi lifecycle events to the shared ContextRail runtime", async () => {
	const handlers = new Map<keyof PiEventMap, PiEventHandler<keyof PiEventMap>>();
	let commandHandler:
		| ((args: string, ctx: PiExtensionContext) => Promise<void> | void)
		| undefined;
	const publications: Publication[] = [];
	const notifications: string[] = [];
	const statuses: Array<string | undefined> = [];
	const widgets: Array<string[] | undefined> = [];
	let viewerStops = 0;

	const api = {
		on(event: keyof PiEventMap, handler: PiEventHandler<keyof PiEventMap>) {
			handlers.set(event, handler);
		},
		registerCommand(
			_name: string,
			options: {
				handler: (args: string, ctx: PiExtensionContext) => Promise<void> | void;
			},
		) {
			commandHandler = options.handler;
		},
	} as PiExtensionApi;

	const ctx: PiExtensionContext = {
		cwd: "/projects/context-rail",
		model: { id: "pi-test-model" },
		sessionManager: {
			getSessionId: () => "pi-session-a",
			getSessionFile: () => "/sessions/pi-session-a.jsonl",
			getSessionName: () => "Pi session",
			getCwd: () => "/projects/context-rail",
		},
		getContextUsage: () => ({ tokens: 4_000, contextWindow: 16_000, percent: 25 }),
		getSystemPrompt: () => "Pi system prompt",
		ui: {
			setStatus: (_key, value) => statuses.push(value),
			setWidget: (_key, value) => widgets.push(value),
			notify: (message) => notifications.push(message),
		},
	};

	createPiContextRailExtension({
		processId: "pi-process-test",
		startViewer: async () => ({
			instanceId: "pi-hub-test",
			port: 4317,
			url: "http://127.0.0.1:4317/",
			viewerUrl: "http://127.0.0.1:4317/",
			healthy: async () => true,
			publish: (state, source) => publications.push(clonePublication(state, source)),
			heartbeat: () => undefined,
			disconnect: () => undefined,
			stop: async () => {
				viewerStops += 1;
			},
		}),
	})(api);

	assert.deepEqual([...handlers.keys()].sort(), [
		"context",
		"message_end",
		"session_compact",
		"session_info_changed",
		"session_shutdown",
		"session_start",
		"session_tree",
		"tool_execution_end",
		"tool_execution_start",
	]);
	assert.ok(commandHandler);

	await handlers.get("session_start")?.(
		{ type: "session_start", reason: "startup" },
		ctx,
	);
	await handlers.get("context")?.(
		{
			type: "context",
			messages: [
				{ role: "user", content: "Question", timestamp: 1 },
				{ role: "assistant", content: [{ type: "text", text: "Answer" }], timestamp: 2 },
			],
		},
		ctx,
	);
	assert.equal(statuses.at(-1), "ctx 25% | 4.0k/16.0k | 3 items");

	await commandHandler?.("web", ctx);
	assert.equal(notifications.at(-1), "ContextRail viewer: http://127.0.0.1:4317/");
	assert.equal(publications.at(-1)?.source?.processId, "pi-process-test");
	assert.equal(publications.at(-1)?.source?.sessionId, "pi-session-a");
	assert.deepEqual(publications.at(-1)?.state.timeline?.activeIds, [
		"system-prompt",
		"message-local-1",
		"message-local-2",
	]);

	await handlers.get("message_end")?.(
		{ type: "message_end", message: { role: "assistant", content: "Pending", timestamp: 3 } },
		ctx,
	);
	assert.deepEqual(publications.at(-1)?.state.timeline?.pendingIds, ["message-local-3"]);

	await handlers.get("tool_execution_start")?.(
		{
			type: "tool_execution_start",
			toolCallId: "pi-call-1",
			toolName: "read",
			args: {},
		},
		ctx,
	);
	assert.equal(publications.at(-1)?.state.phase, "tool");
	await handlers.get("tool_execution_end")?.(
		{
			type: "tool_execution_end",
			toolCallId: "pi-call-1",
			toolName: "read",
			result: {},
			isError: false,
		},
		ctx,
	);
	assert.equal(publications.at(-1)?.state.phase, "context");

	await handlers.get("context")?.(
		{
			type: "context",
			messages: [
				{ role: "user", content: "Before compact", timestamp: 10 },
				{ role: "assistant", content: "Before compact", timestamp: 11 },
			],
		},
		ctx,
	);
	await handlers.get("session_compact")?.(
		{
			type: "session_compact",
			compactionEntry: { type: "compaction", summary: "Pi summary" },
			fromExtension: false,
			reason: "threshold",
			willRetry: false,
		},
		ctx,
	);
	await handlers.get("context")?.(
		{
			type: "context",
			messages: [{ role: "assistant", content: "After compact", timestamp: 12 }],
		},
		ctx,
	);
	assert.equal(
		publications.at(-1)?.state.timeline?.history.filter((item) => item.synthetic).length,
		1,
	);
	assert.ok((publications.at(-1)?.state.timeline?.summaryEdges.length ?? 0) > 0);

	const historyBeforeTree = publications.at(-1)?.state.timeline?.history.length;
	await handlers.get("session_tree")?.(
		{ type: "session_tree", oldLeafId: "leaf-a", newLeafId: "leaf-b" },
		ctx,
	);
	assert.equal(publications.at(-1)?.state.timeline?.history.length, historyBeforeTree);
	assert.equal(publications.at(-1)?.source?.activity, false);

	await handlers.get("session_info_changed")?.(
		{ type: "session_info_changed", name: "Renamed Pi session" },
		ctx,
	);
	assert.equal(publications.at(-1)?.source?.sessionId, "pi-session-a");

	await handlers.get("session_shutdown")?.(
		{ type: "session_shutdown", reason: "quit" },
		ctx,
	);
	assert.equal(statuses.at(-1), undefined);
	assert.equal(widgets.at(-1), undefined);
	assert.equal(viewerStops, 1);
});

test("Pi compaction provenance is armed only by the committed event", async () => {
	const handlers = new Map<keyof PiEventMap, PiEventHandler<keyof PiEventMap>>();
	const publications: Publication[] = [];
	let commandHandler:
		| ((args: string, ctx: PiExtensionContext) => Promise<void> | void)
		| undefined;
	const api = {
		on(event: keyof PiEventMap, handler: PiEventHandler<keyof PiEventMap>) {
			handlers.set(event, handler);
		},
		registerCommand(
			_name: string,
			options: {
				handler: (args: string, ctx: PiExtensionContext) => Promise<void> | void;
			},
		) {
			commandHandler = options.handler;
		},
	} as PiExtensionApi;
	const ctx: PiExtensionContext = {
		cwd: "/projects/context-rail",
		sessionManager: {
			getSessionId: () => "pi-compaction",
			getSessionFile: () => "/sessions/pi-compaction.jsonl",
		},
		getContextUsage: () => undefined,
		getSystemPrompt: () => "",
		ui: {
			setStatus: () => undefined,
			setWidget: () => undefined,
			notify: () => undefined,
		},
	};

	createPiContextRailExtension({
		processId: "pi-compaction-test",
		startViewer: async () => ({
			instanceId: "pi-hub-test",
			port: 4317,
			url: "http://127.0.0.1:4317/",
			viewerUrl: "http://127.0.0.1:4317/",
			healthy: async () => true,
			publish: (state, source) => publications.push(clonePublication(state, source)),
			heartbeat: () => undefined,
			disconnect: () => undefined,
			stop: async () => undefined,
		}),
	})(api);

	await handlers.get("context")?.(
		{
			type: "context",
			messages: [
				{ role: "user", timestamp: 1 },
				{ role: "assistant", timestamp: 2 },
			],
		},
		ctx,
	);
	await commandHandler?.("web", ctx);
	await handlers.get("context")?.(
		{ type: "context", messages: [{ role: "assistant", timestamp: 3 }] },
		ctx,
	);
	assert.equal(publications.at(-1)?.state.timeline?.history.some((item) => item.synthetic), false);

	await handlers.get("session_shutdown")?.(
		{ type: "session_shutdown", reason: "quit" },
		ctx,
	);
});

test("Pi session events immediately hydrate the authoritative model context", async () => {
	const handlers = new Map<keyof PiEventMap, PiEventHandler<keyof PiEventMap>>();
	const publications: Publication[] = [];
	let commandHandler:
		| ((args: string, ctx: PiExtensionContext) => Promise<void> | void)
		| undefined;
	let buildCalls = 0;
	let entries: Array<Record<string, unknown>> = [];
	const sessionManager = {
		getSessionId: () => "pi-hydration",
		getSessionFile: () => "/sessions/pi-hydration.jsonl",
		buildContextEntries: () => {
			buildCalls += 1;
			return entries;
		},
	};
	const ctx: PiExtensionContext = {
		cwd: "/projects/context-rail",
		sessionManager,
		getContextUsage: () => undefined,
		getSystemPrompt: () => "",
		ui: {
			setStatus: () => undefined,
			setWidget: () => undefined,
			notify: () => undefined,
		},
	};
	const api = {
		on(event: keyof PiEventMap, handler: PiEventHandler<keyof PiEventMap>) {
			handlers.set(event, handler);
		},
		registerCommand(
			_name: string,
			options: {
				handler: (args: string, ctx: PiExtensionContext) => Promise<void> | void;
			},
		) {
			commandHandler = options.handler;
		},
	} as PiExtensionApi;

	createPiContextRailExtension({
		processId: "pi-hydration-test",
		startViewer: async () => ({
			instanceId: "pi-hub-test",
			port: 4317,
			url: "http://127.0.0.1:4317/",
			viewerUrl: "http://127.0.0.1:4317/",
			healthy: async () => true,
			publish: (state, source) => publications.push(clonePublication(state, source)),
			heartbeat: () => undefined,
			disconnect: () => undefined,
			stop: async () => undefined,
		}),
	})(api);
	await commandHandler?.("web", ctx);

	entries = [{
		type: "message",
		id: "entry-user",
		parentId: null,
		timestamp: "2026-08-04T00:00:00.000Z",
		message: { role: "user", content: "Restored prompt", timestamp: 1 },
	}];
	await handlers.get("session_start")?.(
		{ type: "session_start", reason: "resume" },
		ctx,
	);
	assert.equal(buildCalls, 1);
	assert.equal(publications.at(-1)?.state.timeline?.activeIds.length, 1);
	assert.equal(
		publications.at(-1)?.state.timeline?.history.at(-1)?.detail?.modelMessages[0]?.modelRole,
		"user",
	);

	entries = [
		{
			type: "compaction",
			id: "entry-summary",
			parentId: "entry-user",
			timestamp: "2026-08-04T00:01:00.000Z",
			summary: "Pi compacted state",
			firstKeptEntryId: "entry-kept",
			tokensBefore: 8_000,
		},
		{
			type: "message",
			id: "entry-kept",
			parentId: "entry-summary",
			timestamp: "2026-08-04T00:02:00.000Z",
			message: { role: "assistant", content: "Kept answer", timestamp: 2 },
		},
	];
	await handlers.get("session_compact")?.(
		{
			type: "session_compact",
			compactionEntry: entries[0],
			fromExtension: false,
			reason: "manual",
			willRetry: false,
		},
		ctx,
	);
	assert.equal(buildCalls, 2);
	assert.equal(publications.at(-1)?.state.timeline?.activeIds.length, 2);
	assert.equal(
		publications.at(-1)?.state.timeline?.history.filter((item) => item.synthetic).length,
		0,
	);
	assert.equal(
		publications.at(-1)?.state.timeline?.history.find((item) => item.kind === "memory")
			?.detail?.sourceRole,
		"compactionSummary",
	);

	entries = [{
		type: "message",
		id: "entry-branch",
		parentId: null,
		timestamp: "2026-08-04T00:03:00.000Z",
		message: { role: "user", content: "Other branch", timestamp: 3 },
	}];
	await handlers.get("session_tree")?.(
		{ type: "session_tree", oldLeafId: "entry-kept", newLeafId: "entry-branch" },
		ctx,
	);
	assert.equal(buildCalls, 3);
	assert.equal(publications.at(-1)?.state.timeline?.activeIds.length, 1);
	assert.equal(publications.at(-1)?.source?.activity, false);

	await handlers.get("session_shutdown")?.(
		{ type: "session_shutdown", reason: "quit" },
		ctx,
	);
});

test("Pi adapter replacement preserves prior session history in one producer", async () => {
	const publications: Publication[] = [];
	let viewerStops = 0;
	let viewerDisposals = 0;
	let sessionId = "pi-session-a";
	let entriesBySession: Record<string, Array<Record<string, unknown>>> = {
		"pi-session-a": [{
			type: "message",
			id: "a-current",
			parentId: null,
			timestamp: "2026-08-04T01:00:00.000Z",
			message: { role: "assistant", content: "A current", timestamp: 30 },
		}],
		"pi-session-b": [{
			type: "message",
			id: "b-current",
			parentId: null,
			timestamp: "2026-08-04T02:00:00.000Z",
			message: { role: "user", content: "B current", timestamp: 40 },
		}],
	};
	const ctx: PiExtensionContext = {
		cwd: "/projects/context-rail",
		sessionManager: {
			getSessionId: () => sessionId,
			getSessionFile: () => `/sessions/${sessionId}.jsonl`,
			buildContextEntries: () => entriesBySession[sessionId] ?? [],
		},
		getContextUsage: () => undefined,
		getSystemPrompt: () => "",
		ui: {
			setStatus: () => undefined,
			setWidget: () => undefined,
			notify: () => undefined,
		},
	};
	const options = {
		processId: "pi-replacement-test",
		connectHub: async () => ({
			instanceId: "pi-hub-test",
			port: 4317,
			url: "http://127.0.0.1:4317/",
			viewerUrl: "http://127.0.0.1:4317/",
			healthy: async () => true,
			publish: (state: RenderState, source?: ContextRailSessionSource) =>
				publications.push(clonePublication(state, source)),
			heartbeat: () => undefined,
			disconnect: () => undefined,
			dispose: () => {
				viewerDisposals += 1;
			},
			stop: async () => {
				viewerStops += 1;
			},
		}),
	};
	const loadAdapter = () => {
		const handlers = new Map<keyof PiEventMap, PiEventHandler<keyof PiEventMap>>();
		const api = {
			on(event: keyof PiEventMap, handler: PiEventHandler<keyof PiEventMap>) {
				handlers.set(event, handler);
			},
			registerCommand() {},
		} as PiExtensionApi;
		createPiContextRailExtension(options)(api);
		return handlers;
	};

	let handlers = loadAdapter();
	await handlers.get("context")?.(
		{
			type: "context",
			messages: [
				{ role: "user", content: "A old prompt", timestamp: 10 },
				{ role: "assistant", content: "A old answer", timestamp: 20 },
				{ role: "assistant", content: "A current", timestamp: 30 },
			],
		},
		ctx,
	);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(publications.at(-1)?.state.timeline?.history.length, 3);
	await handlers.get("session_shutdown")?.(
		{ type: "session_shutdown", reason: "resume", targetSessionFile: "/sessions/pi-session-b.jsonl" },
		ctx,
	);

	sessionId = "pi-session-b";
	handlers = loadAdapter();
	await handlers.get("session_start")?.(
		{ type: "session_start", reason: "resume", previousSessionFile: "/sessions/pi-session-a.jsonl" },
		ctx,
	);
	await new Promise<void>((resolve) => setImmediate(resolve));
	await handlers.get("session_shutdown")?.(
		{ type: "session_shutdown", reason: "resume", targetSessionFile: "/sessions/pi-session-a.jsonl" },
		ctx,
	);

	const publicationsBeforeResume = publications.length;
	sessionId = "pi-session-a";
	handlers = loadAdapter();
	await handlers.get("session_start")?.(
		{ type: "session_start", reason: "resume", previousSessionFile: "/sessions/pi-session-b.jsonl" },
		ctx,
	);
	await new Promise<void>((resolve) => setImmediate(resolve));
	const resumed = publications
		.slice(publicationsBeforeResume)
		.find((publication) => publication.source?.sessionId === "pi-session-a" && publication.source.active);
	assert.equal(resumed?.source?.processId, "pi-replacement-test");
	assert.equal(resumed?.source?.sessionId, "pi-session-a");
	assert.equal(resumed?.state.timeline?.history.length, 3);
	assert.equal(viewerStops, 0, "session handoff must not disconnect the process producer");
	assert.equal(viewerDisposals, 2);

	await handlers.get("session_shutdown")?.(
		{ type: "session_shutdown", reason: "quit" },
		ctx,
	);
	assert.equal(viewerStops, 1);
});

test("Pi monitoring stays stopped across adapter replacement until web re-enables it", async () => {
	let connectCalls = 0;
	let commandHandler:
		| ((args: string, ctx: PiExtensionContext) => Promise<void> | void)
		| undefined;
	const ctx: PiExtensionContext = {
		cwd: "/projects/context-rail",
		sessionManager: {
			getSessionId: () => "pi-stopped-session",
			getSessionFile: () => "/sessions/pi-stopped-session.jsonl",
			buildContextEntries: () => [],
		},
		getContextUsage: () => undefined,
		getSystemPrompt: () => "",
		ui: {
			setStatus: () => undefined,
			setWidget: () => undefined,
			notify: () => undefined,
		},
	};
	const options = {
		processId: "pi-stopped-replacement-test",
		connectHub: async () => {
			connectCalls += 1;
			return {
				instanceId: "pi-hub-test",
				port: 4317,
				url: "http://127.0.0.1:4317/",
				viewerUrl: "http://127.0.0.1:4317/",
				healthy: async () => true,
				publish: () => undefined,
				heartbeat: () => undefined,
				disconnect: () => undefined,
				dispose: () => undefined,
				stop: async () => undefined,
			};
		},
	};
	const loadAdapter = () => {
		const handlers = new Map<keyof PiEventMap, PiEventHandler<keyof PiEventMap>>();
		const api = {
			on(event: keyof PiEventMap, handler: PiEventHandler<keyof PiEventMap>) {
				handlers.set(event, handler);
			},
			registerCommand(
				_name: string,
				command: {
					handler: (args: string, commandContext: PiExtensionContext) => Promise<void> | void;
				},
			) {
				commandHandler = command.handler;
			},
		} as PiExtensionApi;
		createPiContextRailExtension(options)(api);
		return handlers;
	};

	let handlers = loadAdapter();
	await commandHandler?.("stop", ctx);
	await handlers.get("session_shutdown")?.(
		{ type: "session_shutdown", reason: "reload" },
		ctx,
	);

	handlers = loadAdapter();
	await handlers.get("session_start")?.(
		{ type: "session_start", reason: "startup" },
		ctx,
	);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(connectCalls, 0);

	await commandHandler?.("web", ctx);
	assert.equal(connectCalls, 1);
	await handlers.get("session_shutdown")?.(
		{ type: "session_shutdown", reason: "quit" },
		ctx,
	);
});

test("a late viewer health check cannot act on Pi UI after adapter handoff", async () => {
	const health = deferred<boolean>();
	const notifications: string[] = [];
	const publications: Publication[] = [];
	let disposals = 0;
	let healthyCalls = 0;
	let commandHandler:
		| ((args: string, ctx: PiExtensionContext) => Promise<void> | void)
		| undefined;
	const handlers = new Map<keyof PiEventMap, PiEventHandler<keyof PiEventMap>>();
	const ctx: PiExtensionContext = {
		cwd: "/projects/context-rail",
		sessionManager: {
			getSessionId: () => "pi-health-race",
			getSessionFile: () => "/sessions/pi-health-race.jsonl",
		},
		getContextUsage: () => undefined,
		getSystemPrompt: () => "",
		ui: {
			setStatus: () => undefined,
			setWidget: () => undefined,
			notify: (message) => notifications.push(message),
		},
	};
	const api = {
		on(event: keyof PiEventMap, handler: PiEventHandler<keyof PiEventMap>) {
			handlers.set(event, handler);
		},
		registerCommand(
			_name: string,
			command: {
				handler: (args: string, commandContext: PiExtensionContext) => Promise<void> | void;
			},
		) {
			commandHandler = command.handler;
		},
	} as PiExtensionApi;

	createPiContextRailExtension({
		processId: "pi-health-race-test",
		startViewer: async () => ({
			instanceId: "pi-hub-test",
			port: 4317,
			url: "http://127.0.0.1:4317/",
			viewerUrl: "http://127.0.0.1:4317/",
			healthy: () => {
				healthyCalls += 1;
				return health.promise;
			},
			publish: (state, source) => publications.push(clonePublication(state, source)),
			heartbeat: () => undefined,
			disconnect: () => undefined,
			dispose: () => {
				disposals += 1;
			},
			stop: async () => undefined,
		}),
	})(api);

	await handlers.get("context")?.(
		{ type: "context", messages: [{ role: "user", content: "Question" }] },
		ctx,
	);
	await commandHandler?.("web", ctx);
	const notificationCount = notifications.length;
	const publicationCount = publications.length;

	const pendingWeb = commandHandler?.("web", ctx);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(healthyCalls, 1);
	await handlers.get("session_shutdown")?.(
		{ type: "session_shutdown", reason: "reload" },
		ctx,
	);
	assert.equal(disposals, 1);

	health.resolve(true);
	await pendingWeb;
	assert.equal(publications.length, publicationCount);
	assert.equal(notifications.length, notificationCount);
});

test("Pi handoff does not wait for a pending Hub connection", async () => {
	const connection = deferred<{
		instanceId: string;
		port: number;
		url: string;
		viewerUrl: string;
		healthy(): Promise<boolean>;
		publish(state: RenderState, source?: ContextRailSessionSource): void;
		heartbeat(): void;
		disconnect(): void;
		dispose(): void;
		stop(): Promise<void>;
	}>();
	const handlers = new Map<keyof PiEventMap, PiEventHandler<keyof PiEventMap>>();
	let disposals = 0;
	let publications = 0;
	const ctx: PiExtensionContext = {
		cwd: "/projects/context-rail",
		sessionManager: {
			getSessionId: () => "pi-pending-handoff",
			getSessionFile: () => "/sessions/pi-pending-handoff.jsonl",
			buildContextEntries: () => [],
		},
		getContextUsage: () => undefined,
		getSystemPrompt: () => "",
		ui: {
			setStatus: () => undefined,
			setWidget: () => undefined,
			notify: () => undefined,
		},
	};
	const api = {
		on(event: keyof PiEventMap, handler: PiEventHandler<keyof PiEventMap>) {
			handlers.set(event, handler);
		},
		registerCommand() {},
	} as PiExtensionApi;
	createPiContextRailExtension({
		processId: "pi-pending-handoff-test",
		connectHub: () => connection.promise,
	})(api);

	await handlers.get("session_start")?.(
		{ type: "session_start", reason: "startup" },
		ctx,
	);
	let shutdownSettled = false;
	const shutdown = Promise.resolve(handlers.get("session_shutdown")?.(
		{ type: "session_shutdown", reason: "reload" },
		ctx,
	)).then(() => {
		shutdownSettled = true;
	});
	await new Promise<void>((resolve) => setImmediate(resolve));
	const settledBeforeConnection = shutdownSettled;

	connection.resolve({
		instanceId: "pi-hub-test",
		port: 4317,
		url: "http://127.0.0.1:4317/",
		viewerUrl: "http://127.0.0.1:4317/",
		healthy: async () => true,
		publish: () => {
			publications += 1;
		},
		heartbeat: () => undefined,
		disconnect: () => undefined,
		dispose: () => {
			disposals += 1;
		},
		stop: async () => undefined,
	});
	await shutdown;
	await new Promise<void>((resolve) => setImmediate(resolve));

	assert.equal(settledBeforeConnection, true);
	assert.equal(disposals, 1);
	assert.equal(publications, 0);
});

test("Pi handoff absorbs a rejected background Hub connection", async () => {
	const connection = deferred<never>();
	const handlers = new Map<keyof PiEventMap, PiEventHandler<keyof PiEventMap>>();
	const ctx: PiExtensionContext = {
		cwd: "/projects/context-rail",
		sessionManager: {
			getSessionId: () => "pi-rejected-handoff",
			getSessionFile: () => "/sessions/pi-rejected-handoff.jsonl",
			buildContextEntries: () => [],
		},
		getContextUsage: () => undefined,
		getSystemPrompt: () => "",
		ui: {
			setStatus: () => undefined,
			setWidget: () => undefined,
			notify: () => undefined,
		},
	};
	const api = {
		on(event: keyof PiEventMap, handler: PiEventHandler<keyof PiEventMap>) {
			handlers.set(event, handler);
		},
		registerCommand() {},
	} as PiExtensionApi;
	createPiContextRailExtension({
		processId: "pi-rejected-handoff-test",
		connectHub: () => connection.promise,
	})(api);

	await handlers.get("session_start")?.(
		{ type: "session_start", reason: "startup" },
		ctx,
	);
	const shutdown = Promise.resolve(handlers.get("session_shutdown")?.(
		{ type: "session_shutdown", reason: "resume" },
		ctx,
	));
	const rejection = new Error("Hub unavailable");
	connection.reject(rejection);
	await assert.doesNotReject(shutdown);
});

test("Pi serializes stop before reopening the viewer", async () => {
	const firstStop = deferred<void>();
	const handlers = new Map<keyof PiEventMap, PiEventHandler<keyof PiEventMap>>();
	let commandHandler:
		| ((args: string, ctx: PiExtensionContext) => Promise<void> | void)
		| undefined;
	let starts = 0;
	const ctx: PiExtensionContext = {
		cwd: "/projects/context-rail",
		sessionManager: {
			getSessionId: () => "pi-stop-web",
			getSessionFile: () => "/sessions/pi-stop-web.jsonl",
		},
		getContextUsage: () => undefined,
		getSystemPrompt: () => "",
		ui: {
			setStatus: () => undefined,
			setWidget: () => undefined,
			notify: () => undefined,
		},
	};
	const api = {
		on(event: keyof PiEventMap, handler: PiEventHandler<keyof PiEventMap>) {
			handlers.set(event, handler);
		},
		registerCommand(
			_name: string,
			command: {
				handler: (args: string, commandContext: PiExtensionContext) => Promise<void> | void;
			},
		) {
			commandHandler = command.handler;
		},
	} as PiExtensionApi;
	createPiContextRailExtension({
		processId: "pi-stop-web-test",
		startViewer: async () => {
			starts += 1;
			const start = starts;
			return {
				instanceId: `pi-hub-${start}`,
				port: 4317,
				url: "http://127.0.0.1:4317/",
				viewerUrl: "http://127.0.0.1:4317/",
				healthy: async () => true,
				publish: () => undefined,
				heartbeat: () => undefined,
				disconnect: () => undefined,
				dispose: () => undefined,
				stop: start === 1 ? () => firstStop.promise : async () => undefined,
			};
		},
	})(api);

	await commandHandler?.("web", ctx);
	const stopping = commandHandler?.("stop", ctx);
	const reopening = commandHandler?.("web", ctx);
	await new Promise<void>((resolve) => setImmediate(resolve));
	const startsBeforeStopFinished = starts;
	firstStop.resolve();
	await Promise.all([stopping, reopening]);

	assert.equal(startsBeforeStopFinished, 1);
	assert.equal(starts, 2);
	await handlers.get("session_shutdown")?.(
		{ type: "session_shutdown", reason: "quit" },
		ctx,
	);
});

test("a slow Pi stop does not notify after adapter handoff", async () => {
	const stop = deferred<void>();
	const notifications: string[] = [];
	const handlers = new Map<keyof PiEventMap, PiEventHandler<keyof PiEventMap>>();
	let stopCalls = 0;
	let commandHandler:
		| ((args: string, ctx: PiExtensionContext) => Promise<void> | void)
		| undefined;
	const ctx: PiExtensionContext = {
		cwd: "/projects/context-rail",
		sessionManager: {
			getSessionId: () => "pi-slow-stop",
			getSessionFile: () => "/sessions/pi-slow-stop.jsonl",
		},
		getContextUsage: () => undefined,
		getSystemPrompt: () => "",
		ui: {
			setStatus: () => undefined,
			setWidget: () => undefined,
			notify: (message) => notifications.push(message),
		},
	};
	const api = {
		on(event: keyof PiEventMap, handler: PiEventHandler<keyof PiEventMap>) {
			handlers.set(event, handler);
		},
		registerCommand(
			_name: string,
			command: {
				handler: (args: string, commandContext: PiExtensionContext) => Promise<void> | void;
			},
		) {
			commandHandler = command.handler;
		},
	} as PiExtensionApi;
	createPiContextRailExtension({
		processId: "pi-slow-stop-test",
		startViewer: async () => ({
			instanceId: "pi-hub-test",
			port: 4317,
			url: "http://127.0.0.1:4317/",
			viewerUrl: "http://127.0.0.1:4317/",
			healthy: async () => true,
			publish: () => undefined,
			heartbeat: () => undefined,
			disconnect: () => undefined,
			dispose: () => undefined,
			stop: () => {
				stopCalls += 1;
				return stop.promise;
			},
		}),
	})(api);

	await commandHandler?.("web", ctx);
	const notificationCount = notifications.length;
	const stopping = commandHandler?.("stop", ctx);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(stopCalls, 1);
	await handlers.get("session_shutdown")?.(
		{ type: "session_shutdown", reason: "reload" },
		ctx,
	);
	stop.resolve();
	await stopping;

	assert.equal(notifications.length, notificationCount);
});

test("shared Pi monitoring state disposes a sibling adapter before it can publish", async () => {
	const processState = createContextRailProcessState("pi-overlap-test");
	let sessionId = "pi-overlap-a";
	let firstStops = 0;
	let secondDisposals = 0;
	let secondPublications = 0;
	const ctx: PiExtensionContext = {
		cwd: "/projects/context-rail",
		sessionManager: {
			getSessionId: () => sessionId,
			getSessionFile: () => `/sessions/${sessionId}.jsonl`,
		},
		getContextUsage: () => undefined,
		getSystemPrompt: () => "",
		ui: {
			setStatus: () => undefined,
			setWidget: () => undefined,
			notify: () => undefined,
		},
	};
	const first = createContextRailRuntime({
		processState,
		startViewer: async () => ({
			instanceId: "pi-hub-first",
			port: 4317,
			url: "http://127.0.0.1:4317/",
			viewerUrl: "http://127.0.0.1:4317/",
			healthy: async () => true,
			publish: () => undefined,
			heartbeat: () => undefined,
			disconnect: () => undefined,
			dispose: () => undefined,
			stop: async () => {
				firstStops += 1;
			},
		}),
	});
	const second = createContextRailRuntime({
		processState,
		startViewer: async () => ({
			instanceId: "pi-hub-second",
			port: 4317,
			url: "http://127.0.0.1:4317/",
			viewerUrl: "http://127.0.0.1:4317/",
			healthy: async () => true,
			publish: () => {
				secondPublications += 1;
			},
			heartbeat: () => undefined,
			disconnect: () => undefined,
			dispose: () => {
				secondDisposals += 1;
			},
			stop: async () => undefined,
		}),
	});

	await first.command("web", ctx);
	sessionId = "pi-overlap-b";
	await second.command("web", ctx);
	const publicationsBeforeStop = secondPublications;
	sessionId = "pi-overlap-a";
	await first.command("stop", ctx);
	assert.equal(firstStops, 1);

	sessionId = "pi-overlap-b";
	second.context([{ role: "user", content: "Must stay local" }], ctx);
	assert.equal(secondPublications, publicationsBeforeStop);
	assert.equal(secondDisposals, 1);

	await first.shutdown(ctx, "handoff");
	await second.shutdown(ctx, "handoff");
});
