import { LayoutWorkerState, type LayoutRequest } from "./layout-worker-state.ts";

const state = new LayoutWorkerState();
const host = globalThis as unknown as {
	onmessage: ((event: MessageEvent<LayoutRequest | { forget: string }>) => void) | null;
	postMessage(value: unknown): void;
};
host.onmessage = ({ data }) => {
	if ("forget" in data) state.forget(data.forget);
	else host.postMessage(state.compute(data));
};
