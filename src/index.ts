import type { OmpExtensionApi, OmpExtensionContext } from "./omp-types.ts";
import { renderStatus, renderWidget, type RenderState } from "./render.ts";
import {
	startContextRailServer,
	type ContextRailViewer,
} from "./server.ts";
import { ContextMessageIdentity, createSnapshot } from "./snapshot.ts";
import { ContextTimeline } from "./timeline.ts";

const UI_KEY = "context-rail";

function systemPromptPartCount(ctx: OmpExtensionContext): number {
	const prompt = ctx.getSystemPrompt();
	if (Array.isArray(prompt)) return prompt.length;
	return prompt ? 1 : 0;
}

export interface ContextRailExtensionOptions {
	startViewer?: () => Promise<ContextRailViewer>;
}

export function createContextRailExtension(
	options: ContextRailExtensionOptions = {},
): (pi: OmpExtensionApi) => void {
	const startViewer = options.startViewer ?? startContextRailServer;

	return function contextRailExtension(pi: OmpExtensionApi): void {
		const timeline = new ContextTimeline();
		const identity = new ContextMessageIdentity();
		const state: RenderState = {
			snapshot: undefined,
			timeline: timeline.current(),
			phase: "idle",
			activeTools: [],
		};
		let expanded = false;
		let compactionPending = false;
		const activeTools = new Map<string, string>();
		let viewer: ContextRailViewer | undefined;

		const refresh = (ctx: OmpExtensionContext): void => {
			state.activeTools = [...activeTools.values()];
			ctx.ui.setStatus(UI_KEY, renderStatus(state));
			ctx.ui.setWidget(UI_KEY, expanded ? renderWidget(state) : undefined, {
				placement: "aboveEditor",
			});
			viewer?.publish(state);
		};

		const reset = (ctx: OmpExtensionContext): void => {
			state.snapshot = undefined;
			state.timeline = timeline.reset();
			state.phase = "idle";
			compactionPending = false;
			identity.reset();
			activeTools.clear();
			refresh(ctx);
		};

		pi.on("context", (event, ctx) => {
			const usage = ctx.getContextUsage();
			state.snapshot = createSnapshot({
				messages: event.messages,
				identity,
				...(usage ? { usage } : {}),
				...(ctx.model?.id ? { model: ctx.model.id } : {}),
				systemPromptParts: systemPromptPartCount(ctx),
			});
			state.timeline = timeline.apply(state.snapshot, { compaction: compactionPending });
			compactionPending = false;
			state.phase = "context";
			refresh(ctx);
		});

		pi.on("tool_execution_start", (event, ctx) => {
			activeTools.set(event.toolCallId, event.toolName);
			state.phase = "tool";
			refresh(ctx);
		});

		pi.on("tool_execution_end", (event, ctx) => {
			activeTools.delete(event.toolCallId);
			state.phase = activeTools.size > 0 ? "tool" : "context";
			refresh(ctx);
		});

		pi.on("auto_compaction_start", (_event, ctx) => {
			compactionPending = true;
			state.phase = "compacting";
			refresh(ctx);
		});

		pi.on("auto_compaction_end", (_event, ctx) => {
			state.phase = "context";
			refresh(ctx);
		});

		pi.on("session_start", (_event, ctx) => reset(ctx));
		pi.on("session_switch", (_event, ctx) => reset(ctx));

		pi.on("session_shutdown", async (_event, ctx) => {
			ctx.ui.setStatus(UI_KEY, undefined);
			ctx.ui.setWidget(UI_KEY, undefined, { placement: "aboveEditor" });
			await viewer?.stop();
			viewer = undefined;
		});

		pi.registerCommand("context-rail", {
			description: "Control the terminal strip or local web viewer",
			handler: async (args, ctx) => {
				const action = args.trim().toLowerCase() || "toggle";
				if (action === "web") {
					try {
						viewer ??= await startViewer();
						viewer.publish(state);
						ctx.ui.notify(`ContextRail viewer: ${viewer.url}`, "info");
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						ctx.ui.notify(`ContextRail viewer failed: ${message}`, "error");
					}
					return;
				}
				if (action === "stop") {
					await viewer?.stop();
					viewer = undefined;
					ctx.ui.notify("ContextRail viewer stopped", "info");
					return;
				}
				if (action === "show") expanded = true;
				else if (action === "hide") expanded = false;
				else if (action === "toggle") expanded = !expanded;
				else {
					ctx.ui.notify("Usage: /context-rail [show|hide|toggle|web|stop]", "warning");
					return;
				}
				refresh(ctx);
			},
		});
	};
}

export default createContextRailExtension();

export { createSnapshot } from "./snapshot.ts";
export { ContextMessageIdentity } from "./snapshot.ts";
export { ContextTimeline, emptyTimelineSnapshot } from "./timeline.ts";
export { renderStatus, renderStrip, renderWidget } from "./render.ts";
export { startContextRailServer } from "./server.ts";
export type { ContextRailViewer, ContextRailWebPayload } from "./server.ts";
export type { ContextItem, ContextItemKind, ContextSnapshot } from "./snapshot.ts";
export type {
	ContextTimelineSnapshot,
	HistoryItem,
	SummaryEdge,
} from "./timeline.ts";
