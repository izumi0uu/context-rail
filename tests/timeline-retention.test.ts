import assert from "node:assert/strict";
import test from "node:test";
import { ContextTimeline, type ContextTimelineSnapshot } from "../src/timeline.ts";
import type { ContextItem, ContextItemDetail } from "../src/snapshot.ts";
import { applyRenderStatePatch, chunkRenderStatePatch, decodeRenderStatePatchChunks, diffRenderState } from "../src/hub-delta.ts";
import { projectRenderState, projectRenderStatePatch } from "../src/hub-schema.ts";
import type { RenderState } from "../src/render.ts";
import { isDeeplyFrozen } from "../src/immutable-state.ts";
import { createContextRailProcessState, createContextRailRuntime } from "../src/extension-runtime.ts";
import type { ContextRailHostContext } from "../src/host-types.ts";

function detail(text: string): ContextItemDetail {
	return { sourceRole: "user", modelMessages: [{ modelRole: "user", blocks: [{ type: "text", text }] }] };
}

function apply(timeline: ContextTimeline, ids: string[], now: number, text = "small"): ContextTimelineSnapshot {
	return timeline.apply({ createdAt: now, items: ids.map((id) => ({ id, kind: "user" })) }, { details: new Map(ids.map((id) => [id, detail(text)])) });
}

function serializedHistoryBytes(timeline: ContextTimelineSnapshot): number {
	return Buffer.byteLength(JSON.stringify({ history: timeline.history, summaryEdges: timeline.summaryEdges }));
}

function state(timeline: ContextTimelineSnapshot): RenderState {
	return { snapshot: undefined, phase: "context", activeTools: [], timeline };
}

test("immutable timeline snapshots share unchanged heavy details, records, and arrays", () => {
	const timeline = new ContextTimeline();
	const heavy = "body".repeat(300_000);
	const first = apply(timeline, ["same"], 1, heavy);
	const second = apply(timeline, ["same"], 2, heavy);
	const third = apply(timeline, ["same"], 3, heavy);
	assert.ok(isDeeplyFrozen(first));
	assert.equal(first.history, second.history);
	assert.equal(first.history[0], second.history[0]);
	assert.equal(first.history[0]!.detail, second.history[0]!.detail);
	assert.equal(first.activeIds, second.activeIds);
	assert.equal(second.retainedIds, third.retainedIds);
	assert.equal(second.pendingIds, third.pendingIds);
	assert.equal(second.summaryEdges, third.summaryEdges);
	assert.equal(second.retention, third.retention);
	assert.equal(timeline.current(), timeline.current());
	assert.throws(() => first.history.push(first.history[0]!));
	assert.throws(() => { first.history[0]!.lastSeenAt = 99; });
	assert.throws(() => first.history[0]!.detail!.modelMessages[0]!.blocks.push({ type: "text", text: "mutate" }));
	const changed = apply(timeline, ["same"], 4, "new body");
	assert.notEqual(changed.history[0], first.history[0]);
	assert.deepEqual(first.history[0]!.detail!.modelMessages[0]!.blocks, [{ type: "text", text: heavy }]);
	assert.deepEqual(changed.history[0]!.detail!.modelMessages[0]!.blocks, [{ type: "text", text: "new body" }]);
});

test("mutating caller metadata, details, and active items cannot change retained timeline state", () => {
	const timeline = new ContextTimeline();
	const item: ContextItem = { id: "one", kind: "tool", toolName: "read" };
	const content = detail("original");
	const input = { createdAt: 1, items: [item] };
	const first = timeline.apply(input, { details: new Map([[item.id, content]]) });
	item.kind = "assistant"; item.toolName = "changed"; input.items.length = 0;
	content.modelMessages[0]!.blocks[0] = { type: "text", text: "caller mutated" };
	assert.equal(first.history[0]!.kind, "tool");
	assert.equal(first.history[0]!.toolName, "read");
	assert.deepEqual(first.activeIds, ["one"]);
	assert.deepEqual(first.history[0]!.detail!.modelMessages[0]!.blocks, [{ type: "text", text: "original" }]);
	assert.ok(!Object.isFrozen(content), "caller-owned input must not be frozen as a side effect");
	const second = timeline.observe({ id: "one", kind: "assistant" }, 2, detail("updated"));
	assert.equal(second.history[0]!.toolName, undefined);
	assert.equal(first.history[0]!.toolName, "read");
	assert.deepEqual(second.history[0]!.detail!.modelMessages[0]!.blocks, [{ type: "text", text: "updated" }]);
});

test("count retention evicts oldest inactive records but keeps every active and pending item", () => {
	const timeline = new ContextTimeline({ maxItems: 2, maxBytes: 10_000 });
	const first = apply(timeline, ["a", "b", "c"], 1);
	assert.equal(first.history.length, 3);
	assert.equal(first.retention!.overBudget, true);
	assert.equal(first.retention!.pinnedItems, 3);
	assert.equal(first.retention!.evictedItems, 0);
	const second = apply(timeline, ["c"], 2);
	assert.deepEqual(second.history.map((item) => item.id), ["b", "c"]);
	assert.equal(second.retention!.evictedItems, 1);
	assert.equal(second.retention!.overBudget, false);
	const third = timeline.observe({ id: "pending", kind: "assistant" }, 3, detail("pending"));
	assert.deepEqual(third.history.map((item) => item.id), ["c", "pending"]);
	assert.deepEqual(third.activeIds, ["c"]);
	assert.deepEqual(third.pendingIds, ["pending"]);
	assert.equal(third.retention!.pinnedItems, 2);
	assert.equal(third.retention!.evictedItems, 2);
	assert.equal(first.history.length, 3, "eviction cannot mutate a previously returned snapshot");
	const overflow = timeline.observe({ id: "pending-2", kind: "assistant" }, 4, detail("also pending"));
	assert.equal(overflow.history.length, 3);
	assert.equal(overflow.retention!.overBudget, true);
	assert.deepEqual(overflow.pendingIds, ["pending", "pending-2"]);
});

test("byte retention accounts for multibyte content and keeps over-budget active content exact", () => {
	const timeline = new ContextTimeline({ maxItems: 100, maxBytes: 1_200 });
	const emoji = "🐙汉".repeat(90);
	apply(timeline, ["a"], 1, emoji);
	const second = apply(timeline, ["b"], 2, emoji);
	assert.deepEqual(second.history.map((item) => item.id), ["b"]);
	assert.ok(second.retention!.retainedBytes <= 1_200);
	assert.equal(second.retention!.retainedBytes, serializedHistoryBytes(second));
	assert.equal(second.retention!.evictedItems, 1);
	const oversized = apply(timeline, ["huge"], 3, "a".repeat(5_000));
	assert.deepEqual(oversized.history.map((item) => item.id), ["huge"]);
	assert.equal(oversized.history[0]!.detail!.modelMessages[0]!.blocks[0]!.type, "text");
	assert.deepEqual(oversized.history[0]!.detail!.modelMessages[0]!.blocks, [{ type: "text", text: "a".repeat(5_000) }]);
	assert.equal(oversized.retention!.overBudget, true);
	assert.equal(oversized.retention!.retainedBytes, serializedHistoryBytes(oversized));
	assert.equal(oversized.retention!.pinnedBytes, oversized.retention!.retainedBytes);
	const emptied = apply(timeline, [], 4);
	assert.equal(emptied.history.length, 0);
	assert.equal(emptied.retention!.overBudget, false);
	assert.equal(emptied.retention!.retainedBytes, serializedHistoryBytes(emptied));
});

test("eviction preserves retained compaction edges and monotonic order without dangling endpoints", () => {
	const timeline = new ContextTimeline({ maxItems: 3 });
	apply(timeline, ["a", "b"], 1);
	const compacted = timeline.apply({ createdAt: 2, items: [{ id: "memory", kind: "memory" }] }, { compaction: true });
	assert.deepEqual(compacted.summaryEdges.map((edge) => edge.from), ["a", "b"]);
	assert.equal(compacted.retention!.retainedBytes, serializedHistoryBytes(compacted));
	const after = apply(timeline, ["c"], 3);
	assert.deepEqual(after.history.map((item) => item.id), ["b", "memory", "c"]);
	assert.deepEqual(after.summaryEdges, [{ from: "b", to: "memory", kind: "summary" }]);
	assert.equal(after.retention!.retainedBytes, serializedHistoryBytes(after));
	const returned = apply(timeline, ["a"], 4);
	assert.deepEqual(returned.history.map((item) => item.order), [2, 3, 4]);
	assert.deepEqual(returned.summaryEdges, []);
	assert.equal(returned.history.at(-1)!.id, "a");
	assert.equal(compacted.history.length, 3);
	assert.equal(compacted.summaryEdges.length, 2);
	assert.ok(after.summaryEdges.every((edge) => after.history.some((item) => item.id === edge.from) && after.history.some((item) => item.id === edge.to)));
});

test("synthetic compaction IDs and record order are never reused after eviction", () => {
	const timeline = new ContextTimeline({ maxItems: 2 });
	apply(timeline, ["a"], 1);
	const first = timeline.apply({ createdAt: 2, items: [{ id: "b", kind: "assistant" }] }, { compaction: true });
	const firstSummary = first.history.find((item) => item.synthetic)!;
	const second = timeline.apply({ createdAt: 3, items: [{ id: "c", kind: "assistant" }] }, { compaction: true });
	const secondSummary = second.history.find((item) => item.synthetic)!;
	assert.notEqual(firstSummary.id, secondSummary.id);
	assert.ok(secondSummary.order > firstSummary.order);
	assert.ok(second.history.every((item) => item.order > firstSummary.order));
});

test("managed retention wire deltas remove records/edges without resetting or resending shared heavy content", () => {
	const timeline = new ContextTimeline({ maxItems: 3 });
	apply(timeline, ["retired", "kept"], 1, "HEAVY".repeat(10_000));
	const firstTimeline = timeline.apply({ createdAt: 2, items: [{ id: "memory", kind: "memory" }] }, { compaction: true });
	const first = state(firstTimeline);
	const next = state(apply(timeline, ["new"], 3));
	const patch = diffRenderState(first, next);
	assert.equal(patch.timeline!.reset, undefined);
	assert.deepEqual(patch.timeline!.removedHistoryIds, ["retired"]);
	assert.deepEqual(patch.timeline!.removedSummaryEdges, [{ from: "retired", to: "memory", kind: "summary" }]);
	assert.deepEqual(patch.timeline!.historyUpserts!.map((item) => item.id), ["new"]);
	assert.ok(!JSON.stringify(patch).includes("HEAVY"));
	const decoded = decodeRenderStatePatchChunks(chunkRenderStatePatch(patch, 256));
	assert.deepEqual(applyRenderStatePatch(first, decoded), next);
	assert.deepEqual(projectRenderState(next), next);
	const dirtyRetention = { ...next.timeline!.retention!, rawProviderPayload: "SECRET" };
	const projected = projectRenderStatePatch({ timeline: { retention: dirtyRetention, removedHistoryIds: ["retired"], removedSummaryEdges: [{ from: "retired", to: "memory", kind: "summary", raw: "SECRET" }] } });
	assert.ok(!JSON.stringify(projected).includes("SECRET"));
	assert.deepEqual(projected.timeline!.retention, next.timeline!.retention);
	const clear = applyRenderStatePatch(next, { timeline: { retention: null } });
	assert.equal(clear.timeline!.retention, undefined);
	assert.throws(() => projectRenderStatePatch({ timeline: { retention: { ...dirtyRetention, pinnedItems: -1 } } }), /pinnedItems/);
	assert.throws(() => projectRenderStatePatch({ timeline: { removedHistoryIds: [42] } }), /removedHistoryIds/);
});

test("in-memory timeline upgrades preserve counters, immutable old snapshots, and remaining provenance", () => {
	const previous = new ContextTimeline({ maxItems: 3 });
	apply(previous, ["a", "b"], 1);
	const compacted = previous.apply({ createdAt: 2, items: [{ id: "next", kind: "assistant" }] }, { compaction: true });
	const oldSummary = compacted.history.find((item) => item.synthetic)!;
	const restored = ContextTimeline.fromSnapshot(compacted, { maxItems: 2 }, previous);
	const current = restored.current();
	assert.equal(current.retention!.maxItems, 2);
	assert.equal(current.retention!.evictedItems, compacted.retention!.evictedItems + 1);
	assert.deepEqual(current.activeIds, ["next"]);
	assert.deepEqual(current.history.map((item) => item.order), [oldSummary.order, oldSummary.order + 1]);
	const after = restored.apply({ createdAt: 3, items: [{ id: "later", kind: "assistant" }] }, { compaction: true });
	assert.ok(after.history.find((item) => item.synthetic)!.id !== oldSummary.id);
	assert.ok(after.history.every((item) => item.order > oldSummary.order));
	assert.equal(compacted.history.length, 3);
	assert.ok(isDeeplyFrozen(current));
});

test("Pi cached legacy timeline prototypes are migrated before context applies new retention settings", async (t) => {
	const processState = createContextRailProcessState("legacy-timeline-test");
	const ctx: ContextRailHostContext = {
		sessionManager: { getSessionId: () => "legacy-session", getSessionFile: () => "legacy-session" },
		getContextUsage: () => undefined, getSystemPrompt: () => "",
		ui: { setStatus: () => undefined, setWidget: () => undefined, notify: () => undefined },
	};
	const first = createContextRailRuntime({ processState, connectHub: async () => undefined });
	const messages = Array.from({ length: 5 }, (_, index) => ({ id: `anchor-${index}`, role: "user", content: `content ${index}` }));
	first.context(messages, ctx);
	first.context([messages[4]!], ctx);
	await first.shutdown(ctx, "handoff");
	const cached = processState.runtimes.get("legacy-session")!;
	const { retention: _retention, ...legacy } = structuredClone(cached.state.timeline!);
	cached.timeline = {
		current: () => structuredClone(legacy),
		apply: () => { throw new Error("old unbounded prototype should never execute"); },
	} as unknown as ContextTimeline;
	cached.state.timeline = legacy;
	const originalArchive = cached.state.captures!;
	const replacement = createContextRailRuntime({ processState, historyRetention: { maxItems: 1, maxBytes: 1_024 }, connectHub: async () => undefined });
	t.after(() => replacement.shutdown(ctx));
	assert.ok(cached.timeline instanceof ContextTimeline, "cached sessions must be upgraded before background replay, not only on their next context event");
	assert.equal(cached.state.timeline!.history.length, 1);
	replacement.context([messages[4]!], ctx);
	assert.ok(cached.timeline instanceof ContextTimeline);
	assert.equal(cached.state.timeline!.history.length, 1);
	assert.equal(cached.state.timeline!.retention!.maxItems, 1);
	assert.equal(cached.state.timeline!.retention!.maxBytes, 1_024);
	assert.equal(cached.state.timeline!.retention!.evictedItems, 4);
	assert.equal(cached.state.timeline!.history[0]!.order, 4);
	assert.ok(isDeeplyFrozen(cached.state.timeline));
	assert.equal(legacy.history.length, 5);
	assert.equal(cached.state.captures!.entries[0], originalArchive.entries[0], "timeline migration must not reset capture history");
});
