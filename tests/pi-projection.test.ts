import assert from "node:assert/strict";
import test from "node:test";
import { createPiContextRailExtension } from "../src/pi-extension.ts";
import type {
	PiEventMap,
	PiExtensionApi,
	PiExtensionContext,
} from "../src/pi-types.ts";
import type { RenderState } from "../src/render.ts";
import type { ContextItemDetail, ContextMessageLike } from "../src/snapshot.ts";

type EventHandler = (
	event: PiEventMap[keyof PiEventMap],
	ctx: PiExtensionContext,
) => Promise<void> | void;

interface PiProjectionHarness {
	project(message: ContextMessageLike): Promise<ContextItemDetail | undefined>;
}

function createHarness(): PiProjectionHarness {
	const handlers = new Map<keyof PiEventMap, EventHandler>();
	let commandHandler:
		| ((args: string, ctx: PiExtensionContext) => Promise<void> | void)
		| undefined;
	const publications: RenderState[] = [];
	const api = {
		on(event: keyof PiEventMap, handler: EventHandler) {
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
	} as unknown as PiExtensionApi;
	const ctx: PiExtensionContext = {
		cwd: "/projects/context-rail",
		sessionManager: {
			getSessionId: () => "pi-projection",
			getSessionFile: () => "/sessions/pi-projection.jsonl",
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
		processId: "pi-projection-test",
		startViewer: async () => ({
			instanceId: "pi-projection-hub",
			port: 4317,
			url: "http://127.0.0.1:4317/",
			viewerUrl: "http://127.0.0.1:4317/",
			healthy: async () => true,
			publish: (state) => publications.push(structuredClone(state)),
			heartbeat: () => undefined,
			disconnect: () => undefined,
			stop: async () => undefined,
		}),
	})(api);

	return {
		async project(message) {
			assert.ok(commandHandler, "Pi command should be registered");
			await commandHandler("web", ctx);
			const contextHandler = handlers.get("context");
			assert.ok(contextHandler, "Pi context handler should be registered");
			await contextHandler({ type: "context", messages: [message] }, ctx);

			const timeline = publications.at(-1)?.timeline;
			const activeId = timeline?.activeIds[0];
			return timeline?.history.find((item) => item.id === activeId)?.detail;
		},
	};
}

test("projects Pi custom text as the single user message sent to the model", async () => {
	const detail = await createHarness().project({
		role: "custom",
		customType: "extension-context",
		content: "Injected context",
		timestamp: 1,
	});

	assert.deepEqual(detail, {
		sourceRole: "custom",
		modelMessages: [{
			modelRole: "user",
			blocks: [{ type: "text", text: "Injected context" }],
		}],
	});
});

test("keeps Pi mixed custom blocks in exact order within one user message", async () => {
	const detail = await createHarness().project({
		role: "custom",
		customType: "extension-context",
		content: [
			{ type: "text", text: "Before image" },
			{ type: "image", mimeType: "image/png", data: "cGl4ZWxz" },
			{ type: "text", text: "After image" },
		],
		timestamp: 2,
	});

	assert.deepEqual(detail, {
		sourceRole: "custom",
		modelMessages: [{
			modelRole: "user",
			blocks: [
				{ type: "text", text: "Before image" },
				{ type: "image", mimeType: "image/png", data: "cGl4ZWxz" },
				{ type: "text", text: "After image" },
			],
		}],
	});
});

test("projects Pi compaction summaries with Pi's exact model wrapper", async () => {
	const detail = await createHarness().project({
		role: "compactionSummary",
		summary: "Pi compacted facts",
		timestamp: 3,
	});

	assert.deepEqual(detail, {
		sourceRole: "compactionSummary",
		modelMessages: [{
			modelRole: "user",
			blocks: [{
				type: "text",
				text: "The conversation history before this point was compacted into the following summary:\n\n<summary>\nPi compacted facts\n</summary>",
			}],
		}],
	});
});
