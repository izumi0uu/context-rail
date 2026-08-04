import type { ContextUsageLike } from "./snapshot.ts";

export interface ContextRailHostUi {
	setStatus(key: string, text: string | undefined): void;
	setWidget(
		key: string,
		content: string[] | undefined,
		options?: { placement?: "aboveEditor" | "belowEditor" },
	): void;
	notify(message: string, type?: "info" | "warning" | "error"): void;
}

export interface ContextRailHostSessionManager {
	getSessionId(): string;
	getSessionFile(): string | undefined;
	getSessionName?(): string | undefined;
	getCwd?(): string;
}

export interface ContextRailHostContext {
	ui: ContextRailHostUi;
	cwd?: string;
	model?: { id?: string };
	sessionManager?: ContextRailHostSessionManager;
	getContextUsage(): ContextUsageLike | undefined;
	getSystemPrompt(): string | readonly string[];
}
