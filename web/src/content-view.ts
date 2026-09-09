/** Bounded, browser-safe projections of captured content. No payload is executed or rendered as HTML. */
export interface ContentBlock {
	type: string;
	text?: string;
	name?: string;
	argumentsJson?: string;
	mimeType?: string;
	redacted?: boolean;
}

export interface ContentDetail {
	sourceRole: string;
	modelMessages: readonly { modelRole: string; blocks: readonly ContentBlock[] }[];
	isError?: boolean;
}

/** Structural subset of HistoryItem; image data is deliberately not part of this API. */
export interface ContentItem {
	id: string;
	kind: string;
	toolName?: string;
	synthetic?: boolean;
	detail?: ContentDetail;
}

export interface ContentProjection {
	title: string;
	preview: string;
	category: "message" | "tool-call" | "tool-result" | "summary" | "synthetic";
	sourceRole: string;
	modelRoles: readonly string[];
	messageCount: number;
	imageCount: number;
	/** Counts are lower bounds when the bounded metadata scan did not visit every block. */
	imageCountTruncated: boolean;
	badges: readonly string[];
	previewTruncated: boolean;
	isError: boolean;
	synthetic: boolean;
	scannedCharacters: number;
	scannedBlocks: number;
}

export const CONTENT_LIMITS = Object.freeze({
	previewCharacters: 4_096,
	previewLength: 180,
	previewBlocks: 128,
	previewMessages: 32,
	argumentCharacters: 4_096,
	indexCharacters: 12_000,
	indexTextBytes: 8 * 1024 * 1024,
	indexItems: 10_000,
	indexBlocks: 512,
	indexMessages: 128,
	searchResults: 40,
	searchScanItems: 1_000,
	queryCharacters: 256,
	reconcileSliceItems: 128,
	reconcileSliceMilliseconds: 6,
});

const detailCache = new WeakMap<ContentDetail, Map<string, ContentProjection>>();
const itemCache = new WeakMap<ContentItem, { signature: string; projection: ContentProjection }>();
const cacheMetrics = { hits: 0, misses: 0, scannedCharacters: 0, scannedBlocks: 0 };

export function getContentCacheStats(): Readonly<typeof cacheMetrics> {
	return { ...cacheMetrics };
}

/** Unicode compatibility normalization, locale-independent case folding, and Unicode whitespace. */
export function normalizeSearchText(text: string): string {
	return text.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
}

function compact(text: string, length: number): string {
	const bounded = text.slice(0, length + 1).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, " ");
	return bounded.length > length ? `${bounded.slice(0, length).trimEnd()}…` : bounded;
}

/** First nonempty line within a fixed scan window; Markdown heading markers are presentation only. */
export function firstContentLine(text: string, maxLength = CONTENT_LIMITS.previewLength): string {
	const bounded = text.slice(0, CONTENT_LIMITS.previewCharacters);
	const line = bounded.split(/[\r\n\u2028\u2029]/u).find((part) => part.trim().length > 0);
	if (!line) return "";
	return compact(line.trim().replace(/^#{1,6}\s+/u, ""), Math.max(1, Math.min(maxLength, 500)));
}

const argumentKeys = ["path", "file_path", "filePath", "filename", "directory", "cwd", "command", "cmd", "query", "q", "search", "pattern"];

/** Only recognized path/command/query fields, never a raw JSON fallback or image/base64 payload. */
export function toolArgumentPreview(argumentsJson: string | undefined): string {
	if (!argumentsJson || argumentsJson.length > CONTENT_LIMITS.argumentCharacters) return "";
	let parsed: unknown;
	try { parsed = JSON.parse(argumentsJson); } catch { return ""; }
	const inspect = (value: unknown, depth: number): string => {
		if (!value || typeof value !== "object" || depth > 2) return "";
		const record = value as Record<string, unknown>;
		for (const key of argumentKeys) {
			const candidate = record[key];
			if (typeof candidate !== "string" || !candidate.trim() || /^\s*data:/iu.test(candidate)) continue;
			return compact(candidate.slice(0, 180).replace(/\s+/gu, " ").trim(), 120);
		}
		// Common search APIs wrap their query list. Do not walk arbitrary payload trees.
		for (const key of ["search_query", "queries", "arguments", "input"]) {
			const child = record[key];
			for (const entry of Array.isArray(child) ? child.slice(0, 4) : [child]) {
				const found = inspect(entry, depth + 1);
				if (found) return found;
			}
		}
		return "";
	};
	return inspect(parsed, 0);
}

function contentSignature(item: ContentItem): string {
	return JSON.stringify([item.kind, item.toolName || "", Boolean(item.synthetic)]);
}

function buildProjection(item: ContentItem): ContentProjection {
	const detail = item.detail;
	const messages = detail?.modelMessages ?? [];
	const modelRoles: string[] = [];
	let firstText = "";
	let firstThinking = "";
	let toolCall = "";
	let imageCount = 0;
	let scannedCharacters = 0;
	let scannedBlocks = 0;
	let scanTruncated = false;
	let textTruncated = false;
	for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
		if (messageIndex >= CONTENT_LIMITS.previewMessages) { scanTruncated = true; break; }
		const message = messages[messageIndex]!;
		const role = compact(message.modelRole, 80);
		if (!modelRoles.includes(role)) modelRoles.push(role);
		for (const block of message.blocks) {
			if (scannedBlocks >= CONTENT_LIMITS.previewBlocks) { scanTruncated = true; break; }
			scannedBlocks += 1;
			if (block.type === "image") imageCount += 1;
			if (block.type === "toolCall" && !toolCall) {
				const remaining = CONTENT_LIMITS.previewCharacters - scannedCharacters;
				const argumentJson = (block.argumentsJson?.length ?? 0) <= remaining ? block.argumentsJson : undefined;
				const argument = toolArgumentPreview(argumentJson);
				scannedCharacters += Math.min(argumentJson?.length ?? 0, CONTENT_LIMITS.argumentCharacters);
				if (argumentJson === undefined && block.argumentsJson) textTruncated = true;
				toolCall = [compact(block.name || item.toolName || "Tool call", 80), argument].filter(Boolean).join(" · ");
			}
			if ((block.type === "text" || block.type === "thinking") && block.text) {
				if ((block.type === "text" && firstText) || (block.type === "thinking" && firstThinking)) continue;
				const remaining = CONTENT_LIMITS.previewCharacters - scannedCharacters;
				// Reserve most of the text budget for an actual response after a long thinking block.
				const text = block.text.slice(0, block.type === "thinking" ? Math.min(remaining, 1_024) : remaining);
				scannedCharacters += text.length;
				const line = firstContentLine(text);
				if (block.type === "text" && !firstText) firstText = line;
				if (block.type === "thinking" && !firstThinking) firstThinking = line;
				if (text.length < block.text.length || line.endsWith("…")) textTruncated = true;
			}
		}
		if (scanTruncated) break;
	}
	const sourceRole = compact(detail?.sourceRole || item.kind, 100);
	const synthetic = Boolean(item.synthetic);
	const toolResult = item.kind === "tool" || /^tool(?:result|_result)$/iu.test(sourceRole);
	const category: ContentProjection["category"] = synthetic ? "synthetic" : item.kind === "memory" ? "summary" : toolResult ? "tool-result" : toolCall ? "tool-call" : "message";
	const line = firstText || firstThinking;
	const fallback = imageCount ? `${imageCount}${scanTruncated ? "+" : ""} image${imageCount === 1 ? "" : "s"}` : "No captured text";
	let title = line || fallback;
	let preview = line || fallback;
	if (category === "tool-call") title = preview = toolCall;
	if (category === "tool-result") title = preview = `${compact(item.toolName || "Tool result", 80)} · ${line || fallback}`;
	if (category === "summary") title = "Summary";
	if (category === "synthetic") {
		title = "Synthetic compaction marker";
		preview = line || "Compaction event; no summary text was captured.";
	}
	const badges: string[] = [];
	if (messages.length > 1) badges.push(`${messages.length} model messages`);
	if (imageCount > 0) badges.push(`${imageCount}${scanTruncated ? "+" : ""} image${imageCount === 1 ? "" : "s"}`);
	if (firstThinking && !firstText && category === "message") badges.push("Thinking");
	if (detail?.isError) badges.push("Error");
	if (synthetic) badges.push("Synthetic marker");
	else if (category === "summary") badges.push("Summary");
	cacheMetrics.scannedCharacters += scannedCharacters;
	cacheMetrics.scannedBlocks += scannedBlocks;
	return Object.freeze({ title, preview, category, sourceRole, modelRoles: Object.freeze(modelRoles), messageCount: messages.length, imageCount, imageCountTruncated: scanTruncated, badges: Object.freeze(badges), previewTruncated: scanTruncated || textTruncated, isError: Boolean(detail?.isError), synthetic, scannedCharacters, scannedBlocks });
}

/** Identity cache assumes detail objects are immutable. A replaced detail always invalidates it. */
export function projectContent(item: ContentItem): ContentProjection {
	const signature = contentSignature(item);
	if (!item.detail) {
		const cached = itemCache.get(item);
		if (cached?.signature === signature) { cacheMetrics.hits += 1; return cached.projection; }
		cacheMetrics.misses += 1;
		const projection = buildProjection(item);
		itemCache.set(item, { signature, projection });
		return projection;
	}
	let variants = detailCache.get(item.detail);
	const cached = variants?.get(signature);
	if (cached) { cacheMetrics.hits += 1; return cached; }
	cacheMetrics.misses += 1;
	const projection = buildProjection(item);
	if (!variants) { variants = new Map(); detailCache.set(item.detail, variants); }
	// Bound variants in case a single detail is reused for many tool labels.
	if (variants.size >= 8) variants.delete(variants.keys().next().value!);
	variants.set(signature, projection);
	return projection;
}

interface Excerpt { text: string; truncated: boolean }

function extractExcerpt(item: ContentItem, maxCharacters: number): Excerpt {
	if (maxCharacters === 0) return { text: "", truncated: true };
	const parts: string[] = [];
	let remaining = maxCharacters;
	let truncated = false;
	let blocks = 0;
	const append = (value: string): void => {
		if (!value) return;
		if (remaining <= 0) { truncated = true; return; }
		const separator = parts.length ? "\n" : "";
		const take = Math.max(0, remaining - separator.length);
		const part = value.slice(0, take);
		parts.push(separator + part);
		remaining -= separator.length + part.length;
		if (part.length < value.length) truncated = true;
	};
	const messages = item.detail?.modelMessages ?? [];
	if (item.toolName) append(compact(item.toolName, 80));
	outer: for (let index = 0; index < messages.length; index += 1) {
		if (index >= CONTENT_LIMITS.indexMessages) { truncated = true; break; }
		for (const block of messages[index]!.blocks) {
			if (blocks >= CONTENT_LIMITS.indexBlocks || remaining <= 0) { truncated = true; break outer; }
			blocks += 1;
			if (block.type === "text" || block.type === "thinking") append(block.text || "");
			else if (block.type === "image") append(`Image ${compact(block.mimeType || "unknown type", 80)}`);
			else if (block.type === "toolCall") append([compact(block.name || "Tool call", 80), toolArgumentPreview(block.argumentsJson)].filter(Boolean).join(" · "));
		}
	}
	return { text: parts.join(""), truncated };
}

interface IndexEntry {
	detail: ContentDetail | undefined;
	signature: string;
	content: ContentProjection;
	excerpt: string;
	normalized: string;
	bytes: number;
	truncated: boolean;
	capacityLimited: boolean;
	characterBudget: number;
}

export interface ContentSearchResult { id: string; content: ContentProjection; excerpt: string }
export interface ContentSearchPage {
	results: ContentSearchResult[];
	nextCursor: number | null;
	complete: boolean;
	scannedItems: number;
	scope: "indexed-excerpts";
	revision: number;
}

export interface ContentIndexOptions { maxItemCharacters?: number; maxTextBytes?: number; maxItems?: number }
export interface ContentSearchOptions { limit?: number; cursor?: number; scanLimit?: number }

export interface ContentReconcileProgress {
	generation: number;
	processedItems: number;
	totalItems: number;
	completedWork: number;
	slices: number;
	maxSliceItems: number;
	phase: "indexing" | "ordering" | "ready";
}

export interface ContentReconcileResult {
	committed: boolean;
	cancelled: boolean;
	generation: number;
	processedItems: number;
	slices: number;
	maxSliceItems: number;
	revision: number;
}

export interface ContentReconcileOptions {
	signal?: AbortSignal;
	/** Real task yielding by default; injectable to deterministically test scheduling. */
	yieldControl?: () => Promise<void>;
	/** Work units include indexing one item or placing one ID in chronological order. Hard maximum: 250. */
	maxItemsPerSlice?: number;
	/** Cooperative deadline checked between bounded item operations. Hard maximum: 8 ms. */
	timeBudgetMs?: number;
	now?: () => number;
	onProgress?: (progress: ContentReconcileProgress) => void;
}

interface ReconcileChanges { added: number; updated: number; removed: number; reused: number }

interface IndexTransaction {
	generation: number;
	items: readonly ContentItem[];
	baseEntries: ReadonlyMap<string, IndexEntry>;
	baseIds: readonly string[];
	entries: Map<string, IndexEntry>;
	reversedIds: string[];
	ids: string[];
	totalItems: number;
	windowStart: number;
	nextItem: number;
	nextOrder: number;
	processedItems: number;
	completedWork: number;
	slices: number;
	maxSliceItems: number;
	textBytes: number;
	indexedItems: number;
	truncatedItems: number;
	retainedExisting: number;
	orderChanged: boolean;
	phase: ContentReconcileProgress["phase"];
	changes: ReconcileChanges;
	cancelled: boolean;
	cancellation: Promise<void>;
	wakeCancellation: () => void;
}

function boundedInteger(value: number | undefined, fallback: number, maximum: number): number {
	return value === undefined || !Number.isFinite(value) ? fallback : Math.max(0, Math.min(maximum, Math.floor(value)));
}

/** Search is over bounded excerpts, not full captured content. Retained text has a global byte cap. */
export class ContentIndex {
	private entries = new Map<string, IndexEntry>();
	private ids: string[] = [];
	private textBytes = 0;
	private totalItems = 0;
	private indexedItems = 0;
	private truncatedItems = 0;
	private windowStart = 0;
	private revision = 0;
	private generation = 0;
	private pending: IndexTransaction | null = null;
	private cancelledReconciliations = 0;
	private lastAsyncResult: ContentReconcileResult | null = null;
	private lastReconcile: ReconcileChanges = { added: 0, updated: 0, removed: 0, reused: 0 };
	private readonly maxItemCharacters: number;
	private readonly maxTextBytes: number;
	private readonly maxItems: number;

	constructor(options: ContentIndexOptions = {}) {
		this.maxItemCharacters = boundedInteger(options.maxItemCharacters, CONTENT_LIMITS.indexCharacters, CONTENT_LIMITS.indexCharacters);
		this.maxTextBytes = boundedInteger(options.maxTextBytes, CONTENT_LIMITS.indexTextBytes, CONTENT_LIMITS.indexTextBytes);
		this.maxItems = boundedInteger(options.maxItems, CONTENT_LIMITS.indexItems, CONTENT_LIMITS.indexItems);
	}

	/** Chronological input; the newest tail gets priority. Both paths use the same transactional rules. */
	reconcile(items: readonly ContentItem[]): void {
		const transaction = this.beginTransaction(items);
		try {
			while (this.advanceTransaction(transaction)) { /* synchronous caller explicitly chose this path */ }
			this.commitTransaction(transaction);
		} finally {
			if (this.pending === transaction) this.cancelPendingReconcile();
		}
	}

	/**
	 * Build cooperatively, then publish once. Until commit, search/get/committed metrics
	 * describe the previous complete index. Input history/detail objects must be immutable.
	 * A newer reconciliation, clear(), explicit cancellation, or signal abort supersedes this job.
	 * Staging has its own capped text budget; all-changed input may transiently retain two budgets.
	 */
	async reconcileAsync(items: readonly ContentItem[], options: ContentReconcileOptions = {}): Promise<ContentReconcileResult> {
		const transaction = this.beginTransaction(items);
		const maxItems = Math.max(1, boundedInteger(options.maxItemsPerSlice, CONTENT_LIMITS.reconcileSliceItems, 250));
		const milliseconds = Math.max(1, boundedInteger(options.timeBudgetMs, CONTENT_LIMITS.reconcileSliceMilliseconds, 8));
		const now = options.now ?? (() => performance.now());
		const yieldControl = options.yieldControl ?? (() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
		const abort = (): void => { if (this.pending === transaction) this.cancelPendingReconcile(); };
		options.signal?.addEventListener("abort", abort, { once: true });
		if (options.signal?.aborted) abort();
		try {
			while (!transaction.cancelled && this.pending === transaction) {
				const started = now();
				let work = 0;
				while (!transaction.cancelled && this.pending === transaction && work < maxItems) {
					if (!this.advanceTransaction(transaction)) break;
					work += 1;
					if (now() - started >= milliseconds) break;
				}
				transaction.slices += 1;
				transaction.maxSliceItems = Math.max(transaction.maxSliceItems, work);
				options.onProgress?.(this.progress(transaction));
				if (transaction.cancelled || this.pending !== transaction) break;
				if (transaction.phase === "ready") {
					this.commitTransaction(transaction);
					const result = this.result(transaction, true);
					this.lastAsyncResult = result;
					return result;
				}
				// Cancellation does not wait for a stalled/custom scheduler to resolve.
				await Promise.race([yieldControl(), transaction.cancellation]);
			}
			return this.result(transaction, false);
		} finally {
			options.signal?.removeEventListener("abort", abort);
			if (this.pending === transaction) this.cancelPendingReconcile();
		}
	}

	/** Immediately drop staged references and wake a cancelled asynchronous waiter. */
	cancelPendingReconcile(): void {
		const transaction = this.pending;
		if (!transaction) return;
		this.pending = null;
		transaction.cancelled = true;
		transaction.entries.clear();
		transaction.reversedIds.length = 0;
		transaction.ids.length = 0;
		transaction.items = [];
		transaction.baseEntries = new Map();
		transaction.baseIds = [];
		transaction.textBytes = 0;
		this.cancelledReconciliations += 1;
		this.lastAsyncResult = this.result(transaction, false);
		transaction.wakeCancellation();
	}

	private beginTransaction(items: readonly ContentItem[]): IndexTransaction {
		this.cancelPendingReconcile();
		let wakeCancellation = (): void => {};
		const cancellation = new Promise<void>((resolve) => { wakeCancellation = resolve; });
		const windowStart = Math.max(0, items.length - this.maxItems);
		const transaction: IndexTransaction = {
			generation: ++this.generation, items, baseEntries: this.entries, baseIds: this.ids,
			entries: new Map(), reversedIds: [], ids: [], totalItems: items.length, windowStart,
			nextItem: items.length - 1, nextOrder: -1, processedItems: 0, completedWork: 0,
			slices: 0, maxSliceItems: 0, textBytes: 0, indexedItems: 0, truncatedItems: 0,
			retainedExisting: 0, orderChanged: false, phase: "indexing",
			changes: { added: 0, updated: 0, removed: 0, reused: 0 },
			cancelled: false, cancellation, wakeCancellation,
		};
		this.pending = transaction;
		return transaction;
	}

	/** One bounded item/ordering unit; expensive extraction is never hidden in final publication. */
	private advanceTransaction(transaction: IndexTransaction): boolean {
		if (transaction.cancelled || this.pending !== transaction || transaction.phase === "ready") return false;
		if (transaction.phase === "indexing" && transaction.nextItem >= transaction.windowStart) {
			const item = transaction.items[transaction.nextItem--]!;
			transaction.processedItems += 1;
			transaction.completedWork += 1;
			// Last occurrence wins for a malformed duplicate ID, consistent with newest-first retention.
			if (transaction.entries.has(item.id)) return true;
			const existing = transaction.baseEntries.get(item.id);
			const characterBudget = Math.min(this.maxItemCharacters, Math.floor((this.maxTextBytes - transaction.textBytes) / 4));
			const entry = this.entryFor(item, existing, characterBudget);
			if (existing) transaction.retainedExisting += 1;
			if (entry === existing) transaction.changes.reused += 1;
			else if (existing) transaction.changes.updated += 1;
			else transaction.changes.added += 1;
			transaction.entries.set(item.id, entry);
			transaction.reversedIds.push(item.id);
			transaction.textBytes += entry.bytes;
			if (entry.normalized) transaction.indexedItems += 1;
			if (entry.truncated) transaction.truncatedItems += 1;
			return true;
		}
		if (transaction.phase === "indexing") {
			transaction.phase = "ordering";
			transaction.nextOrder = transaction.reversedIds.length - 1;
			transaction.orderChanged = transaction.reversedIds.length !== transaction.baseIds.length;
			transaction.changes.removed = transaction.baseEntries.size - transaction.retainedExisting;
		}
		if (transaction.nextOrder >= 0) {
			const id = transaction.reversedIds[transaction.nextOrder--]!;
			if (transaction.baseIds[transaction.ids.length] !== id) transaction.orderChanged = true;
			transaction.ids.push(id);
			transaction.completedWork += 1;
			if (transaction.nextOrder < 0) transaction.phase = "ready";
			return true;
		}
		transaction.phase = "ready";
		return false;
	}

	private entryFor(item: ContentItem, existing: IndexEntry | undefined, characterBudget: number): IndexEntry {
		const signature = contentSignature(item);
		const unchanged = existing && existing.detail === item.detail && existing.signature === signature;
		if (unchanged && existing.excerpt.length <= characterBudget && existing.normalized.length <= characterBudget
			&& (!existing.capacityLimited || characterBudget <= existing.characterBudget)) return existing;
		// A smaller allowance can reuse the captured prefix. A larger allowance must fetch new text.
		const extracted = unchanged && existing.excerpt.length > characterBudget
			? { text: existing.excerpt.slice(0, characterBudget), truncated: true }
			: extractExcerpt(item, characterBudget);
		const fullNormalized = normalizeSearchText(extracted.text);
		const normalized = fullNormalized.slice(0, characterBudget);
		const truncated = extracted.truncated || fullNormalized.length > characterBudget;
		return {
			detail: item.detail, signature, content: unchanged ? existing.content : projectContent(item),
			excerpt: extracted.text, normalized, bytes: (extracted.text.length + normalized.length) * 2,
			truncated, characterBudget,
			capacityLimited: characterBudget < this.maxItemCharacters && truncated
				&& (extracted.text.length === characterBudget || fullNormalized.length > characterBudget),
		};
	}

	private commitTransaction(transaction: IndexTransaction): void {
		if (transaction.cancelled || this.pending !== transaction) return;
		const changes = transaction.changes;
		if (changes.added || changes.updated || changes.removed || transaction.orderChanged || this.totalItems !== transaction.totalItems) this.revision += 1;
		this.entries = transaction.entries;
		this.ids = transaction.ids;
		this.textBytes = transaction.textBytes;
		this.totalItems = transaction.totalItems;
		this.indexedItems = transaction.indexedItems;
		this.truncatedItems = transaction.truncatedItems;
		this.windowStart = transaction.windowStart;
		this.lastReconcile = changes;
		this.pending = null;
		transaction.items = [];
		transaction.baseEntries = new Map();
		transaction.baseIds = [];
		transaction.reversedIds.length = 0;
	}

	private progress(transaction: IndexTransaction): ContentReconcileProgress {
		return { generation: transaction.generation, processedItems: transaction.processedItems,
			totalItems: transaction.totalItems - transaction.windowStart, completedWork: transaction.completedWork,
			slices: transaction.slices, maxSliceItems: transaction.maxSliceItems, phase: transaction.phase };
	}

	private result(transaction: IndexTransaction, committed: boolean): ContentReconcileResult {
		return { committed, cancelled: !committed, generation: transaction.generation,
			processedItems: transaction.processedItems, slices: transaction.slices,
			maxSliceItems: transaction.maxSliceItems, revision: this.revision };
	}

	get(id: string): ContentProjection | undefined { return this.entries.get(id)?.content; }

	clear(): void {
		this.cancelPendingReconcile();
		const removed = this.entries.size;
		this.entries.clear();
		this.ids = [];
		this.textBytes = 0;
		this.totalItems = 0;
		this.indexedItems = 0;
		this.truncatedItems = 0;
		this.windowStart = 0;
		this.lastReconcile = { added: 0, updated: 0, removed, reused: 0 };
		this.revision += 1;
	}

	diagnostics() {
		return {
			itemCount: this.totalItems, retainedItems: this.entries.size, maxItems: this.maxItems,
			indexedItems: this.indexedItems, omittedItems: this.totalItems - this.indexedItems, truncatedItems: this.truncatedItems,
			textBytes: this.textBytes, maxTextBytes: this.maxTextBytes, maxItemCharacters: this.maxItemCharacters,
			windowPolicy: "newest-items" as const, byteAllocation: "newest-first" as const, resultOrder: "chronological" as const,
			windowStart: this.windowStart, windowEnd: this.totalItems,
			revision: this.revision, lastReconcile: { ...this.lastReconcile }, cache: getContentCacheStats(), scope: "indexed-excerpts" as const,
			indexing: this.pending !== null,
			pending: this.pending ? { ...this.progress(this.pending), stagedTextBytes: this.pending.textBytes } : null,
			cancelledReconciliations: this.cancelledReconciliations,
			lastAsyncResult: this.lastAsyncResult ? { ...this.lastAsyncResult } : null,
		};
	}

	/** Cursor is an index into this revision's history order; restart after reconcile changes revision. */
	search(query: string, options: ContentSearchOptions = {}): ContentSearchPage {
		const terms = [...new Set(normalizeSearchText(query.slice(0, CONTENT_LIMITS.queryCharacters)).split(" ").filter(Boolean))].slice(0, 16);
		const limit = boundedInteger(options.limit, CONTENT_LIMITS.searchResults, CONTENT_LIMITS.searchResults);
		const scanLimit = Math.max(1, boundedInteger(options.scanLimit, CONTENT_LIMITS.searchScanItems, 10_000));
		let cursor = boundedInteger(options.cursor, 0, this.ids.length);
		let scannedItems = 0;
		const results: ContentSearchResult[] = [];
		if (!terms.length || !limit) return { results, nextCursor: null, complete: true, scannedItems, scope: "indexed-excerpts", revision: this.revision };
		while (cursor < this.ids.length && scannedItems < scanLimit && results.length < limit) {
			const id = this.ids[cursor++]!;
			const entry = this.entries.get(id)!;
			scannedItems += 1;
			if (!entry.normalized || !terms.every((term) => entry.normalized.includes(term))) continue;
			// Use normalized offsets only with normalized excerpts; compatibility folding changes lengths.
			const match = entry.normalized.indexOf(terms[0]!);
			const start = Math.max(0, match - 60);
			const excerpt = `${start ? "…" : ""}${entry.normalized.slice(start, start + 220)}${start + 220 < entry.normalized.length ? "…" : ""}`;
			results.push({ id, content: entry.content, excerpt });
		}
		const complete = cursor >= this.ids.length;
		return { results, nextCursor: complete ? null : cursor, complete, scannedItems, scope: "indexed-excerpts", revision: this.revision };
	}
}
