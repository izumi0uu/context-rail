import assert from "node:assert/strict";
import test from "node:test";
import { classifyMessage, createSnapshot } from "../src/snapshot.ts";

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
