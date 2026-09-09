import { type ContentBlock, type ContentItem } from "./content-view.ts";
import { readingSections, READER_PAGE_BLOCKS, READER_PAGE_CHARACTERS } from "./reader.ts";

export type InspectorMode = "read" | "original";

export interface InspectorCursor {
	messageIndex: number;
	blockIndex: number;
	headerRendered: boolean;
}

export interface InspectorMessagePage {
	messageIndex: number;
	modelRole: string;
	showHeader: boolean;
	empty: boolean;
	blocks: { blockIndex: number; block: ContentBlock }[];
}

export interface InspectorPage {
	messages: InspectorMessagePage[];
	nextCursor: InspectorCursor | null;
}

const RECONSTRUCTION_NOTICE = "Context-hook reconstruction, not the exact provider request JSON.";
const SYNTHETIC_NOTICE = "Synthetic compaction marker. This records a compaction event, not captured model content.";
const EMPTY_NOTICE = "No model-facing content was exposed for this item.";
const MAX_PRETTY_JSON_CHARACTERS = 64_000;
const MAX_READING_SECTIONS = 128;

/** Pages messages in place: no flattened copy or traversal of all blocks/messages. */
export function inspectorPage(item: ContentItem, cursor?: InspectorCursor): InspectorPage {
	const source = item.synthetic ? [] : item.detail?.modelMessages ?? [];
	let messageIndex = Math.max(0, Math.min(source.length, Math.floor(cursor?.messageIndex ?? 0)));
	let blockIndex = Math.max(0, Math.floor(cursor?.blockIndex ?? 0));
	let headerRendered = cursor?.headerRendered ?? false;
	let blocksRemaining = READER_PAGE_BLOCKS;
	let headersRemaining = READER_PAGE_BLOCKS;
	const messages: InspectorMessagePage[] = [];
	while (messageIndex < source.length && blocksRemaining > 0 && headersRemaining > 0) {
		const message = source[messageIndex]!;
		const page: InspectorMessagePage = {
			messageIndex,
			modelRole: message.modelRole,
			showHeader: !headerRendered,
			empty: message.blocks.length === 0,
			blocks: [],
		};
		if (!headerRendered) headersRemaining -= 1;
		while (blockIndex < message.blocks.length && blocksRemaining > 0) {
			page.blocks.push({ blockIndex, block: message.blocks[blockIndex]! });
			blockIndex += 1;
			blocksRemaining -= 1;
		}
		messages.push(page);
		if (blockIndex >= message.blocks.length) {
			messageIndex += 1;
			blockIndex = 0;
			headerRendered = false;
		} else headerRendered = true;
	}
	return { messages, nextCursor: messageIndex < source.length ? { messageIndex, blockIndex, headerRendered } : null };
}

/** Bounded exact text slices. Prefer line boundaries and never split a UTF-16 surrogate pair. */
export function inspectorTextPage(text: string, cursor = 0): { text: string; nextCursor: number | null } {
	const start = Math.max(0, Math.min(text.length, Math.floor(cursor)));
	let end = Math.min(text.length, start + READER_PAGE_CHARACTERS);
	if (end < text.length) {
		const bounded = text.slice(start, end);
		const lastNewline = bounded.lastIndexOf("\n");
		if (lastNewline >= bounded.length - 2_048) end = start + lastNewline + 1;
		const previous = text.charCodeAt(end - 1);
		if (previous >= 0xd800 && previous <= 0xdbff) end -= 1;
	}
	return { text: text.slice(start, end), nextCursor: end < text.length ? end : null };
}

/** Original mode is exact. Large/invalid JSON is always left raw and paged by the renderer. */
export function inspectorToolText(argumentsJson: string, mode: InspectorMode): string {
	if (mode === "original" || argumentsJson.length > MAX_PRETTY_JSON_CHARACTERS) return argumentsJson;
	try { return JSON.stringify(JSON.parse(argumentsJson), null, 2); } catch { return argumentsJson; }
}

function labelText(text: string): string {
	return text.length <= 240 ? text : `${text.slice(0, 240)}…`;
}

function element<K extends keyof HTMLElementTagNameMap>(
	document: Document,
	tag: K,
	className?: string,
	text?: string,
): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	if (className) node.className = className;
	if (text !== undefined) node.textContent = text;
	return node;
}

function appendPagedText(container: HTMLElement, text: string, mode: InspectorMode): void {
	const document = container.ownerDocument;
	const body = element(document, "div", mode === "read" ? "reading" : "inspector-original");
	container.append(body);
	let cursor: number | null = 0;
	let insideCode = false;
	const more = element(document, "button", "load-more", "Load more text");
	more.type = "button";
	const append = (): void => {
		if (cursor === null) return;
		const page = inspectorTextPage(text, cursor);
		cursor = page.nextCursor;
		if (mode === "original") body.append(element(document, "pre", undefined, page.text));
		else {
			const sections = readingSections(`${insideCode ? "```\n" : ""}${page.text}`);
			// A deliberately dense Markdown block should not create thousands of DOM nodes.
			if (sections.length > MAX_READING_SECTIONS) body.append(element(document, "pre", undefined, page.text));
			else for (const section of sections) {
				const tag = section.kind === "heading" ? "h3" : section.kind === "code" ? "pre" : "p";
				body.append(element(document, tag, section.kind === "list" ? "reading-list" : undefined, section.text));
			}
			for (const line of page.text.split("\n")) if (/^\s*```/u.test(line)) insideCode = !insideCode;
		}
		if (cursor === null) more.remove();
		else more.textContent = `Load more text · ${cursor.toLocaleString()} of ${text.length.toLocaleString()} characters shown`;
	};
	more.addEventListener("click", append);
	container.append(more);
	append();
}

function appendImage(container: HTMLElement, block: ContentBlock): void {
	const document = container.ownerDocument;
	const mimeType = block.mimeType || "unknown type";
	container.append(element(document, "p", undefined, `Image · ${labelText(mimeType)}`));
	if (!/^image\/[a-z0-9.+-]+$/iu.test(mimeType)) {
		container.append(element(document, "p", undefined, "No supported image MIME type was exposed."));
		return;
	}
	// Neither data access nor a potentially huge data URL is needed until explicitly requested.
	const load = element(document, "button", "load-more", "Load image");
	load.type = "button";
	load.addEventListener("click", () => {
		const data = (block as ContentBlock & { data?: unknown }).data;
		if (typeof data !== "string" || !data.length) {
			load.textContent = "Image data was not exposed";
			load.disabled = true;
			return;
		}
		const image = element(document, "img");
		image.alt = `Captured context image (${labelText(mimeType)})`;
		image.loading = "lazy";
		image.decoding = "async";
		image.src = `data:${mimeType};base64,${data}`;
		container.append(image);
		load.remove();
	});
	container.append(load);
}

function appendBlock(container: HTMLElement, block: ContentBlock, index: number, mode: InspectorMode): void {
	const document = container.ownerDocument;
	const section = element(document, "section", "detail-block");
	section.dataset.type = block.type;
	section.dataset.blockIndex = String(index);
	const label = block.type === "toolCall" ? `Tool call · ${labelText(block.name || "Unnamed tool")}`
		: block.type === "thinking" ? `Thinking${block.redacted ? " · redacted" : ""}`
		: block.type === "image" ? "Image" : block.type === "text" ? "Content" : `Captured block · ${labelText(block.type)}`;
	section.append(element(document, "div", "detail-block-label", label));
	if (block.type === "image") appendImage(section, block);
	else if (block.type === "thinking") {
		const details = element(document, "details");
		details.append(element(document, "summary", undefined, "Show thinking"));
		let rendered = false;
		details.addEventListener("toggle", () => {
			if (!details.open || rendered) return;
			rendered = true;
			appendPagedText(details, block.text || "", mode);
		});
		section.append(details);
	} else if (block.type === "toolCall") appendPagedText(section, inspectorToolText(block.argumentsJson || "", mode), "original");
	else if (block.type === "text") appendPagedText(section, block.text || "", mode);
	else section.append(element(document, "p", undefined, "This block type has no reader representation."));
	container.append(section);
}

function provenance(item: ContentItem, document: Document): HTMLDetailsElement {
	const details = element(document, "details");
	details.id = "detail-provenance";
	details.append(element(document, "summary", undefined, "Content provenance"));
	details.append(element(document, "p", undefined, `Source role: ${labelText(item.detail?.sourceRole || item.kind)}`));
	const messages = item.synthetic ? [] : item.detail?.modelMessages ?? [];
	const roles = messages.slice(0, READER_PAGE_BLOCKS).map((message, index) => `${index + 1}: ${labelText(message.modelRole)}`).join(" · ");
	details.append(element(document, "p", undefined, messages.length
		? `Model roles${messages.length > READER_PAGE_BLOCKS ? ` (first ${READER_PAGE_BLOCKS} of ${messages.length})` : ""}: ${roles}. Each model-message header preserves its captured order.`
		: "Model roles: no captured model messages."));
	details.append(element(document, "p", undefined, `${RECONSTRUCTION_NOTICE} The active adapter exposes this content at its context hook; provider-only transforms or fields may not be present. Original view preserves captured block text, not a provider payload.`));
	return details;
}

/** Render bounded pages safely using DOM text nodes. Never interprets captured HTML. */
export function renderInspectorContent(container: HTMLElement, item: ContentItem, mode: InspectorMode): void {
	const document = container.ownerDocument;
	container.replaceChildren();
	if (item.synthetic) {
		container.append(element(document, "p", "inspector-empty", SYNTHETIC_NOTICE), provenance(item, document));
		return;
	}
	if (!item.detail?.modelMessages.length) {
		container.append(element(document, "p", "inspector-empty", EMPTY_NOTICE), provenance(item, document));
		return;
	}
	const messages = element(document, "div", "inspector-messages");
	const messageElements = new Map<number, HTMLElement>();
	const more = element(document, "button", "load-more", "Load more model content");
	more.type = "button";
	container.append(messages, more, provenance(item, document));
	let cursor: InspectorCursor | null | undefined;
	const appendPage = (): void => {
		if (cursor === null) return;
		const page = inspectorPage(item, cursor);
		for (const message of page.messages) {
			let messageElement = messageElements.get(message.messageIndex);
			if (!messageElement) {
				messageElement = element(document, "section", "model-message");
				messageElement.dataset.messageIndex = String(message.messageIndex);
				messageElement.append(element(document, "header", undefined, `Model message ${message.messageIndex + 1} · ${labelText(message.modelRole)}`));
				messages.append(messageElement);
				messageElements.set(message.messageIndex, messageElement);
			}
			if (message.empty) messageElement.append(element(document, "p", "inspector-empty", "No displayable blocks were exposed for this model message."));
			for (const { block, blockIndex } of message.blocks) appendBlock(messageElement, block, blockIndex, mode);
		}
		cursor = page.nextCursor;
		if (cursor === null) more.remove();
	};
	more.addEventListener("click", appendPage);
	appendPage();
}

/** Explicitly requested full-text copy; images are represented by metadata, never base64 data. */
export function copyableContextText(item: ContentItem): string {
	const parts = [RECONSTRUCTION_NOTICE, `Source role: ${item.detail?.sourceRole || item.kind}`];
	if (item.synthetic) return [...parts, "", SYNTHETIC_NOTICE].join("\n");
	if (item.toolName) parts.push(`Tool: ${item.toolName}`);
	if (item.detail?.isError) parts.push("Captured error state: true");
	const messages = item.detail?.modelMessages ?? [];
	if (!messages.length) return [...parts, "", EMPTY_NOTICE].join("\n");
	for (const [messageIndex, message] of messages.entries()) {
		parts.push("", `[Model message ${messageIndex + 1} · ${message.modelRole}]`);
		if (!message.blocks.length) parts.push("No displayable blocks were exposed for this model message.");
		for (const block of message.blocks) {
			if (block.type === "text") parts.push("[Text]", block.text || "");
			else if (block.type === "thinking") parts.push(`[Thinking${block.redacted ? " · redacted" : ""}]`, block.text || "");
			else if (block.type === "toolCall") parts.push(`[Tool call: ${block.name || "Unnamed tool"}]`, block.argumentsJson || "");
			else if (block.type === "image") parts.push(`[Image: ${block.mimeType || "unknown type"}; image data omitted]`);
			else parts.push(`[Unsupported captured block: ${block.type}]`);
		}
	}
	return parts.join("\n");
}
