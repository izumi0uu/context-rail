import assert from "node:assert/strict";
import test from "node:test";
import { renderStatus, renderStrip, renderWidget } from "../src/render.ts";
import type { ContextItem, ContextSnapshot } from "../src/snapshot.ts";

const snapshot: ContextSnapshot = {
	createdAt: 1,
	model: "claude-test",
	tokens: 31_200,
	contextWindow: 64_000,
	percent: 48.75,
	items: [
		{ id: "system", kind: "system" },
		{ id: "user", kind: "user" },
		{ id: "assistant", kind: "assistant" },
		{ id: "tool", kind: "tool" },
	],
};

test("renders a compact status without message content", () => {
	assert.equal(
		renderStatus({ snapshot, phase: "context", activeTools: [] }),
		"ctx 49% | 31.2k/64.0k | 4 items",
	);
});

test("renders model, usage, strip, and active phase", () => {
	assert.deepEqual(renderWidget({ snapshot, phase: "tool", activeTools: ["bash"] }), [
		"Context window | claude-test",
		"31.2k / 64.0k tokens | 49%",
		"[SYS][USR][AST][TOL]",
		"phase: tool: bash",
	]);
});

test("keeps the system block and newest context when the strip is long", () => {
	const items: ContextItem[] = [
		{ id: "system", kind: "system" },
		...Array.from({ length: 15 }, (_, index) => ({ id: `user-${index}`, kind: "user" as const })),
	];
	assert.equal(renderStrip(items, 5), "[SYS][...+12][USR][USR][USR]");
});
