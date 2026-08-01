import type { ContextMessageLike, ContextUsageLike } from "./snapshot.ts";

export interface OmpUiContext {
	setStatus(key: string, text: string | undefined): void;
	setWidget(
		key: string,
		content: string[] | undefined,
		options?: { placement?: "aboveEditor" | "belowEditor" },
	): void;
	notify(message: string, type?: "info" | "warning" | "error"): void;
}

export interface OmpExtensionContext {
	ui: OmpUiContext;
	cwd?: string;
	model?: { id?: string };
	sessionManager?: {
		getSessionId(): string;
		getSessionFile(): string | undefined;
		getSessionName?(): string | undefined;
		getCwd?(): string;
	};
	getContextUsage(): ContextUsageLike | undefined;
	getSystemPrompt(): string | string[];
}

export type OmpCompactionAction = "context-full" | "snapcompact" | "handoff" | "shake";

export interface OmpCompactionResult {
	summary: string;
	shortSummary?: string;
	firstKeptEntryId?: string;
	tokensBefore?: number;
	details?: unknown;
	preserveData?: unknown;
}

export interface OmpEventMap {
	context: { type: "context"; messages: ContextMessageLike[] };
	message_end: { type: "message_end"; message: ContextMessageLike };
	tool_execution_start: {
		type: "tool_execution_start";
		toolCallId: string;
		toolName: string;
	};
	tool_execution_end: {
		type: "tool_execution_end";
		toolCallId: string;
		toolName: string;
		isError: boolean;
	};
	auto_compaction_start: {
		type: "auto_compaction_start";
		reason?: string;
		action: OmpCompactionAction;
	};
	auto_compaction_end: {
		type: "auto_compaction_end";
		action: OmpCompactionAction;
		result: OmpCompactionResult | undefined;
		aborted: boolean;
		willRetry: boolean;
		errorMessage?: string;
		skipped?: boolean;
	};
	session_compact: {
		type: "session_compact";
		compactionEntry: unknown;
		fromExtension: boolean;
	};
	session_start: {
		type: "session_start";
		reason?: "startup" | "reload" | "new" | "resume" | "fork";
		previousSessionFile?: string;
	};
	session_switch: {
		type: "session_switch";
		reason?: "new" | "resume" | "fork" | "handoff";
		previousSessionFile?: string;
	};
	session_branch: {
		type: "session_branch";
		previousSessionFile: string | undefined;
	};
	session_shutdown: {
		type: "session_shutdown";
		reason?: string;
	};
}

export type OmpEventHandler<K extends keyof OmpEventMap> = (
	event: OmpEventMap[K],
	ctx: OmpExtensionContext,
) => Promise<void> | void;

export interface OmpExtensionApi {
	on<K extends keyof OmpEventMap>(event: K, handler: OmpEventHandler<K>): void;
	registerCommand(
		name: string,
		options: {
			description?: string;
			handler: (args: string, ctx: OmpExtensionContext) => Promise<void> | void;
		},
	): void;
}
