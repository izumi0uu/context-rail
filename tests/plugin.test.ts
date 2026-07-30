import assert from "node:assert/strict";
import test from "node:test";
import contextRailExtension from "../src/index.ts";
import type {
	OmpEventHandler,
	OmpEventMap,
	OmpExtensionApi,
	OmpExtensionContext,
} from "../src/omp-types.ts";

test("connects OMP lifecycle events to status and widget UI", async () => {
	const handlers = new Map<keyof OmpEventMap, OmpEventHandler<keyof OmpEventMap>>();
	let commandHandler: ((args: string, ctx: OmpExtensionContext) => Promise<void> | void) | undefined;
	let commandName: string | undefined;

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
	const ctx: OmpExtensionContext = {
		model: { id: "test-model" },
		getContextUsage: () => ({ tokens: 8_000, contextWindow: 32_000, percent: 25 }),
		getSystemPrompt: () => ["base", "project"],
		ui: {
			setStatus: (_key, value) => statuses.push(value),
			setWidget: (_key, value) => widgets.push(value),
			notify: () => undefined,
		},
	};

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

	await handlers.get("tool_execution_start")?.(
		{ type: "tool_execution_start", toolCallId: "call-1", toolName: "bash" },
		ctx,
	);
	assert.match(statuses.at(-1) ?? "", /1 tool$/);

	await handlers.get("session_shutdown")?.({ type: "session_shutdown" }, ctx);
	assert.equal(statuses.at(-1), undefined);
	assert.equal(widgets.at(-1), undefined);
});
