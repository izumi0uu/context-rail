import type { ContextItem, ContextSnapshot } from "./snapshot.ts";

export interface HistoryItem extends ContextItem {
	order: number;
	firstSeenAt: number;
	lastSeenAt: number;
	synthetic?: boolean;
}

export interface SummaryEdge {
	from: string;
	to: string;
	kind: "summary";
}

export interface ContextTimelineSnapshot {
	revision: number;
	history: HistoryItem[];
	activeIds: string[];
	enteredIds: string[];
	retainedIds: string[];
	exitedIds: string[];
	summaryEdges: SummaryEdge[];
}

export interface ApplyTimelineOptions {
	compaction?: boolean;
}

export function emptyTimelineSnapshot(): ContextTimelineSnapshot {
	return {
		revision: 0,
		history: [],
		activeIds: [],
		enteredIds: [],
		retainedIds: [],
		exitedIds: [],
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

	apply(snapshot: ContextSnapshot, options: ApplyTimelineOptions = {}): ContextTimelineSnapshot {
		const now = snapshot.createdAt;
		const items = snapshot.items.map((item) => ({ ...item }));
		let summaryId = options.compaction
			? items.find((item) => item.kind === "memory" && !this.history.has(item.id))?.id
			: undefined;

		if (options.compaction && !summaryId) {
			summaryId = `memory-compaction-${++this.syntheticSummary}`;
			const insertionIndex = items[0]?.kind === "system" ? 1 : 0;
			items.splice(insertionIndex, 0, {
				id: summaryId,
				kind: "memory",
			});
		}

		for (const item of items) {
			const existing = this.history.get(item.id);
			if (existing) {
				existing.kind = item.kind;
				if (item.toolName) existing.toolName = item.toolName;
				else delete existing.toolName;
				existing.lastSeenAt = now;
				continue;
			}
			this.history.set(item.id, {
				...item,
				order: this.history.size,
				firstSeenAt: now,
				lastSeenAt: now,
				...(item.id === summaryId && !snapshot.items.some((entry) => entry.id === item.id)
					? { synthetic: true }
					: {}),
			});
		}

		const previous = new Set(this.activeIds);
		const nextIds = [...new Set(items.map((item) => item.id))];
		const next = new Set(nextIds);
		const enteredIds = nextIds.filter((id) => !previous.has(id));
		const retainedIds = nextIds.filter((id) => previous.has(id));
		const exitedIds = this.activeIds.filter((id) => !next.has(id));

		if (summaryId) {
			const existingEdges = new Set(this.summaryEdges.map((edge) => `${edge.from}->${edge.to}`));
			for (const from of exitedIds) {
				if (from === summaryId || this.history.get(from)?.kind === "system") continue;
				const key = `${from}->${summaryId}`;
				if (existingEdges.has(key)) continue;
				this.summaryEdges.push({ from, to: summaryId, kind: "summary" });
				existingEdges.add(key);
			}
		}

		this.activeIds = nextIds;
		this.revision += 1;
		return this.snapshot({ enteredIds, retainedIds, exitedIds });
	}

	current(): ContextTimelineSnapshot {
		return this.snapshot({ enteredIds: [], retainedIds: [...this.activeIds], exitedIds: [] });
	}

	private snapshot(diff: Pick<ContextTimelineSnapshot, "enteredIds" | "retainedIds" | "exitedIds">): ContextTimelineSnapshot {
		return {
			revision: this.revision,
			history: [...this.history.values()].map((item) => ({ ...item })),
			activeIds: [...this.activeIds],
			enteredIds: [...diff.enteredIds],
			retainedIds: [...diff.retainedIds],
			exitedIds: [...diff.exitedIds],
			summaryEdges: this.summaryEdges.map((edge) => ({ ...edge })),
		};
	}
}
