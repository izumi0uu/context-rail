import {
	createContextRailRuntime,
	type ContextRailExtensionOptions,
} from "./extension-runtime.ts";
import type { OmpEventMap, OmpExtensionApi } from "./omp-types.ts";

function completedSummaryCompaction(event: OmpEventMap["auto_compaction_end"]): boolean {
	return (
		(event.action === "context-full" || event.action === "snapcompact") &&
		!event.aborted &&
		!event.skipped &&
		typeof event.result?.summary === "string" &&
		event.result.summary.trim().length > 0
	);
}

export function createOmpContextRailExtension(
	options: ContextRailExtensionOptions = {},
): (omp: OmpExtensionApi) => void {
	return function contextRailOmpExtension(omp: OmpExtensionApi): void {
		const runtime = createContextRailRuntime(options);

		omp.on("message_end", (event, ctx) => runtime.messageEnd(event.message, ctx));
		omp.on("context", (event, ctx) => runtime.context(event.messages, ctx));
		omp.on("tool_execution_start", (event, ctx) =>
			runtime.toolExecutionStart(event.toolCallId, event.toolName, ctx),
		);
		omp.on("tool_execution_end", (event, ctx) =>
			runtime.toolExecutionEnd(event.toolCallId, ctx),
		);
		omp.on("auto_compaction_start", (_event, ctx) => runtime.compactionStarted(ctx));
		omp.on("auto_compaction_end", (event, ctx) =>
			runtime.compactionFinished(ctx, completedSummaryCompaction(event)),
		);
		omp.on("session_compact", (_event, ctx) => runtime.compactionCommitted(ctx));
		omp.on("session_start", (_event, ctx) => runtime.sessionActivated(ctx, false));
		omp.on("session_switch", (_event, ctx) => runtime.sessionActivated(ctx));
		omp.on("session_branch", (_event, ctx) => runtime.sessionActivated(ctx));
		omp.on("session_shutdown", (_event, ctx) => runtime.shutdown(ctx));

		omp.registerCommand("context-rail", {
			description: "Control the terminal strip or local web viewer",
			handler: (args, ctx) => runtime.command(args, ctx),
		});
	};
}

export type { ContextRailExtensionOptions } from "./extension-runtime.ts";
