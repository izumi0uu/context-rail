import assert from "node:assert/strict";
import test from "node:test";
import {
	captureContext,
	classifyMessage,
	ContextMessageIdentity,
	createContextItem,
	createContextItemDetail,
	createSnapshot,
} from "../src/snapshot.ts";
import { ContextTimeline } from "../src/timeline.ts";

test("classifies common OMP message shapes", () => {
	assert.equal(classifyMessage({ role: "user" }), "user");
	assert.equal(classifyMessage({ role: "developer" }), "developer");
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
			{ id: "message-local-1", kind: "user" },
			{ id: "message-local-2", kind: "assistant" },
			{ id: "message-local-3", kind: "tool", toolName: "read" },
		],
	});
});

test("captures allowlisted model-context details for supported OMP messages", () => {
	const capture = captureContext({
		systemPrompt: "System instructions",
		messages: [
			{ role: "user", content: "User text" },
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "Prior reasoning", thinkingSignature: "private" },
					{ type: "toolCall", id: "private-call", name: "read", arguments: { path: "a.ts" } },
				],
			},
			{
				role: "toolResult",
				toolName: "read",
				toolCallId: "private-result",
				isError: false,
				content: [{ type: "image", mimeType: "image/png", data: "aGVsbG8=" }],
				details: { private: true },
			},
			{ role: "bashExecution", command: "pwd", output: "/tmp", exitCode: 0 },
			{ role: "custom", customType: "notice", content: "Custom context" },
			{ role: "branchSummary", summary: "Branch facts" },
			{ role: "compactionSummary", summary: "Compact facts" },
			{ role: "bashExecution", command: "secret", output: "hidden", excludeFromContext: true },
		],
		now: 1,
	});

	assert.equal(capture.snapshot.items.length, 8);
	assert.equal(capture.snapshot.items.at(-1)?.kind, "memory");
	assert.deepEqual(capture.details.get("system-prompt"), {
		sourceRole: "system",
		modelMessages: [{
			modelRole: "system",
			blocks: [{ type: "text", text: "System instructions" }],
		}],
	});
	assert.deepEqual(capture.details.get(capture.snapshot.items[1]!.id)?.modelMessages[0]?.blocks, [
		{ type: "text", text: "User text" },
	]);
	assert.deepEqual(capture.details.get(capture.snapshot.items[2]!.id)?.modelMessages[0]?.blocks, [
		{ type: "thinking", text: "Prior reasoning" },
		{ type: "toolCall", name: "read", argumentsJson: '{"path":"a.ts"}' },
	]);
	assert.deepEqual(capture.details.get(capture.snapshot.items[3]!.id), {
		sourceRole: "toolResult",
		modelMessages: [{
			modelRole: "toolResult",
			blocks: [{ type: "image", mimeType: "image/png", data: "aGVsbG8=" }],
		}],
		isError: false,
	});
	assert.match(capture.details.get(capture.snapshot.items[4]!.id)?.modelMessages[0]?.blocks[0]?.text ?? "", /Ran `pwd`/);
	assert.match(capture.details.get(capture.snapshot.items[6]!.id)?.modelMessages[0]?.blocks[0]?.text ?? "", /Branch facts/);
	assert.match(capture.details.get(capture.snapshot.items[7]!.id)?.modelMessages[0]?.blocks[0]?.text ?? "", /Compact facts/);
	assert.doesNotMatch(JSON.stringify(capture), /private-call|private-result|thinkingSignature|"private":true/);
});

test("mirrors OMP developer roles and image-bearing custom message splits", () => {
	assert.deepEqual(createContextItemDetail({ role: "developer", content: "Direct policy" }), {
		sourceRole: "developer",
		modelMessages: [{
			modelRole: "developer",
			blocks: [{ type: "text", text: "Direct policy" }],
		}],
	});
	assert.doesNotMatch(JSON.stringify(createContextItemDetail({
		role: "developer",
		content: "Visible policy",
		providerPayload: { secret: "provider-state" },
	})), /provider-state|providerPayload/);
	assert.deepEqual(createContextItemDetail({ role: "custom", content: "Injected context" }), {
		sourceRole: "custom",
		modelMessages: [{
			modelRole: "developer",
			blocks: [{ type: "text", text: "Injected context" }],
		}],
	});
	assert.deepEqual(createContextItemDetail({ role: "hookMessage", content: "Legacy context" }), {
		sourceRole: "hookMessage",
		modelMessages: [{
			modelRole: "developer",
			blocks: [{ type: "text", text: "Legacy context" }],
		}],
	});
	assert.deepEqual(createContextItemDetail({
		role: "custom",
		customType: "browser-capture",
		content: [
			{ type: "image", mimeType: "image/png", data: "cGl4ZWxz" },
			{ type: "text", text: "Screenshot context" },
		],
	}), {
		sourceRole: "custom",
		modelMessages: [
			{
				modelRole: "developer",
				blocks: [{ type: "text", text: "Screenshot context" }],
			},
			{
				modelRole: "user",
				blocks: [
					{ type: "text", text: "Images attached to browser-capture." },
					{ type: "image", mimeType: "image/png", data: "cGl4ZWxz" },
				],
			},
		],
	});
	assert.deepEqual(createContextItemDetail({
		role: "custom",
		customType: "skill-prompt",
		attribution: "user",
		content: "User-invoked skill",
	}), {
		sourceRole: "custom",
		modelMessages: [{
			modelRole: "user",
			blocks: [{ type: "text", text: "User-invoked skill" }],
		}],
	});
});

test("preserves OMP compaction blocks without exposing provider payloads", () => {
	const withBlocks = createContextItemDetail({
		role: "compactionSummary",
		summary: "Final lead-in",
		blocks: [
			{ type: "text", text: "Archived text" },
			{ type: "image", mimeType: "image/webp", data: "aW1hZ2U=" },
		],
		images: [{ type: "image", mimeType: "image/png", data: "aWdub3JlZA==" }],
		providerPayload: { secret: "provider-state" },
	});
	assert.deepEqual(withBlocks, {
		sourceRole: "compactionSummary",
		modelMessages: [{
			modelRole: "user",
			blocks: [
				{ type: "text", text: "Final lead-in" },
				{ type: "text", text: "Archived text" },
				{ type: "image", mimeType: "image/webp", data: "aW1hZ2U=" },
			],
		}],
	});
	assert.doesNotMatch(JSON.stringify(withBlocks), /provider-state|providerPayload|aWdub3JlZA/);

	const legacy = createContextItemDetail({
		role: "compactionSummary",
		summary: "Legacy summary",
		images: [{ type: "image", mimeType: "image/png", data: "bGVnYWN5" }],
	});
	const legacyBlocks = legacy?.modelMessages[0]?.blocks ?? [];
	assert.equal(
		legacyBlocks[0]?.type === "text" ? legacyBlocks[0].text : "",
		"Another language model started to solve this problem and produced a summary of its thinking process. You also have access to the state of the tools that model used. You MUST build on the work already done and NEVER duplicate it. Here is that summary:\n\n<summary>\nLegacy summary\n</summary>",
	);
	assert.deepEqual(legacyBlocks[1], {
		type: "image",
		mimeType: "image/png",
		data: "bGVnYWN5",
	});
});

test("captures Python execution and mixed file mentions as model-visible blocks", () => {
	assert.deepEqual(createContextItemDetail({
		role: "pythonExecution",
		code: "print(42)",
		output: "42",
		exitCode: 0,
	}), {
		sourceRole: "pythonExecution",
		modelMessages: [{
			modelRole: "user",
			blocks: [{
				type: "text",
				text: "Ran Python:\n```python\nprint(42)\n```\nOutput:\n```\n42\n```",
			}],
		}],
	});
	assert.deepEqual(createContextItemDetail({
		role: "fileMention",
		files: [
			{ path: "notes.md", content: "Facts" },
			{
				path: "screen.png",
				content: "",
				image: { type: "image", mimeType: "image/png", data: "c2NyZWVu" },
			},
		],
	}), {
		sourceRole: "fileMention",
		modelMessages: [
			{
				modelRole: "developer",
				blocks: [{ type: "text", text: '<file path="notes.md">\nFacts\n</file>' }],
			},
			{
				modelRole: "user",
				blocks: [
					{ type: "text", text: '<file path="screen.png">\n</file>' },
					{ type: "image", mimeType: "image/png", data: "c2NyZWVu" },
				],
			},
		],
	});
	assert.equal(createContextItemDetail({
		role: "pythonExecution",
		code: "secret()",
		output: "hidden",
		excludeFromContext: true,
	}), undefined);
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

test("uses intrinsic identifiers as private anchors for opaque stable ids", () => {
	const identity = new ContextMessageIdentity();
	const first = createSnapshot({
		messages: [{ id: "turn-42", role: "assistant" }, { toolCallId: 19, role: "toolResult" }],
		identity,
		now: 1,
	});
	const recreated = createSnapshot({
		messages: [{ id: "turn-42", role: "assistant" }, { toolCallId: 19, role: "toolResult" }],
		identity,
		now: 2,
	});

	assert.deepEqual(first.items.map((item) => item.id), ["message-local-1", "message-local-2"]);
	assert.deepEqual(recreated.items.map((item) => item.id), first.items.map((item) => item.id));
	assert.doesNotMatch(JSON.stringify(recreated), /turn-42|message-19/);
});

test("reconciles lifecycle messages and context clones by timestamp", () => {
	const identity = new ContextMessageIdentity();
	const observed = createContextItem({ role: "assistant", timestamp: 42 }, identity);
	const snapshot = createSnapshot({
		messages: [{ role: "assistant", timestamp: 42 }],
		identity,
		now: 43,
	});
	assert.equal(observed.id, "message-local-1");
	assert.equal(snapshot.items[0]?.id, observed.id);
	assert.notEqual(
		createContextItem({ role: "user", timestamp: 42 }, identity).id,
		observed.id,
	);
});

test("keeps repeated anchored lifecycle occurrences distinct through context", () => {
	for (const anchor of [
		{ id: "shared-raw-message-id" },
		{ toolCallId: "shared-raw-tool-call" },
		{ timestamp: "shared-raw-timestamp" },
	]) {
		const identity = new ContextMessageIdentity();
		const observed = [
			createContextItem({ role: "assistant", ...anchor }, identity),
			createContextItem({ role: "assistant", ...anchor }, identity),
		];
		const snapshot = createSnapshot({
			messages: [{ role: "assistant", ...anchor }, { role: "assistant", ...anchor }],
			identity,
			now: 1,
		});
		const timeline = new ContextTimeline();
		for (const item of observed) timeline.observe(item);
		const confirmed = timeline.apply(snapshot);

		assert.deepEqual(observed.map((item) => item.id), ["message-local-1", "message-local-2"]);
		assert.deepEqual(snapshot.items.map((item) => item.id), observed.map((item) => item.id));
		assert.deepEqual(confirmed.activeIds, observed.map((item) => item.id));
		assert.equal(confirmed.history.length, 2);
	}
});

test("reconciles a unique lifecycle fallback with its context clone", () => {
	const identity = new ContextMessageIdentity();
	const previous = createSnapshot({
		messages: [{ role: "user" }],
		identity,
		now: 1,
	});
	const observed = createContextItem({ role: "assistant" }, identity);
	const snapshot = createSnapshot({
		messages: [{ role: "user" }, { role: "assistant" }],
		identity,
		now: 2,
	});

	assert.equal(snapshot.items[0]?.id, previous.items[0]?.id);
	assert.equal(snapshot.items[1]?.id, observed.id);
});

test("reconciles ordered lifecycle fallback occurrences when counts align", () => {
	const identity = new ContextMessageIdentity();
	const observedIds = [
		createContextItem({ role: "assistant" }, identity).id,
		createContextItem({ role: "assistant" }, identity).id,
	];
	const snapshot = createSnapshot({
		messages: [{ role: "assistant" }, { role: "assistant" }],
		identity,
		now: 1,
	});

	assert.deepEqual(snapshot.items.map((item) => item.id), observedIds);
});

test("does not let a lifecycle fallback replace a same-length context clone", () => {
	const identity = new ContextMessageIdentity();
	createSnapshot({ messages: [{ role: "user" }], identity, now: 1 });
	const observed = createContextItem({ role: "user" }, identity);
	const sameLength = createSnapshot({ messages: [{ role: "user" }], identity, now: 2 });

	assert.notEqual(sameLength.items[0]?.id, observed.id);
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

test("keeps recreated same-length fallback sequences stable", () => {
	const identity = new ContextMessageIdentity();
	const first = createSnapshot({
		messages: [{ role: "user" }, { role: "assistant" }],
		identity,
		now: 1,
	});
	const recreated = createSnapshot({
		messages: [{ role: "user" }, { role: "assistant" }],
		identity,
		now: 2,
	});
	assert.deepEqual(
		recreated.items.map((item) => item.id),
		first.items.map((item) => item.id),
	);
});

test("does not positionally reuse ids when a recreated sequence changes", () => {
	const identity = new ContextMessageIdentity();
	const first = createSnapshot({
		messages: [{ role: "user" }, { role: "assistant" }],
		identity,
		now: 1,
	});
	const reordered = createSnapshot({
		messages: [{ role: "assistant" }, { role: "user" }],
		identity,
		now: 2,
	});

	assert.equal(reordered.items.some((item) => first.items.some((old) => old.id === item.id)), false);
});

test("serializes allowlisted content without raw anchors, timestamps, or signatures", () => {
	const identity = new ContextMessageIdentity();
	const message = {
		id: "raw-message-id-sentinel",
		toolCallId: "raw-tool-call-sentinel",
		timestamp: "raw-message-timestamp-sentinel",
		role: "assistant",
		content: [{
			type: "text",
			text: "visible-message-content-sentinel",
			textSignature: "private-text-signature-sentinel",
		}],
	};
	const observed = createContextItem(message, identity);
	const timeline = new ContextTimeline();
	const detail = createContextItemDetail(message);
	const pending = timeline.observe(observed, 6, detail);
	const capture = captureContext({
		messages: [{ ...message }],
		identity,
		systemPrompt: "visible-system-prompt",
		now: 7,
	});
	const confirmed = timeline.apply(capture.snapshot, { details: capture.details });
	const serialized = JSON.stringify({ snapshot: capture.snapshot, pending, confirmed });

	assert.equal(capture.snapshot.items[0]?.id, "system-prompt");
	assert.match(observed.id, /^message-local-\d+$/);
	assert.match(serialized, /visible-message-content-sentinel|visible-system-prompt/);
	for (const sentinel of [message.id, message.toolCallId, message.timestamp, "private-text-signature-sentinel"]) {
		assert.equal(serialized.includes(sentinel), false);
	}
});
