import assert from "node:assert/strict";
import test from "node:test";
import { startContextRailServer } from "../src/server.ts";

test("serves the viewer and publishes the latest snapshot over SSE", async (t) => {
	const viewer = await startContextRailServer({ html: "<!doctype html><title>test viewer</title>" });
	t.after(() => viewer.stop());

	viewer.publish({
		phase: "context",
		activeTools: [],
		snapshot: {
			createdAt: 1,
			model: "test-model",
			items: [{ id: "message-1", kind: "user" }],
		},
		timeline: {
			revision: 1,
			history: [{ id: "message-1", kind: "user", order: 0, firstSeenAt: 1, lastSeenAt: 1 }],
			activeIds: ["message-1"],
			enteredIds: ["message-1"],
			retainedIds: [],
			exitedIds: [],
			summaryEdges: [],
		},
	});

	const page = await fetch(viewer.url);
	assert.equal(page.status, 200);
	assert.match(await page.text(), /test viewer/);
	assert.equal(page.headers.get("cache-control"), "no-store");
	assert.match(page.headers.get("content-security-policy") ?? "", /connect-src 'self'/);

	const stream = await fetch(`${viewer.url}events`);
	assert.equal(stream.status, 200);
	assert.match(stream.headers.get("content-type") ?? "", /text\/event-stream/);
	assert.ok(stream.body);
	const reader = stream.body.getReader();
	const chunk = await reader.read();
	const text = new TextDecoder().decode(chunk.value);
	assert.match(text, /event: snapshot/);
	assert.match(text, /"model":"test-model"/);
	assert.match(text, /"activeIds":\["message-1"\]/);
	await reader.cancel();
});

test("rejects cross-origin reads", async (t) => {
	const viewer = await startContextRailServer({ html: "ok" });
	t.after(() => viewer.stop());

	const response = await fetch(`${viewer.url}health`, {
		headers: { Origin: "https://example.com" },
	});
	assert.equal(response.status, 403);
});
