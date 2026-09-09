import type { RenderState } from "./render.ts";
import { emptyCaptureArchive, type ContextCaptureEntry, type ContextCaptureVersion } from "./context-captures.ts";
import { projectRenderStatePatch } from "./hub-schema.ts";
import type { ContextSnapshot } from "./snapshot.ts";
import { immutableCopy, sameJsonValue } from "./immutable-state.ts";
import {
	emptyTimelineSnapshot,
	summaryEdgeKey,
	type HistoryItem,
	type SummaryEdge,
	type ContextTimelineRetention,
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
	removedHistoryIds?: string[];
	removedSummaryEdges?: SummaryEdge[];
	retention?: ContextTimelineRetention | null;
}

export interface ContextCaptureArchivePatch {
	reset?: boolean;
	revision?: number;
	entryUpserts?: ContextCaptureEntry[];
	versionUpserts?: ContextCaptureVersion[];
	removedEntryIds?: string[];
	removedVersionIds?: string[];
}

export interface RenderStatePatch {
	reset?: boolean;
	snapshot?: ContextSnapshot | null;
	phase?: RenderState["phase"];
	activeTools?: string[];
	timeline?: ContextTimelinePatch | null;
	captures?: ContextCaptureArchivePatch | null;
}

export interface ChunkedRenderStatePatch {
	index: number;
	data: string;
	complete: boolean;
}

function sameValue(left: unknown, right: unknown): boolean {
	return sameJsonValue(left, right);
}

function unchangedHistoryItem(previous: HistoryItem | undefined, next: HistoryItem): boolean {
	if (previous === next) return true;
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
	if (next.revision < previous.revision) return true;
	// Managed retention has explicit deletion patches, so eviction does not
	// resend every retained multi-megabyte history record.
	if (next.retention) return false;
	if (next.history.length < previous.history.length) return true;
	const nextIds = new Set(next.history.map((item) => item.id));
	if (previous.history.some((item) => !nextIds.has(item.id))) return true;
	const nextEdgeKeys = new Set(next.summaryEdges.map(summaryEdgeKey));
	return previous.summaryEdges.some((edge) => !nextEdgeKeys.has(summaryEdgeKey(edge)));
}

export function diffRenderState(previous: RenderState | undefined, next: RenderState): RenderStatePatch {
	const reset = previous === undefined;
	const patch: RenderStatePatch = {
		...(reset ? { reset: true } : {}),
		snapshot: next.snapshot ? immutableCopy(next.snapshot) : null,
		phase: next.phase,
		activeTools: [...next.activeTools],
	};
	if (!next.captures) {
		if (previous?.captures) patch.captures = null;
	} else if (next.captures !== previous?.captures) {
		const before = previous?.captures;
		const archiveReset = !before || next.captures.revision < before.revision;
		const previousEntries = new Set(archiveReset ? [] : before.entries.map((entry) => entry.id));
		const previousVersions = new Set(archiveReset ? [] : before.versions.map((version) => version.versionId));
		const nextEntries = new Set(next.captures.entries.map((entry) => entry.id));
		const nextVersions = new Set(next.captures.versions.map((version) => version.versionId));
		const entryUpserts = next.captures.entries.filter((entry) => !previousEntries.has(entry.id));
		const versionUpserts = next.captures.versions.filter((version) => !previousVersions.has(version.versionId));
		const removedEntryIds = [...previousEntries].filter((id) => !nextEntries.has(id));
		const removedVersionIds = [...previousVersions].filter((id) => !nextVersions.has(id));
		if (archiveReset || before.revision !== next.captures.revision || entryUpserts.length || versionUpserts.length || removedEntryIds.length || removedVersionIds.length) {
			patch.captures = {
				...(archiveReset ? { reset: true } : {}), revision: next.captures.revision,
				...(entryUpserts.length ? { entryUpserts } : {}),
				...(versionUpserts.length ? { versionUpserts } : {}),
				...(removedEntryIds.length ? { removedEntryIds } : {}),
				...(removedVersionIds.length ? { removedVersionIds } : {}),
			};
		}
	}

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
	const nextIds = new Set(next.timeline.history.map((item) => item.id));
	const nextEdgeKeys = new Set(next.timeline.summaryEdges.map(summaryEdgeKey));
	const removedHistoryIds = timelineReset ? [] : [...previousHistory.keys()].filter((id) => !nextIds.has(id));
	const removedSummaryEdges = timelineReset ? [] : [...previousEdges].filter(([key]) => !nextEdgeKeys.has(key)).map(([, edge]) => edge);

	patch.timeline = {
		...(timelineReset ? { reset: true } : {}),
		revision: next.timeline.revision,
		...(historyUpserts.length > 0 ? { historyUpserts: historyUpserts.map(immutableCopy) } : {}),
		...(removedHistoryIds.length ? { removedHistoryIds } : {}),
		...(removedSummaryEdges.length ? { removedSummaryEdges: removedSummaryEdges.map(immutableCopy) } : {}),
		activeIds: [...next.timeline.activeIds],
		enteredIds: [...next.timeline.enteredIds],
		retainedIds: [...next.timeline.retainedIds],
		exitedIds: [...next.timeline.exitedIds],
		observedIds: [...next.timeline.observedIds],
		confirmedIds: [...next.timeline.confirmedIds],
		pendingIds: [...next.timeline.pendingIds],
		...(summaryEdgeUpserts.length > 0 ? { summaryEdgeUpserts: summaryEdgeUpserts.map(immutableCopy) } : {}),
		...(next.timeline.retention ? { retention: immutableCopy(next.timeline.retention) }
			: previous?.timeline?.retention ? { retention: null } : {}),
	};
	return patch;
}

export function applyRenderStatePatch(previous: RenderState | undefined, patch: RenderStatePatch): RenderState {
	const state: RenderState = patch.reset || !previous
		? { snapshot: undefined, phase: "idle", activeTools: [], timeline: emptyTimelineSnapshot() }
		: { ...previous };

	if ("snapshot" in patch) {
		state.snapshot = patch.snapshot ? immutableCopy(patch.snapshot) : undefined;
	}
	if (patch.phase) state.phase = patch.phase;
	if (patch.activeTools) state.activeTools = [...patch.activeTools];
	// Captures are independent of timeline presence; do not skip this update when
	// a capture-only viewer or older producer omits/removes the timeline.
	if (patch.captures === null) delete state.captures;
	else if (patch.captures) {
		const archive = patch.captures.reset || !state.captures ? emptyCaptureArchive() : state.captures;
		const entries = new Map(archive.entries.map((entry) => [entry.id, entry]));
		const versions = new Map(archive.versions.map((version) => [version.versionId, version]));
		for (const id of patch.captures.removedEntryIds ?? []) entries.delete(id);
		for (const id of patch.captures.removedVersionIds ?? []) versions.delete(id);
		for (const entry of patch.captures.entryUpserts ?? []) entries.set(entry.id, immutableCopy(entry));
		for (const version of patch.captures.versionUpserts ?? []) versions.set(version.versionId, immutableCopy(version));
		state.captures = {
			revision: patch.captures.revision ?? archive.revision,
			entries: [...entries.values()], versions: [...versions.values()],
		};
	}
	if (patch.timeline === null) {
		delete state.timeline;
		return state;
	}
	if (!patch.timeline) return state;

	const timeline = patch.timeline.reset || !state.timeline
		? emptyTimelineSnapshot()
		: { ...state.timeline };
	const historyUpserts = patch.timeline.historyUpserts ?? [];
	if (historyUpserts.length > 0 || patch.timeline.removedHistoryIds?.length) {
		const history = new Map(timeline.history.map((item) => [item.id, item]));
		for (const id of patch.timeline.removedHistoryIds ?? []) history.delete(id);
		for (const item of historyUpserts) history.set(item.id, immutableCopy(item));
		timeline.history = [...history.values()].sort((left, right) => left.order - right.order);
	}

	const summaryEdgeUpserts = patch.timeline.summaryEdgeUpserts ?? [];
	if (summaryEdgeUpserts.length > 0 || patch.timeline.removedSummaryEdges?.length) {
		const edges = new Map(
			timeline.summaryEdges.map((edge) => [summaryEdgeKey(edge), edge]),
		);
		for (const edge of patch.timeline.removedSummaryEdges ?? []) edges.delete(summaryEdgeKey(edge));
		for (const edge of summaryEdgeUpserts) {
			edges.set(summaryEdgeKey(edge), immutableCopy(edge));
		}
		timeline.summaryEdges = [...edges.values()];
	}

	if (patch.timeline.revision !== undefined) timeline.revision = patch.timeline.revision;
	if (patch.timeline.retention === null) delete timeline.retention;
	else if (patch.timeline.retention) timeline.retention = immutableCopy(patch.timeline.retention);
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
