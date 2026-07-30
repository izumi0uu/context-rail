import assert from "node:assert/strict";
import test from "node:test";
import { classifyMessage, ContextMessageIdentity, createSnapshot } from "../src/snapshot.ts";

test("classifies common OMP message shapes", () => {
	assert.equal(classifyMessage({ role: "user" }), "user");
	assert.equal(classifyMessage({ role: "assistant" }), "assistant");
	assert.equal(classifyMessage({ role: "toolResult", toolName: "bash" }), "tool");
	assert.equal(classifyMessage({ customType: "memory_summary" }), "memory");
	assert.equal(classifyMessage({ type: "other" }), "unknown");
});

test("builds a content-free normalized snapshot", () => {
	const result = createSnapshot({
		messages: [
			{ role: "user" },
			{ role: "assistant" },
			{ role: "toolResult", toolName: "read" },
		],
		usage: { tokens: 16_000, contextWindow: 64_000 },
		model: "test-model",
		systemPromptParts: 3,
		now: 123,
	});

	assert.deepEqual(result, {
		createdAt: 123,
		model: "test-model",
		tokens: 16_000,
		contextWindow: 64_000,
		percent: 25,
		items: [
			{ id: "system-prompt", kind: "system" },
			{ id: "message-0", kind: "user" },
			{ id: "message-1", kind: "assistant" },
			{ id: "message-2", kind: "tool", toolName: "read" },
		],
	});
});

test("ignores invalid usage values", () => {
	const result = createSnapshot({
		messages: [],
		usage: { tokens: Number.NaN, contextWindow: -1, percent: null },
		now: 1,
	});
	assert.equal(result.tokens, undefined);
	assert.equal(result.contextWindow, undefined);
	assert.equal(result.percent, undefined);
});

test("prefers intrinsic message identifiers for stable live updates", () => {
	const result = createSnapshot({
		messages: [{ id: "turn-42", role: "assistant" }, { toolCallId: 19, role: "toolResult" }],
		now: 1,
	});
	assert.deepEqual(
		result.items.map((item) => item.id),
		["message-turn-42", "message-19"],
	);
});

test("keeps content-free fallback ids stable for appends and compacted suffixes", () => {
	const identity = new ContextMessageIdentity();
	const user = { role: "user" };
	const assistant = { role: "assistant" };
	const first = createSnapshot({ messages: [user, assistant], identity, now: 1 });
	const appended = createSnapshot({
		messages: [user, assistant, { role: "user" }],
		identity,
		now: 2,
	});
	assert.deepEqual(appended.items.slice(0, 2).map((item) => item.id), first.items.map((item) => item.id));

	const compacted = createSnapshot({
		messages: [{ customType: "memory_summary" }, assistant],
		identity,
		now: 3,
	});
	assert.equal(compacted.items[1]?.id, first.items[1]?.id);
	assert.notEqual(compacted.items[0]?.id, first.items[0]?.id);
});

test("does not falsely reuse fallback ids for ambiguous same-length windows", () => {
	const identity = new ContextMessageIdentity();
	const first = createSnapshot({
		messages: [{ role: "user" }, { role: "assistant" }],
		identity,
		now: 1,
	});
	const ambiguous = createSnapshot({
		messages: [{ role: "user" }, { role: "assistant" }],
		identity,
		now: 2,
	});
	assert.notDeepEqual(
		ambiguous.items.map((item) => item.id),
		first.items.map((item) => item.id),
	);
});
