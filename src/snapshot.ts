export type ContextItemKind = "system" | "memory" | "user" | "assistant" | "tool" | "unknown";

export interface ContextMessageLike {
	role?: unknown;
	type?: unknown;
	customType?: unknown;
	toolName?: unknown;
}

export interface ContextUsageLike {
	tokens?: number | null;
	contextWindow?: number | null;
	percent?: number | null;
}

export interface ContextItem {
	id: string;
	kind: ContextItemKind;
	toolName?: string;
}

export interface ContextSnapshot {
	createdAt: number;
	model?: string;
	tokens?: number;
	contextWindow?: number;
	percent?: number;
	items: ContextItem[];
}

export interface CreateSnapshotOptions {
	messages: readonly ContextMessageLike[];
	usage?: ContextUsageLike;
	model?: string;
	systemPromptParts?: number;
	now?: number;
}

function normalizeHint(message: ContextMessageLike): string {
	return [message.role, message.type, message.customType]
		.filter((value): value is string => typeof value === "string")
		.join("-")
		.toLowerCase();
}

export function classifyMessage(message: ContextMessageLike): ContextItemKind {
	const hint = normalizeHint(message);

	if (hint.includes("summary") || hint.includes("memory") || hint.includes("compact")) return "memory";
	if (hint.includes("system")) return "system";
	if (hint.includes("tool")) return "tool";
	if (hint.includes("assistant")) return "assistant";
	if (hint.includes("user")) return "user";
	return "unknown";
}

function finiteNonNegative(value: number | null | undefined): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function createSnapshot(options: CreateSnapshotOptions): ContextSnapshot {
	const tokens = finiteNonNegative(options.usage?.tokens);
	const contextWindow = finiteNonNegative(options.usage?.contextWindow);
	const reportedPercent = finiteNonNegative(options.usage?.percent);
	const calculatedPercent =
		tokens !== undefined && contextWindow !== undefined && contextWindow > 0
			? Math.min(100, (tokens / contextWindow) * 100)
			: undefined;

	const items: ContextItem[] = [];
	if ((options.systemPromptParts ?? 0) > 0) {
		items.push({ id: "system-prompt", kind: "system" });
	}

	for (const [index, message] of options.messages.entries()) {
		const toolName = typeof message.toolName === "string" ? message.toolName : undefined;
		items.push({
			id: `message-${index}`,
			kind: classifyMessage(message),
			...(toolName ? { toolName } : {}),
		});
	}

	return {
		createdAt: options.now ?? Date.now(),
		...(options.model ? { model: options.model } : {}),
		...(tokens !== undefined ? { tokens } : {}),
		...(contextWindow !== undefined ? { contextWindow } : {}),
		...(reportedPercent !== undefined || calculatedPercent !== undefined
			? { percent: Math.min(100, reportedPercent ?? calculatedPercent ?? 0) }
			: {}),
		items,
	};
}
