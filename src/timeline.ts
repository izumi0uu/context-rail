import type { ContextItem, ContextItemDetail, ContextSnapshot } from "./snapshot.ts";
import { projectItemDetail, projectTimeline } from "./hub-schema.ts";
import { freezeJson, sameJsonValue } from "./immutable-state.ts";

export interface HistoryItem extends ContextItem {
	order: number;
	firstSeenAt: number;
	lastSeenAt: number;
	pending?: true;
	confirmedAt?: number;
	synthetic?: boolean;
	detail?: ContextItemDetail;
}

export interface SummaryEdge { from: string; to: string; kind: "summary" }

export function summaryEdgeKey(edge: SummaryEdge): string {
	return JSON.stringify([edge.kind, edge.from, edge.to]);
}

/** Retention concerns the serialized history records and provenance edges, not
 * active context, capture archives, transport envelopes, or exact heap usage.
 */
export interface ContextTimelineRetention {
	maxItems: number;
	maxBytes: number;
	retainedItems: number;
	retainedBytes: number;
	pinnedItems: number;
	pinnedBytes: number;
	evictedItems: number;
	evictedBytes: number;
	overBudget: boolean;
}

export interface ContextTimelineSnapshot {
	revision: number;
	history: HistoryItem[];
	activeIds: string[];
	enteredIds: string[];
	retainedIds: string[];
	exitedIds: string[];
	observedIds: string[];
	confirmedIds: string[];
	pendingIds: string[];
	summaryEdges: SummaryEdge[];
	retention?: ContextTimelineRetention;
}

export interface ContextTimelineOptions { maxItems?: number; maxBytes?: number }
export interface ApplyTimelineOptions { compaction?: boolean; details?: ReadonlyMap<string, ContextItemDetail> }

type TimelineDiff = Pick<ContextTimelineSnapshot, "enteredIds" | "retainedIds" | "exitedIds" | "observedIds" | "confirmedIds">;
const PAYLOAD_ENVELOPE_BYTES = Buffer.byteLength(JSON.stringify({ history: [], summaryEdges: [] }));
const detailBytes = new WeakMap<ContextItemDetail, number>();

function jsonBytes(value: unknown): number { return Buffer.byteLength(JSON.stringify(value)); }

function itemBytes(item: HistoryItem): number {
	const { detail, ...metadata } = item;
	if (!detail) return jsonBytes(metadata);
	let size = detailBytes.get(detail);
	if (size === undefined) { size = jsonBytes(detail); detailBytes.set(detail, size); }
	return jsonBytes(metadata) + 10 + size; // ,"detail": plus its serialized value
}

function payloadBytes(itemCount: number, itemTotal: number, edgeCount: number, edgeTotal: number): number {
	return PAYLOAD_ENVELOPE_BYTES + itemTotal + Math.max(0, itemCount - 1) + edgeTotal + Math.max(0, edgeCount - 1);
}

function limit(value: number | undefined, fallback: number): number {
	return Number.isFinite(value) ? Math.max(0, Math.floor(value!)) : fallback;
}

function reuseArray<T>(previous: T[] | undefined, next: T[]): T[] {
	return previous?.length === next.length && next.every((value, index) => value === previous[index])
		? previous : freezeJson(next);
}

function itemMetadata(item: ContextItem): ContextItem {
	return { id: item.id, kind: item.kind, ...(item.toolName ? { toolName: item.toolName } : {}) };
}

function immutableDetail(detail: ContextItemDetail | undefined, previous?: ContextItemDetail): ContextItemDetail | undefined {
	if (!detail) return undefined;
	const projected = projectItemDetail(detail, "timeline.detail");
	return sameJsonValue(previous, projected) ? previous : freezeJson(projected);
}

export function emptyTimelineSnapshot(): ContextTimelineSnapshot {
	return { revision: 0, history: [], activeIds: [], enteredIds: [], retainedIds: [], exitedIds: [], observedIds: [], confirmedIds: [], pendingIds: [], summaryEdges: [] };
}

/** All externally visible objects are immutable. New snapshots replace changed
 * records and share unchanged records/details/arrays instead of cloning bodies.
 */
export class ContextTimeline {
	private readonly maxItems: number;
	private readonly maxBytes: number;
	private revision = 0;
	private nextOrder = 0;
	private syntheticSummary = 0;
	private history = new Map<string, HistoryItem>();
	private recordBytes = new Map<string, number>();
	private historyBytes = 0;
	private historyDirty = true;
	private historyArray: HistoryItem[] = freezeJson([]);
	private activeIds: string[] = freezeJson([]);
	private edges = new Map<string, SummaryEdge>();
	private edgeBytes = new Map<string, number>();
	private incidentEdges = new Map<string, Set<string>>();
	private totalEdgeBytes = 0;
	private edgesDirty = true;
	private edgeArray: SummaryEdge[] = freezeJson([]);
	private evictedItems = 0;
	private evictedBytes = 0;
	private retention: ContextTimelineRetention | undefined;
	private lastSnapshot: ContextTimelineSnapshot | undefined;

	constructor(options: ContextTimelineOptions = {}) {
		this.maxItems = limit(options.maxItems, 2_000);
		this.maxBytes = limit(options.maxBytes, 16 * 1024 * 1024);
	}

	matchesOptions(options: ContextTimelineOptions = {}): boolean {
		return this.maxItems === limit(options.maxItems, 2_000) && this.maxBytes === limit(options.maxBytes, 16 * 1024 * 1024);
	}

	/** Upgrade a cached Pi runtime without discarding retained provenance. This
	 * is an in-memory handoff, not a persistence/import or historical replay API.
	 */
	static fromSnapshot(snapshot: ContextTimelineSnapshot, options: ContextTimelineOptions = {}, previous?: ContextTimeline): ContextTimeline {
		const restored = new ContextTimeline(options);
		const projected = projectTimeline(snapshot, "timeline.restore");
		restored.revision = projected.revision;
		restored.evictedItems = projected.retention?.evictedItems ?? 0;
		restored.evictedBytes = projected.retention?.evictedBytes ?? 0;
		for (const item of [...projected.history].sort((left, right) => left.order - right.order)) {
			restored.setItem(item);
			restored.nextOrder = Math.max(restored.nextOrder, item.order + 1);
			if (item.synthetic) {
				const suffix = /^memory-compaction-(\d+)$/.exec(item.id)?.[1];
				if (suffix && Number.isSafeInteger(Number(suffix))) restored.syntheticSummary = Math.max(restored.syntheticSummary, Number(suffix));
			}
		}
		// Legacy implementations used ordinary private fields, so these optional
		// counters can survive code reloads even when their prototypes are old.
		if (Number.isSafeInteger(previous?.nextOrder)) restored.nextOrder = Math.max(restored.nextOrder, previous!.nextOrder);
		if (Number.isSafeInteger(previous?.syntheticSummary)) restored.syntheticSummary = Math.max(restored.syntheticSummary, previous!.syntheticSummary);
		restored.nextOrder = Math.max(restored.nextOrder, restored.evictedItems + restored.history.size);
		restored.activeIds = freezeJson([...projected.activeIds]);
		for (const edge of projected.summaryEdges) {
			if (restored.history.has(edge.from) && restored.history.has(edge.to)) restored.addEdge(edge);
		}
		restored.current();
		return restored;
	}

	reset(): ContextTimelineSnapshot {
		this.revision = 0;
		this.nextOrder = 0;
		this.syntheticSummary = 0;
		this.history.clear(); this.recordBytes.clear(); this.historyBytes = 0; this.historyDirty = true;
		this.activeIds = freezeJson([]);
		this.edges.clear(); this.edgeBytes.clear(); this.incidentEdges.clear(); this.totalEdgeBytes = 0; this.edgesDirty = true;
		this.evictedItems = 0; this.evictedBytes = 0;
		return this.current();
	}

	observe(item: ContextItem, now = Date.now(), detail?: ContextItemDetail): ContextTimelineSnapshot {
		const existing = this.history.get(item.id);
		const observedIds: string[] = [];
		const nextDetail = detail ? immutableDetail(detail, existing?.detail) : existing?.detail;
		if (existing) {
			const metadata = itemMetadata(item);
			if (existing.kind !== metadata.kind || existing.toolName !== metadata.toolName || nextDetail !== existing.detail) {
				const { toolName: _toolName, detail: _detail, ...retained } = existing;
				this.setItem({ ...retained, ...metadata, ...(nextDetail ? { detail: nextDetail } : {}), lastSeenAt: now });
				this.revision += 1;
			}
		} else {
			this.setItem({ ...itemMetadata(item), ...(nextDetail ? { detail: nextDetail } : {}), order: this.nextOrder++, firstSeenAt: now, lastSeenAt: now, pending: true });
			observedIds.push(item.id);
			this.revision += 1;
		}
		return this.snapshot({ enteredIds: [], retainedIds: this.activeIds, exitedIds: [], observedIds, confirmedIds: [] });
	}

	apply(snapshot: ContextSnapshot, options: ApplyTimelineOptions = {}): ContextTimelineSnapshot {
		const now = snapshot.createdAt;
		const historyItems = snapshot.items.map(itemMetadata);
		const previous = new Set(this.activeIds);
		const authoritativeIds = new Set(snapshot.items.map((item) => item.id));
		const confirmedIds: string[] = [];
		let summaryId = options.compaction ? historyItems.find((item) => item.kind === "memory" && !this.history.has(item.id))?.id : undefined;
		let syntheticSummaryId: string | undefined;
		if (options.compaction && !summaryId) {
			do { summaryId = `memory-compaction-${++this.syntheticSummary}`; }
			while (this.history.has(summaryId) || authoritativeIds.has(summaryId));
			syntheticSummaryId = summaryId;
			historyItems.splice(historyItems[0]?.kind === "system" ? 1 : 0, 0, { id: summaryId, kind: "memory" });
		}

		for (const item of historyItems) {
			const existing = this.history.get(item.id);
			const detail = options.details ? immutableDetail(options.details.get(item.id), existing?.detail) : existing?.detail;
			if (existing) {
				const changed = existing.pending || existing.kind !== item.kind || existing.toolName !== item.toolName || existing.detail !== detail;
				if (existing.pending) confirmedIds.push(item.id);
				if (changed || (authoritativeIds.has(item.id) && !previous.has(item.id))) {
					const { toolName: _toolName, detail: _detail, pending: _pending, ...retained } = existing;
					this.setItem({ ...retained, ...item, ...(detail ? { detail } : {}), ...(existing.pending ? { confirmedAt: now } : {}), lastSeenAt: now });
				}
			} else {
				this.setItem({ ...item, ...(detail ? { detail } : {}), order: this.nextOrder++, firstSeenAt: now, lastSeenAt: now, confirmedAt: now, ...(item.id === syntheticSummaryId ? { synthetic: true } : {}) });
			}
		}

		const nextIds = [...authoritativeIds];
		const enteredIds = nextIds.filter((id) => !previous.has(id));
		const retainedIds = nextIds.filter((id) => previous.has(id));
		const exitedIds = this.activeIds.filter((id) => !authoritativeIds.has(id));
		if (summaryId) {
			for (const from of exitedIds) {
				if (from !== summaryId && this.history.get(from)?.kind !== "system") this.addEdge({ from, to: summaryId, kind: "summary" });
			}
		}
		this.activeIds = reuseArray(this.activeIds, nextIds);
		this.revision += 1;
		return this.snapshot({ enteredIds, retainedIds, exitedIds, observedIds: [], confirmedIds });
	}

	current(): ContextTimelineSnapshot {
		return this.snapshot({ enteredIds: [], retainedIds: this.activeIds, exitedIds: [], observedIds: [], confirmedIds: [] });
	}

	private setItem(item: HistoryItem): void {
		const bytes = itemBytes(item);
		this.historyBytes += bytes - (this.recordBytes.get(item.id) ?? 0);
		this.recordBytes.set(item.id, bytes);
		this.history.set(item.id, freezeJson(item));
		this.historyDirty = true;
	}

	private addEdge(edge: SummaryEdge): void {
		const key = summaryEdgeKey(edge);
		if (this.edges.has(key)) return;
		this.edges.set(key, freezeJson(edge));
		const size = jsonBytes(edge);
		this.edgeBytes.set(key, size); this.totalEdgeBytes += size; this.edgesDirty = true;
		for (const id of [edge.from, edge.to]) {
			const keys = this.incidentEdges.get(id) ?? new Set();
			keys.add(key); this.incidentEdges.set(id, keys);
		}
	}

	private retainedBytes(): number {
		return payloadBytes(this.history.size, this.historyBytes, this.edges.size, this.totalEdgeBytes);
	}

	private removeItem(id: string): void {
		const before = this.retainedBytes();
		this.historyBytes -= this.recordBytes.get(id)!;
		this.recordBytes.delete(id); this.history.delete(id); this.historyDirty = true;
		for (const key of this.incidentEdges.get(id) ?? []) {
			const edge = this.edges.get(key)!;
			this.totalEdgeBytes -= this.edgeBytes.get(key)!;
			this.edgeBytes.delete(key); this.edges.delete(key); this.edgesDirty = true;
			const otherId = edge.from === id ? edge.to : edge.from;
			const other = this.incidentEdges.get(otherId);
			other?.delete(key);
			if (other?.size === 0) this.incidentEdges.delete(otherId);
		}
		this.incidentEdges.delete(id);
		this.evictedItems += 1; this.evictedBytes += before - this.retainedBytes();
	}

	private enforceRetention(): ContextTimelineRetention {
		const pinned = new Set(this.activeIds);
		for (const item of this.history.values()) if (item.pending) pinned.add(item.id);
		for (const item of this.history.values()) {
			if (this.history.size <= this.maxItems && this.retainedBytes() <= this.maxBytes) break;
			if (!pinned.has(item.id)) this.removeItem(item.id);
		}
		let pinnedBytes = 0;
		for (const id of pinned) pinnedBytes += this.recordBytes.get(id) ?? 0;
		let pinnedEdgeCount = 0, pinnedEdgeBytes = 0;
		for (const [key, edge] of this.edges) {
			if (pinned.has(edge.from) && pinned.has(edge.to)) { pinnedEdgeCount += 1; pinnedEdgeBytes += this.edgeBytes.get(key)!; }
		}
		const retention: ContextTimelineRetention = {
			maxItems: this.maxItems, maxBytes: this.maxBytes,
			retainedItems: this.history.size, retainedBytes: this.retainedBytes(),
			pinnedItems: pinned.size, pinnedBytes: payloadBytes(pinned.size, pinnedBytes, pinnedEdgeCount, pinnedEdgeBytes),
			evictedItems: this.evictedItems, evictedBytes: this.evictedBytes,
			overBudget: this.history.size > this.maxItems || this.retainedBytes() > this.maxBytes,
		};
		if (sameJsonValue(retention, this.retention)) return this.retention!;
		this.retention = freezeJson(retention);
		return this.retention;
	}

	private snapshot(diff: TimelineDiff): ContextTimelineSnapshot {
		const retention = this.enforceRetention();
		if (this.historyDirty) { this.historyArray = freezeJson([...this.history.values()]); this.historyDirty = false; }
		if (this.edgesDirty) { this.edgeArray = freezeJson([...this.edges.values()]); this.edgesDirty = false; }
		const before = this.lastSnapshot;
		const next: ContextTimelineSnapshot = {
			revision: this.revision, history: this.historyArray, activeIds: this.activeIds,
			enteredIds: reuseArray(before?.enteredIds, diff.enteredIds),
			retainedIds: reuseArray(before?.retainedIds, diff.retainedIds),
			exitedIds: reuseArray(before?.exitedIds, diff.exitedIds),
			observedIds: reuseArray(before?.observedIds, diff.observedIds),
			confirmedIds: reuseArray(before?.confirmedIds, diff.confirmedIds),
			pendingIds: reuseArray(before?.pendingIds, this.historyArray.filter((item) => item.pending).map((item) => item.id)),
			summaryEdges: this.edgeArray, retention,
		};
		if (before && Object.keys(next).every((key) => next[key as keyof ContextTimelineSnapshot] === before[key as keyof ContextTimelineSnapshot])) return before;
		this.lastSnapshot = freezeJson(next);
		return this.lastSnapshot;
	}
}
