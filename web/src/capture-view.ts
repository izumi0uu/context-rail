import type { ContextCaptureArchivePatch } from "../../src/hub-delta.ts";
import type {
	ContextCaptureArchiveSnapshot,
	ContextCaptureEntry,
	ContextCaptureVersion,
} from "../../src/context-captures.ts";
import type { RenderState } from "../../src/render.ts";
import type { HistoryItem } from "../../src/timeline.ts";

export function applyCaptureArchivePatch(
	previous: ContextCaptureArchiveSnapshot | undefined,
	patch: ContextCaptureArchivePatch | null,
): ContextCaptureArchiveSnapshot | undefined {
	if (patch === null) return undefined;
	const base = patch.reset || !previous ? { revision: 0, entries: [], versions: [] } : previous;
	const entries = new Map(base.entries.map((entry) => [entry.id, entry]));
	const versions = new Map(base.versions.map((version) => [version.versionId, version]));
	for (const id of patch.removedEntryIds ?? []) entries.delete(id);
	for (const id of patch.removedVersionIds ?? []) versions.delete(id);
	for (const entry of patch.entryUpserts ?? []) entries.set(entry.id, entry);
	for (const version of patch.versionUpserts ?? []) versions.set(version.versionId, version);
	return { revision: patch.revision ?? base.revision, entries: [...entries.values()], versions: [...versions.values()] };
}

export function resolveCaptureItems(
	archive: ContextCaptureArchiveSnapshot,
	entry: ContextCaptureEntry,
): HistoryItem[] | undefined {
	if (entry.contentStatus !== "available") return undefined;
	const versions = new Map(archive.versions.map((version) => [version.versionId, version]));
	const result: HistoryItem[] = [];
	for (const ref of entry.itemRefs) {
		const version = versions.get(ref.versionId);
		if (!version || version.id !== ref.itemId) return undefined;
		result.push({
			id: version.id,
			kind: version.kind,
			...(version.toolName ? { toolName: version.toolName } : {}),
			...(version.detail ? { detail: version.detail } : {}),
			order: result.length,
			firstSeenAt: entry.capturedAt,
			lastSeenAt: entry.capturedAt,
			confirmedAt: entry.capturedAt,
		});
	}
	return result;
}

export function captureRenderState(archive: ContextCaptureArchiveSnapshot, entry: ContextCaptureEntry): RenderState {
	const items = resolveCaptureItems(archive, entry) ?? [];
	const activeIds = items.map((item) => item.id);
	return {
		snapshot: entry.snapshot,
		phase: "context",
		activeTools: [],
		timeline: {
			revision: 0, history: items, activeIds,
			enteredIds: [], retainedIds: activeIds, exitedIds: [],
			observedIds: [], confirmedIds: [], pendingIds: [], summaryEdges: [],
		},
	};
}

export interface CaptureChange {
	id: string;
	status: "entered" | "exited" | "changed";
	before?: ContextCaptureVersion;
	after?: ContextCaptureVersion;
}

export function compareCaptures(
	archive: ContextCaptureArchiveSnapshot,
	before: ContextCaptureEntry | undefined,
	after: ContextCaptureEntry | undefined,
): CaptureChange[] | undefined {
	if (!before || !after || before.contentStatus !== "available" || after.contentStatus !== "available") return undefined;
	const versions = new Map(archive.versions.map((version) => [version.versionId, version]));
	const oldRefs = new Map(before.itemRefs.map((ref) => [ref.itemId, ref.versionId]));
	const newRefs = new Map(after.itemRefs.map((ref) => [ref.itemId, ref.versionId]));
	const changes: CaptureChange[] = [];
	for (const ref of [...before.itemRefs, ...after.itemRefs]) if (versions.get(ref.versionId)?.id !== ref.itemId) return undefined;
	for (const ref of after.itemRefs) {
		const old = oldRefs.get(ref.itemId);
		const next = versions.get(ref.versionId)!;
		if (!old) changes.push({ id: ref.itemId, status: "entered", after: next });
		else if (old !== ref.versionId) changes.push({ id: ref.itemId, status: "changed", before: versions.get(old)!, after: next });
	}
	for (const ref of before.itemRefs) {
		if (!newRefs.has(ref.itemId)) changes.push({ id: ref.itemId, status: "exited", before: versions.get(ref.versionId)! });
	}
	return changes;
}
