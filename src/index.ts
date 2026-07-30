import type { OmpExtensionApi, OmpExtensionContext } from "./omp-types.ts";
import { renderStatus, renderWidget, type RenderState } from "./render.ts";
import { createSnapshot } from "./snapshot.ts";

const UI_KEY = "context-rail";

function systemPromptPartCount(ctx: OmpExtensionContext): number {
	const prompt = ctx.getSystemPrompt();
	if (Array.isArray(prompt)) return prompt.length;
	return prompt ? 1 : 0;
}

export default function contextRailExtension(pi: OmpExtensionApi): void {
	const state: RenderState = {
		snapshot: undefined,
		phase: "idle",
		activeTools: [],
	};
	let expanded = false;
	const activeTools = new Map<string, string>();

	const refresh = (ctx: OmpExtensionContext): void => {
		state.activeTools = [...activeTools.values()];
		ctx.ui.setStatus(UI_KEY, renderStatus(state));
		ctx.ui.setWidget(UI_KEY, expanded ? renderWidget(state) : undefined, { placement: "aboveEditor" });
	};

	const reset = (ctx: OmpExtensionContext): void => {
		state.snapshot = undefined;
		state.phase = "idle";
		activeTools.clear();
		refresh(ctx);
	};

	pi.on("context", (event, ctx) => {
		const usage = ctx.getContextUsage();
		state.snapshot = createSnapshot({
			messages: event.messages,
			...(usage ? { usage } : {}),
			...(ctx.model?.id ? { model: ctx.model.id } : {}),
			systemPromptParts: systemPromptPartCount(ctx),
		});
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
		state.phase = "compacting";
		refresh(ctx);
	});

	pi.on("auto_compaction_end", (_event, ctx) => {
		state.phase = "context";
		refresh(ctx);
	});

	pi.on("session_start", (_event, ctx) => reset(ctx));
	pi.on("session_switch", (_event, ctx) => reset(ctx));

	pi.on("session_shutdown", (_event, ctx) => {
		ctx.ui.setStatus(UI_KEY, undefined);
		ctx.ui.setWidget(UI_KEY, undefined, { placement: "aboveEditor" });
	});

	pi.registerCommand("context-rail", {
		description: "Show, hide, or toggle the context window strip",
		handler: (args, ctx) => {
			const action = args.trim().toLowerCase() || "toggle";
			if (action === "show") expanded = true;
			else if (action === "hide") expanded = false;
			else if (action === "toggle") expanded = !expanded;
			else {
				ctx.ui.notify("Usage: /context-rail [show|hide|toggle]", "warning");
				return;
			}
			refresh(ctx);
		},
	});
}

export { createSnapshot } from "./snapshot.ts";
export { renderStatus, renderStrip, renderWidget } from "./render.ts";
export type { ContextItem, ContextItemKind, ContextSnapshot } from "./snapshot.ts";
