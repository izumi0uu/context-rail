import assert from "node:assert/strict";
import test from "node:test";
import { LayoutWorkerClient, type LayoutWorkerPort } from "../web/src/layout-worker-client.ts";
import { LayoutWorkerState, layoutTimelineInput, type LayoutRequest } from "../web/src/layout-worker-state.ts";
import { buildSceneLayout } from "../web/src/scene-layout.ts";

const options = { nodeWidth: 176, nodeHeight: 92 };
const timeline = { history: [{ id: "one", kind: "user" }], activeIds: ["one"] };
class Port implements LayoutWorkerPort {
	onmessage: LayoutWorkerPort["onmessage"] = null;
	onerror: LayoutWorkerPort["onerror"] = null;
	request: LayoutRequest | undefined;
	terminated = false;
	postMessage(value: LayoutRequest | { forget: string }): void { if ("id" in value) this.request = value; }
	terminate(): void { this.terminated = true; }
	finish(): void {
		this.onmessage?.({ data: { id: this.request!.id, layout: buildSceneLayout(this.request!.timeline, options) } } as MessageEvent);
	}
}

test("worker input excludes message bodies and images even when callers pass full histories", () => {
	const item = { id: "one", kind: "user", order: 3, get detail(): never { throw new Error("must not access text"); } };
	const input = layoutTimelineInput({ history: [item], activeIds: ["one"] });
	assert.deepEqual(input.history, [{ id: "one", kind: "user", order: 3 }]);
});

test("worker layout matches canonical layout and caches at most four metadata scenes", () => {
	const state = new LayoutWorkerState();
	assert.deepEqual(state.compute({ id: 1, key: "session|live", timeline, options }), { id: 1, layout: buildSceneLayout(timeline, options) });
	for (let id = 2; id < 12; id++) state.compute({ id, key: `session|${id}`, timeline, options });
	assert.equal(state.size, 4);
	state.forget("session|");
	assert.equal(state.size, 0);
});

test("superseded worker requests release their promises and reject stale output/errors", async () => {
	const ports: Port[] = [];
	const client = new LayoutWorkerClient(() => { const port = new Port(); ports.push(port); return port; });
	const first = client.run("a|live", timeline, options);
	const second = client.run("b|live", timeline, options);
	assert.equal(await first, null);
	assert.equal(ports[0]!.terminated, true);
	ports[0]!.finish();
	ports[0]!.onerror?.({ message: "late terminated worker" } as ErrorEvent);
	assert.equal(ports[1]!.terminated, false);
	ports[1]!.finish();
	assert.deepEqual(await second, buildSceneLayout(timeline, options));
});

test("worker creation and execution errors are surfaced for the viewer fallback", async () => {
	const denied = new LayoutWorkerClient(() => { throw new Error("CSP denied"); });
	await assert.rejects(denied.run("a", timeline, options), /CSP denied/);
	const port = new Port(), client = new LayoutWorkerClient(() => port);
	const failed = client.run("a", timeline, options);
	port.onerror?.({ message: "load failed" } as ErrorEvent);
	await assert.rejects(failed, /load failed/);
	assert.equal(port.terminated, true);
});
