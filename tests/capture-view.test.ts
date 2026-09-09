import assert from "node:assert/strict";
import test from "node:test";
import {
	ContextCaptureArchive,
	type ContextCaptureArchiveSnapshot,
	type ContextCaptureEntry,
} from "../src/context-captures.ts";
import { applyRenderStatePatch, diffRenderState, type RenderStatePatch } from "../src/hub-delta.ts";
import type { RenderState } from "../src/render.ts";
import type { ContextCapture, ContextItemKind } from "../src/snapshot.ts";
import {
	applyCaptureArchivePatch,
	captureRenderState,
	compareCaptures,
	resolveCaptureItems,
} from "../web/src/capture-view.ts";

function capture(items: { id: string; text?: string; kind?: ContextItemKind; toolName?: string }[], at: number): ContextCapture {
	return {
		snapshot: {
			createdAt: at, tokens: 120, contextWindow: 1000, percent: 12,
			items: items.map(({ id, kind = "user", toolName }) => ({ id, kind, ...(toolName !== undefined ? { toolName } : {}) })),
		},
		details: new Map(items.filter((item) => item.text !== undefined).map((item) => [item.id, {
			sourceRole: item.kind === "tool" ? "toolResult" : item.kind ?? "user",
			modelMessages: [{
				modelRole: item.kind === "tool" ? "toolResult" as const : item.kind === "assistant" ? "assistant" as const : "user" as const,
				blocks: [{ type: "text" as const, text: item.text! }],
			}],
		}])),
	};
}

function state(captures?: ContextCaptureArchiveSnapshot): RenderState {
	return { snapshot: undefined, phase: "context", activeTools: [], ...(captures ? { captures } : {}) };
}

function browserApply(previous: RenderState | undefined, patch: RenderStatePatch): ContextCaptureArchiveSnapshot | undefined {
	// The browser outer state handler performs the top-level reset; archive
	// patching must remain independent of an omitted or explicitly null timeline.
	const base = patch.reset ? undefined : previous?.captures;
	return patch.captures === undefined ? base : applyCaptureArchivePatch(base, patch.captures);
}

test("frontend archive patches match canonical application for reset, eviction, removal, and absent timeline", () => {
	const archive = new ContextCaptureArchive({ maxCaptures: 2 });
	const states = [
		state(archive.append(capture([{ id: "same", text: "v1" }], 1))),
		state(archive.append(capture([{ id: "same", text: "v1" }, { id: "new", text: "v2" }], 2))),
		state(archive.append(capture([{ id: "same", text: "v3" }], 3))),
		state(archive.append(capture([{ id: "final", text: "v4" }], 4))),
		state(),
		state(new ContextCaptureArchive().append(capture([{ id: "reset", text: "isolated" }], 1))),
	];
	let previous: RenderState | undefined;
	for (const next of states) {
		const patch = diffRenderState(previous, next);
		const encoded = JSON.parse(JSON.stringify(patch)) as RenderStatePatch;
		assert.equal(encoded.timeline, null);
		assert.deepEqual(browserApply(previous, encoded), applyRenderStatePatch(previous, encoded).captures);
		assert.deepEqual(browserApply(previous, encoded), next.captures);
		const withoutTimeline = { ...encoded };
		delete withoutTimeline.timeline;
		assert.deepEqual(browserApply(previous, withoutTimeline), applyRenderStatePatch(previous, withoutTimeline).captures);
		previous = next;
	}
	const resetOnly: RenderStatePatch = { reset: true, phase: "idle" };
	assert.equal(browserApply(previous, resetOnly), applyRenderStatePatch(previous, resetOnly).captures);
	assert.equal(applyCaptureArchivePatch(states[0]!.captures, null), undefined);
});

test("incremental frontend patches preserve old archive snapshots and structurally share untouched records", () => {
	const archive = new ContextCaptureArchive({ maxCaptures: 2 });
	const first = archive.append(capture([{ id: "same", text: "old" }], 1));
	const second = archive.append(capture([{ id: "same", text: "new" }], 2));
	const previous = JSON.parse(JSON.stringify(first)) as ContextCaptureArchiveSnapshot;
	const before = structuredClone(previous);
	const patch = diffRenderState(state(first), state(second)).captures!;
	assert.ok(patch);
	const result = applyCaptureArchivePatch(previous, structuredClone(patch))!;
	assert.deepEqual(previous, before);
	assert.equal(result.entries[0], previous.entries[0]);
	assert.equal(result.versions[0], previous.versions[0]);
	assert.deepEqual(result, second);
	const third = archive.append(capture([{ id: "other", text: "third" }], 3));
	const eviction = diffRenderState(state(second), state(third)).captures!;
	applyCaptureArchivePatch(result, eviction);
	assert.deepEqual(previous, before);
	assert.deepEqual(result, second);
});

test("historical same-id content resolves its immutable version and cannot read the live replacement", () => {
	const archive = new ContextCaptureArchive();
	const first = archive.append(capture([{ id: "same", text: "historical exact content" }], 10));
	const current = archive.append(capture([{ id: "same", text: "LIVE REPLACEMENT" }], 20));
	const selected = current.entries[0]!;
	const historical = captureRenderState(current, selected);
	const live = captureRenderState(current, current.entries[1]!);
	assert.deepEqual(historical.timeline!.history[0]!.detail!.modelMessages[0]!.blocks, [{ type: "text", text: "historical exact content" }]);
	assert.deepEqual(live.timeline!.history[0]!.detail!.modelMessages[0]!.blocks, [{ type: "text", text: "LIVE REPLACEMENT" }]);
	assert.deepEqual(selected, first.entries[0]);
	assert.ok(!JSON.stringify(historical).includes("LIVE REPLACEMENT"));
	assert.equal(historical.snapshot?.tokens, 120);
	assert.equal(historical.snapshot?.createdAt, 10);
	assert.deepEqual(historical.activeTools, []);
	assert.deepEqual(historical.timeline!.pendingIds, []);
	assert.deepEqual(historical.timeline!.summaryEdges, []);
	assert.equal(historical.captures, undefined, "historical canvas must not carry a second live archive");
});

test("capture refs determine reader order independently of version/history storage order", () => {
	const archive = new ContextCaptureArchive();
	archive.append(capture([{ id: "a", text: "A" }, { id: "b", text: "B" }, { id: "tool", kind: "tool", toolName: "read", text: "Tool" }], 1));
	const current = archive.append(capture([{ id: "tool", kind: "tool", toolName: "read", text: "Tool" }, { id: "b", text: "B" }, { id: "a", text: "A" }], 2));
	const selected = current.entries[1]!;
	const shuffled = { ...current, versions: [...current.versions].reverse() };
	const items = resolveCaptureItems(shuffled, selected)!;
	assert.deepEqual(items.map((item) => item.id), ["tool", "b", "a"]);
	assert.deepEqual(items.map((item) => item.order), [0, 1, 2]);
	assert.equal(items[0]!.toolName, "read");
	assert.ok(items.every((item) => item.firstSeenAt === 2 && item.lastSeenAt === 2 && item.confirmedAt === 2));
	assert.deepEqual(captureRenderState(shuffled, selected).timeline!.activeIds, ["tool", "b", "a"]);
	assert.deepEqual(compareCaptures(shuffled, current.entries[0], selected), [], "reordering does not fabricate content changes or model invocations");
});

test("omitted captures and missing immutable versions are unavailable, never substituted with live content", () => {
	const archive = new ContextCaptureArchive({ maxBytes: 1024 });
	const initial = archive.append(capture([{ id: "same", text: "old" }], 1));
	const omittedArchive = archive.append(capture([{ id: "same", text: "large".repeat(1000) }], 2));
	const omitted = omittedArchive.entries.at(-1)!;
	assert.equal(omitted.contentStatus, "omitted");
	assert.equal(resolveCaptureItems(omittedArchive, omitted), undefined);
	assert.equal(compareCaptures(omittedArchive, initial.entries[0], omitted), undefined);
	assert.deepEqual(captureRenderState(omittedArchive, omitted).timeline!.history, []);
	const full = new ContextCaptureArchive();
	full.append(capture([{ id: "same", text: "old" }], 1));
	const available = full.append(capture([{ id: "same", text: "LIVE REPLACEMENT" }], 2));
	const missing = { ...available, versions: available.versions.slice(1) };
	assert.equal(resolveCaptureItems(missing, missing.entries[0]!), undefined);
	assert.equal(compareCaptures(missing, missing.entries[0], missing.entries[1]), undefined);
	assert.ok(!JSON.stringify(captureRenderState(missing, missing.entries[0]!)).includes("LIVE REPLACEMENT"));
	assert.deepEqual(captureRenderState(missing, missing.entries[0]!).timeline!.history, []);
});

test("a captured item without detail remains detail-unavailable even when another version has content", () => {
	const archive = new ContextCaptureArchive();
	archive.append(capture([{ id: "same", text: "prior content" }], 1));
	const current = archive.append(capture([{ id: "same" }], 2));
	const resolved = resolveCaptureItems(current, current.entries[1]!)!;
	assert.equal(resolved.length, 1);
	assert.equal(resolved[0]!.detail, undefined);
	assert.ok(!JSON.stringify(captureRenderState(current, current.entries[1]!)).includes("prior content"));
});

test("capture comparison reports only entered, exited, and same-item changed content with source IDs intact", () => {
	const archive = new ContextCaptureArchive();
	archive.append(capture([{ id: "retained", text: "same" }, { id: "changed", text: "old" }, { id: "exited", text: "gone" }], 1));
	const current = archive.append(capture([{ id: "entered", text: "new" }, { id: "changed", text: "updated" }, { id: "retained", text: "same" }], 2), { source: "session-reconstruction", reason: "session-tree" });
	const changes = compareCaptures(current, current.entries[0], current.entries[1])!;
	assert.deepEqual(changes.map(({ id, status }) => ({ id, status })), [
		{ id: "entered", status: "entered" },
		{ id: "changed", status: "changed" },
		{ id: "exited", status: "exited" },
	]);
	assert.equal(changes[0]!.before, undefined);
	assert.equal(changes[0]!.after!.id, "entered");
	assert.deepEqual(changes[1]!.before!.detail!.modelMessages[0]!.blocks, [{ type: "text", text: "old" }]);
	assert.deepEqual(changes[1]!.after!.detail!.modelMessages[0]!.blocks, [{ type: "text", text: "updated" }]);
	assert.equal(changes[2]!.after, undefined);
	assert.ok(changes.every((change) => !Object.hasOwn(change, "providerCallId") && !Object.hasOwn(change, "invocationId")));
	assert.equal(compareCaptures(current, undefined, current.entries[1]), undefined);
	assert.equal(compareCaptures(current, current.entries[0], undefined), undefined);
});

test("capture readers reject a version ref whose item ID does not match", () => {
	const archive = new ContextCaptureArchive().append(capture([{ id: "one", text: "one" }, { id: "two", text: "two" }], 1));
	const malformed: ContextCaptureEntry = { ...archive.entries[0]!, itemRefs: [{ itemId: "one", versionId: archive.versions[1]!.versionId }] };
	assert.equal(resolveCaptureItems(archive, malformed), undefined);
	assert.deepEqual(captureRenderState(archive, malformed).timeline!.history, []);
	assert.equal(compareCaptures(archive, archive.entries[0], malformed), undefined);
});
