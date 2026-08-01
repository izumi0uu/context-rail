import assert from "node:assert/strict";
import test from "node:test";
import {
	applyRenderStatePatch,
	chunkRenderStatePatch,
	decodeRenderStatePatchChunks,
	diffRenderState,
} from "../src/hub-delta.ts";
import type { RenderState } from "../src/render.ts";
import type { HistoryItem, SummaryEdge } from "../src/timeline.ts";
import { ContextTimeline } from "../src/timeline.ts";

function historyItem(id: string, order: number, pending = false): HistoryItem {
	return {
		id,
		kind: order % 2 === 0 ? "user" : "assistant",
		order,
		firstSeenAt: order + 1,
		lastSeenAt: order + 1,
		...(pending ? { pending: true } : { confirmedAt: order + 1 }),
	};
}

function state(history: HistoryItem[], revision: number): RenderState {
	const activeIds = history.slice(-3).filter((item) => !item.pending).map((item) => item.id);
	return {
		snapshot: {
			createdAt: revision,
			model: "test-model",
			items: history
				.filter((item) => activeIds.includes(item.id))
				.map(({ id, kind }) => ({ id, kind })),
		},
		phase: "context",
		activeTools: [],
		timeline: {
			revision,
			history,
			activeIds,
			enteredIds: activeIds,
			retainedIds: [],
			exitedIds: [],
			observedIds: history.filter((item) => item.pending).map((item) => item.id),
			confirmedIds: [],
			pendingIds: history.filter((item) => item.pending).map((item) => item.id),
			summaryEdges: [],
		},
	};
}

function withSummaryEdges(renderState: RenderState, summaryEdges: SummaryEdge[]): RenderState {
	assert.ok(renderState.timeline);
	return {
		...renderState,
		timeline: {
			...renderState.timeline,
			summaryEdges,
		},
	};
}

test("applies history upserts without resending unchanged history", () => {
	const first = state([historyItem("message-1", 0, true)], 1);
	const confirmed = { ...historyItem("message-1", 0), lastSeenAt: 2, confirmedAt: 2 };
	const second = state([confirmed, historyItem("message-2", 1)], 2);
	const patch = diffRenderState(first, second);

	assert.equal(patch.reset, undefined);
	assert.deepEqual(patch.timeline?.historyUpserts?.map((item) => item.id), ["message-1", "message-2"]);
	assert.deepEqual(applyRenderStatePatch(first, patch), second);
	assert.equal(diffRenderState(second, second).timeline?.historyUpserts, undefined);
});

test("does not upsert unchanged active details on consecutive context events", () => {
	const timeline = new ContextTimeline();
	const item = { id: "message-1", kind: "user" as const };
	const detail = {
		sourceRole: "user",
		modelMessages: [{
			modelRole: "user" as const,
			blocks: [{ type: "text" as const, text: "unchanged context" }],
		}],
	};
	const firstTimeline = timeline.apply(
		{ createdAt: 10, items: [item] },
		{ details: new Map([[item.id, detail]]) },
	);
	const secondTimeline = timeline.apply(
		{ createdAt: 20, items: [{ ...item }] },
		{ details: new Map([[item.id, structuredClone(detail)]]) },
	);
	const first: RenderState = {
		snapshot: { createdAt: 10, items: [item] },
		phase: "context",
		activeTools: [],
		timeline: firstTimeline,
	};
	const second: RenderState = {
		snapshot: { createdAt: 20, items: [item] },
		phase: "context",
		activeTools: [],
		timeline: secondTimeline,
	};

	assert.equal(secondTimeline.history[0]?.lastSeenAt, 10);
	assert.equal(diffRenderState(first, second).timeline?.historyUpserts, undefined);
});

test("chunks a large initial history and reconstructs the exact state", () => {
	const target = state(Array.from({ length: 4_000 }, (_, index) => historyItem(`message-${index}`, index)), 4_000);
	const chunks = chunkRenderStatePatch(diffRenderState(undefined, target), 16 * 1024);
	const reconstructed = applyRenderStatePatch(undefined, decodeRenderStatePatchChunks(chunks));

	assert.ok(chunks.length > 10);
	assert.equal(chunks.at(-1)?.complete, true);
	assert.ok(chunks.slice(0, -1).every((chunk) => chunk.complete === false));
	assert.ok(chunks.every((chunk) => Buffer.byteLength(chunk.data) <= 16 * 1024));
	assert.deepEqual(reconstructed, target);
});

test("chunks a large incremental append without resetting acknowledged history", () => {
	const previous = state(Array.from({ length: 20 }, (_, index) => historyItem(`message-${index}`, index)), 20);
	const next = state(Array.from({ length: 600 }, (_, index) => historyItem(`message-${index}`, index)), 600);
	const patch = diffRenderState(previous, next);
	const chunks = chunkRenderStatePatch(patch, 2 * 1024);
	const reconstructed = applyRenderStatePatch(previous, decodeRenderStatePatchChunks(chunks));

	assert.equal(patch.reset, undefined);
	assert.equal(patch.timeline?.reset, undefined);
	assert.ok(chunks.length > 2);
	assert.ok(chunks.every((chunk) => Buffer.byteLength(chunk.data) <= 2 * 1024));
	assert.deepEqual(reconstructed, next);
});

test("resets timeline state when history shrinks and removes stale items", () => {
	const previous = state(
		[historyItem("message-1", 0), historyItem("message-2", 1), historyItem("message-3", 2)],
		3,
	);
	const next = state([historyItem("message-1", 0), historyItem("message-3", 1)], 4);
	const patch = diffRenderState(previous, next);

	assert.equal(patch.timeline?.reset, true);
	assert.deepEqual(patch.timeline?.historyUpserts, next.timeline?.history);
	assert.deepEqual(applyRenderStatePatch(previous, patch), next);
});

test("removes a timeline with null and can restore it with a reset", () => {
	const previous = state([historyItem("message-1", 0)], 1);
	const withoutTimeline: RenderState = {
		snapshot: undefined,
		phase: "idle",
		activeTools: [],
	};
	const removal = diffRenderState(previous, withoutTimeline);

	assert.equal(removal.timeline, null);
	assert.deepEqual(applyRenderStatePatch(previous, removal), withoutTimeline);

	const restoration = diffRenderState(withoutTimeline, previous);
	assert.equal(restoration.timeline?.reset, true);
	assert.deepEqual(applyRenderStatePatch(withoutTimeline, restoration), previous);
});

test("upserts new summary edges without resending existing edges", () => {
	const history = [historyItem("message-1", 0), historyItem("memory-1", 1)];
	const firstEdge: SummaryEdge = { from: "message-1", to: "memory-1", kind: "summary" };
	const secondEdge: SummaryEdge = { from: "message-2", to: "memory-1", kind: "summary" };
	const previous = withSummaryEdges(state(history, 2), [firstEdge]);
	const next = withSummaryEdges(state(history, 3), [firstEdge, secondEdge]);
	const patch = diffRenderState(previous, next);

	assert.equal(patch.timeline?.reset, undefined);
	assert.deepEqual(patch.timeline?.summaryEdgeUpserts, [secondEdge]);
	assert.deepEqual(applyRenderStatePatch(previous, patch), next);
});

test("round-trips summary edge additions whose delimiter-shaped ids used to collide", () => {
	const history = [
		historyItem("message", 0),
		historyItem("message->nested", 1),
		historyItem("nested->memory", 2),
		historyItem("memory", 3),
	];
	const firstEdge: SummaryEdge = { from: "message", to: "nested->memory", kind: "summary" };
	const secondEdge: SummaryEdge = { from: "message->nested", to: "memory", kind: "summary" };
	const previous = withSummaryEdges(state(history, 4), [firstEdge]);
	const next = withSummaryEdges(state(history, 5), [firstEdge, secondEdge]);
	const patch = diffRenderState(previous, next);

	assert.equal(patch.timeline?.reset, undefined);
	assert.deepEqual(patch.timeline?.summaryEdgeUpserts, [secondEdge]);
	assert.deepEqual(applyRenderStatePatch(previous, patch), next);
});

test("round-trips summary edge removals whose delimiter-shaped ids used to collide", () => {
	const history = [
		historyItem("message", 0),
		historyItem("message->nested", 1),
		historyItem("nested->memory", 2),
		historyItem("memory", 3),
	];
	const retainedEdge: SummaryEdge = { from: "message", to: "nested->memory", kind: "summary" };
	const removedEdge: SummaryEdge = { from: "message->nested", to: "memory", kind: "summary" };
	const previous = withSummaryEdges(state(history, 4), [retainedEdge, removedEdge]);
	const next = withSummaryEdges(state(history, 5), [retainedEdge]);
	const patch = diffRenderState(previous, next);

	assert.equal(patch.timeline?.reset, true);
	assert.deepEqual(applyRenderStatePatch(previous, patch), next);
});

test("resets timeline state when a summary edge is removed", () => {
	const history = [historyItem("message-1", 0), historyItem("message-2", 1), historyItem("memory-1", 2)];
	const removedEdge: SummaryEdge = { from: "message-1", to: "memory-1", kind: "summary" };
	const retainedEdge: SummaryEdge = { from: "message-2", to: "memory-1", kind: "summary" };
	const previous = withSummaryEdges(state(history, 3), [removedEdge, retainedEdge]);
	const next = withSummaryEdges(state(history, 4), [retainedEdge]);
	const patch = diffRenderState(previous, next);

	assert.equal(patch.timeline?.reset, true);
	assert.deepEqual(patch.timeline?.summaryEdgeUpserts, [retainedEdge]);
	assert.deepEqual(applyRenderStatePatch(previous, patch), next);
});

test("structurally shares untouched history while copying patched timeline values", () => {
	const edge: SummaryEdge = { from: "message-1", to: "memory-1", kind: "summary" };
	const previous = withSummaryEdges(
		state([historyItem("message-1", 0), historyItem("memory-1", 1)], 2),
		[edge],
	);
	assert.ok(previous.timeline);

	const applied = applyRenderStatePatch(previous, {
		phase: "tool",
		timeline: {
			revision: 3,
			activeIds: ["memory-1"],
		},
	});
	assert.ok(applied.timeline);

	assert.notEqual(applied, previous);
	assert.equal(applied.snapshot, previous.snapshot);
	assert.equal(applied.activeTools, previous.activeTools);
	assert.notEqual(applied.timeline, previous.timeline);
	assert.equal(applied.timeline.history, previous.timeline.history);
	assert.equal(applied.timeline.summaryEdges, previous.timeline.summaryEdges);
	assert.notEqual(applied.timeline.activeIds, previous.timeline.activeIds);
	assert.deepEqual(applied.timeline.activeIds, ["memory-1"]);
	assert.deepEqual(previous.timeline.activeIds, ["message-1", "memory-1"]);

	const snapshotUpsert = {
		createdAt: 3,
		model: "test-model",
		items: [{ id: "message-2", kind: "user" as const }],
	};
	const historyUpsert = historyItem("message-2", 2);
	const edgeUpsert: SummaryEdge = { from: "message-2", to: "memory-1", kind: "summary" };
	const withUpserts = applyRenderStatePatch(previous, {
		snapshot: snapshotUpsert,
		timeline: {
			historyUpserts: [historyUpsert],
			summaryEdgeUpserts: [edgeUpsert],
		},
	});
	assert.ok(withUpserts.timeline);

	assert.notEqual(withUpserts.snapshot, snapshotUpsert);
	assert.equal(withUpserts.timeline.history[0], previous.timeline.history[0]);
	assert.notEqual(withUpserts.timeline.history.at(-1), historyUpsert);
	assert.equal(withUpserts.timeline.summaryEdges[0], previous.timeline.summaryEdges[0]);
	assert.notEqual(withUpserts.timeline.summaryEdges.at(-1), edgeUpsert);
});

test("returns one complete chunk for empty and under-budget patches", () => {
	const emptyPatch = {};
	const smallPatch = { phase: "tool" as const, activeTools: ["read"] };

	const emptyChunks = chunkRenderStatePatch(emptyPatch, 128);
	const smallChunks = chunkRenderStatePatch(smallPatch, 128);
	assert.equal(emptyChunks.length, 1);
	assert.equal(emptyChunks[0]?.complete, true);
	assert.deepEqual(decodeRenderStatePatchChunks(emptyChunks), emptyPatch);
	assert.equal(smallChunks.length, 1);
	assert.equal(smallChunks[0]?.complete, true);
	assert.deepEqual(decodeRenderStatePatchChunks(smallChunks), smallPatch);
});

test("drops unknown content fields while decoding transport chunks", () => {
	const unsafePatch = {
		secret: "top-level-secret",
		snapshot: {
			createdAt: 1,
			items: [{ id: "message-1", kind: "user", content: "snapshot-secret" }],
		},
	};
	const chunks = chunkRenderStatePatch(unsafePatch as never);

	assert.deepEqual(decodeRenderStatePatchChunks(chunks), {
		snapshot: {
			createdAt: 1,
			items: [{ id: "message-1", kind: "user" }],
		},
	});
});

test("chunks an atomic history item larger than the transport budget", () => {
	const oversizedItem: HistoryItem = {
		...historyItem("message-oversized", 0),
		toolName: "x".repeat(2_048),
	};
	const patch = {
		timeline: {
			historyUpserts: [oversizedItem],
		},
	};

	const chunks = chunkRenderStatePatch(patch, 256);
	assert.ok(chunks.length > 1);
	assert.ok(chunks.every((chunk) => Buffer.byteLength(chunk.data) <= 256));
	assert.deepEqual(decodeRenderStatePatchChunks(chunks), patch);
});
