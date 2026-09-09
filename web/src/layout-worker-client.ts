import { layoutTimelineInput, type LayoutRequest, type LayoutResponse } from "./layout-worker-state.ts";
import type { SceneLayout, SceneLayoutOptions, SceneTimeline } from "./scene-layout.ts";

export interface LayoutWorkerPort {
	postMessage(value: LayoutRequest | { forget: string }): void;
	terminate(): void;
	onmessage: ((event: MessageEvent<LayoutResponse>) => void) | null;
	onerror: ((event: ErrorEvent) => void) | null;
}

/** At most one in-flight computation; superseded work is terminated, not queued indefinitely. */
export class LayoutWorkerClient {
	private worker: LayoutWorkerPort | null = null;
	private generation = 0;
	private pending: { id: number; resolve(value: SceneLayout | null): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> } | null = null;
	private readonly createWorker: () => LayoutWorkerPort;
	constructor(createWorker: () => LayoutWorkerPort = () => new Worker(new URL("./assets/scene-worker.js", location.href), { name: "ContextRail layout" })) { this.createWorker = createWorker; }
	run(key: string, timeline: SceneTimeline, options: SceneLayoutOptions): Promise<SceneLayout | null> {
		this.cancel();
		return new Promise((resolve, reject) => {
			try {
				if (!this.worker) this.worker = this.createWorker();
				const worker = this.worker;
				const id = ++this.generation;
				const timer = setTimeout(() => this.fail(new Error("Layout worker timed out")), 5_000);
				this.pending = { id, resolve, reject, timer };
				this.worker.onmessage = ({ data }) => {
					if (!this.pending || data.id !== this.pending.id) return;
					if ("error" in data) { this.fail(new Error(data.error)); return; }
					clearTimeout(this.pending.timer);
					this.pending = null;
					resolve(data.layout);
				};
				this.worker.onerror = (event) => {
					if (this.worker === worker && this.pending?.id === id) this.fail(new Error(event.message || "Layout worker unavailable"));
				};
				this.worker.postMessage({ id, key, timeline: layoutTimelineInput(timeline), options });
			} catch (error) {
				this.fail(error instanceof Error ? error : new Error(String(error)));
				reject(error);
			}
		});
	}
	cancel(): void {
		if (!this.pending) return;
		clearTimeout(this.pending.timer);
		this.pending.resolve(null);
		this.pending = null;
		this.worker?.terminate();
		this.worker = null;
	}
	forget(prefix: string): void { this.worker?.postMessage({ forget: prefix }); }
	private fail(error: Error): void {
		if (this.pending) { clearTimeout(this.pending.timer); this.pending.reject(error); this.pending = null; }
		this.worker?.terminate();
		this.worker = null;
	}
}
