import assert from "node:assert/strict";
import test from "node:test";
import { ContextTimeline, summaryEdgeKey, type SummaryEdge } from "../src/timeline.ts";
import type { ContextItem, ContextItemDetail, ContextSnapshot } from "../src/snapshot.ts";

function snapshot(items: ContextItem[], createdAt = 1): ContextSnapshot {
	return { createdAt, items };
}

test("keeps exited items in append-only history and supports re-entry", () => {
	const timeline = new ContextTimeline();
	const first = timeline.apply(snapshot([
		{ id: "system", kind: "system" },
		{ id: "user-1", kind: "user" },
		{ id: "assistant-1", kind: "assistant" },
	]));
	assert.deepEqual(first.enteredIds, ["system", "user-1", "assistant-1"]);

	const second = timeline.apply(snapshot([
		{ id: "system", kind: "system" },
		{ id: "assistant-1", kind: "assistant" },
		{ id: "user-2", kind: "user" },
	], 2));
	assert.deepEqual(second.exitedIds, ["user-1"]);
	assert.deepEqual(second.enteredIds, ["user-2"]);
	assert.deepEqual(second.history.map((item) => item.id), ["system", "user-1", "assistant-1", "user-2"]);

	const third = timeline.apply(snapshot([
		{ id: "system", kind: "system" },
		{ id: "user-1", kind: "user" },
		{ id: "user-2", kind: "user" },
	], 3));
	assert.deepEqual(third.enteredIds, ["user-1"]);
	assert.equal(third.history.length, 4);
});

test("observes messages immediately and lets context confirm the same node", () => {
	const timeline = new ContextTimeline();
	const observed = timeline.observe({ id: "user-1", kind: "user" }, 1);
	assert.deepEqual(observed.activeIds, []);
	assert.deepEqual(observed.observedIds, ["user-1"]);
	assert.deepEqual(observed.pendingIds, ["user-1"]);
	assert.equal(observed.history[0]?.pending, true);

	const duplicate = timeline.observe({ id: "user-1", kind: "user" }, 2);
	assert.equal(duplicate.revision, observed.revision);
	assert.equal(duplicate.history.length, 1);

	const confirmed = timeline.apply(snapshot([{ id: "user-1", kind: "user" }], 3));
	assert.deepEqual(confirmed.activeIds, ["user-1"]);
	assert.deepEqual(confirmed.confirmedIds, ["user-1"]);
	assert.deepEqual(confirmed.pendingIds, []);
	assert.equal(confirmed.history[0]?.pending, undefined);
	assert.equal(confirmed.history[0]?.confirmedAt, 3);

	const waiting = timeline.observe({ id: "assistant-1", kind: "assistant" }, 4);
	assert.deepEqual(waiting.activeIds, ["user-1"]);
	assert.deepEqual(waiting.pendingIds, ["assistant-1"]);
	assert.deepEqual(waiting.history.map((item) => item.id), ["user-1", "assistant-1"]);
});

test("retains details and replaces pending content with the authoritative context value", () => {
	const timeline = new ContextTimeline();
	const pendingDetail: ContextItemDetail = {
		sourceRole: "assistant",
		modelMessages: [{
			modelRole: "assistant",
			blocks: [{ type: "text", text: "draft" }],
		}],
	};
	const authoritativeDetail: ContextItemDetail = {
		sourceRole: "assistant",
		modelMessages: [{
			modelRole: "assistant",
			blocks: [{ type: "text", text: "final" }],
		}],
	};

	const pending = timeline.observe({ id: "assistant-1", kind: "assistant" }, 1, pendingDetail);
	assert.deepEqual(pending.history[0]?.detail, pendingDetail);
	pendingDetail.modelMessages[0]!.blocks[0] = { type: "text", text: "mutated" };
	assert.deepEqual(pending.history[0]?.detail?.modelMessages[0]?.blocks, [{ type: "text", text: "draft" }]);

	const confirmed = timeline.apply(snapshot([{ id: "assistant-1", kind: "assistant" }], 2), {
		details: new Map([["assistant-1", authoritativeDetail]]),
	});
	assert.deepEqual(confirmed.history[0]?.detail, authoritativeDetail);
	assert.deepEqual(confirmed.confirmedIds, ["assistant-1"]);

	const outside = timeline.apply(snapshot([], 3), { details: new Map() });
	assert.deepEqual(outside.history[0]?.detail, authoritativeDetail);

	const cleared = timeline.apply(snapshot([{ id: "assistant-1", kind: "assistant" }], 4), {
		details: new Map(),
	});
	assert.equal(cleared.history[0]?.detail, undefined);
});

test("adds a synthetic compaction summary and provenance without deleting sources", () => {
	const timeline = new ContextTimeline();
	timeline.apply(snapshot([
		{ id: "system", kind: "system" },
		{ id: "user-1", kind: "user" },
		{ id: "assistant-1", kind: "assistant" },
	]));

	const compacted = timeline.apply(snapshot([
		{ id: "system", kind: "system" },
		{ id: "assistant-2", kind: "assistant" },
	], 2), { compaction: true });
	const summary = compacted.history.find((item) => item.synthetic);
	assert.equal(summary?.kind, "memory");
	assert.ok(summary && !compacted.activeIds.includes(summary.id));
	assert.deepEqual(compacted.activeIds, ["system", "assistant-2"]);
	assert.deepEqual(compacted.enteredIds, ["assistant-2"]);
	assert.deepEqual(compacted.exitedIds, ["user-1", "assistant-1"]);
	assert.deepEqual(
		compacted.summaryEdges.map((edge) => edge.from),
		["user-1", "assistant-1"],
	);
	assert.equal(compacted.history.length, 5);
});

test("keeps a real compaction memory item in the authoritative context", () => {
	const timeline = new ContextTimeline();
	timeline.apply(snapshot([{ id: "user-1", kind: "user" }]));

	const compacted = timeline.apply(snapshot([
		{ id: "memory-1", kind: "memory" },
		{ id: "assistant-1", kind: "assistant" },
	], 2), { compaction: true });

	assert.deepEqual(compacted.activeIds, ["memory-1", "assistant-1"]);
	assert.equal(compacted.history.find((item) => item.id === "memory-1")?.synthetic, undefined);
});

test("keeps summary edges whose delimiter-shaped ids used to collide", () => {
	const firstEdge: SummaryEdge = {
		from: "message",
		to: "nested->memory",
		kind: "summary",
	};
	const secondEdge: SummaryEdge = {
		from: "message->nested",
		to: "memory",
		kind: "summary",
	};
	assert.notEqual(summaryEdgeKey(firstEdge), summaryEdgeKey(secondEdge));

	const timeline = new ContextTimeline();
	timeline.apply(snapshot([{ id: firstEdge.from, kind: "user" }]));
	timeline.apply(snapshot([{ id: firstEdge.to, kind: "memory" }], 2), { compaction: true });
	timeline.apply(snapshot([{ id: secondEdge.from, kind: "user" }], 3));
	const compacted = timeline.apply(
		snapshot([{ id: secondEdge.to, kind: "memory" }], 4),
		{ compaction: true },
	);

	assert.deepEqual(compacted.summaryEdges, [firstEdge, secondEdge]);
});

test("reset clears history, active ids, and revision", () => {
	const timeline = new ContextTimeline();
	timeline.apply(snapshot([{ id: "user-1", kind: "user" }]));
	const { retention, ...reset } = timeline.reset();
	assert.deepEqual(reset, {
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
	});
	assert.equal(retention?.evictedItems, 0);
	assert.equal(retention?.retainedItems, 0);
	assert.equal(retention?.pinnedItems, 0);
	assert.equal(retention?.overBudget, false);
});
