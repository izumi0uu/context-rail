import { createOmpContextRailExtension } from "./omp-extension.ts";

export function createContextRailExtension(
	...args: Parameters<typeof createOmpContextRailExtension>
): ReturnType<typeof createOmpContextRailExtension> {
	return createOmpContextRailExtension(...args);
}

export default createContextRailExtension();

export { createOmpContextRailExtension } from "./omp-extension.ts";
export { createPiContextRailExtension } from "./pi-extension.ts";
export type { ContextRailExtensionOptions } from "./extension-runtime.ts";
export { connectContextRailHub } from "./hub-client.ts";
export {
	applyRenderStatePatch,
	chunkRenderStatePatch,
	decodeRenderStatePatchChunks,
	diffRenderState,
} from "./hub-delta.ts";
export type {
	ChunkedRenderStatePatch,
	ContextTimelinePatch,
	RenderStatePatch,
} from "./hub-delta.ts";
export { streamIdFor } from "./hub-types.ts";
export {
	captureContext,
	ContextMessageIdentity,
	createContextItem,
	createContextItemDetail,
	createSnapshot,
} from "./snapshot.ts";
export { ContextTimeline, emptyTimelineSnapshot } from "./timeline.ts";
export { renderStatus, renderStrip, renderWidget } from "./render.ts";
export { startContextRailServer } from "./server.ts";
export type {
	ContextRailHubBootstrap,
	ContextRailHubUpdate,
	ContextRailPublishDeltaRequest,
	ContextRailSessionDelta,
	ContextRailSessionSource,
	ContextRailSessionState,
	ContextRailSessionSummary,
} from "./hub-types.ts";
export type { ContextRailViewer, ContextRailWebPayload } from "./server.ts";
export type {
	ContextDetailBlock,
	ContextDetailModelMessage,
	ContextDetailModelRole,
	ContextItem,
	ContextItemDetail,
	ContextItemKind,
	ContextSnapshot,
} from "./snapshot.ts";
export type {
	ContextTimelineSnapshot,
	HistoryItem,
	SummaryEdge,
} from "./timeline.ts";
