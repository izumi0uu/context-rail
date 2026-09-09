import assert from "node:assert/strict";
import test from "node:test";
import { captureRenderStateForTransport, freezeJson, immutableCopy, isDeeplyFrozen, sameJsonValue } from "../src/immutable-state.ts";
import { ContextTimeline } from "../src/timeline.ts";
import { ContextCaptureArchive } from "../src/context-captures.ts";
import { captureContext } from "../src/snapshot.ts";
import { diffRenderState } from "../src/hub-delta.ts";
import { projectRenderState } from "../src/hub-schema.ts";
import type { RenderState } from "../src/render.ts";

test("transport shares producer-owned immutable components and never reclones queued state", () => {
	const capture = captureContext({ messages: [{ role: "user", content: "heavy".repeat(100_000) }], now: 1 });
	const timeline = new ContextTimeline().apply(capture.snapshot, { details: capture.details });
	const archive = new ContextCaptureArchive().append(capture);
	const state: RenderState = { snapshot: freezeJson(capture.snapshot), timeline, captures: archive, phase: "context", activeTools: [] };
	const captured = captureRenderStateForTransport(state);
	assert.notEqual(captured, state);
	assert.equal(captured.timeline, timeline);
	assert.equal(captured.snapshot, state.snapshot);
	assert.equal(captured.captures, archive);
	assert.ok(isDeeplyFrozen(captured));
	assert.equal(captureRenderStateForTransport(captured), captured);
	assert.equal(immutableCopy(timeline), timeline);
	assert.equal(diffRenderState(captured, captured).timeline!.historyUpserts, undefined);
	assert.equal(diffRenderState(captured, captured).captures, undefined);
});

test("mutable external state and shallow-frozen roots retain defensive copy boundaries", () => {
	const state: RenderState = {
		snapshot: Object.freeze({ createdAt: 1, items: [{ id: "original", kind: "user" as const }] }),
		phase: "context", activeTools: ["read"],
	};
	Object.freeze(state);
	assert.equal(isDeeplyFrozen(state), false);
	const captured = captureRenderStateForTransport(state);
	state.snapshot!.items[0]!.id = "mutated";
	(state.activeTools as string[]).push("changed");
	assert.equal(captured.snapshot!.items[0]!.id, "original");
	assert.deepEqual(captured.activeTools, ["read"]);
	assert.ok(isDeeplyFrozen(captured));
	assert.throws(() => { captured.snapshot!.items[0]!.id = "mutate retained"; });
});

test("frozen accessors and mutable built-ins cannot be mistaken for deeply immutable JSON", () => {
	let current = "first";
	const accessor = Object.freeze({ get text() { return current; } });
	assert.equal(isDeeplyFrozen(accessor), false);
	const copied = immutableCopy(accessor);
	current = "second";
	assert.equal(copied.text, "first");
	const map = new Map([["key", "first"]]);
	const root = freezeJson({ map });
	assert.equal(isDeeplyFrozen(root), false);
	const cloned = immutableCopy(root);
	map.set("key", "second");
	assert.equal(cloned.map.get("key"), "first");
	assert.equal(isDeeplyFrozen(cloned), false);
	assert.equal(isDeeplyFrozen(Object.freeze(new Date())), false);
	const callable = Object.freeze({ toJSON: () => current });
	assert.equal(isDeeplyFrozen(callable), false);
	assert.throws(() => immutableCopy(callable), /could not be cloned/);
	const state = Object.freeze({ snapshot: undefined, phase: "context" as const, activeTools: Object.freeze([]), toJSON: () => current });
	assert.equal(isDeeplyFrozen(state), false);
	const safeState = captureRenderStateForTransport(state);
	assert.equal(Object.hasOwn(safeState, "toJSON"), false);
});

test("cycle validation does not cache partially mutable graphs as trusted", () => {
	const mutable = { text: "first" };
	const parent: { child?: unknown; mutable: typeof mutable } = { mutable };
	const child = Object.freeze({ parent });
	parent.child = child;
	Object.freeze(parent);
	assert.equal(isDeeplyFrozen(parent), false);
	assert.equal(isDeeplyFrozen(child), false);
	freezeJson(parent);
	assert.equal(isDeeplyFrozen(parent), true);
	assert.equal(isDeeplyFrozen(child), true);
	assert.throws(() => { mutable.text = "changed"; });
});

test("schema caching only reuses sanitized immutable records and still strips unknown frozen fields", () => {
	const source = captureContext({ messages: [{ role: "user", content: "visible" }], now: 1 });
	const timeline = new ContextTimeline().apply(source.snapshot, { details: source.details });
	const first = projectRenderState({ snapshot: source.snapshot, timeline, phase: "context", activeTools: [] });
	const again = projectRenderState({ ...first, phase: "tool" });
	assert.equal(again.timeline!.history[0], first.timeline!.history[0]);
	assert.equal(again.timeline!.history[0]!.detail, first.timeline!.history[0]!.detail);
	const dirty = freezeJson({ ...timeline.history[0]!, providerPayload: "SECRET", detail: { ...timeline.history[0]!.detail!, signature: "SECRET" } });
	const sanitized = projectRenderState({ ...first, timeline: { ...timeline, history: [dirty] } });
	assert.ok(!JSON.stringify(sanitized).includes("SECRET"));
	const mutable = structuredClone(dirty);
	const before = projectRenderState({ ...first, timeline: { ...timeline, history: [mutable] } });
	(mutable.detail.modelMessages[0]!.blocks[0] as { text: string }).text = "changed";
	const after = projectRenderState({ ...first, timeline: { ...timeline, history: [mutable] } });
	assert.notEqual(after.timeline!.history[0], before.timeline!.history[0]);
	assert.deepEqual(after.timeline!.history[0]!.detail!.modelMessages[0]!.blocks, [{ type: "text", text: "changed" }]);
});

test("JSON-shaped equality compares exact values without serialization or Unicode normalization", () => {
	assert.equal(sameJsonValue({ a: ["same", 1, false] }, { a: ["same", 1, false] }), true);
	assert.equal(sameJsonValue({ a: "\uD800" }, { a: "\uFFFD" }), false);
	assert.equal(sameJsonValue([], {}), false);
	assert.equal(sameJsonValue({ a: undefined }, {}), false);
	assert.equal(sameJsonValue({ a: "old" }, { a: "new" }), false);
});
