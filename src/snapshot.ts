export type ContextItemKind =
	| "system"
	| "memory"
	| "developer"
	| "user"
	| "assistant"
	| "tool"
	| "unknown";

export type ContextDetailModelRole = "system" | "user" | "developer" | "assistant" | "toolResult";

export type ContextDetailBlock =
	| { type: "text"; text: string }
	| { type: "thinking"; text: string; redacted?: true }
	| { type: "image"; mimeType: string; data: string }
	| { type: "toolCall"; name: string; argumentsJson: string };

export interface ContextDetailModelMessage {
	modelRole: ContextDetailModelRole;
	blocks: ContextDetailBlock[];
}

export interface ContextItemDetail {
	sourceRole: string;
	modelMessages: ContextDetailModelMessage[];
	isError?: boolean;
}

export type ContextItemDetailFactory = (
	message: ContextMessageLike,
) => ContextItemDetail | undefined;

export interface ContextMessageLike {
	id?: unknown;
	role?: unknown;
	type?: unknown;
	customType?: unknown;
	toolCallId?: unknown;
	toolName?: unknown;
	timestamp?: unknown;
	content?: unknown;
	command?: unknown;
	output?: unknown;
	exitCode?: unknown;
	cancelled?: unknown;
	truncated?: unknown;
	fullOutputPath?: unknown;
	excludeFromContext?: unknown;
	summary?: unknown;
	isError?: unknown;
	attribution?: unknown;
	blocks?: unknown;
	images?: unknown;
	providerPayload?: unknown;
	code?: unknown;
	files?: unknown;
	prunedAt?: unknown;
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

export interface CaptureContextOptions extends CreateSnapshotOptions {
	systemPrompt?: string | readonly string[];
	createContextItemDetail?: ContextItemDetailFactory;
}

export interface ContextCapture {
	snapshot: ContextSnapshot;
	details: Map<string, ContextItemDetail>;
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
	if (hint.includes("developer")) return "developer";
	if (hint.includes("tool")) return "tool";
	if (hint.includes("assistant")) return "assistant";
	if (hint.includes("user")) return "user";
	if (
		hint.includes("bash") ||
		hint.includes("python") ||
		hint.includes("filemention") ||
		hint.includes("custom") ||
		hint.includes("hookmessage")
	) return "user";
	return "unknown";
}

function stringField(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function jsonText(value: unknown): string {
	try {
		return JSON.stringify(value) ?? "null";
	} catch {
		return "null";
	}
}

function contentBlocks(value: unknown): ContextDetailBlock[] {
	if (typeof value === "string") return [{ type: "text", text: value }];
	if (!Array.isArray(value)) return [];

	const blocks: ContextDetailBlock[] = [];
	for (const entry of value) {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
		const block = entry as Record<string, unknown>;
		if (block.type === "text" && typeof block.text === "string") {
			blocks.push({ type: "text", text: block.text });
		} else if (block.type === "thinking" && typeof block.thinking === "string") {
			blocks.push({
				type: "thinking",
				text: block.thinking,
				...(block.redacted === true ? { redacted: true } : {}),
			});
		} else if (
			block.type === "image" &&
			typeof block.mimeType === "string" &&
			typeof block.data === "string"
		) {
			blocks.push({ type: "image", mimeType: block.mimeType, data: block.data });
		} else if (block.type === "toolCall" && typeof block.name === "string") {
			blocks.push({
				type: "toolCall",
				name: block.name,
				argumentsJson: jsonText(block.arguments),
			});
		}
	}
	return blocks;
}

function textAndImageBlocks(value: unknown): ContextDetailBlock[] | undefined {
	if (typeof value === "string") {
		return [{ type: "text", text: value }];
	}
	if (!Array.isArray(value)) return undefined;

	const blocks: ContextDetailBlock[] = [];
	for (const entry of value) {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined;
		const block = entry as Record<string, unknown>;
		if (block.type === "text" && typeof block.text === "string") {
			blocks.push({ type: "text", text: block.text });
		} else if (
			block.type === "image" &&
			typeof block.mimeType === "string" &&
			typeof block.data === "string"
		) {
			blocks.push({
				type: "image",
				mimeType: block.mimeType,
				data: block.data,
			});
		} else {
			return undefined;
		}
	}
	return blocks;
}

function bashExecutionText(message: ContextMessageLike): string {
	let text = `Ran \`${stringField(message.command)}\`\n`;
	const output = stringField(message.output);
	text += output ? `\`\`\`\n${output}\n\`\`\`` : "(no output)";
	if (message.cancelled === true) {
		text += "\n\n(command cancelled)";
	} else if (
		typeof message.exitCode === "number" &&
		Number.isFinite(message.exitCode) &&
		message.exitCode !== 0
	) {
		text += `\n\nCommand exited with code ${message.exitCode}`;
	}
	if (message.truncated === true && typeof message.fullOutputPath === "string") {
		text += `\n\n[Output truncated. Full output: ${message.fullOutputPath}]`;
	}
	return text;
}

function pythonExecutionText(message: ContextMessageLike): string {
	let text = `Ran Python:\n\`\`\`python\n${stringField(message.code)}\n\`\`\`\n`;
	const output = stringField(message.output);
	text += output ? `Output:\n\`\`\`\n${output}\n\`\`\`` : "(no output)";
	if (message.cancelled === true) {
		text += "\n\n(execution cancelled)";
	} else if (
		typeof message.exitCode === "number" &&
		Number.isFinite(message.exitCode) &&
		message.exitCode !== 0
	) {
		text += `\n\nExecution failed with code ${message.exitCode}`;
	}
	return text;
}

interface FileMention {
	path: string;
	content: string;
	image?: { type: "image"; mimeType: string; data: string };
}

function fileMentions(value: unknown): FileMention[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const files: FileMention[] = [];
	for (const entry of value) {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined;
		const file = entry as Record<string, unknown>;
		if (typeof file.path !== "string" || typeof file.content !== "string") return undefined;
		let image: FileMention["image"];
		if (file.image !== undefined) {
			const blocks = textAndImageBlocks([file.image]);
			if (!blocks || blocks.length !== 1 || blocks[0]?.type !== "image") return undefined;
			image = blocks[0];
		}
		files.push({
			path: file.path,
			content: file.content,
			...(image ? { image } : {}),
		});
	}
	return files;
}

function fileMentionText(file: FileMention): string {
	const inner = file.content ? `\n${file.content}\n` : "\n";
	return `<file path="${file.path}">${inner}</file>`;
}

function customMessageDetail(message: ContextMessageLike): ContextItemDetail | undefined {
	const role = sourceRole(message);
	const blocks = textAndImageBlocks(message.content);
	if (!blocks) return undefined;
	const userInvokedSkill =
		role === "custom" &&
		message.customType === "skill-prompt" &&
		message.attribution === "user";
	if (userInvokedSkill) {
		return {
			sourceRole: role,
			modelMessages: [{ modelRole: "user", blocks }],
		};
	}

	const textBlocks = blocks.filter((block) => block.type === "text");
	const imageBlocks = blocks.filter((block) => block.type === "image");
	if (imageBlocks.length === 0) {
		return {
			sourceRole: role,
			modelMessages: [{ modelRole: "developer", blocks: textBlocks }],
		};
	}

	const modelMessages: ContextDetailModelMessage[] = [];
	if (textBlocks.length > 0) {
		modelMessages.push({ modelRole: "developer", blocks: textBlocks });
	}
	modelMessages.push({
		modelRole: "user",
		blocks: [
			{
				type: "text",
				text: `Images attached to ${stringField(message.customType)}.`,
			},
			...imageBlocks,
		],
	});
	return {
		sourceRole: role,
		modelMessages,
	};
}

function sourceRole(message: ContextMessageLike): string {
	return typeof message.role === "string" && message.role ? message.role : "unknown";
}

function excludedExecution(message: ContextMessageLike): boolean {
	return (
		(message.role === "bashExecution" || message.role === "pythonExecution") &&
		message.excludeFromContext === true
	);
}

export function createContextItemDetail(
	message: ContextMessageLike,
): ContextItemDetail | undefined {
	const role = sourceRole(message);
	if (excludedExecution(message)) return undefined;
	if (role === "custom" || role === "hookMessage") return customMessageDetail(message);

	let modelMessages: ContextDetailModelMessage[];
	if (role === "system") {
		modelMessages = [{ modelRole: "system", blocks: contentBlocks(message.content) }];
	} else if (role === "user") {
		modelMessages = [{ modelRole: "user", blocks: contentBlocks(message.content) }];
	} else if (role === "developer") {
		modelMessages = [{ modelRole: "developer", blocks: contentBlocks(message.content) }];
	} else if (role === "assistant") {
		modelMessages = [{ modelRole: "assistant", blocks: contentBlocks(message.content) }];
	} else if (role === "toolResult") {
		let blocks: ContextDetailBlock[];
		const content = contentBlocks(message.content);
		if (message.prunedAt === undefined) {
			blocks = content;
		} else {
			const text = content
				.filter((block) => block.type === "text")
				.map((block) => block.text)
				.join("") || "[Output truncated]";
			blocks = [{ type: "text", text }];
		}
		modelMessages = [{ modelRole: "toolResult", blocks }];
	} else if (role === "bashExecution") {
		modelMessages = [{
			modelRole: "user",
			blocks: [{ type: "text", text: bashExecutionText(message) }],
		}];
	} else if (role === "pythonExecution") {
		modelMessages = [{
			modelRole: "user",
			blocks: [{ type: "text", text: pythonExecutionText(message) }],
		}];
	} else if (role === "fileMention") {
		const files = fileMentions(message.files);
		if (!files) return undefined;
		const textFiles = files.filter((file) => !file.image);
		const imageFiles = files.filter((file) => file.image);
		if (textFiles.length === 0 && imageFiles.length === 0) return undefined;
		modelMessages = [];
		if (textFiles.length > 0) {
			modelMessages.push({
				modelRole: "developer",
				blocks: [{ type: "text", text: textFiles.map(fileMentionText).join("\n") }],
			});
		}
		if (imageFiles.length > 0) {
			const blocks: ContextDetailBlock[] = [{
				type: "text",
				text: imageFiles.map(fileMentionText).join("\n"),
			}];
			for (const file of imageFiles) {
				if (file.image) blocks.push(file.image);
			}
			modelMessages.push({ modelRole: "user", blocks });
		}
	} else if (role === "branchSummary") {
		modelMessages = [{
			modelRole: "user",
			blocks: [{
				type: "text",
				text: `The following is a summary of a branch that this conversation came back from:\n\n<summary>\n${stringField(message.summary)}\n</summary>`,
			}],
		}];
	} else if (role === "compactionSummary") {
		let blocks: ContextDetailBlock[];
		if (Array.isArray(message.blocks)) {
			blocks = [
				{ type: "text", text: stringField(message.summary) },
				...(textAndImageBlocks(message.blocks) ?? []),
			];
		} else {
			blocks = [
				{
					type: "text",
					text: `Another language model started to solve this problem and produced a summary of its thinking process. You also have access to the state of the tools that model used. You MUST build on the work already done and NEVER duplicate it. Here is that summary:\n\n<summary>\n${stringField(message.summary)}\n</summary>`,
				},
				...(textAndImageBlocks(message.images) ?? []),
			];
		}
		modelMessages = [{ modelRole: "user", blocks }];
	} else {
		return undefined;
	}

	return {
		sourceRole: role,
		modelMessages,
		...(typeof message.isError === "boolean" ? { isError: message.isError } : {}),
	};
}

function visibleMessages(messages: readonly ContextMessageLike[]): ContextMessageLike[] {
	return messages.filter((message) => !excludedExecution(message));
}

function finiteNonNegative(value: number | null | undefined): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function contextItem(message: ContextMessageLike, id: string): ContextItem {
	const toolName = typeof message.toolName === "string" ? message.toolName : undefined;
	return {
		id,
		kind: classifyMessage(message),
		...(toolName ? { toolName } : {}),
	};
}

function messageSignature(message: ContextMessageLike): string {
	const kind = classifyMessage(message);
	const toolName = typeof message.toolName === "string" ? message.toolName : "";
	return `${kind}:${toolName}`;
}

function messageAnchor(message: ContextMessageLike): string | undefined {
	for (const [field, value] of [
		["id", message.id],
		["tool", message.toolCallId],
		["timestamp", message.timestamp],
	] as const) {
		if (typeof value === "string" || typeof value === "number") {
			return `${messageSignature(message)}:${field}:${typeof value}:${String(value).slice(0, 128)}`;
		}
	}
	return undefined;
}

interface PreviousIdentity {
	id: string;
	signature: string;
	anchor?: string;
}

/**
 * Keeps content-free fallback identities stable across live context events.
 * Raw OMP ids and timestamps are private matching anchors only. Emitted ids are
 * session-local, while object identity and conservative sequence alignment cover
 * append, recreation, and compaction paths without inspecting message content.
 */
export class ContextMessageIdentity {
	private static readonly MAX_PROVISIONAL_IDENTITIES = 2_048;
	private counter = 0;
	private objectIds = new WeakMap<object, string>();
	private previous: PreviousIdentity[] = [];
	private provisional: PreviousIdentity[] = [];

	reset(): void {
		this.counter = 0;
		this.objectIds = new WeakMap<object, string>();
		this.previous = [];
		this.provisional = [];
	}

	private nextId(): string {
		return `message-local-${++this.counter}`;
	}

	resolveOne(message: ContextMessageLike): string {
		const existing = this.objectIds.get(message);
		if (existing) return existing;

		const id = this.nextId();
		this.objectIds.set(message, id);
		const anchor = messageAnchor(message);
		this.provisional.push({
			id,
			signature: messageSignature(message),
			...(anchor ? { anchor } : {}),
		});
		if (this.provisional.length > ContextMessageIdentity.MAX_PROVISIONAL_IDENTITIES) {
			this.provisional.splice(
				0,
				this.provisional.length - ContextMessageIdentity.MAX_PROVISIONAL_IDENTITIES,
			);
		}
		return id;
	}

	resolve(messages: readonly ContextMessageLike[]): string[] {
		const signatures = messages.map(messageSignature);
		const anchors = messages.map(messageAnchor);
		const ids: Array<string | undefined> = messages.map((message) => this.objectIds.get(message));
		const claimed = new Set(ids.filter((id): id is string => id !== undefined));

		const candidatesByAnchor = new Map<string, PreviousIdentity[]>();
		for (const candidate of [...this.previous, ...this.provisional]) {
			if (!candidate.anchor || claimed.has(candidate.id)) continue;
			const candidates = candidatesByAnchor.get(candidate.anchor) ?? [];
			candidates.push(candidate);
			candidatesByAnchor.set(candidate.anchor, candidates);
		}
		for (const [index, anchor] of anchors.entries()) {
			if (ids[index] || !anchor) continue;
			const candidates = candidatesByAnchor.get(anchor);
			while (candidates?.length && claimed.has(candidates[0]!.id)) candidates.shift();
			const candidate = candidates?.shift();
			if (!candidate) continue;
			ids[index] = candidate.id;
			claimed.add(candidate.id);
		}

		const sameLengthUnchanged =
			messages.length === this.previous.length &&
			signatures.every((signature, index) => signature === this.previous[index]?.signature);
		let prefix = 0;
		while (
			(messages.length > this.previous.length ||
				sameLengthUnchanged) &&
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

		const unresolvedBySignature = new Map<string, number[]>();
		for (const [index, id] of ids.entries()) {
			if (id) continue;
			const indexes = unresolvedBySignature.get(signatures[index]!) ?? [];
			indexes.push(index);
			unresolvedBySignature.set(signatures[index]!, indexes);
		}
		const provisionalBySignature = new Map<string, PreviousIdentity[]>();
		for (const candidate of this.provisional) {
			if (claimed.has(candidate.id)) continue;
			const candidates = provisionalBySignature.get(candidate.signature) ?? [];
			candidates.push(candidate);
			provisionalBySignature.set(candidate.signature, candidates);
		}
		const previousBySignature = new Map<string, PreviousIdentity[]>();
		for (const candidate of this.previous) {
			if (claimed.has(candidate.id)) continue;
			const candidates = previousBySignature.get(candidate.signature) ?? [];
			candidates.push(candidate);
			previousBySignature.set(candidate.signature, candidates);
		}
		for (const [signature, indexes] of unresolvedBySignature) {
			const candidates = provisionalBySignature.get(signature) ?? [];
			const previousCandidates = previousBySignature.get(signature) ?? [];
			if (indexes.length !== candidates.length || previousCandidates.length > 0) continue;
			for (const [offset, index] of indexes.entries()) {
				ids[index] = candidates[offset]!.id;
				claimed.add(candidates[offset]!.id);
			}
		}

		for (const [index, message] of messages.entries()) {
			const id = ids[index] ?? this.nextId();
			ids[index] = id;
			this.objectIds.set(message, id);
		}

		this.previous = messages.map((message, index) => ({
			id: ids[index]!,
			signature: signatures[index]!,
			...(anchors[index] ? { anchor: anchors[index] } : {}),
		}));
		this.provisional = this.provisional.filter((candidate) => !claimed.has(candidate.id));
		return ids as string[];
	}
}

export function createContextItem(
	message: ContextMessageLike,
	identity = new ContextMessageIdentity(),
): ContextItem {
	return contextItem(message, identity.resolveOne(message));
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

	const messages = visibleMessages(options.messages);
	const resolvedIds = (options.identity ?? new ContextMessageIdentity()).resolve(messages);
	for (const [index, message] of messages.entries()) {
		items.push(contextItem(message, resolvedIds[index]!));
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

export function captureContext(options: CaptureContextOptions): ContextCapture {
	const {
		systemPrompt,
		createContextItemDetail: detailForMessage = createContextItemDetail,
		...snapshotOptions
	} = options;
	const promptParts = Array.isArray(systemPrompt)
		? [...systemPrompt]
		: typeof systemPrompt === "string" && systemPrompt.length > 0
			? [systemPrompt]
			: [];
	const messages = visibleMessages(options.messages);
	const snapshot = createSnapshot({
		...snapshotOptions,
		messages,
		systemPromptParts: snapshotOptions.systemPromptParts ?? promptParts.length,
	});
	const details = new Map<string, ContextItemDetail>();
	let itemOffset = 0;
	if (snapshot.items[0]?.id === "system-prompt") {
		details.set(snapshot.items[0].id, {
			sourceRole: "system",
			modelMessages: [{
				modelRole: "system",
				blocks: promptParts.map((text) => ({ type: "text", text })),
			}],
		});
		itemOffset = 1;
	}
	for (const [index, message] of messages.entries()) {
		const detail = detailForMessage(message);
		const item = snapshot.items[index + itemOffset];
		if (detail && item) details.set(item.id, detail);
	}
	return { snapshot, details };
}
