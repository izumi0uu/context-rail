export type ContextItemKind = "system" | "memory" | "user" | "assistant" | "tool" | "unknown";

export interface ContextMessageLike {
	id?: unknown;
	role?: unknown;
	type?: unknown;
	customType?: unknown;
	toolCallId?: unknown;
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
	identity?: ContextMessageIdentity;
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

function intrinsicMessageId(message: ContextMessageLike): string | undefined {
	const intrinsicId = message.id ?? message.toolCallId;
	if (typeof intrinsicId === "string" || typeof intrinsicId === "number") {
		return `message-${String(intrinsicId).slice(0, 128)}`;
	}
	return undefined;
}

function messageSignature(message: ContextMessageLike): string {
	const kind = classifyMessage(message);
	const toolName = typeof message.toolName === "string" ? message.toolName : "";
	return `${kind}:${toolName}`;
}

interface PreviousIdentity {
	id: string;
	signature: string;
}

/**
 * Keeps content-free fallback identities stable across live context events.
 * Intrinsic OMP ids always win; object identity, unchanged prefixes, and
 * unchanged suffixes cover the common append and compaction paths.
 */
export class ContextMessageIdentity {
	private counter = 0;
	private objectIds = new WeakMap<object, string>();
	private previous: PreviousIdentity[] = [];

	reset(): void {
		this.counter = 0;
		this.objectIds = new WeakMap<object, string>();
		this.previous = [];
	}

	resolve(messages: readonly ContextMessageLike[]): string[] {
		const signatures = messages.map(messageSignature);
		const ids: Array<string | undefined> = messages.map((message) => {
			const intrinsic = intrinsicMessageId(message);
			if (intrinsic) return intrinsic;
			return this.objectIds.get(message);
		});
		const claimed = new Set(ids.filter((id): id is string => id !== undefined));

		let prefix = 0;
		while (
			messages.length > this.previous.length &&
			prefix < messages.length &&
			prefix < this.previous.length &&
			signatures[prefix] === this.previous[prefix]?.signature
		) {
			if (!ids[prefix] && !claimed.has(this.previous[prefix]!.id)) {
				ids[prefix] = this.previous[prefix]!.id;
				claimed.add(this.previous[prefix]!.id);
			}
			prefix += 1;
		}

		let currentIndex = messages.length - 1;
		let previousIndex = this.previous.length - 1;
		while (
			messages.length < this.previous.length &&
			currentIndex >= prefix &&
			previousIndex >= prefix &&
			signatures[currentIndex] === this.previous[previousIndex]?.signature
		) {
			const previousId = this.previous[previousIndex]!.id;
			if (!ids[currentIndex] && !claimed.has(previousId)) {
				ids[currentIndex] = previousId;
				claimed.add(previousId);
			}
			currentIndex -= 1;
			previousIndex -= 1;
		}

		for (const [index, message] of messages.entries()) {
			const id = ids[index] ?? `message-fallback-${++this.counter}`;
			ids[index] = id;
			this.objectIds.set(message, id);
		}

		this.previous = messages.map((message, index) => ({
			id: ids[index]!,
			signature: signatures[index]!,
		}));
		return ids as string[];
	}
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

	const resolvedIds = options.identity?.resolve(options.messages);
	for (const [index, message] of options.messages.entries()) {
		const toolName = typeof message.toolName === "string" ? message.toolName : undefined;
		items.push({
			id: resolvedIds?.[index] ?? intrinsicMessageId(message) ?? `message-${index}`,
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
