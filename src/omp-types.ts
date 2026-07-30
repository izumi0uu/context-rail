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
	model?: { id?: string };
	getContextUsage(): ContextUsageLike | undefined;
	getSystemPrompt(): string | string[];
}

export interface OmpEventMap {
	context: { type: "context"; messages: ContextMessageLike[] };
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
	auto_compaction_start: { type: "auto_compaction_start" };
	auto_compaction_end: { type: "auto_compaction_end" };
	session_start: { type: "session_start" };
	session_switch: { type: "session_switch" };
	session_shutdown: { type: "session_shutdown" };
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
