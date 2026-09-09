import { buildSceneLayout, type SceneLayout, type SceneLayoutOptions, type SceneTimeline } from "./scene-layout.ts";

export interface LayoutRequest { id: number; key: string; timeline: SceneTimeline; options: SceneLayoutOptions }
export type LayoutResponse = { id: number; layout: SceneLayout } | { id: number; error: string };

/** Worker inputs contain geometry metadata only, never captured text or image data. */
export function layoutTimelineInput(timeline: SceneTimeline): SceneTimeline {
	return {
		history: timeline.history.map(({ id, kind, order, synthetic }) => ({ id,
			...(kind !== undefined ? { kind } : {}), ...(order !== undefined ? { order } : {}),
			...(synthetic !== undefined ? { synthetic } : {}),
		})),
		activeIds: [...(timeline.activeIds ?? [])], pendingIds: [...(timeline.pendingIds ?? [])],
		summaryEdges: (timeline.summaryEdges ?? []).map(({ from, to, kind }) => ({ from, to, kind })),
	};
}

export class LayoutWorkerState {
	private readonly layouts = new Map<string, SceneLayout>();
	private readonly maxScenes: number;
	constructor(maxScenes = 4) { this.maxScenes = Number.isFinite(maxScenes) ? Math.max(1, Math.floor(maxScenes)) : 4; }
	compute(request: LayoutRequest): LayoutResponse {
		try {
			const layout = buildSceneLayout(request.timeline, request.options, this.layouts.get(request.key));
			this.layouts.delete(request.key);
			this.layouts.set(request.key, layout);
			while (this.layouts.size > this.maxScenes) this.layouts.delete(this.layouts.keys().next().value!);
			return { id: request.id, layout };
		} catch (error) { return { id: request.id, error: error instanceof Error ? error.message : String(error) }; }
	}
	forget(prefix: string): void { for (const key of this.layouts.keys()) if (key.startsWith(prefix)) this.layouts.delete(key); }
	get size(): number { return this.layouts.size; }
}
