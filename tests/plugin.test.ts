import assert from "node:assert/strict";
import test from "node:test";
import { createContextRailExtension } from "../src/index.ts";
import type {
	OmpEventHandler,
	OmpEventMap,
	OmpExtensionApi,
	OmpExtensionContext,
} from "../src/omp-types.ts";
import type { RenderState } from "../src/render.ts";

test("connects OMP lifecycle events to status and widget UI", async () => {
	const handlers = new Map<keyof OmpEventMap, OmpEventHandler<keyof OmpEventMap>>();
	let commandHandler: ((args: string, ctx: OmpExtensionContext) => Promise<void> | void) | undefined;
	let commandName: string | undefined;
	const publications: RenderState[] = [];
	let viewerStops = 0;

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
		model: { id: "test-model" },
		getContextUsage: () => ({ tokens: 8_000, contextWindow: 32_000, percent: 25 }),
		getSystemPrompt: () => ["base", "project"],
		ui: {
			setStatus: (_key, value) => statuses.push(value),
			setWidget: (_key, value) => widgets.push(value),
			notify: (message) => notifications.push(message),
		},
	};

	const contextRailExtension = createContextRailExtension({
		startViewer: async () => ({
			port: 4317,
			url: "http://127.0.0.1:4317/",
			publish: (state) =>
				publications.push({
					snapshot: state.snapshot,
					timeline: state.timeline,
					phase: state.phase,
					activeTools: [...state.activeTools],
				}),
			stop: async () => {
				viewerStops += 1;
			},
		}),
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

	await commandHandler?.("web", ctx);
	assert.equal(notifications.at(-1), "ContextRail viewer: http://127.0.0.1:4317/");
	assert.equal(publications.at(-1)?.phase, "context");
	assert.equal(publications.at(-1)?.timeline?.history.length, 4);
	assert.deepEqual(publications.at(-1)?.timeline?.activeIds, [
		"system-prompt",
		"message-fallback-1",
		"message-fallback-2",
		"message-fallback-3",
	]);

	await handlers.get("tool_execution_start")?.(
		{ type: "tool_execution_start", toolCallId: "call-1", toolName: "bash" },
		ctx,
	);
	assert.match(statuses.at(-1) ?? "", /1 tool$/);

	await handlers.get("auto_compaction_start")?.({ type: "auto_compaction_start" }, ctx);
	await handlers.get("auto_compaction_end")?.({ type: "auto_compaction_end" }, ctx);
	await handlers.get("context")?.(
		{ type: "context", messages: [{ role: "assistant" }] },
		ctx,
	);
	assert.ok(publications.at(-1)?.timeline?.history.some((item) => item.synthetic));
	assert.ok((publications.at(-1)?.timeline?.summaryEdges.length ?? 0) >= 3);

	await handlers.get("session_switch")?.({ type: "session_switch" }, ctx);
	assert.equal(publications.at(-1)?.timeline?.history.length, 0);

	await handlers.get("session_shutdown")?.({ type: "session_shutdown" }, ctx);
	assert.equal(statuses.at(-1), undefined);
	assert.equal(widgets.at(-1), undefined);
	assert.equal(viewerStops, 1);
});
