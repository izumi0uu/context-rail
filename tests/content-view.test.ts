import assert from "node:assert/strict";
import test from "node:test";
import {
	CONTENT_LIMITS,
	ContentIndex,
	firstContentLine,
	getContentCacheStats,
	normalizeSearchText,
	projectContent,
	toolArgumentPreview,
	type ContentBlock,
	type ContentItem,
	type ContentReconcileProgress,
} from "../web/src/content-view.ts";

function item(id: string, text: string, extra: Partial<ContentItem> = {}): ContentItem {
	return { id, kind: "user", detail: { sourceRole: "user", modelMessages: [{ modelRole: "user", blocks: [{ type: "text", text }] }] }, ...extra };
}

test("previews use the first nonempty heading or line without assigning importance", () => {
	assert.equal(firstContentLine("\n\u3000\n## Exact title\nLater claim"), "Exact title");
	const content = projectContent(item("heading", "\n# Small question\nA much more important-looking line"));
	assert.equal(content.title, "Small question");
	assert.equal(content.preview, "Small question");
	assert.equal(content.category, "message");
	assert.equal(firstContentLine(" ".repeat(8_000) + "invisible"), "");
});

test("tool calls expose recognized arguments and never an arbitrary JSON fallback", () => {
	assert.equal(toolArgumentPreview('{"file_path":"/workspace/app.ts","secret":"hidden"}'), "/workspace/app.ts");
	assert.equal(toolArgumentPreview('{"cmd":"rg\\n test src"}'), "rg test src");
	assert.equal(toolArgumentPreview('{"search_query":[{"q":"中文 搜索"}]}'), "中文 搜索");
	assert.equal(toolArgumentPreview('{"secret":"hidden"}'), "");
	assert.equal(toolArgumentPreview('{broken'), "");
	assert.equal(toolArgumentPreview('{"query":"data:image/png;base64,AAAA"}'), "");
	assert.equal(toolArgumentPreview(`{"query":"${"a".repeat(5_000)}"}`), "");
	const content = projectContent(item("call", "", { kind: "assistant", detail: { sourceRole: "assistant", modelMessages: [{ modelRole: "assistant", blocks: [{ type: "toolCall", name: "read_file", argumentsJson: '{"path":"src/main.ts"}' }] }] } }));
	assert.equal(content.category, "tool-call");
	assert.equal(content.preview, "read_file · src/main.ts");
});

test("tool results retain their actual output and independent error state", () => {
	const value = item("result", "", { kind: "tool", toolName: "shell", detail: { sourceRole: "toolResult", isError: true, modelMessages: [{ modelRole: "toolResult", blocks: [{ type: "text", text: "\nExit code: 2\nPermission denied" }] }] } });
	const content = projectContent(value);
	assert.equal(content.preview, "shell · Exit code: 2");
	assert.equal(content.category, "tool-result");
	assert.equal(content.isError, true);
	assert.ok(content.badges.includes("Error"));
	const index = new ContentIndex();
	index.reconcile([value]);
	assert.equal(index.search("shell denied").results[0]?.id, "result");
});

test("source role and model roles remain distinct, with multiple model messages counted", () => {
	const content = projectContent(item("roles", "", { kind: "user", detail: { sourceRole: "custom_notification", modelMessages: [{ modelRole: "developer", blocks: [{ type: "text", text: "Operator instructions" }] }, { modelRole: "user", blocks: [{ type: "text", text: "Visible request" }] }] } }));
	assert.equal(content.sourceRole, "custom_notification");
	assert.deepEqual(content.modelRoles, ["developer", "user"]);
	assert.equal(content.messageCount, 2);
	assert.ok(content.badges.includes("2 model messages"));
	assert.equal(content.preview, "Operator instructions");
});

test("real summaries and synthetic markers cannot be mistaken for each other", () => {
	const summary = projectContent(item("summary", "Retained facts", { kind: "memory" }));
	const synthetic = projectContent({ id: "marker", kind: "memory", synthetic: true });
	assert.equal(summary.category, "summary");
	assert.equal(summary.title, "Summary");
	assert.equal(summary.preview, "Retained facts");
	assert.equal(synthetic.category, "synthetic");
	assert.equal(synthetic.title, "Synthetic compaction marker");
	assert.match(synthetic.preview, /no summary text/);
});

test("image counts and MIME metadata never inspect image data", () => {
	const image = { type: "image", mimeType: "image/png", get data(): never { throw new Error("Image data must not be touched"); } };
	const value = item("image", "", { detail: { sourceRole: "user", modelMessages: [{ modelRole: "user", blocks: [image, image] }] } });
	const content = projectContent(value);
	assert.equal(content.imageCount, 2);
	assert.equal(content.preview, "2 images");
	assert.ok(content.badges.includes("2 images"));
	const index = new ContentIndex();
	index.reconcile([value]);
	assert.equal(index.search("image/png").results.length, 1);
	assert.equal(index.search("base64").results.length, 0);
});

test("thinking-only content is labeled and captured text wins over thinking", () => {
	const thinking = item("thinking", "", { kind: "assistant", detail: { sourceRole: "assistant", modelMessages: [{ modelRole: "assistant", blocks: [{ type: "thinking", text: "Possible route" }] }] } });
	assert.equal(projectContent(thinking).preview, "Possible route");
	assert.ok(projectContent(thinking).badges.includes("Thinking"));
	const withText = { ...thinking, detail: { ...thinking.detail!, modelMessages: [{ modelRole: "assistant", blocks: [...thinking.detail!.modelMessages[0]!.blocks, { type: "text", text: "Actual response" }] }] } };
	assert.equal(projectContent(withText).preview, "Actual response");
	const longThinking = { ...thinking, detail: { ...thinking.detail!, modelMessages: [{ modelRole: "assistant", blocks: [{ type: "thinking", text: "T".repeat(50_000) }, { type: "text", text: "Answer after long thinking" }] }] } };
	assert.equal(projectContent(longThinking).preview, "Answer after long thinking");
});

test("projection cache follows detail identity and relevant fields, not wrapper replacements", () => {
	const value = item("cached", "Original text");
	const before = getContentCacheStats();
	const content = projectContent(value);
	assert.strictEqual(projectContent(value), content);
	assert.strictEqual(projectContent({ ...value }), content);
	assert.equal(getContentCacheStats().misses, before.misses + 1);
	assert.equal(getContentCacheStats().hits, before.hits + 2);
	assert.notStrictEqual(projectContent({ ...value, synthetic: true }), content);
	const changed = item(value.id, "New text");
	assert.notStrictEqual(projectContent(changed), content);
	assert.equal(projectContent(changed).preview, "New text");
	const withoutDetail: ContentItem = { id: "none", kind: "user" };
	assert.strictEqual(projectContent(withoutDetail), projectContent(withoutDetail));
});

test("large strings and block arrays have bounded preview scans", () => {
	const blocks: ContentBlock[] = Array.from({ length: 10_000 }, () => ({ type: "image", mimeType: "image/png" }));
	blocks[0] = { type: "text", text: "X".repeat(5_000_000) };
	const value = item("large", "", { detail: { sourceRole: "user", modelMessages: [{ modelRole: "user", blocks }] } });
	const content = projectContent(value);
	assert.ok(content.scannedCharacters <= CONTENT_LIMITS.previewCharacters);
	assert.equal(content.scannedBlocks, CONTENT_LIMITS.previewBlocks);
	assert.equal(content.imageCount, CONTENT_LIMITS.previewBlocks - 1);
	assert.equal(content.imageCountTruncated, true);
	assert.equal(content.previewTruncated, true);
	assert.ok(content.preview.length <= CONTENT_LIMITS.previewLength + 1);
	const before = getContentCacheStats();
	for (let count = 0; count < 1_000; count += 1) projectContent(value);
	assert.equal(getContentCacheStats().scannedCharacters, before.scannedCharacters);
	assert.equal(getContentCacheStats().scannedBlocks, before.scannedBlocks);
});

test("search matches Unicode whitespace, case, compatibility forms and unordered multilingual terms", () => {
	assert.equal(normalizeSearchText(" ＡＢＣ\u3000中文\nNext "), "abc 中文 next");
	const index = new ContentIndex();
	index.reconcile([item("match", "ＨＥＬＬＯ\n世界 代码\tReview"), item("other", "Another message")]);
	assert.equal(index.search("hello\u3000代码 review").results[0]?.id, "match");
	assert.equal(index.search("代码 世界").results[0]?.id, "match");
	assert.equal(index.search("hello missing").results.length, 0);
	assert.equal(index.search(" ").results.length, 0);
	assert.equal(index.search("hello").scope, "indexed-excerpts");
});

test("reconcile incrementally replaces content, reuses unchanged detail, and deletes stale IDs", () => {
	const index = new ContentIndex();
	const original = item("one", "Original body");
	index.reconcile([original, item("two", "Second body")]);
	const projection = index.get("one");
	const revision = index.diagnostics().revision;
	index.reconcile([{ ...original }, item("two", "Changed body")]);
	assert.strictEqual(index.get("one"), projection);
	assert.deepEqual(index.diagnostics().lastReconcile, { added: 0, updated: 1, removed: 0, reused: 1 });
	assert.ok(index.diagnostics().revision > revision);
	assert.equal(index.search("second").results.length, 0);
	assert.equal(index.search("changed").results[0]?.id, "two");
	index.reconcile([original]);
	assert.equal(index.get("two"), undefined);
	assert.equal(index.search("changed").results.length, 0);
	index.clear();
	assert.equal(index.diagnostics().itemCount, 0);
	assert.equal(index.diagnostics().textBytes, 0);
	assert.equal(index.search("original").results.length, 0);
	index.reconcile([item("new-session", "Fresh session")]);
	assert.equal(index.search("fresh").results[0]?.id, "new-session");
});

test("large content is capped per item and globally, and search never claims full-content coverage", () => {
	const index = new ContentIndex({ maxItemCharacters: 100, maxTextBytes: 800 });
	index.reconcile([item("a", "A".repeat(500) + "hidden-tail"), item("b", "B".repeat(500)), item("c", "C".repeat(500))]);
	assert.ok(index.diagnostics().textBytes <= 800);
	assert.equal(index.diagnostics().maxItemCharacters, 100);
	assert.equal(index.diagnostics().truncatedItems, 3);
	assert.equal(index.diagnostics().omittedItems, 1);
	assert.equal(index.search("hidden-tail").results.length, 0);
	assert.equal(index.search("hidden-tail").scope, "indexed-excerpts");
	index.reconcile([item("c", "C".repeat(500))]);
	assert.equal(index.search("ccc").results[0]?.id, "c");
});

test("search page scans and result counts are bounded without sorting", () => {
	const index = new ContentIndex();
	index.reconcile(Array.from({ length: 2_010 }, (_, n) => item(`${n}`, n < 1_500 ? "nothing" : "needle")));
	const first = index.search("needle");
	assert.equal(first.scannedItems, 1_000);
	assert.equal(first.results.length, 0);
	assert.equal(first.nextCursor, 1_000);
	assert.equal(first.complete, false);
	const second = index.search("needle", { cursor: first.nextCursor! });
	assert.equal(second.results.length, 40);
	assert.equal(second.results[0]?.id, "1500");
	assert.equal(second.nextCursor, 1_540);
	assert.equal(index.search("needle", { limit: 9_000 }).results.length, 0);
	const final = index.search("needle", { cursor: 2_000, limit: 9_000 });
	assert.equal(final.results.length, 10);
	assert.equal(final.complete, true);
	assert.equal(final.nextCursor, null);
});

test("zero index budget still supports cached display without retaining searchable payloads", () => {
	const index = new ContentIndex({ maxTextBytes: 0 });
	index.reconcile([item("only-preview", "Visible preview")]);
	assert.equal(index.get("only-preview")?.preview, "Visible preview");
	assert.equal(index.search("visible").results.length, 0);
	assert.equal(index.diagnostics().textBytes, 0);
	assert.equal(index.diagnostics().omittedItems, 1);
});

test("index entry metadata is bounded independently of text size", () => {
	const index = new ContentIndex({ maxItems: 2 });
	const values = [item("first", "first"), item("second", "second"), item("third", "third")];
	index.reconcile(values);
	assert.equal(index.diagnostics().itemCount, 3);
	assert.equal(index.diagnostics().retainedItems, 2);
	assert.equal(index.diagnostics().omittedItems, 1);
	assert.equal(index.get("first"), undefined);
	assert.equal(index.search("first").results.length, 0);
	assert.equal(index.search("third").results[0]?.id, "third");
	index.reconcile(values.slice(1));
	assert.equal(index.get("first"), undefined);
	assert.equal(index.search("third").results[0]?.id, "third");
});

test("block-limited excerpts are not repeatedly extracted when detail identities are unchanged", () => {
	const index = new ContentIndex();
	const blocks = Array.from({ length: 600 }, () => ({ type: "text", text: "" }));
	const value = item("block-limited", "", { detail: { sourceRole: "user", modelMessages: [{ modelRole: "user", blocks }] } });
	index.reconcile([value]);
	assert.equal(index.diagnostics().truncatedItems, 1);
	const revision = index.diagnostics().revision;
	index.reconcile([{ ...value }]);
	assert.equal(index.diagnostics().revision, revision);
	assert.deepEqual(index.diagnostics().lastReconcile, { added: 0, updated: 0, removed: 0, reused: 1 });
});

test("newest entry and byte windows are explicit while result order remains chronological", async () => {
	const values = Array.from({ length: 7 }, (_, n) => item(`${n}`, `needle ${n}`));
	const index = new ContentIndex({ maxItems: 3 });
	const result = await index.reconcileAsync(values, { now: () => 0, yieldControl: async () => {} });
	assert.equal(result.committed, true);
	assert.deepEqual(index.search("needle").results.map(({ id }) => id), ["4", "5", "6"]);
	assert.equal(index.get("3"), undefined);
	assert.equal(index.diagnostics().windowPolicy, "newest-items");
	assert.equal(index.diagnostics().byteAllocation, "newest-first");
	assert.equal(index.diagnostics().resultOrder, "chronological");
	assert.equal(index.diagnostics().windowStart, 4);
	assert.equal(index.diagnostics().windowEnd, 7);
	assert.equal(index.diagnostics().omittedItems, 4);
	const capped = new ContentIndex({ maxItems: 3, maxItemCharacters: 10, maxTextBytes: 40 });
	await capped.reconcileAsync(values, { now: () => 0, yieldControl: async () => {} });
	assert.equal(capped.search("needle").results[0]?.id, "6");
	assert.equal(capped.search("needle").results.length, 1);
	assert.ok(capped.diagnostics().textBytes <= 40);
});

test("the default 10k window never projects excluded older items", async () => {
	const excluded = Array.from({ length: 3 }, (_, n): ContentItem => ({
		id: `excluded-${n}`, kind: "user", get detail(): never { throw new Error("Outside the retained window"); },
	}));
	const recent = Array.from({ length: CONTENT_LIMITS.indexItems }, (_, n) => item(`recent-${n}`, `needle-${n}`));
	const index = new ContentIndex();
	const result = await index.reconcileAsync([...excluded, ...recent], { now: () => 0, yieldControl: async () => {} });
	assert.equal(result.processedItems, 10_000);
	assert.equal(index.diagnostics().retainedItems, 10_000);
	assert.equal(index.diagnostics().windowStart, 3);
	assert.deepEqual(index.search("needle").results.slice(0, 3).map(({ id }) => id), ["recent-0", "recent-1", "recent-2"]);
	assert.equal(index.search("needle-9999", { cursor: 9_000 }).results[0]?.id, "recent-9999");
});

test("asynchronous reconciliation exposes only the old complete index until atomic commit", async () => {
	const index = new ContentIndex();
	const old = item("shared", "Old complete content");
	index.reconcile([old]);
	const oldProjection = index.get(old.id);
	const oldRevision = index.diagnostics().revision;
	const next = [item("shared", "Replacement content"), ...Array.from({ length: 6 }, (_, n) => item(`new-${n}`, "New session content"))];
	let yields = 0;
	const seen: ContentReconcileProgress[] = [];
	const result = await index.reconcileAsync(next, {
		maxItemsPerSlice: 2, now: () => 0,
		yieldControl: async () => { yields += 1; },
		onProgress(progress) {
			seen.push(progress);
			assert.strictEqual(index.get(old.id), oldProjection);
			assert.equal(index.search("old").results[0]?.id, old.id);
			assert.equal(index.search("new").results.length, 0);
			assert.equal(index.get("new-0"), undefined);
			assert.equal(index.diagnostics().revision, oldRevision);
			assert.equal(index.diagnostics().itemCount, 1);
			assert.equal(index.diagnostics().indexing, true);
		},
	});
	assert.ok(yields > 1);
	assert.ok(seen.length > 1);
	assert.equal(result.processedItems, next.length);
	assert.equal(result.committed, true);
	assert.equal(result.cancelled, false);
	assert.equal(index.diagnostics().indexing, false);
	assert.equal(index.diagnostics().pending, null);
	assert.equal(index.diagnostics().revision, oldRevision + 1);
	assert.equal(index.search("old").results.length, 0);
	assert.equal(index.search("new").results.length, 6);
	assert.equal(index.get("shared")?.preview, "Replacement content");
});

test("abort releases staging and completes cancellation without waiting for a stalled scheduler", async () => {
	const index = new ContentIndex();
	index.reconcile([item("old", "Old complete index")]);
	const oldRevision = index.diagnostics().revision;
	const controller = new AbortController();
	let resume!: () => void;
	const pending = index.reconcileAsync([item("new-1", "New body"), item("new-2", "Another new body")], {
		signal: controller.signal, maxItemsPerSlice: 1, now: () => 0,
		yieldControl: () => new Promise<void>((resolve) => { resume = resolve; }),
	});
	assert.ok(index.diagnostics().pending!.stagedTextBytes > 0);
	controller.abort();
	assert.equal(index.diagnostics().pending, null);
	assert.equal(index.diagnostics().indexing, false);
	const result = await pending;
	assert.equal(result.cancelled, true);
	assert.equal(result.committed, false);
	assert.equal(result.processedItems, 1);
	assert.equal(index.diagnostics().cancelledReconciliations, 1);
	assert.equal(index.diagnostics().revision, oldRevision);
	assert.equal(index.search("old").results[0]?.id, "old");
	assert.equal(index.search("new").results.length, 0);
	resume();
	await Promise.resolve();
	assert.equal(index.diagnostics().revision, oldRevision, "a late scheduler completion must not publish cancelled work");
});

test("a newer async request cancels older work and alone publishes its complete session", async () => {
	const index = new ContentIndex();
	index.reconcile([item("initial", "Initial body")]);
	let oldResume!: () => void;
	const oldJob = index.reconcileAsync([item("same-id", "Stale session body"), item("stale-extra", "Stale extra")], {
		maxItemsPerSlice: 1, now: () => 0,
		yieldControl: () => new Promise<void>((resolve) => { oldResume = resolve; }),
	});
	const newJob = index.reconcileAsync([item("same-id", "Current session body")], { now: () => 0, yieldControl: async () => {} });
	const [oldResult, newResult] = await Promise.all([oldJob, newJob]);
	assert.equal(oldResult.cancelled, true);
	assert.equal(newResult.committed, true);
	assert.ok(newResult.generation > oldResult.generation);
	assert.equal(index.search("current").results[0]?.id, "same-id");
	assert.equal(index.search("stale").results.length, 0);
	assert.equal(index.get("initial"), undefined);
	assert.equal(index.get("stale-extra"), undefined);
	oldResume();
	await Promise.resolve();
	assert.equal(index.get("same-id")?.preview, "Current session body");
	assert.equal(index.diagnostics().lastAsyncResult?.generation, newResult.generation);
});

test("clear, synchronous replacement, explicit cancel, and pre-aborted signals prevent stale publication", async () => {
	for (const operation of ["clear", "sync", "cancel"] as const) {
		const index = new ContentIndex();
		index.reconcile([item("old", "Old")]);
		const pending = index.reconcileAsync([item("new", "New"), item("second", "Second")], {
			maxItemsPerSlice: 1, now: () => 0, yieldControl: () => new Promise<void>(() => {}),
		});
		if (operation === "clear") index.clear();
		if (operation === "sync") index.reconcile([item("sync", "Synchronous replacement")]);
		if (operation === "cancel") index.cancelPendingReconcile();
		assert.equal((await pending).cancelled, true);
		assert.equal(index.get("new"), undefined);
		assert.equal(index.get("second"), undefined);
		assert.equal(index.diagnostics().pending, null);
		if (operation === "clear") assert.equal(index.diagnostics().itemCount, 0);
		if (operation === "sync") assert.equal(index.get("sync")?.preview, "Synchronous replacement");
		if (operation === "cancel") assert.equal(index.get("old")?.preview, "Old");
	}
	const index = new ContentIndex();
	const controller = new AbortController();
	controller.abort();
	const neverRead: ContentItem = { id: "never", kind: "user", get detail(): never { throw new Error("Cancelled input must not be projected"); } };
	const cancelled = await index.reconcileAsync([neverRead], { signal: controller.signal });
	assert.equal(cancelled.cancelled, true);
	assert.equal(cancelled.processedItems, 0);
	assert.equal(index.diagnostics().itemCount, 0);
});

test("work-unit ceilings and injected time budgets bound every cooperative slice", async () => {
	const values = Array.from({ length: 600 }, (_, n) => item(`${n}`, `Body ${n}`));
	const index = new ContentIndex();
	const progress: ContentReconcileProgress[] = [];
	let yields = 0;
	const result = await index.reconcileAsync(values, {
		maxItemsPerSlice: 10_000, now: () => 0,
		yieldControl: async () => { yields += 1; }, onProgress: (value) => { progress.push(value); },
	});
	assert.equal(result.maxSliceItems, 250, "caller cannot disable the hard per-slice work ceiling");
	assert.equal(result.processedItems, 600);
	assert.equal(progress.at(-1)?.completedWork, 1_200, "chronological-order construction is also sliced work");
	for (let n = 0; n < progress.length; n += 1) {
		assert.ok(progress[n]!.completedWork - (progress[n - 1]?.completedWork ?? 0) <= 250);
	}
	assert.equal(yields, result.slices - 1);
	let ticks = 0;
	const timed = await index.reconcileAsync(values.slice(0, 20), {
		maxItemsPerSlice: 250, timeBudgetMs: 4, now: () => ticks++, yieldControl: async () => {},
	});
	assert.equal(timed.maxSliceItems, 4);
	assert.ok(timed.slices >= 10);
});

test("async reconciliation reuses unchanged detail projections without rescanning text", async () => {
	let reads = 0;
	const value: ContentItem = { id: "shared", kind: "user", detail: { sourceRole: "user", modelMessages: [{ modelRole: "user", blocks: [{ type: "text", get text() { reads += 1; return "Reusable captured text"; } }] }] } };
	const index = new ContentIndex();
	index.reconcile([value]);
	const projection = index.get(value.id);
	const revision = index.diagnostics().revision;
	const initialReads = reads;
	const scans = getContentCacheStats();
	const result = await index.reconcileAsync([{ ...value }], { now: () => 0, yieldControl: async () => {} });
	assert.equal(result.committed, true);
	assert.strictEqual(index.get(value.id), projection);
	assert.equal(reads, initialReads);
	assert.equal(getContentCacheStats().scannedCharacters, scans.scannedCharacters);
	assert.equal(index.diagnostics().revision, revision);
	assert.deepEqual(index.diagnostics().lastReconcile, { added: 0, updated: 0, removed: 0, reused: 1 });
});

test("newest-first byte limits refill after removal and match fresh synchronous allocation", async () => {
	const options = { maxItemCharacters: 100, maxTextBytes: 480 };
	const a = item("a", "A".repeat(300));
	const b = item("b", "B".repeat(50) + "needle" + "B".repeat(300));
	const c = item("c", "C".repeat(300));
	const index = new ContentIndex(options);
	const cooperate = { maxItemsPerSlice: 1, now: () => 0, yieldControl: async () => {} };
	for (const values of [[a, b, c], [a, b], [a, b, c], [a, { ...b }, item("c", "Short C")], [a]]) {
		await index.reconcileAsync(values, cooperate);
		const fresh = new ContentIndex(options);
		fresh.reconcile(values);
		assert.ok(index.diagnostics().textBytes <= 480);
		assert.equal(index.diagnostics().textBytes, fresh.diagnostics().textBytes);
		assert.equal(index.diagnostics().indexedItems, fresh.diagnostics().indexedItems);
		assert.equal(index.diagnostics().truncatedItems, fresh.diagnostics().truncatedItems);
		for (const query of ["aaa", "bbb", "ccc", "needle", "short"]) {
			assert.deepEqual(index.search(query).results.map(({ id, excerpt }) => ({ id, excerpt })), fresh.search(query).results.map(({ id, excerpt }) => ({ id, excerpt })));
		}
		if (values.length === 2) assert.equal(index.search("needle").results[0]?.id, "b");
		if (values.at(-1) === c) assert.equal(index.search("needle").results.length, 0);
	}
});

test("yield failures discard unpublished content and leave the committed index usable", async () => {
	const index = new ContentIndex();
	index.reconcile([item("old", "Still committed")]);
	await assert.rejects(index.reconcileAsync([item("new", "Not published"), item("more", "More")], {
		maxItemsPerSlice: 1, now: () => 0,
		yieldControl: async () => { throw new Error("scheduler failed"); },
	}), /scheduler failed/);
	assert.equal(index.diagnostics().pending, null);
	assert.equal(index.search("committed").results[0]?.id, "old");
	assert.equal(index.search("published").results.length, 0);
	assert.equal((await index.reconcileAsync([item("ok", "Recovery")])).committed, true);
});

test("Unicode normalization expansion stays capped and budget refill matches a fresh index", async () => {
	const options = { maxItemCharacters: 100, maxTextBytes: 400 };
	const older = item("older", "A".repeat(200));
	const expanding = item("expanding", "ﬃ".repeat(40));
	const index = new ContentIndex(options);
	index.reconcile([older, expanding]);
	assert.equal(index.diagnostics().truncatedItems, 2);
	assert.ok(index.diagnostics().textBytes <= 400);
	await index.reconcileAsync([expanding, item("newer", "B".repeat(75))], { maxItemsPerSlice: 1, now: () => 0, yieldControl: async () => {} });
	const fresh = new ContentIndex(options);
	fresh.reconcile([expanding, item("newer", "B".repeat(75))]);
	assert.equal(index.diagnostics().textBytes, fresh.diagnostics().textBytes);
	assert.equal(index.diagnostics().truncatedItems, fresh.diagnostics().truncatedItems);
	assert.deepEqual(index.search("ffi").results.map(({ id, excerpt }) => ({ id, excerpt })), fresh.search("ffi").results.map(({ id, excerpt }) => ({ id, excerpt })));
});
