import assert from "node:assert/strict";
import test from "node:test";
import type { ContentBlock, ContentItem } from "../web/src/content-view.ts";
import {
	copyableContextText,
	inspectorPage,
	inspectorTextPage,
	inspectorToolText,
	renderInspectorContent,
} from "../web/src/inspector-view.ts";
import { READER_PAGE_BLOCKS, READER_PAGE_CHARACTERS } from "../web/src/reader.ts";

function item(blocks: ContentBlock[]): ContentItem {
	return { id: "item", kind: "assistant", detail: { sourceRole: "custom_source", modelMessages: [{ modelRole: "assistant", blocks }] } };
}

test("inspector pages preserve model-message boundaries and repeated roles", () => {
	const value = item([]);
	value.detail = { sourceRole: "custom_source", modelMessages: [
		{ modelRole: "developer", blocks: [{ type: "text", text: "first" }] },
		{ modelRole: "user", blocks: [{ type: "text", text: "second" }] },
		{ modelRole: "developer", blocks: [{ type: "text", text: "third" }] },
	] };
	const page = inspectorPage(value);
	assert.deepEqual(page.messages.map(({ modelRole }) => modelRole), ["developer", "user", "developer"]);
	assert.deepEqual(page.messages.map(({ messageIndex }) => messageIndex), [0, 1, 2]);
	assert.ok(page.messages.every(({ showHeader }) => showHeader));
	assert.equal(page.nextCursor, null);
});

test("large block lists continue within their original message without adding another header", () => {
	const value = item(Array.from({ length: 100 }, (_, index) => ({ type: "text", text: `block ${index}` })));
	const first = inspectorPage(value);
	assert.equal(first.messages[0]!.blocks.length, READER_PAGE_BLOCKS);
	assert.equal(first.messages[0]!.showHeader, true);
	assert.deepEqual(first.nextCursor, { messageIndex: 0, blockIndex: READER_PAGE_BLOCKS, headerRendered: true });
	const second = inspectorPage(value, first.nextCursor!);
	assert.equal(second.messages[0]!.showHeader, false);
	assert.equal(second.messages[0]!.blocks[0]!.blockIndex, READER_PAGE_BLOCKS);
	assert.equal(second.messages[0]!.blocks[0]!.block.text, "block 24");
});

test("empty model-message lists have the same bounded header pagination", () => {
	const value = item([]);
	value.detail = { sourceRole: "custom_source", modelMessages: Array.from({ length: 10_000 }, () => ({ modelRole: "user", blocks: [] })) };
	const first = inspectorPage(value);
	assert.equal(first.messages.length, READER_PAGE_BLOCKS);
	assert.ok(first.messages.every(({ empty }) => empty));
	assert.equal(first.nextCursor?.messageIndex, READER_PAGE_BLOCKS);
	const second = inspectorPage(value, first.nextCursor!);
	assert.equal(second.messages[0]!.messageIndex, READER_PAGE_BLOCKS);
	assert.equal(second.messages.length, READER_PAGE_BLOCKS);
});

test("text pages preserve every character and do not break surrogate pairs", () => {
	const source = "a".repeat(READER_PAGE_CHARACTERS - 1) + "😀" + "\n中文\r\n".repeat(8_000);
	const parts: string[] = [];
	let cursor: number | null = 0;
	while (cursor !== null) {
		const page = inspectorTextPage(source, cursor);
		assert.ok(page.text.length <= READER_PAGE_CHARACTERS);
		assert.doesNotMatch(page.text, /[\ud800-\udbff]$/u);
		parts.push(page.text);
		cursor = page.nextCursor;
	}
	assert.ok(parts.length > 2);
	assert.equal(parts.join(""), source);
	assert.deepEqual(inspectorTextPage(""), { text: "", nextCursor: null });
});

test("only small valid tool JSON is prettified, and original mode is exact", () => {
	const raw = '{"path":"<script>unsafe()</script>","count":2}';
	assert.equal(inspectorToolText(raw, "read"), '{\n  "path": "<script>unsafe()</script>",\n  "count": 2\n}');
	assert.equal(inspectorToolText(raw, "original"), raw);
	assert.equal(inspectorToolText("{not JSON}", "read"), "{not JSON}");
	const large = `{"query":"${"q".repeat(65_000)}"}`;
	const parse = JSON.parse;
	try {
		JSON.parse = (): never => { throw new Error("Large tool JSON must not be parsed"); };
		assert.equal(inspectorToolText(large, "read"), large);
	} finally { JSON.parse = parse; }
});

test("copy emits ordered role headers and exact text, thinking, and tool arguments", () => {
	const text = "  # Exact heading\r\n<script>not HTML</script>\n";
	const thinking = "\tThinking\nwith spaces  ";
	const args = '{ "cmd" : "printf \\"hi\\"", "n": 1 }';
	const value = item([{ type: "text", text }, { type: "thinking", text: thinking, redacted: true }, { type: "toolCall", name: "shell", argumentsJson: args }]);
	value.detail!.modelMessages = [...value.detail!.modelMessages, { modelRole: "user", blocks: [{ type: "text", text: "Next message" }] }];
	const copied = copyableContextText(value);
	assert.match(copied, /Context-hook reconstruction, not the exact provider request JSON/);
	assert.ok(copied.includes(`Source role: custom_source\n\n[Model message 1 · assistant]\n[Text]\n${text}\n[Thinking · redacted]\n${thinking}\n[Tool call: shell]\n${args}`));
	assert.ok(copied.endsWith("[Model message 2 · user]\n[Text]\nNext message"));
});

test("copy omits all image data and distinguishes synthetic markers from missing content", () => {
	const image = { type: "image", mimeType: "image/png", get data(): never { throw new Error("No base64 access during copy"); } };
	assert.ok(copyableContextText(item([image])).includes("[Image: image/png; image data omitted]"));
	assert.match(copyableContextText({ id: "marker", kind: "memory", synthetic: true }), /Synthetic compaction marker.*not captured model content/);
	assert.match(copyableContextText({ id: "missing", kind: "user" }), /No model-facing content was exposed/);
	assert.equal(inspectorPage({ id: "marker", kind: "memory", synthetic: true }).messages.length, 0);
});

/** Minimal DOM harness: enough to verify safety, bounded rendering, and button wiring without a dependency. */
class FakeElement {
	readonly children: FakeElement[] = [];
	readonly dataset: Record<string, string> = {};
	readonly events = new Map<string, (() => void)[]>();
	parent: FakeElement | undefined;
	className = "";
	id = "";
	type = "";
	open = false;
	disabled = false;
	loading = "";
	decoding = "";
	src = "";
	alt = "";
	private text = "";
	readonly ownerDocument: FakeDocument;
	readonly tagName: string;
	constructor(ownerDocument: FakeDocument, tagName: string) { this.ownerDocument = ownerDocument; this.tagName = tagName; }
	set innerHTML(_value: string) { throw new Error("Captured HTML must never be interpreted"); }
	set textContent(value: string) { this.text = value; this.replaceChildren(); }
	get textContent(): string { return this.text + this.children.map((child) => child.textContent).join(""); }
	append(...nodes: FakeElement[]): void { for (const node of nodes) { node.parent = this; this.children.push(node); } }
	replaceChildren(...nodes: FakeElement[]): void {
		for (const child of this.children) child.parent = undefined;
		this.children.length = 0;
		this.append(...nodes);
	}
	remove(): void {
		if (!this.parent) return;
		this.parent.children.splice(this.parent.children.indexOf(this), 1);
		this.parent = undefined;
	}
	addEventListener(name: string, handler: () => void): void {
		const handlers = this.events.get(name) || [];
		handlers.push(handler);
		this.events.set(name, handlers);
	}
	dispatch(name: string): void { for (const handler of this.events.get(name) || []) handler(); }
}

class FakeDocument {
	createElement(tag: string): FakeElement { return new FakeElement(this, tag); }
}

function descendants(node: FakeElement): FakeElement[] {
	return node.children.flatMap((child) => [child, ...descendants(child)]);
}

function render(value: ContentItem, mode: "read" | "original" = "read"): FakeElement {
	const container = new FakeDocument().createElement("div");
	renderInspectorContent(container as unknown as HTMLElement, value, mode);
	return container;
}

test("DOM paging appends blocks without duplicating the per-message header", () => {
	const container = render(item(Array.from({ length: 50 }, (_, index) => ({ type: "text", text: `Block ${index}` }))));
	assert.equal(descendants(container).filter((node) => node.className === "detail-block").length, 24);
	assert.equal(descendants(container).filter((node) => node.tagName === "header").length, 1);
	const more = descendants(container).find((node) => node.textContent === "Load more model content")!;
	more.dispatch("click");
	assert.equal(descendants(container).filter((node) => node.className === "detail-block").length, 48);
	assert.equal(descendants(container).filter((node) => node.tagName === "header").length, 1);
	more.dispatch("click");
	assert.equal(descendants(container).filter((node) => node.className === "detail-block").length, 50);
	assert.equal(more.parent, undefined);
});

test("DOM text paging is bounded, exact in original mode, and never creates injected elements", () => {
	const source = "<script>alert(1)</script>" + "x".repeat(40_000);
	const container = render(item([{ type: "text", text: source }]), "original");
	let blocks = descendants(container).filter((node) => node.tagName === "pre");
	assert.equal(blocks.length, 1);
	assert.equal(blocks[0]!.textContent.length, READER_PAGE_CHARACTERS);
	assert.equal(descendants(container).filter((node) => node.tagName === "script").length, 0);
	const more = descendants(container).find((node) => node.tagName === "button" && node.textContent.startsWith("Load more text"))!;
	more.dispatch("click");
	more.dispatch("click");
	blocks = descendants(container).filter((node) => node.tagName === "pre");
	assert.equal(blocks.map((node) => node.textContent).join(""), source);
	assert.equal(more.parent, undefined);
});

test("thinking and image payloads are not read until explicitly expanded or loaded", () => {
	let thinkingReads = 0;
	let imageReads = 0;
	const thinking = { type: "thinking", get text(): string { thinkingReads += 1; return "Deferred thinking"; } };
	const image = { type: "image", mimeType: "image/png", get data(): string { imageReads += 1; return "AAAA"; } };
	const container = render(item([thinking, image]));
	assert.equal(thinkingReads, 0);
	assert.equal(imageReads, 0);
	const thinkingDetails = descendants(container).find((node) => node.tagName === "details" && node.id !== "detail-provenance")!;
	assert.equal(thinkingDetails.open, false);
	thinkingDetails.open = true;
	thinkingDetails.dispatch("toggle");
	assert.equal(thinkingReads, 1);
	assert.ok(thinkingDetails.textContent.includes("Deferred thinking"));
	thinkingDetails.dispatch("toggle");
	assert.equal(thinkingReads, 1);
	const loadImage = descendants(container).find((node) => node.tagName === "button" && node.textContent === "Load image")!;
	loadImage.dispatch("click");
	assert.equal(imageReads, 1);
	const renderedImage = descendants(container).find((node) => node.tagName === "img")!;
	assert.equal(renderedImage.loading, "lazy");
	assert.equal(renderedImage.src, "data:image/png;base64,AAAA");
});

test("provenance preserves source/model distinctions and remains adapter-neutral", () => {
	const value = item([{ type: "text", text: "hello" }]);
	value.detail = { ...value.detail!, sourceRole: "notification", modelMessages: [{ modelRole: "developer", blocks: [] }, { modelRole: "user", blocks: [] }] };
	const container = render(value);
	const provenance = descendants(container).find((node) => node.id === "detail-provenance")!;
	assert.equal(provenance.open, false);
	assert.match(provenance.textContent, /Source role: notification/);
	assert.match(provenance.textContent, /1: developer · 2: user/);
	assert.match(provenance.textContent, /not the exact provider request JSON/);
	assert.doesNotMatch(provenance.textContent, /OMP/);
	assert.deepEqual(descendants(container).filter((node) => node.tagName === "header").map((node) => node.textContent), ["Model message 1 · developer", "Model message 2 · user"]);
});

test("dense reading markup cannot expand one bounded text page into unbounded DOM nodes", () => {
	const container = render(item([{ type: "text", text: "# x\n".repeat(4_000) }]));
	assert.ok(descendants(container).length < 150);
	assert.equal(descendants(container).filter((node) => node.tagName === "pre").length, 1);
});
