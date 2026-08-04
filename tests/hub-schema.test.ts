import assert from "node:assert/strict";
import test from "node:test";
import { projectRenderState, projectRenderStatePatch } from "../src/hub-schema.ts";

test("projects render states onto the allowlisted detail wire schema", () => {
	const projected = projectRenderState({
		phase: "context",
		activeTools: ["read"],
		content: "top-level-secret",
		snapshot: {
			createdAt: 10,
			model: "test-model",
			items: [{ id: "message-1", kind: "user", content: "snapshot-secret" }],
		},
		timeline: {
			revision: 1,
			history: [{
				id: "message-1",
				kind: "user",
				order: 0,
				firstSeenAt: 10,
				lastSeenAt: 10,
				content: "history-secret",
				detail: {
					sourceRole: "user",
					modelMessages: [
						{
							modelRole: "developer",
							blocks: [{ type: "text", text: "visible context", signature: "secret" }],
						},
						{
							modelRole: "user",
							blocks: [{ type: "image", mimeType: "image/png", data: "cGl4ZWxz", id: "secret" }],
						},
					],
					private: "secret",
				},
			}],
			activeIds: ["message-1"],
			enteredIds: ["message-1"],
			retainedIds: [],
			exitedIds: [],
			observedIds: [],
			confirmedIds: [],
			pendingIds: [],
			summaryEdges: [],
		},
	});

	assert.deepEqual(projected, {
		phase: "context",
		activeTools: ["read"],
		snapshot: {
			createdAt: 10,
			model: "test-model",
			items: [{ id: "message-1", kind: "user" }],
		},
		timeline: {
			revision: 1,
			history: [{
				id: "message-1",
				kind: "user",
				order: 0,
				firstSeenAt: 10,
				lastSeenAt: 10,
				detail: {
					sourceRole: "user",
					modelMessages: [
						{
							modelRole: "developer",
							blocks: [{ type: "text", text: "visible context" }],
						},
						{
							modelRole: "user",
							blocks: [{ type: "image", mimeType: "image/png", data: "cGl4ZWxz" }],
						},
					],
				},
			}],
			activeIds: ["message-1"],
			enteredIds: ["message-1"],
			retainedIds: [],
			exitedIds: [],
			observedIds: [],
			confirmedIds: [],
			pendingIds: [],
			summaryEdges: [],
		},
	});
});

test("projects decoded patches and rejects malformed declared fields", () => {
	assert.deepEqual(projectRenderStatePatch({
		reset: true,
		snapshot: null,
		timeline: null,
	}), {
		reset: true,
		snapshot: null,
		timeline: null,
	});

	assert.deepEqual(projectRenderStatePatch({
		secret: "top-level-secret",
		snapshot: {
			createdAt: 20,
			items: [{ id: "message-2", kind: "assistant", content: "snapshot-secret" }],
		},
		timeline: {
			historyUpserts: [{
				id: "message-2",
				kind: "assistant",
				order: 1,
				firstSeenAt: 20,
				lastSeenAt: 20,
				content: "history-secret",
				detail: {
					sourceRole: "assistant",
					modelMessages: [{
						modelRole: "assistant",
						blocks: [{
							type: "toolCall",
							name: "read",
							argumentsJson: '{"path":"a.ts"}',
							id: "secret",
						}],
					}],
				},
			}],
		},
	}), {
		snapshot: {
			createdAt: 20,
			items: [{ id: "message-2", kind: "assistant" }],
		},
		timeline: {
			historyUpserts: [{
				id: "message-2",
				kind: "assistant",
				order: 1,
				firstSeenAt: 20,
				lastSeenAt: 20,
				detail: {
					sourceRole: "assistant",
					modelMessages: [{
						modelRole: "assistant",
						blocks: [{ type: "toolCall", name: "read", argumentsJson: '{"path":"a.ts"}' }],
					}],
				},
			}],
		},
	});

	assert.throws(
		() => projectRenderState({ phase: "context", activeTools: [42] }),
		/activeTools\[0\]/,
	);
	assert.throws(
		() => projectRenderState({ phase: "context", activeTools: [], snapshot: { createdAt: 1, items: [{ id: "x", kind: "message" }] } }),
		/snapshot\.items\[0\]\.kind/,
	);
	assert.throws(
		() => projectRenderStatePatch({ timeline: { historyUpserts: [{ id: "x", kind: "user" }] } }),
		/order/,
	);
	assert.throws(
		() => projectRenderStatePatch({
			timeline: {
				historyUpserts: [{
					id: "x",
					kind: "user",
					order: 0,
					firstSeenAt: 1,
					lastSeenAt: 1,
					detail: {
						sourceRole: "user",
						modelMessages: [{ modelRole: "provider", blocks: [] }],
					},
				}],
			},
		}),
		/model role/,
	);
});
