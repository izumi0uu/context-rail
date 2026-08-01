import type { ContextItem, ContextItemDetail, ContextSnapshot } from "./snapshot.ts";

export interface HistoryItem extends ContextItem {
	order: number;
	firstSeenAt: number;
	lastSeenAt: number;
	pending?: true;
	confirmedAt?: number;
	synthetic?: boolean;
	detail?: ContextItemDetail;
}

export interface SummaryEdge {
	from: string;
	to: string;
	kind: "summary";
}

export function summaryEdgeKey(edge: SummaryEdge): string {
	return JSON.stringify([edge.kind, edge.from, edge.to]);
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
}

export interface ApplyTimelineOptions {
	compaction?: boolean;
	details?: ReadonlyMap<string, ContextItemDetail>;
}

function cloneDetail(detail: ContextItemDetail): ContextItemDetail {
	return structuredClone(detail);
}

function sameDetail(left: ContextItemDetail | undefined, right: ContextItemDetail): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

export function emptyTimelineSnapshot(): ContextTimelineSnapshot {
	return {
		revision: 0,
		history: [],
		activeIds: [],
		enteredIds: [],
		retainedIds: [],
		exitedIds: [],
		observedIds: [],
		confirmedIds: [],
		pendingIds: [],
		summaryEdges: [],
	};
}

export class ContextTimeline {
	private revision = 0;
	private syntheticSummary = 0;
	private history = new Map<string, HistoryItem>();
	private activeIds: string[] = [];
	private summaryEdges: SummaryEdge[] = [];

	reset(): ContextTimelineSnapshot {
		this.revision = 0;
		this.syntheticSummary = 0;
		this.history.clear();
		this.activeIds = [];
		this.summaryEdges = [];
		return emptyTimelineSnapshot();
	}

	observe(
		item: ContextItem,
		now = Date.now(),
		detail?: ContextItemDetail,
	): ContextTimelineSnapshot {
		const existing = this.history.get(item.id);
		let changed = false;
		const observedIds: string[] = [];
		if (existing) {
			if (existing.kind !== item.kind) {
				existing.kind = item.kind;
				changed = true;
			}
			if (item.toolName && existing.toolName !== item.toolName) {
				existing.toolName = item.toolName;
				changed = true;
			} else if (!item.toolName && existing.toolName) {
				delete existing.toolName;
				changed = true;
			}
			if (detail && !sameDetail(existing.detail, detail)) {
				existing.detail = cloneDetail(detail);
				changed = true;
			}
			if (changed) existing.lastSeenAt = now;
		} else {
			this.history.set(item.id, {
				...item,
				...(detail ? { detail: cloneDetail(detail) } : {}),
				order: this.history.size,
				firstSeenAt: now,
				lastSeenAt: now,
				pending: true,
			});
			observedIds.push(item.id);
			changed = true;
		}

		if (changed) this.revision += 1;
		return this.snapshot({
			enteredIds: [],
			retainedIds: [...this.activeIds],
			exitedIds: [],
			observedIds,
			confirmedIds: [],
		});
	}

	apply(snapshot: ContextSnapshot, options: ApplyTimelineOptions = {}): ContextTimelineSnapshot {
		const now = snapshot.createdAt;
		const authoritativeItems = snapshot.items.map((item) => ({ ...item }));
		const historyItems = [...authoritativeItems];
		const previous = new Set(this.activeIds);
		const authoritativeIds = new Set(authoritativeItems.map((item) => item.id));
		const confirmedIds: string[] = [];
		let summaryId = options.compaction
			? authoritativeItems.find((item) => item.kind === "memory" && !this.history.has(item.id))?.id
			: undefined;
		let syntheticSummaryId: string | undefined;

		if (options.compaction && !summaryId) {
			summaryId = `memory-compaction-${++this.syntheticSummary}`;
			syntheticSummaryId = summaryId;
			const insertionIndex = historyItems[0]?.kind === "system" ? 1 : 0;
			historyItems.splice(insertionIndex, 0, {
				id: summaryId,
				kind: "memory",
			});
		}

		for (const item of historyItems) {
			const existing = this.history.get(item.id);
			const detail = options.details?.get(item.id);
			if (existing) {
				let changed = false;
				if (existing.pending) {
					delete existing.pending;
					existing.confirmedAt = now;
					confirmedIds.push(item.id);
					changed = true;
				}
				if (existing.kind !== item.kind) {
					existing.kind = item.kind;
					changed = true;
				}
				if (item.toolName && existing.toolName !== item.toolName) {
					existing.toolName = item.toolName;
					changed = true;
				} else if (!item.toolName && existing.toolName) {
					delete existing.toolName;
					changed = true;
				}
				if (options.details) {
					if (detail && !sameDetail(existing.detail, detail)) {
						existing.detail = cloneDetail(detail);
						changed = true;
					} else if (!detail && existing.detail) {
						delete existing.detail;
						changed = true;
					}
				}
				if (changed || (authoritativeIds.has(item.id) && !previous.has(item.id))) {
					existing.lastSeenAt = now;
				}
				continue;
			}
			this.history.set(item.id, {
				...item,
				...(detail ? { detail: cloneDetail(detail) } : {}),
				order: this.history.size,
				firstSeenAt: now,
				lastSeenAt: now,
				confirmedAt: now,
				...(item.id === syntheticSummaryId ? { synthetic: true } : {}),
			});
		}

		const nextIds = [...new Set(authoritativeItems.map((item) => item.id))];
		const next = new Set(nextIds);
		const enteredIds = nextIds.filter((id) => !previous.has(id));
		const retainedIds = nextIds.filter((id) => previous.has(id));
		const exitedIds = this.activeIds.filter((id) => !next.has(id));

		if (summaryId) {
			const existingEdges = new Set(this.summaryEdges.map(summaryEdgeKey));
			for (const from of exitedIds) {
				if (from === summaryId || this.history.get(from)?.kind === "system") continue;
				const edge: SummaryEdge = { from, to: summaryId, kind: "summary" };
				const key = summaryEdgeKey(edge);
				if (existingEdges.has(key)) continue;
				this.summaryEdges.push(edge);
				existingEdges.add(key);
			}
		}

		this.activeIds = nextIds;
		this.revision += 1;
		return this.snapshot({
			enteredIds,
			retainedIds,
			exitedIds,
			observedIds: [],
			confirmedIds,
		});
	}

	current(): ContextTimelineSnapshot {
		return this.snapshot({
			enteredIds: [],
			retainedIds: [...this.activeIds],
			exitedIds: [],
			observedIds: [],
			confirmedIds: [],
		});
	}

	private snapshot(
		diff: Pick<
			ContextTimelineSnapshot,
			"enteredIds" | "retainedIds" | "exitedIds" | "observedIds" | "confirmedIds"
		>,
	): ContextTimelineSnapshot {
		return {
			revision: this.revision,
			history: [...this.history.values()].map((item) => ({
				...item,
				...(item.detail ? { detail: cloneDetail(item.detail) } : {}),
			})),
			activeIds: [...this.activeIds],
			enteredIds: [...diff.enteredIds],
			retainedIds: [...diff.retainedIds],
			exitedIds: [...diff.exitedIds],
			observedIds: [...diff.observedIds],
			confirmedIds: [...diff.confirmedIds],
			pendingIds: [...this.history.values()].filter((item) => item.pending).map((item) => item.id),
			summaryEdges: this.summaryEdges.map((edge) => ({ ...edge })),
		};
	}
}
