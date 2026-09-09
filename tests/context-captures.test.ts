import assert from "node:assert/strict";
import test from "node:test";
import { ContextCaptureArchive } from "../src/context-captures.ts";
import { applyRenderStatePatch, chunkRenderStatePatch, decodeRenderStatePatchChunks, diffRenderState } from "../src/hub-delta.ts";
import { projectRenderState, projectRenderStatePatch } from "../src/hub-schema.ts";
import { captureContext, type ContextCapture, type ContextItemDetail } from "../src/snapshot.ts";
import type { RenderState } from "../src/render.ts";
import { createContextRailProcessState, createContextRailRuntime } from "../src/extension-runtime.ts";
import type { ContextRailHostContext } from "../src/host-types.ts";

function capture(text = "hello", now = 1, id = "user-1"): ContextCapture {
	return captureContext({ messages: [{ id, role: "user", content: text }], now, usage: { tokens: 42, contextWindow: 100 } });
}

function state(captures: ReturnType<ContextCaptureArchive["current"]>): RenderState {
	return { snapshot: undefined, phase: "context", activeTools: [], captures };
}

test("same-id content updates create immutable versions without mutating previous captures", () => {
	const archive = new ContextCaptureArchive();
	const input = capture();
	const first = archive.append(input);
	const firstVersion = first.versions[0]!;
	const detail = input.details.values().next().value!;
	(detail.modelMessages[0]!.blocks[0] as { text: string }).text = "mutated input";
	const second = archive.append(capture("updated", 2));
	assert.equal(first.entries.length, 1);
	assert.equal(second.entries.length, 2);
	assert.equal(second.versions.length, 2);
	assert.deepEqual(firstVersion.detail!.modelMessages[0]!.blocks, [{ type: "text", text: "hello" }]);
	assert.notEqual(first.entries[0]!.itemRefs[0]!.versionId, second.entries[1]!.itemRefs[0]!.versionId);
	assert.throws(() => first.entries.push(second.entries[1]!));
	assert.throws(() => { firstVersion.detail!.modelMessages[0]!.blocks.length = 0; });
	assert.equal(second.versions[0], firstVersion);
});

test("content hashing preserves lone UTF-16 surrogates instead of aliasing replacement characters", () => {
	const archive = new ContextCaptureArchive();
	const first = archive.append(capture("\uD800"));
	const second = archive.append(capture("\uFFFD", 2));
	assert.equal(second.versions.length, 2);
	assert.notEqual(first.entries[0]!.itemRefs[0]!.versionId, second.entries[1]!.itemRefs[0]!.versionId);
	assert.deepEqual(second.versions[1]!.detail!.modelMessages[0]!.blocks, [{ type: "text", text: "\uFFFD" }]);
});

test("unchanged heavy text and image content reuse one immutable version and omit heavy deltas", () => {
	const archive = new ContextCaptureArchive();
	const make = (now: number) => captureContext({
		messages: [{ id: "heavy", role: "user", content: [
			{ type: "text", text: "HEAVY_SENTINEL".repeat(80_000) },
			{ type: "image", mimeType: "image/png", data: "a".repeat(800_000) },
		] }], now,
	});
	const first = archive.append(make(1));
	const second = archive.append(make(2));
	assert.equal(second.versions.length, 1);
	assert.equal(second.versions[0], first.versions[0]);
	assert.equal(second.entries[0], first.entries[0]);
	const patch = diffRenderState(state(first), state(second));
	assert.equal(patch.captures?.versionUpserts, undefined);
	assert.equal(patch.captures?.entryUpserts?.length, 1);
	assert.ok(JSON.stringify(patch).length < 1500);
	assert.ok(!JSON.stringify(patch).includes("HEAVY_SENTINEL"));
	assert.equal(diffRenderState(state(second), state(second)).captures, undefined);
	assert.equal(diffRenderState(state(structuredClone(second)), state(second)).captures, undefined);
});

test("captures preserve active item order and aggregate usage without manufacturing per-item tokens", () => {
	const archive = new ContextCaptureArchive();
	const input = captureContext({ messages: [{ id: "b", role: "user", content: "B" }, { id: "a", role: "assistant", content: "A" }], systemPrompt: "system", now: 17, usage: { tokens: 900, percent: 9, contextWindow: 10_000 } });
	const entry = archive.append(input).entries[0]!;
	assert.deepEqual(entry.itemRefs.map((ref) => ref.itemId), input.snapshot.items.map((item) => item.id));
	assert.equal(entry.capturedAt, 17);
	assert.equal(entry.snapshot.tokens, 900);
	assert.equal(entry.source, "context-hook");
	assert.equal(entry.itemCount, 3);
	assert.ok(entry.snapshot.items.every((item) => !Object.hasOwn(item, "tokens")));
});

test("count eviction collects unused versions, retains shared versions, and isolates archives", () => {
	const archive = new ContextCaptureArchive({ maxCaptures: 2 });
	const first = archive.append(capture("first"));
	const firstId = first.entries[0]!.id;
	archive.append(capture("second", 2));
	const third = archive.append(capture("second", 3));
	assert.equal(third.entries.length, 2);
	assert.equal(third.versions.length, 1);
	assert.ok(!third.entries.some((entry) => entry.id === firstId));
	assert.equal(first.versions.length, 1);
	const other = new ContextCaptureArchive().append(capture("first"));
	assert.notEqual(other.entries[0]!.id, firstId);
	assert.equal(new ContextCaptureArchive().current().entries.length, 0);
});

test("default archive keeps at most 24 captures even when all versions are shared", () => {
	const archive = new ContextCaptureArchive();
	for (let index = 1; index <= 30; index += 1) archive.append(capture("same", index));
	assert.equal(archive.current().entries.length, 24);
	assert.equal(archive.current().entries[0]!.capturedAt, 7);
	assert.equal(archive.current().versions.length, 1);
});

test("runtime archives only context boundaries and resets evicted sessions without reusing capture IDs", async (t) => {
	const processState = createContextRailProcessState("capture-test");
	const runtime = createContextRailRuntime({ processState, maxSessionRuntimes: 1, connectHub: async () => undefined });
	let sessionId = "a";
	const ctx: ContextRailHostContext = {
		sessionManager: { getSessionId: () => sessionId, getSessionFile: () => sessionId },
		getContextUsage: () => undefined,
		getSystemPrompt: () => "",
		ui: { setStatus: () => undefined, setWidget: () => undefined, notify: () => undefined },
	};
	t.after(() => runtime.shutdown(ctx));
	runtime.context([{ id: "user", role: "user", content: "A only" }], ctx);
	const first = processState.runtimes.get("a")!.state.captures!;
	runtime.messageEnd({ id: "pending", role: "assistant", content: "not active yet" }, ctx);
	runtime.toolExecutionStart("call-1", "read", ctx);
	runtime.toolExecutionEnd("call-1", ctx);
	assert.equal(processState.runtimes.get("a")!.state.captures, first);
	runtime.compactionCommitted(ctx);
	runtime.context([{ id: "user", role: "user", content: "compact context" }], ctx);
	assert.equal(processState.runtimes.get("a")!.state.captures!.entries.at(-1)!.reason, "context-compaction");
	sessionId = "b";
	runtime.context([{ id: "user", role: "user", content: "B only" }], ctx);
	assert.equal(processState.runtimes.has("a"), false);
	assert.ok(!JSON.stringify(processState.runtimes.get("b")!.state.captures).includes("A only"));
	sessionId = "a";
	runtime.context([{ id: "user", role: "user", content: "A rebuilt" }], ctx);
	const rebuilt = processState.runtimes.get("a")!.state.captures!;
	assert.equal(rebuilt.entries.length, 1);
	assert.notEqual(rebuilt.entries[0]!.id, first.entries[0]!.id);
	assert.ok(!JSON.stringify(rebuilt).includes("A only"));
});

test("byte budget evicts old content and an individually oversized capture is explicitly omitted", () => {
	const archive = new ContextCaptureArchive({ maxBytes: 4096 });
	const first = archive.append(capture("a".repeat(2000)));
	assert.equal(first.entries[0]!.contentStatus, "available");
	const second = archive.append(capture("b".repeat(2000), 2));
	assert.equal(second.entries.length, 1);
	assert.equal(second.versions.length, 1);
	const third = archive.append(capture("c".repeat(9000), 3));
	const omitted = third.entries.at(-1)!;
	assert.equal(omitted.contentStatus, "omitted");
	assert.equal(omitted.omittedReason, "byte-limit");
	assert.equal(omitted.itemCount, 1);
	assert.equal(omitted.snapshot.tokens, 42);
	assert.deepEqual(omitted.snapshot.items, []);
	assert.deepEqual(omitted.itemRefs, []);
	assert.ok(!third.versions.some((version) => JSON.stringify(version).includes("c".repeat(100))));
	assert.ok(Buffer.byteLength(JSON.stringify(third)) <= 4096);
});

test("byte eviction counts multilingual and emoji content as UTF-8 bytes", () => {
	const archive = new ContextCaptureArchive({ maxBytes: 4096 });
	for (let index = 1; index <= 40; index += 1) {
		const result = archive.append(capture(`${index}:${"🐙汉".repeat(400)}`, index));
		assert.equal(result.entries.at(-1)!.contentStatus, "available");
		assert.ok(Buffer.byteLength(JSON.stringify(result), "utf8") <= 4096);
	}
	assert.equal(archive.current().entries.length, 1);
	assert.equal(archive.current().versions.length, 1);
});

test("oversize metadata is omitted too so long item IDs and model names cannot defeat byte bounds", () => {
	const archive = new ContextCaptureArchive({ maxBytes: 1024 });
	const input = capture("x", 1);
	const detail = input.details.values().next().value!;
	input.snapshot.items[0]!.id = "id".repeat(5000);
	input.details = new Map([[input.snapshot.items[0]!.id, detail]]);
	input.snapshot.model = "model".repeat(5000);
	const result = archive.append(input);
	assert.equal(result.entries[0]!.contentStatus, "omitted");
	assert.equal(result.versions.length, 0);
	assert.equal(result.entries[0]!.snapshot.model, undefined);
	assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 1024);
});

test("a missing historical detail remains unavailable and never falls back to a prior version", () => {
	const archive = new ContextCaptureArchive();
	archive.append(capture("original"));
	const input = capture("missing", 2);
	input.details.clear();
	const result = archive.append(input);
	const ref = result.entries[1]!.itemRefs[0]!;
	assert.equal(result.versions.find((version) => version.versionId === ref.versionId)!.detail, undefined);
	assert.equal(result.versions.length, 2);
});

test("capture deltas and chunks roundtrip with eviction even when timeline is absent or null", () => {
	const archive = new ContextCaptureArchive({ maxCaptures: 1 });
	const first = state(archive.append(capture("x".repeat(8000))));
	const firstPatch = diffRenderState(undefined, first);
	const chunks = chunkRenderStatePatch(firstPatch, 1024);
	assert.ok(chunks.length > 4);
	assert.deepEqual(applyRenderStatePatch(undefined, decodeRenderStatePatchChunks(chunks)), first);
	const second = state(archive.append(capture("new", 2)));
	const delta = diffRenderState(first, second);
	assert.equal(delta.timeline, null);
	assert.equal(delta.captures?.removedEntryIds?.length, 1);
	assert.equal(delta.captures?.removedVersionIds?.length, 1);
	assert.deepEqual(applyRenderStatePatch(first, decodeRenderStatePatchChunks(chunkRenderStatePatch(delta, 256))), second);
	const archiveOnly = { captures: delta.captures };
	assert.deepEqual(applyRenderStatePatch(first, archiveOnly), second);
	const without: RenderState = { snapshot: undefined, phase: "context", activeTools: [] };
	assert.deepEqual(applyRenderStatePatch(second, diffRenderState(second, without)), without);
	assert.deepEqual(applyRenderStatePatch(second, diffRenderState(second, first)), first);
});

test("archive producer and full/delta wire projections strip raw provider fields at every boundary", () => {
	const input = capture("visible");
	const detail = input.details.values().next().value! as ContextItemDetail & { providerPayload: string };
	detail.providerPayload = "RAW_SENTINEL";
	Object.assign(detail.modelMessages[0]!.blocks[0]!, { signature: "RAW_SENTINEL" });
	const archive = new ContextCaptureArchive().append(input);
	assert.ok(!JSON.stringify(archive).includes("RAW_SENTINEL"));
	const dirty = structuredClone(archive);
	Object.assign(dirty, { providerPayload: "RAW_SENTINEL" });
	Object.assign(dirty.entries[0]!, { providerCallId: "RAW_SENTINEL" });
	Object.assign(dirty.entries[0]!.snapshot.items[0]!, { content: "RAW_SENTINEL" });
	Object.assign(dirty.entries[0]!.itemRefs[0]!, { signature: "RAW_SENTINEL" });
	Object.assign(dirty.versions[0]!, { providerPayload: "RAW_SENTINEL" });
	Object.assign(dirty.versions[0]!.detail!, { providerPayload: "RAW_SENTINEL" });
	Object.assign(dirty.versions[0]!.detail!.modelMessages[0]!.blocks[0]!, { signature: "RAW_SENTINEL" });
	assert.deepEqual(projectRenderState(state(dirty)).captures, archive);
	const projected = projectRenderStatePatch({ captures: { reset: true, revision: 1, entryUpserts: dirty.entries, versionUpserts: dirty.versions, providerPayload: "RAW_SENTINEL" } });
	assert.ok(!JSON.stringify(projected).includes("RAW_SENTINEL"));
	assert.deepEqual(projected.captures?.entryUpserts, archive.entries);
	assert.deepEqual(projected.captures?.versionUpserts, archive.versions);
	assert.throws(() => projectRenderStatePatch({ captures: { entryUpserts: [{ ...archive.entries[0], source: "provider-invocation" }] } }), /source/);
});
