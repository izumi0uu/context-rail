import {
	createContextRailProcessState,
	createContextRailRuntime,
	defaultContextRailProcessId,
	type ContextRailExtensionOptions,
	type ContextRailExtensionRuntime,
	type ContextRailProcessState,
} from "./extension-runtime.ts";
import type {
	PiExtensionApi,
	PiExtensionContext,
	PiSessionEntryLike,
} from "./pi-types.ts";
import {
	createContextItemDetail,
	type ContextItemDetail,
	type ContextMessageLike,
} from "./snapshot.ts";

const PI_PROCESS_STATES_KEY = Symbol.for("context-rail.pi-process-states.v1");
const PI_COMPACTION_PREFIX =
	"The conversation history before this point was compacted into the following summary:\n\n<summary>\n";
const PI_BRANCH_PREFIX =
	"The following is a summary of a branch that this conversation came back from:\n\n<summary>\n";
const PI_SUMMARY_SUFFIX = "\n</summary>";

interface PiProcessStateRegistry {
	readonly schemaVersion: 1;
	readonly pid: number;
	readonly states: Map<string, ContextRailProcessState>;
}

function processStateRegistry(): PiProcessStateRegistry {
	const globals = globalThis as unknown as Record<PropertyKey, unknown>;
	const existing = globals[PI_PROCESS_STATES_KEY] as Partial<PiProcessStateRegistry> | undefined;
	if (
		existing?.schemaVersion === 1 &&
		existing.pid === process.pid &&
		existing.states instanceof Map
	) return existing as PiProcessStateRegistry;
	const registry: PiProcessStateRegistry = {
		schemaVersion: 1,
		pid: process.pid,
		states: new Map(),
	};
	globals[PI_PROCESS_STATES_KEY] = registry;
	return registry;
}

function processStateFor(options: ContextRailExtensionOptions): ContextRailProcessState {
	if (options.processState) return options.processState;
	const processId = options.processId ?? defaultContextRailProcessId();
	const registry = processStateRegistry();
	let state = registry.states.get(processId);
	if (!state || state.schemaVersion !== 1 || state.pid !== process.pid) {
		state = createContextRailProcessState(processId);
		registry.states.set(processId, state);
	}
	return state;
}

function releaseProcessState(state: ContextRailProcessState): void {
	const registry = processStateRegistry();
	if (registry.states.get(state.processId) === state) registry.states.delete(state.processId);
}

function sourceRole(message: ContextMessageLike): string {
	return typeof message.role === "string" && message.role ? message.role : "unknown";
}

function piModelMessage(message: ContextMessageLike): ContextMessageLike {
	if (message.role === "custom") {
		return { ...message, role: "user" };
	}
	if (message.role === "compactionSummary") {
		return {
			...message,
			role: "user",
			content: [{
				type: "text",
				text: `${PI_COMPACTION_PREFIX}${typeof message.summary === "string" ? message.summary : ""}${PI_SUMMARY_SUFFIX}`,
			}],
		};
	}
	if (message.role === "branchSummary") {
		return {
			...message,
			role: "user",
			content: [{
				type: "text",
				text: `${PI_BRANCH_PREFIX}${typeof message.summary === "string" ? message.summary : ""}${PI_SUMMARY_SUFFIX}`,
			}],
		};
	}
	return message;
}

function createPiContextItemDetail(
	message: ContextMessageLike,
): ContextItemDetail | undefined {
	const detail = createContextItemDetail(piModelMessage(message));
	return detail ? { ...detail, sourceRole: sourceRole(message) } : undefined;
}

function entryTimestamp(entry: PiSessionEntryLike): unknown {
	if (typeof entry.timestamp !== "string") return entry.timestamp;
	const timestamp = Date.parse(entry.timestamp);
	return Number.isFinite(timestamp) ? timestamp : entry.timestamp;
}

function contextMessagesForEntry(entry: PiSessionEntryLike): ContextMessageLike[] {
	if (entry.type === "message" && entry.message && typeof entry.message === "object") {
		return [entry.message];
	}
	if (entry.type === "custom_message") {
		return [{
			role: "custom",
			customType: entry.customType,
			content: entry.content,
			timestamp: entryTimestamp(entry),
		}];
	}
	if (entry.type === "branch_summary") {
		return [{
			role: "branchSummary",
			summary: entry.summary,
			timestamp: entryTimestamp(entry),
		}];
	}
	if (entry.type === "compaction") {
		return [{
			role: "compactionSummary",
			summary: entry.summary,
			timestamp: entryTimestamp(entry),
		}];
	}
	return [];
}

function currentPiContext(ctx: PiExtensionContext): ContextMessageLike[] | undefined {
	const entries = ctx.sessionManager?.buildContextEntries?.();
	return entries ? entries.flatMap(contextMessagesForEntry) : undefined;
}

function reconcileSessionContext(
	runtime: ContextRailExtensionRuntime,
	ctx: PiExtensionContext,
	options: { compaction: boolean; activity: boolean; reason: "session-start" | "session-tree" | "session-compaction" },
): void {
	const messages = currentPiContext(ctx);
	if (messages) {
		runtime.context(messages, ctx, { ...options, source: "session-reconstruction" });
		return;
	}
	if (options.compaction) runtime.compactionCommitted(ctx);
	else runtime.sessionActivated(ctx, options.activity);
}

export function createPiContextRailExtension(
	options: ContextRailExtensionOptions = {},
): (pi: PiExtensionApi) => void {
	return function contextRailPiExtension(pi: PiExtensionApi): void {
		const processState = processStateFor(options);
		const runtime = createContextRailRuntime(
			{ ...options, processId: processState.processId, processState },
			{ createContextItemDetail: createPiContextItemDetail },
		);

		pi.on("message_end", (event, ctx) => runtime.messageEnd(event.message, ctx));
		pi.on("context", (event, ctx) => runtime.context(event.messages, ctx));
		pi.on("tool_execution_start", (event, ctx) =>
			runtime.toolExecutionStart(event.toolCallId, event.toolName, ctx),
		);
		pi.on("tool_execution_end", (event, ctx) =>
			runtime.toolExecutionEnd(event.toolCallId, ctx),
		);
		pi.on("session_compact", (_event, ctx) =>
			reconcileSessionContext(runtime, ctx, { compaction: true, activity: false, reason: "session-compaction" }),
		);
		pi.on("session_start", (_event, ctx) =>
			reconcileSessionContext(runtime, ctx, { compaction: false, activity: false, reason: "session-start" }),
		);
		pi.on("session_tree", (_event, ctx) =>
			reconcileSessionContext(runtime, ctx, { compaction: false, activity: false, reason: "session-tree" }),
		);
		pi.on("session_info_changed", (_event, ctx) => runtime.sessionActivated(ctx, false));
		pi.on("session_shutdown", async (event, ctx) => {
			const quit = event.reason === "quit";
			await runtime.shutdown(ctx, quit ? "quit" : "handoff");
			if (quit && !options.processState) releaseProcessState(processState);
		});

		pi.registerCommand("context-rail", {
			description: "Control the terminal strip or local web viewer",
			handler: (args, ctx) => runtime.command(args, ctx),
		});
	};
}

export type { ContextRailExtensionOptions } from "./extension-runtime.ts";
