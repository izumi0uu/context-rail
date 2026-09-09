import assert from "node:assert/strict";
import test from "node:test";
import { contentState, readingSections, sameSceneTimeline } from "../web/src/reader.ts";

test("reading sections preserve code and treat embedded markup as text", () => {
	assert.deepEqual(readingSections("# Title\n\n<script>alert(1)</script>\n\n```ts\nconst x = 1;\n```\n- item"), [
		{ kind: "heading", text: "Title" },
		{ kind: "paragraph", text: "<script>alert(1)</script>" },
		{ kind: "code", text: "const x = 1;" },
		{ kind: "list", text: "- item" },
	]);
});

test("a synthetic compaction event is never described as included content", () => {
	assert.equal(contentState({ synthetic: true, active: true }), "Compaction event · not model content");
	assert.equal(contentState({ pending: true }), "Observed · awaiting context");
});

test("tool-only timeline wrappers do not invalidate the scene; content and order changes do", () => {
	const a = { history: [{ id: "a" }, { id: "b" }], activeIds: ["a", "b"], pendingIds: [], summaryEdges: [] };
	assert.equal(sameSceneTimeline(a, { ...a, activeIds: ["a", "b"], pendingIds: [] }), true);
	assert.equal(sameSceneTimeline(a, { ...a, activeIds: ["b", "a"] }), false);
	assert.equal(sameSceneTimeline(a, { ...a, history: [...a.history] }), false);
	assert.equal(sameSceneTimeline(null, a), false);
});
