import type {
	ContextRailHostContext,
	ContextRailHostSessionManager,
} from "./host-types.ts";
import type { ContextMessageLike } from "./snapshot.ts";

export interface PiSessionEntryLike {
	type?: unknown;
	timestamp?: unknown;
	message?: ContextMessageLike;
	customType?: unknown;
	content?: unknown;
	display?: unknown;
	details?: unknown;
	summary?: unknown;
	fromId?: unknown;
	tokensBefore?: unknown;
}

export interface PiSessionManager extends ContextRailHostSessionManager {
	buildContextEntries?(): readonly PiSessionEntryLike[];
}

export interface PiExtensionContext extends ContextRailHostContext {
	sessionManager?: PiSessionManager;
}

export interface PiEventMap {
	context: { type: "context"; messages: ContextMessageLike[] };
	message_end: { type: "message_end"; message: ContextMessageLike };
	tool_execution_start: {
		type: "tool_execution_start";
		toolCallId: string;
		toolName: string;
		args: unknown;
	};
	tool_execution_end: {
		type: "tool_execution_end";
		toolCallId: string;
		toolName: string;
		result: unknown;
		isError: boolean;
	};
	session_start: {
		type: "session_start";
		reason: "startup" | "reload" | "new" | "resume" | "fork";
		previousSessionFile?: string;
	};
	session_compact: {
		type: "session_compact";
		compactionEntry: unknown;
		fromExtension: boolean;
		reason: "manual" | "threshold" | "overflow";
		willRetry: boolean;
	};
	session_tree: {
		type: "session_tree";
		newLeafId: string | null;
		oldLeafId: string | null;
		summaryEntry?: unknown;
		fromExtension?: boolean;
	};
	session_info_changed: {
		type: "session_info_changed";
		name: string | undefined;
	};
	session_shutdown: {
		type: "session_shutdown";
		reason: "quit" | "reload" | "new" | "resume" | "fork";
		targetSessionFile?: string;
	};
}

export type PiEventHandler<K extends keyof PiEventMap> = (
	event: PiEventMap[K],
	ctx: PiExtensionContext,
) => Promise<void> | void;

export interface PiExtensionApi {
	on(event: "context", handler: PiEventHandler<"context">): void;
	on(event: "message_end", handler: PiEventHandler<"message_end">): void;
	on(event: "tool_execution_start", handler: PiEventHandler<"tool_execution_start">): void;
	on(event: "tool_execution_end", handler: PiEventHandler<"tool_execution_end">): void;
	on(event: "session_start", handler: PiEventHandler<"session_start">): void;
	on(event: "session_compact", handler: PiEventHandler<"session_compact">): void;
	on(event: "session_tree", handler: PiEventHandler<"session_tree">): void;
	on(event: "session_info_changed", handler: PiEventHandler<"session_info_changed">): void;
	on(event: "session_shutdown", handler: PiEventHandler<"session_shutdown">): void;
	registerCommand(
		name: string,
	options: {
		description?: string;
		handler: (args: string, ctx: PiExtensionContext) => Promise<void>;
	},
	): void;
}
