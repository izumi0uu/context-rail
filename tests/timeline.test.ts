import assert from "node:assert/strict";
import test from "node:test";
import { ContextTimeline } from "../src/timeline.ts";
import type { ContextItem, ContextSnapshot } from "../src/snapshot.ts";

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
	assert.ok(summary && compacted.activeIds.includes(summary.id));
	assert.deepEqual(compacted.exitedIds, ["user-1", "assistant-1"]);
	assert.deepEqual(
		compacted.summaryEdges.map((edge) => edge.from),
		["user-1", "assistant-1"],
	);
	assert.equal(compacted.history.length, 5);
});

test("reset clears history, active ids, and revision", () => {
	const timeline = new ContextTimeline();
	timeline.apply(snapshot([{ id: "user-1", kind: "user" }]));
	assert.deepEqual(timeline.reset(), {
		revision: 0,
		history: [],
		activeIds: [],
		enteredIds: [],
		retainedIds: [],
		exitedIds: [],
		summaryEdges: [],
	});
});
