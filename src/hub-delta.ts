import type { RenderState } from "./render.ts";
import { projectRenderStatePatch } from "./hub-schema.ts";
import type { ContextSnapshot } from "./snapshot.ts";
import {
	emptyTimelineSnapshot,
	summaryEdgeKey,
	type HistoryItem,
	type SummaryEdge,
} from "./timeline.ts";

export interface ContextTimelinePatch {
	reset?: boolean;
	revision?: number;
	historyUpserts?: HistoryItem[];
	activeIds?: string[];
	enteredIds?: string[];
	retainedIds?: string[];
	exitedIds?: string[];
	observedIds?: string[];
	confirmedIds?: string[];
	pendingIds?: string[];
	summaryEdgeUpserts?: SummaryEdge[];
}

export interface RenderStatePatch {
	reset?: boolean;
	snapshot?: ContextSnapshot | null;
	phase?: RenderState["phase"];
	activeTools?: string[];
	timeline?: ContextTimelinePatch | null;
}

export interface ChunkedRenderStatePatch {
	index: number;
	data: string;
	complete: boolean;
}

function sameValue(left: unknown, right: unknown): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

function unchangedHistoryItem(previous: HistoryItem | undefined, next: HistoryItem): boolean {
	if (!previous) return false;
	if (
		previous.lastSeenAt !== next.lastSeenAt ||
		previous.pending !== next.pending ||
		previous.confirmedAt !== next.confirmedAt
	) return false;
	return sameValue(previous, next);
}

function requiresTimelineReset(previous: RenderState["timeline"], next: NonNullable<RenderState["timeline"]>): boolean {
	if (!previous) return true;
	if (next.revision < previous.revision || next.history.length < previous.history.length) return true;
	const nextIds = new Set(next.history.map((item) => item.id));
	if (previous.history.some((item) => !nextIds.has(item.id))) return true;
	const nextEdgeKeys = new Set(next.summaryEdges.map(summaryEdgeKey));
	return previous.summaryEdges.some((edge) => !nextEdgeKeys.has(summaryEdgeKey(edge)));
}

export function diffRenderState(previous: RenderState | undefined, next: RenderState): RenderStatePatch {
	const reset = previous === undefined;
	const patch: RenderStatePatch = {
		...(reset ? { reset: true } : {}),
		snapshot: next.snapshot ? structuredClone(next.snapshot) : null,
		phase: next.phase,
		activeTools: [...next.activeTools],
	};

	if (!next.timeline) {
		patch.timeline = null;
		return patch;
	}

	const timelineReset = requiresTimelineReset(previous?.timeline, next.timeline);
	const previousHistory = new Map(previous?.timeline?.history.map((item) => [item.id, item]) ?? []);
	const previousEdges = new Map(
		previous?.timeline?.summaryEdges.map((edge) => [summaryEdgeKey(edge), edge]) ?? [],
	);
	const historyUpserts = timelineReset
		? next.timeline.history
		: next.timeline.history.filter((item) => !unchangedHistoryItem(previousHistory.get(item.id), item));
	const summaryEdgeUpserts = timelineReset
		? next.timeline.summaryEdges
		: next.timeline.summaryEdges.filter(
			(edge) => !sameValue(previousEdges.get(summaryEdgeKey(edge)), edge),
		);

	patch.timeline = {
		...(timelineReset ? { reset: true } : {}),
		revision: next.timeline.revision,
		...(historyUpserts.length > 0 ? { historyUpserts: structuredClone(historyUpserts) } : {}),
		activeIds: [...next.timeline.activeIds],
		enteredIds: [...next.timeline.enteredIds],
		retainedIds: [...next.timeline.retainedIds],
		exitedIds: [...next.timeline.exitedIds],
		observedIds: [...next.timeline.observedIds],
		confirmedIds: [...next.timeline.confirmedIds],
		pendingIds: [...next.timeline.pendingIds],
		...(summaryEdgeUpserts.length > 0 ? { summaryEdgeUpserts: structuredClone(summaryEdgeUpserts) } : {}),
	};
	return patch;
}

export function applyRenderStatePatch(previous: RenderState | undefined, patch: RenderStatePatch): RenderState {
	const state: RenderState = patch.reset || !previous
		? { snapshot: undefined, phase: "idle", activeTools: [], timeline: emptyTimelineSnapshot() }
		: { ...previous };

	if ("snapshot" in patch) {
		state.snapshot = patch.snapshot ? structuredClone(patch.snapshot) : undefined;
	}
	if (patch.phase) state.phase = patch.phase;
	if (patch.activeTools) state.activeTools = [...patch.activeTools];
	if (patch.timeline === null) {
		delete state.timeline;
		return state;
	}
	if (!patch.timeline) return state;

	const timeline = patch.timeline.reset || !state.timeline
		? emptyTimelineSnapshot()
		: { ...state.timeline };
	const historyUpserts = patch.timeline.historyUpserts ?? [];
	if (historyUpserts.length > 0) {
		const history = new Map(timeline.history.map((item) => [item.id, item]));
		for (const item of historyUpserts) history.set(item.id, structuredClone(item));
		timeline.history = [...history.values()].sort((left, right) => left.order - right.order);
	}

	const summaryEdgeUpserts = patch.timeline.summaryEdgeUpserts ?? [];
	if (summaryEdgeUpserts.length > 0) {
		const edges = new Map(
			timeline.summaryEdges.map((edge) => [summaryEdgeKey(edge), edge]),
		);
		for (const edge of summaryEdgeUpserts) {
			edges.set(summaryEdgeKey(edge), structuredClone(edge));
		}
		timeline.summaryEdges = [...edges.values()];
	}

	if (patch.timeline.revision !== undefined) timeline.revision = patch.timeline.revision;
	for (const key of [
		"activeIds",
		"enteredIds",
		"retainedIds",
		"exitedIds",
		"observedIds",
		"confirmedIds",
		"pendingIds",
	] as const) {
		const value = patch.timeline[key];
		if (value) timeline[key] = [...value];
	}
	state.timeline = timeline;
	return state;
}

export function chunkRenderStatePatch(
	patch: RenderStatePatch,
	maxBytes = 256 * 1024,
): ChunkedRenderStatePatch[] {
	if (!Number.isFinite(maxBytes) || maxBytes < 4) {
		throw new RangeError("maxBytes must be at least four");
	}
	const encoded = Buffer.from(JSON.stringify(patch), "utf8");
	const rawChunkBytes = Math.max(1, Math.floor(maxBytes / 4) * 3);
	const chunks: ChunkedRenderStatePatch[] = [];
	for (let offset = 0, index = 0; offset < encoded.length; offset += rawChunkBytes, index += 1) {
		const data = encoded.subarray(offset, offset + rawChunkBytes).toString("base64");
		chunks.push({ index, data, complete: offset + rawChunkBytes >= encoded.length });
	}
	return chunks;
}

export function decodeRenderStatePatchChunks(
	chunks: readonly Pick<ChunkedRenderStatePatch, "data">[],
): RenderStatePatch {
	if (chunks.length === 0) throw new Error("Render state patch has no chunks");
	const buffers = chunks.map(({ data }) => {
		if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) {
			throw new Error("Render state patch contains invalid base64");
		}
		return Buffer.from(data, "base64");
	});
	const value: unknown = JSON.parse(Buffer.concat(buffers).toString("utf8"));
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Render state patch must be an object");
	}
	return projectRenderStatePatch(value);
}
