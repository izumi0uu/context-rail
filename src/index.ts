import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { connectContextRailHub } from "./hub-client.ts";
import type { ContextRailSessionSource } from "./hub-types.ts";
import type { OmpEventMap, OmpExtensionApi, OmpExtensionContext } from "./omp-types.ts";
import { renderStatus, renderWidget, type RenderState } from "./render.ts";
import type { ContextRailViewer } from "./server.ts";
import {
	captureContext,
	ContextMessageIdentity,
	createContextItem,
	createContextItemDetail,
	createSnapshot,
} from "./snapshot.ts";
import { ContextTimeline } from "./timeline.ts";

const UI_KEY = "context-rail";
const DEFAULT_MAX_SESSION_RUNTIMES = 100;

interface SessionRuntime {
	sessionId: string;
	sessionLabel: string;
	timeline: ContextTimeline;
	identity: ContextMessageIdentity;
	state: RenderState;
	compactionPending: boolean;
	activeTools: Map<string, string>;
}

function sessionIdentity(ctx: OmpExtensionContext): { id: string; label: string } {
	const manager = ctx.sessionManager;
	const id = manager?.getSessionId() || manager?.getSessionFile() || "default";
	const name = manager?.getSessionName?.();
	return {
		id,
		label: name?.trim() || (id === "default" ? "Current session" : id.slice(0, 8)),
	};
}

function processLabel(ctx: OmpExtensionContext): string {
	const cwd = ctx.cwd || ctx.sessionManager?.getCwd?.() || process.cwd();
	return basename(cwd) || `OMP ${process.pid}`;
}

function createRuntime(sessionId: string, sessionLabel: string): SessionRuntime {
	const timeline = new ContextTimeline();
	return {
		sessionId,
		sessionLabel,
		timeline,
		identity: new ContextMessageIdentity(),
		state: {
			snapshot: undefined,
			timeline: timeline.current(),
			phase: "idle",
			activeTools: [],
		},
		compactionPending: false,
		activeTools: new Map(),
	};
}

function completedSummaryCompaction(event: OmpEventMap["auto_compaction_end"]): boolean {
	return (
		(event.action === "context-full" || event.action === "snapcompact") &&
		!event.aborted &&
		!event.skipped &&
		typeof event.result?.summary === "string" &&
		event.result.summary.trim().length > 0
	);
}

export interface ContextRailExtensionOptions {
	startViewer?: () => Promise<ContextRailViewer>;
	connectHub?: (startIfMissing: boolean) => Promise<ContextRailViewer | undefined>;
	processId?: string;
	maxSessionRuntimes?: number;
}

export function createContextRailExtension(
	options: ContextRailExtensionOptions = {},
): (pi: OmpExtensionApi) => void {
	const maxSessionRuntimes = Number.isFinite(options.maxSessionRuntimes)
		? Math.max(1, Math.floor(options.maxSessionRuntimes ?? DEFAULT_MAX_SESSION_RUNTIMES))
		: DEFAULT_MAX_SESSION_RUNTIMES;

	return function contextRailExtension(pi: OmpExtensionApi): void {
		const processId = options.processId ?? `${process.pid}-${randomUUID()}`;
		const runtimes = new Map<string, SessionRuntime>();
		let activeSessionId: string | undefined;
		let expanded = false;
		let monitoringEnabled = true;
		let viewer: ContextRailViewer | undefined;
		let viewerPromise: Promise<ContextRailViewer | undefined> | undefined;
		let viewerPromiseStartsHub = false;
		let lastContext: OmpExtensionContext | undefined;

		const sourceFor = (
			runtime: SessionRuntime,
			ctx: OmpExtensionContext,
			active: boolean,
			activity = true,
		): ContextRailSessionSource => ({
			processId,
			processLabel: processLabel(ctx),
			sessionId: runtime.sessionId,
			sessionLabel: runtime.sessionLabel,
			active,
			activity,
		});

		const publishRuntime = (
			runtime: SessionRuntime,
			ctx: OmpExtensionContext,
			active: boolean,
			activity = true,
		): void => {
			viewer?.publish(runtime.state, sourceFor(runtime, ctx, active, activity));
		};

		const publishAll = (ctx: OmpExtensionContext): void => {
			const activeRuntime = activeSessionId ? runtimes.get(activeSessionId) : undefined;
			if (activeRuntime) publishRuntime(activeRuntime, ctx, true, false);
			for (const runtime of runtimes.values()) {
				if (runtime !== activeRuntime) publishRuntime(runtime, ctx, false, false);
			}
		};

		const connectViewer = async (
			startIfMissing: boolean,
			publishExisting = false,
		): Promise<ContextRailViewer | undefined> => {
			if (viewer) {
				if (!startIfMissing) return viewer;
				try {
					if (await viewer.healthy()) {
						if (publishExisting && lastContext) publishAll(lastContext);
						return viewer;
					}
				} catch {
					// Reconnect below.
				}
				viewer = undefined;
			}
			if (viewerPromise) {
				const pendingStartsHub = viewerPromiseStartsHub;
				const connected = await viewerPromise;
				if (connected || !startIfMissing || pendingStartsHub) return connected;
				return connectViewer(true, publishExisting);
			}

			viewerPromiseStartsHub = startIfMissing;
			const connection = (
				options.connectHub
					? options.connectHub(startIfMissing)
					: options.startViewer
					? startIfMissing
						? options.startViewer()
						: Promise.resolve(undefined)
					: connectContextRailHub({ processId, startIfMissing })
			)
				.then(async (connected) => {
					if (connected && !monitoringEnabled) {
						await connected.stop();
						return undefined;
					}
					viewer = connected;
					if (viewer && lastContext) publishAll(lastContext);
					return connected;
				});
			viewerPromise = connection;
			try {
				return await connection;
			} finally {
				if (viewerPromise === connection) {
					viewerPromise = undefined;
					viewerPromiseStartsHub = false;
				}
			}
		};

		const reconnectToAvailableHub = (): void => {
			if (!monitoringEnabled || viewer || viewerPromise || options.startViewer) return;
			void connectViewer(false).catch(() => undefined);
		};

		const stopMonitoring = async (): Promise<void> => {
			monitoringEnabled = false;
			const connected = viewer;
			const pending = viewerPromise;
			viewer = undefined;
			if (connected) await connected.stop();
			else await pending;
		};

		const runtimeFor = (ctx: OmpExtensionContext): SessionRuntime => {
			lastContext = ctx;
			const identity = sessionIdentity(ctx);
			let runtime = runtimes.get(identity.id);
			if (!runtime) {
				runtime = createRuntime(identity.id, identity.label);
				runtimes.set(identity.id, runtime);
			} else {
				runtime.sessionLabel = identity.label;
				runtimes.delete(identity.id);
				runtimes.set(identity.id, runtime);
			}
			return runtime;
		};

		const evictInactiveRuntimes = (): void => {
			while (runtimes.size > maxSessionRuntimes) {
				const oldestInactive = [...runtimes.keys()].find(
					(sessionId) => sessionId !== activeSessionId,
				);
				if (!oldestInactive) return;
				runtimes.delete(oldestInactive);
			}
		};

		const activate = (ctx: OmpExtensionContext): SessionRuntime => {
			const runtime = runtimeFor(ctx);
			if (activeSessionId && activeSessionId !== runtime.sessionId) {
				const previous = runtimes.get(activeSessionId);
				if (previous) publishRuntime(previous, ctx, false, false);
			}
			activeSessionId = runtime.sessionId;
			evictInactiveRuntimes();
			return runtime;
		};

		const refresh = (ctx: OmpExtensionContext, activity = true): void => {
			const runtime = activate(ctx);
			runtime.state.activeTools = [...runtime.activeTools.values()];
			ctx.ui.setStatus(UI_KEY, renderStatus(runtime.state));
			ctx.ui.setWidget(UI_KEY, expanded ? renderWidget(runtime.state) : undefined, {
				placement: "aboveEditor",
			});
			publishRuntime(runtime, ctx, true, activity);
			reconnectToAvailableHub();
		};

		pi.on("message_end", (event, ctx) => {
			const runtime = activate(ctx);
			const detail = createContextItemDetail(event.message);
			if (!detail) return;
			const previousRevision = runtime.state.timeline?.revision ?? -1;
			runtime.state.timeline = runtime.timeline.observe(
				createContextItem(event.message, runtime.identity),
				Date.now(),
				detail,
			);
			if (runtime.state.timeline.revision !== previousRevision) refresh(ctx);
		});

		pi.on("context", (event, ctx) => {
			const runtime = activate(ctx);
			const usage = ctx.getContextUsage();
			const capture = captureContext({
				messages: event.messages,
				identity: runtime.identity,
				...(usage ? { usage } : {}),
				...(ctx.model?.id ? { model: ctx.model.id } : {}),
				systemPrompt: ctx.getSystemPrompt(),
			});
			runtime.state.snapshot = capture.snapshot;
			runtime.state.timeline = runtime.timeline.apply(runtime.state.snapshot, {
				compaction: runtime.compactionPending,
				details: capture.details,
			});
			runtime.compactionPending = false;
			runtime.state.phase = "context";
			refresh(ctx);
		});

		pi.on("tool_execution_start", (event, ctx) => {
			const runtime = activate(ctx);
			runtime.activeTools.set(event.toolCallId, event.toolName);
			runtime.state.phase = "tool";
			refresh(ctx);
		});

		pi.on("tool_execution_end", (event, ctx) => {
			const runtime = activate(ctx);
			runtime.activeTools.delete(event.toolCallId);
			runtime.state.phase = runtime.activeTools.size > 0 ? "tool" : "context";
			refresh(ctx);
		});

		pi.on("auto_compaction_start", (_event, ctx) => {
			const runtime = activate(ctx);
			runtime.state.phase = "compacting";
			refresh(ctx);
		});

		pi.on("auto_compaction_end", (event, ctx) => {
			const runtime = activate(ctx);
			if (completedSummaryCompaction(event)) runtime.compactionPending = true;
			runtime.state.phase = "context";
			refresh(ctx);
		});

		pi.on("session_compact", (_event, ctx) => {
			const runtime = activate(ctx);
			runtime.compactionPending = true;
		});

		pi.on("session_start", (_event, ctx) => refresh(ctx, false));
		pi.on("session_switch", (_event, ctx) => refresh(ctx));
		pi.on("session_branch", (_event, ctx) => refresh(ctx));

		const heartbeat = setInterval(() => {
			const connected = viewer;
			if (!connected) {
				reconnectToAvailableHub();
				return;
			}
			connected.heartbeat(processId);
			void connected
				.healthy()
				.then((healthy) => {
					if (!healthy && viewer === connected) {
						connected.dispose?.();
						viewer = undefined;
						reconnectToAvailableHub();
					}
				})
				.catch(() => {
					if (viewer === connected) {
						connected.dispose?.();
						viewer = undefined;
						reconnectToAvailableHub();
					}
				});
		}, 10_000);
		heartbeat.unref();

		pi.on("session_shutdown", async (_event, ctx) => {
			clearInterval(heartbeat);
			const runtime = runtimeFor(ctx);
			publishRuntime(runtime, ctx, false, false);
			ctx.ui.setStatus(UI_KEY, undefined);
			ctx.ui.setWidget(UI_KEY, undefined, { placement: "aboveEditor" });
			await stopMonitoring();
		});

		pi.registerCommand("context-rail", {
			description: "Control the terminal strip or local web viewer",
			handler: async (args, ctx) => {
				const action = args.trim().toLowerCase() || "toggle";
				if (action === "web") {
					try {
						monitoringEnabled = true;
						const connected = await connectViewer(true, true);
						if (!connected) throw new Error("Hub did not start");
						ctx.ui.notify(`ContextRail viewer: ${connected.viewerUrl}`, "info");
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						ctx.ui.notify(`ContextRail viewer failed: ${message}`, "error");
					}
					return;
				}
				if (action === "stop") {
					await stopMonitoring();
					ctx.ui.notify("ContextRail monitoring stopped for this process", "info");
					return;
				}
				if (action === "show") expanded = true;
				else if (action === "hide") expanded = false;
				else if (action === "toggle") expanded = !expanded;
				else {
					ctx.ui.notify("Usage: /context-rail [show|hide|toggle|web|stop]", "warning");
					return;
				}
				refresh(ctx, false);
			},
		});
	};
}

export default createContextRailExtension();

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
export { createContextItem } from "./snapshot.ts";
export { captureContext, createContextItemDetail } from "./snapshot.ts";
export { createSnapshot } from "./snapshot.ts";
export { ContextMessageIdentity } from "./snapshot.ts";
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
