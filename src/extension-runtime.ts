import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { connectContextRailHub } from "./hub-client.ts";
import type { ContextRailSessionSource } from "./hub-types.ts";
import type { ContextRailHostContext } from "./host-types.ts";
import { renderStatus, renderWidget, type RenderState } from "./render.ts";
import type { ContextRailViewer } from "./server.ts";
import {
	captureContext,
	ContextMessageIdentity,
	createContextItem,
	createContextItemDetail,
	type ContextItemDetailFactory,
	type ContextMessageLike,
} from "./snapshot.ts";
import { ContextTimeline } from "./timeline.ts";

const UI_KEY = "context-rail";
const DEFAULT_MAX_SESSION_RUNTIMES = 100;
const RECONNECT_PROBE_INTERVAL_MS = 5_000;

const PROCESS_ID_KEY = Symbol.for("context-rail.process-id.v1");

export function defaultContextRailProcessId(): string {
	const globals = globalThis as unknown as Record<PropertyKey, unknown>;
	const existing = globals[PROCESS_ID_KEY];
	if (typeof existing === "string" && existing.length > 0) return existing;
	const processId = `${process.pid}-${randomUUID()}`;
	globals[PROCESS_ID_KEY] = processId;
	return processId;
}

interface SessionRuntime {
	sessionId: string;
	sessionLabel: string;
	timeline: ContextTimeline;
	identity: ContextMessageIdentity;
	state: RenderState;
	compactionPending: boolean;
	activeTools: Map<string, string>;
}

export interface ContextRailProcessState {
	readonly schemaVersion: 1;
	readonly pid: number;
	readonly processId: string;
	readonly runtimes: Map<string, SessionRuntime>;
	activeSessionId?: string;
	expanded: boolean;
	monitoringEnabled: boolean;
}

export function createContextRailProcessState(
	processId = defaultContextRailProcessId(),
): ContextRailProcessState {
	return {
		schemaVersion: 1,
		pid: process.pid,
		processId,
		runtimes: new Map(),
		expanded: false,
		monitoringEnabled: true,
	};
}

function sessionIdentity(ctx: ContextRailHostContext): { id: string; label: string } {
	const manager = ctx.sessionManager;
	const id = manager?.getSessionId() || manager?.getSessionFile() || "default";
	const name = manager?.getSessionName?.();
	return {
		id,
		label: name?.trim() || (id === "default" ? "Current session" : id.slice(0, 8)),
	};
}

function processLabel(ctx: ContextRailHostContext): string {
	const cwd = ctx.cwd || ctx.sessionManager?.getCwd?.() || process.cwd();
	return basename(cwd) || `Agent ${process.pid}`;
}

function createSessionRuntime(sessionId: string, sessionLabel: string): SessionRuntime {
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

export interface ContextRailExtensionOptions {
	startViewer?: () => Promise<ContextRailViewer>;
	connectHub?: (startIfMissing: boolean) => Promise<ContextRailViewer | undefined>;
	processId?: string;
	processState?: ContextRailProcessState;
	maxSessionRuntimes?: number;
}

export interface ContextRailRuntimeAdapter {
	createContextItemDetail?: ContextItemDetailFactory;
}

export interface ContextRailContextOptions {
	compaction?: boolean;
	activity?: boolean;
}

export type ContextRailRuntimeShutdownMode = "quit" | "handoff";

export interface ContextRailExtensionRuntime {
	messageEnd(message: ContextMessageLike, ctx: ContextRailHostContext): void;
	context(
		messages: readonly ContextMessageLike[],
		ctx: ContextRailHostContext,
		options?: ContextRailContextOptions,
	): void;
	toolExecutionStart(
		toolCallId: string,
		toolName: string,
		ctx: ContextRailHostContext,
	): void;
	toolExecutionEnd(toolCallId: string, ctx: ContextRailHostContext): void;
	compactionStarted(ctx: ContextRailHostContext): void;
	compactionFinished(ctx: ContextRailHostContext, committed: boolean): void;
	compactionCommitted(ctx: ContextRailHostContext): void;
	sessionActivated(ctx: ContextRailHostContext, activity?: boolean): void;
	command(args: string, ctx: ContextRailHostContext): Promise<void>;
	shutdown(
		ctx: ContextRailHostContext,
		mode?: ContextRailRuntimeShutdownMode,
	): Promise<void>;
}

export function createContextRailRuntime(
	options: ContextRailExtensionOptions = {},
	adapter: ContextRailRuntimeAdapter = {},
): ContextRailExtensionRuntime {
	const maxSessionRuntimes = Number.isFinite(options.maxSessionRuntimes)
		? Math.max(1, Math.floor(options.maxSessionRuntimes ?? DEFAULT_MAX_SESSION_RUNTIMES))
		: DEFAULT_MAX_SESSION_RUNTIMES;
	const processState = options.processState ?? createContextRailProcessState(options.processId);
	if (options.processId && options.processId !== processState.processId) {
		throw new Error("ContextRail processId does not match processState");
	}
	const processId = processState.processId;
	const runtimes = processState.runtimes;
	const detailForMessage = adapter.createContextItemDetail ?? createContextItemDetail;
	let viewer: ContextRailViewer | undefined;
	let viewerPromise: Promise<ContextRailViewer | undefined> | undefined;
	let viewerPromiseStartsHub = false;
	let lastContext: ContextRailHostContext | undefined;
	let closed = false;
	let shutdownMode: ContextRailRuntimeShutdownMode | undefined;
	let lastReconnectProbeAt = 0;
	let viewerControlChain = Promise.resolve();

	const sourceFor = (
		runtime: SessionRuntime,
		ctx: ContextRailHostContext,
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
		ctx: ContextRailHostContext,
		active: boolean,
		activity = true,
	): void => {
		if (closed) return;
		if (!processState.monitoringEnabled) {
			const connected = viewer;
			viewer = undefined;
			connected?.dispose?.();
			return;
		}
		viewer?.publish(runtime.state, sourceFor(runtime, ctx, active, activity));
	};

	const publishAll = (ctx: ContextRailHostContext): void => {
		const activeRuntime = processState.activeSessionId
			? runtimes.get(processState.activeSessionId)
			: undefined;
		if (activeRuntime) publishRuntime(activeRuntime, ctx, true, false);
		for (const runtime of runtimes.values()) {
			if (runtime !== activeRuntime) publishRuntime(runtime, ctx, false, false);
		}
	};

	const connectViewer = async (
		startIfMissing: boolean,
		publishExisting = false,
	): Promise<ContextRailViewer | undefined> => {
		if (closed) return undefined;
		if (viewer) {
			const connectedViewer = viewer;
			if (!startIfMissing) return connectedViewer;
			try {
				const healthy = await connectedViewer.healthy();
				if (
					closed ||
					!processState.monitoringEnabled ||
					viewer !== connectedViewer
				) return undefined;
				if (healthy) {
					if (publishExisting && lastContext) publishAll(lastContext);
					return connectedViewer;
				}
			} catch {
				if (closed || viewer !== connectedViewer) return undefined;
				// Reconnect below.
			}
			if (viewer === connectedViewer) viewer = undefined;
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
		).then(async (connected) => {
			if (connected && closed) {
				if (shutdownMode === "quit" || !processState.monitoringEnabled) {
					await connected.stop();
				} else connected.dispose?.();
				return undefined;
			}
			if (connected && !processState.monitoringEnabled) {
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
		if (
			closed ||
			!processState.monitoringEnabled ||
			viewer ||
			viewerPromise ||
			options.startViewer
		) return;
		const now = Date.now();
		if (now - lastReconnectProbeAt < RECONNECT_PROBE_INTERVAL_MS) return;
		lastReconnectProbeAt = now;
		void connectViewer(false)
			.then((connected) => {
				if (connected) lastReconnectProbeAt = 0;
			})
			.catch(() => undefined);
	};

	const stopMonitoring = async (): Promise<void> => {
		processState.monitoringEnabled = false;
		const connected = viewer;
		const pending = viewerPromise;
		viewer = undefined;
		try {
			if (connected) await connected.stop();
			else await pending;
		} catch {
			// Local monitoring is already disabled; Hub disconnect is best effort.
		}
	};

	const closeViewer = async (mode: ContextRailRuntimeShutdownMode): Promise<void> => {
		const connected = viewer;
		const pending = viewerPromise;
		viewer = undefined;
		if (connected) {
			if (mode === "quit") await connected.stop();
			else connected.dispose?.();
		} else if (mode === "quit") {
			try {
				await pending;
			} catch {
				// A failed background connection must not break host shutdown.
			}
		}
	};

	const runViewerControl = (operation: () => Promise<void>): Promise<void> => {
		const queued = viewerControlChain.then(operation, operation);
		viewerControlChain = queued.catch(() => undefined);
		return queued;
	};

	const runtimeFor = (ctx: ContextRailHostContext): SessionRuntime => {
		lastContext = ctx;
		const identity = sessionIdentity(ctx);
		let runtime = runtimes.get(identity.id);
		if (!runtime) {
			runtime = createSessionRuntime(identity.id, identity.label);
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
				(sessionId) => sessionId !== processState.activeSessionId,
			);
			if (!oldestInactive) return;
			runtimes.delete(oldestInactive);
		}
	};

	const activate = (ctx: ContextRailHostContext): SessionRuntime => {
		const runtime = runtimeFor(ctx);
		if (processState.activeSessionId && processState.activeSessionId !== runtime.sessionId) {
			const previous = runtimes.get(processState.activeSessionId);
			if (previous) publishRuntime(previous, ctx, false, false);
		}
		processState.activeSessionId = runtime.sessionId;
		evictInactiveRuntimes();
		return runtime;
	};

	const refresh = (ctx: ContextRailHostContext, activity = true): void => {
		const runtime = activate(ctx);
		runtime.state.activeTools = [...runtime.activeTools.values()];
		ctx.ui.setStatus(UI_KEY, renderStatus(runtime.state));
		ctx.ui.setWidget(UI_KEY, processState.expanded ? renderWidget(runtime.state) : undefined, {
			placement: "aboveEditor",
		});
		publishRuntime(runtime, ctx, true, activity);
		reconnectToAvailableHub();
	};

	const heartbeat = setInterval(() => {
		if (closed) return;
		if (!processState.monitoringEnabled) {
			const connected = viewer;
			viewer = undefined;
			connected?.dispose?.();
			return;
		}
		const connected = viewer;
		if (!connected) {
			reconnectToAvailableHub();
			return;
		}
		connected.heartbeat(processId);
		void connected
			.healthy()
			.then((healthy) => {
				if (!closed && !healthy && viewer === connected) {
					connected.dispose?.();
					viewer = undefined;
					reconnectToAvailableHub();
				}
			})
			.catch(() => {
				if (!closed && viewer === connected) {
					connected.dispose?.();
					viewer = undefined;
					reconnectToAvailableHub();
				}
			});
	}, 10_000);
	heartbeat.unref();

	return {
		messageEnd(message, ctx) {
			if (closed) return;
			const runtime = activate(ctx);
			const detail = detailForMessage(message);
			if (!detail) return;
			const previousRevision = runtime.state.timeline?.revision ?? -1;
			runtime.state.timeline = runtime.timeline.observe(
				createContextItem(message, runtime.identity),
				Date.now(),
				detail,
			);
			if (runtime.state.timeline.revision !== previousRevision) refresh(ctx);
		},

		context(messages, ctx, contextOptions = {}) {
			if (closed) return;
			const runtime = activate(ctx);
			const usage = ctx.getContextUsage();
			const capture = captureContext({
				messages,
				identity: runtime.identity,
				...(usage ? { usage } : {}),
				...(ctx.model?.id ? { model: ctx.model.id } : {}),
				systemPrompt: ctx.getSystemPrompt(),
				createContextItemDetail: detailForMessage,
			});
			runtime.state.snapshot = capture.snapshot;
			runtime.state.timeline = runtime.timeline.apply(runtime.state.snapshot, {
				compaction: contextOptions.compaction ?? runtime.compactionPending,
				details: capture.details,
			});
			runtime.compactionPending = false;
			runtime.state.phase = "context";
			refresh(ctx, contextOptions.activity ?? true);
		},

		toolExecutionStart(toolCallId, toolName, ctx) {
			if (closed) return;
			const runtime = activate(ctx);
			runtime.activeTools.set(toolCallId, toolName);
			runtime.state.phase = "tool";
			refresh(ctx);
		},

		toolExecutionEnd(toolCallId, ctx) {
			if (closed) return;
			const runtime = activate(ctx);
			runtime.activeTools.delete(toolCallId);
			runtime.state.phase = runtime.activeTools.size > 0 ? "tool" : "context";
			refresh(ctx);
		},

		compactionStarted(ctx) {
			if (closed) return;
			const runtime = activate(ctx);
			runtime.state.phase = "compacting";
			refresh(ctx);
		},

		compactionFinished(ctx, committed) {
			if (closed) return;
			const runtime = activate(ctx);
			if (committed) runtime.compactionPending = true;
			runtime.state.phase = "context";
			refresh(ctx);
		},

		compactionCommitted(ctx) {
			if (closed) return;
			const runtime = activate(ctx);
			runtime.compactionPending = true;
		},

		sessionActivated(ctx, activity = true) {
			if (closed) return;
			refresh(ctx, activity);
		},

		async command(args, ctx) {
			if (closed) return;
			const action = args.trim().toLowerCase() || "toggle";
			if (action === "web") {
				await runViewerControl(async () => {
					if (closed) return;
					try {
						processState.monitoringEnabled = true;
						const connected = await connectViewer(true, true);
						if (closed || !processState.monitoringEnabled) return;
						if (!connected) throw new Error("Hub did not start");
						ctx.ui.notify(`ContextRail viewer: ${connected.viewerUrl}`, "info");
					} catch (error) {
						if (closed || !processState.monitoringEnabled) return;
						const message = error instanceof Error ? error.message : String(error);
						ctx.ui.notify(`ContextRail viewer failed: ${message}`, "error");
					}
				});
				return;
			}
			if (action === "stop") {
				await runViewerControl(async () => {
					if (closed) return;
					await stopMonitoring();
					if (closed) return;
					ctx.ui.notify("ContextRail monitoring stopped for this process", "info");
				});
				return;
			}
			if (action === "show") processState.expanded = true;
			else if (action === "hide") processState.expanded = false;
			else if (action === "toggle") processState.expanded = !processState.expanded;
			else {
				ctx.ui.notify("Usage: /context-rail [show|hide|toggle|web|stop]", "warning");
				return;
			}
			refresh(ctx, false);
		},

		async shutdown(ctx, mode = "quit") {
			if (closed) return;
			if (mode === "quit") {
				const runtime = runtimeFor(ctx);
				publishRuntime(runtime, ctx, false, false);
			}
			closed = true;
			shutdownMode = mode;
			clearInterval(heartbeat);
			ctx.ui.setStatus(UI_KEY, undefined);
			ctx.ui.setWidget(UI_KEY, undefined, { placement: "aboveEditor" });
			await closeViewer(mode);
			lastContext = undefined;
		},
	};
}
