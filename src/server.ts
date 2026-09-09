import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { fileURLToPath } from "node:url";
import type {
	ContextRailHubBootstrap,
	ContextRailHubUpdate,
	ContextRailProcessRequest,
	ContextRailPublishDeltaRequest,
	ContextRailPublishRequest,
	ContextRailPublishResponse,
	ContextRailSessionDelta,
	ContextRailSessionSource,
	ContextRailSessionState,
	ContextRailSessionSummary,
} from "./hub-types.ts";
import { streamIdFor } from "./hub-types.ts";
import {
	applyRenderStatePatch,
	chunkRenderStatePatch,
	decodeRenderStatePatchChunks,
	type ChunkedRenderStatePatch,
} from "./hub-delta.ts";
import { projectRenderState, projectSessionSource } from "./hub-schema.ts";
import type { RenderState } from "./render.ts";

const DEFAULT_HTML_PATH = fileURLToPath(new URL("../web/index.html", import.meta.url));
interface DefaultWebAsset {
	path: string;
	contentType: string;
	optional?: boolean;
}

const DEFAULT_WEB_ASSETS: ReadonlyMap<string, DefaultWebAsset> = new Map([
	["/assets/scene-worker.js", {
		path: fileURLToPath(new URL("../web/assets/scene-worker.js", import.meta.url)),
		contentType: "text/javascript; charset=utf-8", optional: true,
	}],
	[
		"/assets/scene-core.js",
		{
			path: fileURLToPath(new URL("../web/assets/scene-core.js", import.meta.url)),
			contentType: "text/javascript; charset=utf-8",
		},
	],
	[
		"/assets/pixi-history.js",
		{
			path: fileURLToPath(new URL("../web/assets/pixi-history.js", import.meta.url)),
			contentType: "text/javascript; charset=utf-8",
			optional: true,
		},
	],
]);
const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const DEFAULT_REQUEST_BODY_TIMEOUT_MS = 5_000;
const DEFAULT_HEARTBEAT_TTL_MS = 30_000;
const DEFAULT_HEARTBEAT_SWEEP_INTERVAL_MS = 5_000;
const DEFAULT_SSE_CLIENT_MAX_QUEUED_BYTES = 1024 * 1024;
const DEFAULT_SSE_DRAIN_TIMEOUT_MS = 2_000;
const DEFAULT_SSE_BROADCAST_MAX_QUEUED_BYTES = 128 * 1024 * 1024;
const DEFAULT_SERVER_SHUTDOWN_GRACE_MS = 200;
const DEFAULT_DISCONNECTED_SESSION_TTL_MS = 60 * 60 * 1_000;
const DEFAULT_MAX_RETAINED_SESSIONS = 100;
const DEFAULT_MAX_PENDING_DELTA_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_PENDING_DELTA_CHUNKS = 512;
const DEFAULT_MAX_PENDING_DELTAS = 128;
const DEFAULT_MAX_PENDING_DELTA_AGGREGATE_BYTES = 128 * 1024 * 1024;
const DEFAULT_PENDING_DELTA_TTL_MS = 60_000;
const MAX_SOURCE_ID_BYTES = 1024;
const MAX_SOURCE_LABEL_BYTES = 4 * 1024;
const MAX_TRANSFER_ID_BYTES = 256;

export interface ContextRailWebPayload extends RenderState {
	sequence: number;
	publishedAt: number;
}

export interface ContextRailViewer {
	readonly instanceId: string;
	readonly port: number;
	readonly url: string;
	readonly viewerUrl: string;
	healthy(): Promise<boolean>;
	publish(state: RenderState, source?: ContextRailSessionSource): void;
	heartbeat(processId: string): void;
	disconnect(processId: string): void;
	/** Cancels local work without telling the Hub that the process disconnected. */
	dispose?(): void;
	stop(): Promise<void>;
}

export interface StartContextRailServerOptions {
	html?: string;
	port?: number;
	token?: string;
	viewerToken?: string;
	instanceId?: string;
	requestBodyTimeoutMs?: number;
	heartbeatTtlMs?: number;
	heartbeatSweepIntervalMs?: number;
	sseClientMaxQueuedBytes?: number;
	sseDrainTimeoutMs?: number;
	sseBroadcastMaxQueuedBytes?: number;
	disconnectedSessionTtlMs?: number;
	maxRetainedSessions?: number;
	maxPendingDeltaBytes?: number;
	maxPendingDeltaChunks?: number;
	maxPendingDeltas?: number;
	maxPendingDeltaAggregateBytes?: number;
	pendingDeltaTtlMs?: number;
	now?: () => number;
	webAssetLoader?: (path: string) => Promise<Buffer>;
}

interface StoredSession extends ContextRailSessionState {
	summary: ContextRailSessionSummary;
	version: number;
	disconnectedAt?: number;
}

interface StoredProcess {
	lastHeartbeatAt: number;
}

interface PendingDelta {
	source: ContextRailSessionSource;
	transferId: string;
	baseVersion: number;
	chunks: ChunkedRenderStatePatch[];
	encodedBytes: number;
	expiresAt: number;
}

interface SseClient {
	response: ServerResponse;
	queue: QueuedSseChunk[];
	queuedBytes: number;
	closed: boolean;
	pump: Promise<void> | undefined;
	settleDrain: (() => void) | undefined;
}

interface QueuedSseChunk {
	chunk: string;
	bytes: number;
}

interface QueuedSseEvent {
	chunk: string;
	bytes: number;
	recipients: SseClient[];
}

class VersionConflictError extends Error {
	readonly version: number;

	constructor(version: number) {
		super("Delta base version does not match the current stream");
		this.version = version;
	}
}

function eventChunk(event: string, data: unknown, sequence: number): string {
	return `id: ${sequence}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function tokenMatches(actualToken: string | undefined, expected: string): boolean {
	if (actualToken === undefined) return false;
	const actual = Buffer.from(actualToken);
	const target = Buffer.from(expected);
	return actual.length === target.length && timingSafeEqual(actual, target);
}

function bearerTokenMatches(header: string | undefined, expected: string): boolean {
	return header?.startsWith("Bearer ") === true && tokenMatches(header.slice(7), expected);
}

async function readJsonBody<T>(request: IncomingMessage, timeoutMs: number): Promise<T> {
	let size = 0;
	const chunks: Buffer[] = [];
	let timedOut = false;
	const timeout = setTimeout(() => {
		timedOut = true;
		request.destroy(new Error("Request body timed out"));
	}, timeoutMs);
	timeout.unref();
	try {
		for await (const chunk of request) {
			const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			size += buffer.length;
			if (size > MAX_REQUEST_BYTES) {
				request.destroy();
				throw new Error("Request body too large");
			}
			chunks.push(buffer);
		}
	} catch (error) {
		if (timedOut) throw new Error("Request body timed out");
		throw error;
	} finally {
		clearTimeout(timeout);
	}
	return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
}

function htmlWithScriptNonce(html: string, nonce: string): string {
	return html.replace(/<script\b([^>]*)>/gi, (_tag, attributes: string) => {
		const normalized = attributes.replace(
			/\snonce=(?:"[^"]*"|'[^']*'|[^\s>]+)/gi,
			"",
		);
		return `<script nonce="${nonce}"${normalized}>`;
	});
}

function defaultSource(): ContextRailSessionSource {
	return {
		processId: `local-${process.pid}`,
		processLabel: "Local preview",
		sessionId: "default",
		sessionLabel: "Default session",
		active: true,
	};
}

function positiveNumber(value: number, name: string): number {
	if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${name} must be greater than zero`);
	return value;
}

function positiveInteger(value: number, name: string): number {
	if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive integer`);
	return value;
}

function assertBoundedText(value: unknown, name: string, maxBytes: number): asserts value is string {
	if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value) > maxBytes) {
		throw new Error(`${name} must be a non-empty string no larger than ${maxBytes} bytes`);
	}
}

function assertValidSource(source: ContextRailSessionSource): void {
	if (!source || typeof source !== "object") throw new Error("Invalid session source");
	assertBoundedText(source.processId, "processId", MAX_SOURCE_ID_BYTES);
	assertBoundedText(source.sessionId, "sessionId", MAX_SOURCE_ID_BYTES);
	assertBoundedText(source.processLabel, "processLabel", MAX_SOURCE_LABEL_BYTES);
	assertBoundedText(source.sessionLabel, "sessionLabel", MAX_SOURCE_LABEL_BYTES);
}

function pendingDeltaKey(streamId: string, transferId: string): string {
	return JSON.stringify([streamId, transferId]);
}

export async function startContextRailServer(
	options: StartContextRailServerOptions = {},
): Promise<ContextRailViewer> {
	const viewerToken =
		options.viewerToken ??
		(options.token === undefined ? undefined : randomBytes(32).toString("base64url"));
	if (options.token !== undefined && viewerToken !== undefined && options.token === viewerToken) {
		throw new Error("ContextRail read and write capabilities must be different");
	}
	const heartbeatTtlMs = positiveNumber(
		options.heartbeatTtlMs ?? DEFAULT_HEARTBEAT_TTL_MS,
		"heartbeatTtlMs",
	);
	const requestBodyTimeoutMs = positiveNumber(
		options.requestBodyTimeoutMs ?? DEFAULT_REQUEST_BODY_TIMEOUT_MS,
		"requestBodyTimeoutMs",
	);
	const heartbeatSweepIntervalMs = positiveNumber(
		options.heartbeatSweepIntervalMs ?? DEFAULT_HEARTBEAT_SWEEP_INTERVAL_MS,
		"heartbeatSweepIntervalMs",
	);
	const sseClientMaxQueuedBytes = positiveInteger(
		options.sseClientMaxQueuedBytes ?? DEFAULT_SSE_CLIENT_MAX_QUEUED_BYTES,
		"sseClientMaxQueuedBytes",
	);
	const sseDrainTimeoutMs = positiveNumber(
		options.sseDrainTimeoutMs ?? DEFAULT_SSE_DRAIN_TIMEOUT_MS,
		"sseDrainTimeoutMs",
	);
	const sseBroadcastMaxQueuedBytes = positiveInteger(
		options.sseBroadcastMaxQueuedBytes ?? DEFAULT_SSE_BROADCAST_MAX_QUEUED_BYTES,
		"sseBroadcastMaxQueuedBytes",
	);
	const disconnectedSessionTtlMs = positiveNumber(
		options.disconnectedSessionTtlMs ?? DEFAULT_DISCONNECTED_SESSION_TTL_MS,
		"disconnectedSessionTtlMs",
	);
	const maxRetainedSessions = positiveInteger(
		options.maxRetainedSessions ?? DEFAULT_MAX_RETAINED_SESSIONS,
		"maxRetainedSessions",
	);
	const maxPendingDeltaBytes = positiveInteger(
		options.maxPendingDeltaBytes ?? DEFAULT_MAX_PENDING_DELTA_BYTES,
		"maxPendingDeltaBytes",
	);
	const maxPendingDeltaChunks = positiveInteger(
		options.maxPendingDeltaChunks ?? DEFAULT_MAX_PENDING_DELTA_CHUNKS,
		"maxPendingDeltaChunks",
	);
	const maxPendingDeltas = positiveInteger(
		options.maxPendingDeltas ?? DEFAULT_MAX_PENDING_DELTAS,
		"maxPendingDeltas",
	);
	const maxPendingDeltaAggregateBytes = positiveInteger(
		options.maxPendingDeltaAggregateBytes ?? DEFAULT_MAX_PENDING_DELTA_AGGREGATE_BYTES,
		"maxPendingDeltaAggregateBytes",
	);
	const pendingDeltaTtlMs = positiveNumber(
		options.pendingDeltaTtlMs ?? DEFAULT_PENDING_DELTA_TTL_MS,
		"pendingDeltaTtlMs",
	);
	const now = options.now ?? Date.now;
	const html = options.html ?? (await readFile(DEFAULT_HTML_PATH, "utf8"));
	const sourceWebAssetLoader = options.webAssetLoader ?? readFile;
	const webAssetReads = new Map<string, Promise<Buffer>>();
	const webAssetLoader = (path: string): Promise<Buffer> => {
		let pending = webAssetReads.get(path);
		if (!pending) {
			pending = sourceWebAssetLoader(path).catch((error: unknown) => {
				webAssetReads.delete(path);
				throw error;
			});
			webAssetReads.set(path, pending);
		}
		return pending;
	};
	await Promise.all(
		[...DEFAULT_WEB_ASSETS.values()]
			.filter((asset) => !asset.optional)
			.map((asset) => webAssetLoader(asset.path)),
	);
	const instanceId = options.instanceId ?? randomUUID();
	const clients = new Set<SseClient>();
	const sessions = new Map<string, StoredSession>();
	const processes = new Map<string, StoredProcess>();
	const pendingDeltas = new Map<string, PendingDelta>();
	const sockets = new Set<Socket>();
	let origin = "";
	let activeStreamId: string | undefined;
	let sequence = 0;
	let stopped = false;
	let pendingDeltaBytes = 0;
	const broadcastQueue: QueuedSseEvent[] = [];
	let broadcastQueueBytes = 0;
	let broadcastPump: Promise<void> | undefined;
	let stopPromise: Promise<void> | undefined;

	const streamVersion = (streamId: string): number => sessions.get(streamId)?.version ?? 0;

	const removePendingDelta = (key: string): PendingDelta | undefined => {
			const pending = pendingDeltas.get(key);
			if (!pending) return undefined;
			pendingDeltas.delete(key);
			pendingDeltaBytes = Math.max(0, pendingDeltaBytes - pending.encodedBytes);
			return pending;
	};

	const removePendingDeltas = (predicate: (pending: PendingDelta) => boolean): void => {
			for (const [key, pending] of pendingDeltas) {
				if (predicate(pending)) removePendingDelta(key);
			}
	};

	const expirePendingDeltas = (): void => {
			const timestamp = now();
			removePendingDeltas((pending) => pending.expiresAt <= timestamp);
	};

	const sessionList = (): ContextRailSessionSummary[] =>
		[...sessions.values()]
			.map(({ summary }) => ({ ...summary }))
			.sort(
				(left, right) =>
					right.lastActivityAt - left.lastActivityAt ||
					right.updatedAt - left.updatedAt ||
					left.streamId.localeCompare(right.streamId),
			);

	const bootstrap = (): ContextRailHubBootstrap => ({
		type: "bootstrap",
		sequence,
		publishedAt: now(),
		...(activeStreamId ? { activeStreamId } : {}),
		sessions: sessionList(),
		states: [...sessions.values()].map(({ streamId, state }) => ({ streamId, state })),
	});

	const closeSseClient = (client: SseClient): void => {
		if (client.closed) return;
		client.closed = true;
		client.queue.length = 0;
		client.queuedBytes = 0;
		clients.delete(client);
		client.settleDrain?.();
		client.response.destroy();
	};

	const waitForSseDrain = (client: SseClient): Promise<void> => {
		if (client.closed) return Promise.resolve();
		return new Promise((resolve) => {
			let settled = false;
			const settle = (): void => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				client.response.off("drain", settle);
				if (client.settleDrain === settle) client.settleDrain = undefined;
				resolve();
			};
			const timer = setTimeout(() => {
				closeSseClient(client);
			}, sseDrainTimeoutMs);
			timer.unref();
			client.settleDrain = settle;
			client.response.once("drain", settle);
		});
	};

	const pumpSseClient = async (client: SseClient): Promise<void> => {
		while (!stopped && !client.closed && client.queue.length > 0) {
			const entry = client.queue.shift();
			if (!entry) return;
			client.queuedBytes = Math.max(0, client.queuedBytes - entry.bytes);
			try {
				if (!client.response.write(entry.chunk)) await waitForSseDrain(client);
			} catch {
				closeSseClient(client);
			}
		}
	};

	const scheduleSseClientPump = (client: SseClient): void => {
		if (stopped || client.closed || client.pump || client.queue.length === 0) return;
		const running = pumpSseClient(client);
		client.pump = running;
		void running.finally(() => {
			if (client.pump !== running) return;
			client.pump = undefined;
			scheduleSseClientPump(client);
		});
	};

	const enqueueSse = (client: SseClient, chunk: string, allowOversized = false): void => {
		if (client.closed || client.response.destroyed || client.response.writableEnded) {
			closeSseClient(client);
			return;
		}
		const bytes = Buffer.byteLength(chunk);
		if (!allowOversized && client.queuedBytes + bytes > sseClientMaxQueuedBytes) {
			closeSseClient(client);
			return;
		}
		client.queue.push({ chunk, bytes });
		client.queuedBytes += bytes;
		scheduleSseClientPump(client);
	};

	const pumpBroadcastQueue = async (): Promise<void> => {
		while (!stopped && broadcastQueue.length > 0) {
			const event = broadcastQueue.shift();
			if (!event) return;
			broadcastQueueBytes = Math.max(0, broadcastQueueBytes - event.bytes);
			for (const client of event.recipients) enqueueSse(client, event.chunk);
			// Yield to socket drains without waiting for any particular client.
			await new Promise<void>((resolve) => setImmediate(resolve));
		}
	};

	const scheduleBroadcastPump = (): void => {
		if (stopped || broadcastPump || broadcastQueue.length === 0) return;
		const running = pumpBroadcastQueue();
		broadcastPump = running;
		void running.finally(() => {
			if (broadcastPump !== running) return;
			broadcastPump = undefined;
			scheduleBroadcastPump();
		});
	};

	const enqueueBroadcast = (chunk: string): void => {
		// Snapshot recipients so a later connection starts at its bootstrap boundary.
		const recipients = [...clients];
		if (recipients.length === 0) return;
		const bytes = Buffer.byteLength(chunk);
		if (bytes > sseBroadcastMaxQueuedBytes || broadcastQueueBytes + bytes > sseBroadcastMaxQueuedBytes) {
			const affected = new Set([
				...recipients,
				...broadcastQueue.flatMap((event) => event.recipients),
			]);
			broadcastQueue.length = 0;
			broadcastQueueBytes = 0;
			for (const client of affected) closeSseClient(client);
			return;
		}
		broadcastQueue.push({ chunk, bytes, recipients });
		broadcastQueueBytes += bytes;
		scheduleBroadcastPump();
	};

	const broadcast = (options: {
		activity?: boolean;
		changed?: ContextRailSessionState;
		delta?: ContextRailSessionDelta;
		includeSessions?: boolean;
	} = {}): void => {
		if (stopped) return;
		const payload: ContextRailHubUpdate = {
			type: "update",
			sequence: ++sequence,
			publishedAt: now(),
			...(options.activity !== undefined ? { activity: options.activity } : {}),
			...(activeStreamId ? { activeStreamId } : {}),
			...(options.includeSessions !== false ? { sessions: sessionList() } : {}),
			...(options.changed ? { changed: options.changed } : {}),
			...(options.delta ? { delta: options.delta } : {}),
		};
		const chunk = eventChunk("update", payload, sequence);
		enqueueBroadcast(chunk);
	};

	const selectActiveStream = (): string | undefined =>
		[...sessions.values()]
			.filter((session) => session.summary.active && session.summary.connected)
			.sort(
				(left, right) =>
					right.summary.lastActivityAt - left.summary.lastActivityAt ||
					left.streamId.localeCompare(right.streamId),
			)[0]?.streamId;

	const refreshActiveStream = (): void => {
		activeStreamId = selectActiveStream();
	};

	const markProcessDisconnected = (processId: string): boolean => {
			let changed = false;
			removePendingDeltas((pending) => pending.source.processId === processId);
			for (const session of sessions.values()) {
				if (session.summary.processId !== processId || !session.summary.connected) continue;
				session.summary.connected = false;
				session.summary.active = false;
				session.disconnectedAt = now();
				changed = true;
			}
			refreshActiveStream();
			return changed;
	};

	const evictSessions = (): boolean => {
			const cutoff = now() - disconnectedSessionTtlMs;
			const disconnected = [...sessions.values()].filter((session) => !session.summary.connected);
			const evict = (session: StoredSession): void => {
				sessions.delete(session.streamId);
				removePendingDeltas((pending) => streamIdFor(pending.source) === session.streamId);
			};
			let changed = false;
			for (const session of disconnected) {
				if ((session.disconnectedAt ?? session.summary.updatedAt) > cutoff) continue;
				evict(session);
				changed = true;
			}

			const retained = [...sessions.values()]
				.sort(
					(left, right) =>
						Number(left.summary.active) - Number(right.summary.active) ||
						left.summary.lastActivityAt - right.summary.lastActivityAt ||
						left.summary.updatedAt - right.summary.updatedAt ||
						left.streamId.localeCompare(right.streamId),
				);
			for (const session of retained.slice(0, Math.max(0, retained.length - maxRetainedSessions))) {
				evict(session);
				changed = true;
			}
			refreshActiveStream();
			return changed;
	};

			const storePublishedState = (state: RenderState, source: ContextRailSessionSource): StoredSession => {
				const streamId = streamIdFor(source);
				const publishedAt = now();
				const storedState = projectRenderState(state);
		processes.set(source.processId, { lastHeartbeatAt: publishedAt });
		if (source.active) {
			for (const session of sessions.values()) {
				if (session.summary.processId === source.processId) session.summary.active = false;
			}
		}
		const timeline = storedState.timeline;
			const previousSession = sessions.get(streamId);
			const previous = previousSession?.summary;
		const summary: ContextRailSessionSummary = {
			streamId,
			processId: source.processId,
			processLabel: source.processLabel,
			sessionId: source.sessionId,
			sessionLabel: source.sessionLabel,
			active: source.active ?? false,
			connected: true,
			phase: storedState.phase,
			...(storedState.snapshot?.model ? { model: storedState.snapshot.model } : {}),
			activeItems: timeline?.activeIds.length ?? storedState.snapshot?.items.length ?? 0,
			historyItems: timeline?.history.length ?? storedState.snapshot?.items.length ?? 0,
			lastActivityAt:
				source.activity !== false ? publishedAt : (previous?.lastActivityAt ?? 0),
			updatedAt: publishedAt,
		};
			const stored: StoredSession = {
				streamId,
				state: storedState,
				summary,
				version: (previousSession?.version ?? 0) + 1,
			};
			sessions.set(streamId, stored);
			refreshActiveStream();
			return stored;
		};

			const publish = (state: RenderState, source = defaultSource()): void => {
				if (stopped) return;
					const projectedSource = projectSessionSource(source);
					assertValidSource(projectedSource);
					const streamId = streamIdFor(projectedSource);
				removePendingDeltas((pending) => streamIdFor(pending.source) === streamId);
				const stored = storePublishedState(state, projectedSource);
				evictSessions();
				broadcast({
					...(sessions.has(streamId)
						? {
							activity: projectedSource.activity !== false,
						changed: { streamId, state: stored.state },
					}
					: {}),
			});
		};

			const publishDelta = (request: ContextRailPublishDeltaRequest): ContextRailPublishResponse => {
				if (stopped) return { ok: true };
					const source = projectSessionSource(request.source);
					assertValidSource(source);
					const streamId = streamIdFor(source);
				assertBoundedText(request.transferId, "transferId", MAX_TRANSFER_ID_BYTES);
				if (!Number.isSafeInteger(request.index) || request.index < 0) {
				throw new Error("Invalid delta transfer identity");
			}
			if (!Number.isSafeInteger(request.baseVersion) || request.baseVersion < 0) {
				throw new Error("Invalid delta base version");
			}
			if (typeof request.data !== "string" || typeof request.complete !== "boolean") {
				throw new Error("Invalid delta chunk");
			}
			expirePendingDeltas();
			const key = pendingDeltaKey(streamId, request.transferId);
			const encodedBytes = Buffer.byteLength(request.data);
			let pending = pendingDeltas.get(key);
			if (request.index === 0) {
				if (request.baseVersion !== streamVersion(streamId)) {
					throw new VersionConflictError(streamVersion(streamId));
				}
				removePendingDelta(key);
				if (pendingDeltas.size >= maxPendingDeltas) throw new Error("Too many pending delta transfers");
				if (encodedBytes > maxPendingDeltaBytes) throw new Error("Delta transfer exceeds byte limit");
				if (pendingDeltaBytes + encodedBytes > maxPendingDeltaAggregateBytes) {
					throw new Error("Pending delta transfers exceed aggregate byte limit");
				}
				pending = {
						source,
					transferId: request.transferId,
					baseVersion: request.baseVersion,
					chunks: [{ index: 0, data: request.data, complete: request.complete }],
					encodedBytes,
					expiresAt: now() + pendingDeltaTtlMs,
				};
				pendingDeltas.set(key, pending);
				pendingDeltaBytes += encodedBytes;
			} else {
				if (!pending) throw new VersionConflictError(streamVersion(streamId));
				if (pending.baseVersion !== request.baseVersion || request.index !== pending.chunks.length) {
					removePendingDelta(key);
					throw new Error("Delta chunks arrived out of order");
				}
				if (pending.chunks.length + 1 > maxPendingDeltaChunks) {
					removePendingDelta(key);
					throw new Error("Delta transfer exceeds chunk limit");
				}
				if (pending.encodedBytes + encodedBytes > maxPendingDeltaBytes) {
					removePendingDelta(key);
					throw new Error("Delta transfer exceeds byte limit");
				}
				if (pendingDeltaBytes + encodedBytes > maxPendingDeltaAggregateBytes) {
					removePendingDelta(key);
					throw new Error("Pending delta transfers exceed aggregate byte limit");
				}
					pending.source = source;
				pending.chunks.push({
					index: request.index,
					data: request.data,
					complete: request.complete,
				});
				pending.encodedBytes += encodedBytes;
				pendingDeltaBytes += encodedBytes;
			}
			processes.set(source.processId, { lastHeartbeatAt: now() });
			if (!request.complete) return { ok: true, version: streamVersion(streamId) };

			if (!pending) throw new Error("Delta transfer is missing");
			if (pending.baseVersion !== streamVersion(streamId)) {
				removePendingDelta(key);
				throw new VersionConflictError(streamVersion(streamId));
			}
				removePendingDelta(key);
				const patch = decodeRenderStatePatchChunks(pending.chunks);
				const state = applyRenderStatePatch(sessions.get(streamId)?.state, patch);
				const stored = storePublishedState(state, pending.source);
				const sanitizedChunks = chunkRenderStatePatch(
					patch,
					Math.max(...pending.chunks.map((chunk) => Buffer.byteLength(chunk.data))),
				);
				evictSessions();
				if (sessions.has(streamId)) {
					for (const chunk of sanitizedChunks) {
					broadcast({
						...(chunk.complete ? { activity: pending.source.activity !== false } : {}),
						delta: { streamId, transferId: pending.transferId, ...chunk },
						includeSessions: chunk.complete,
					});
				}
			} else {
				broadcast();
			}
			return { ok: true, version: stored.version };
		};

		const heartbeat = (processId: string): void => {
			assertBoundedText(processId, "processId", MAX_SOURCE_ID_BYTES);
			let changed = false;
		processes.set(processId, { lastHeartbeatAt: now() });
		for (const session of sessions.values()) {
			if (session.summary.processId !== processId) continue;
			if (!session.summary.connected) {
				session.summary.connected = true;
				changed = true;
			}
		}
		if (changed) {
			refreshActiveStream();
			broadcast();
		}
	};

			const disconnect = (processId: string): void => {
				assertBoundedText(processId, "processId", MAX_SOURCE_ID_BYTES);
				processes.delete(processId);
			const changed = markProcessDisconnected(processId);
			if (evictSessions() || changed) broadcast();
		};

	const server = createServer((request, response) => {
		void (async () => {
			const requestOrigin = request.headers.origin;
			if (requestOrigin && requestOrigin !== origin) {
				response.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
				response.end("Forbidden");
				return;
			}

			const requestUrl = new URL(request.url ?? "/", origin || "http://127.0.0.1");
			const pathname = requestUrl.pathname;
			if (request.method === "GET" && pathname === "/") {
				const nonce = randomBytes(18).toString("base64");
				response.writeHead(200, {
					"Cache-Control": "no-store",
					"Content-Security-Policy":
						`default-src 'self'; connect-src 'self'; worker-src 'self'; form-action 'none'; img-src 'self' data:; object-src 'none'; script-src 'self' 'nonce-${nonce}'; style-src 'self' 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'`,
					"Content-Type": "text/html; charset=utf-8",
					"Referrer-Policy": "no-referrer",
					"X-Content-Type-Options": "nosniff",
				});
				response.end(htmlWithScriptNonce(html, nonce));
				return;
			}

			const webAsset = DEFAULT_WEB_ASSETS.get(pathname);
			if (request.method === "GET" && webAsset) {
				let contents: Buffer;
				try {
					contents = await webAssetLoader(webAsset.path);
				} catch (error: unknown) {
					if (!webAsset.optional) throw error;
					response.writeHead(404, {
						"Cache-Control": "no-store",
						"Content-Type": "text/plain; charset=utf-8",
						"X-Content-Type-Options": "nosniff",
					});
					response.end("Not found");
					return;
				}
				response.writeHead(200, {
					"Cache-Control": "no-store",
					"Content-Type": webAsset.contentType,
					"Cross-Origin-Resource-Policy": "same-origin",
					"Referrer-Policy": "no-referrer",
					"X-Content-Type-Options": "nosniff",
				});
				response.end(contents);
				return;
			}

			if (request.method === "GET" && pathname === "/health") {
				response.writeHead(200, {
					"Cache-Control": "no-store",
					"Content-Type": "application/json; charset=utf-8",
				});
				response.end(
					JSON.stringify({ ok: true, instanceId, clients: clients.size, sessions: sessions.size }),
				);
				return;
			}

			if (request.method === "GET" && pathname === "/events") {
				if (viewerToken !== undefined && !tokenMatches(requestUrl.searchParams.get("token") ?? undefined, viewerToken)) {
					response.writeHead(401, { "Content-Type": "text/plain; charset=utf-8" });
					response.end("Unauthorized");
					return;
				}
					response.writeHead(200, {
						"Cache-Control": "no-cache, no-transform",
					Connection: "keep-alive",
						"Content-Type": "text/event-stream; charset=utf-8",
						"X-Accel-Buffering": "no",
					});
					const client: SseClient = {
						response,
						queue: [],
						queuedBytes: 0,
						closed: false,
						pump: undefined,
						settleDrain: undefined,
					};
					enqueueSse(
						client,
						`retry: 1000\n\n${eventChunk("bootstrap", bootstrap(), sequence)}`,
						true,
					);
					if (!client.closed) clients.add(client);

					const keepalive = setInterval(() => enqueueSse(client, ": keepalive\n\n"), 15_000);
					keepalive.unref();
					request.on("close", () => {
						clearInterval(keepalive);
						closeSseClient(client);
					});
					return;
				}

			const isApiPost = request.method === "POST" && pathname.startsWith("/api/");
			if (isApiPost && options.token && bearerTokenMatches(request.headers.authorization, options.token)) {
					let result: ContextRailPublishResponse = { ok: true };
					if (pathname === "/api/publish") {
							const body = await readJsonBody<ContextRailPublishRequest>(request, requestBodyTimeoutMs);
						publish(body.state, body.source);
					} else if (pathname === "/api/publish-delta") {
							const body = await readJsonBody<ContextRailPublishDeltaRequest>(request, requestBodyTimeoutMs);
						result = publishDelta(body);
				} else if (pathname === "/api/heartbeat") {
					const body = await readJsonBody<ContextRailProcessRequest>(request, requestBodyTimeoutMs);
					heartbeat(body.processId);
				} else if (pathname === "/api/disconnect") {
					const body = await readJsonBody<ContextRailProcessRequest>(request, requestBodyTimeoutMs);
					disconnect(body.processId);
				} else {
					response.writeHead(404);
					response.end();
					return;
					}
					response.writeHead(202, { "Content-Type": "application/json; charset=utf-8" });
					response.end(JSON.stringify(result));
				return;
			}

			if (isApiPost) {
				response.writeHead(401, { "Content-Type": "text/plain; charset=utf-8" });
				response.end("Unauthorized");
				return;
			}

			response.writeHead(request.method === "GET" ? 404 : 405, {
				...(request.method === "GET" ? {} : { Allow: "GET, POST" }),
				"Content-Type": "text/plain; charset=utf-8",
			});
			response.end(request.method === "GET" ? "Not found" : "Method not allowed");
			})().catch((error: unknown) => {
					if (response.destroyed || response.writableEnded) return;
					if (response.headersSent) {
					response.end();
					return;
				}
				if (error instanceof VersionConflictError) {
					response.writeHead(409, { "Content-Type": "application/json; charset=utf-8" });
					response.end(JSON.stringify({ ok: false, error: "version_conflict", version: error.version }));
					return;
				}
				const message = error instanceof Error ? error.message : "Invalid request";
			response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
			response.end(message);
		});
	});
	server.on("connection", (socket) => {
		sockets.add(socket);
		socket.once("close", () => sockets.delete(socket));
	});

	await new Promise<void>((resolve, reject) => {
		const onError = (error: Error): void => reject(error);
		server.once("error", onError);
		server.listen(options.port ?? 0, "127.0.0.1", () => {
			server.off("error", onError);
			resolve();
		});
	});

	const address = server.address() as AddressInfo;
	origin = `http://127.0.0.1:${address.port}`;
		const heartbeatSweep = setInterval(() => {
			if (stopped) return;
			const cutoff = now() - heartbeatTtlMs;
			let changed = false;
		for (const [processId, processState] of processes) {
			if (processState.lastHeartbeatAt >= cutoff) continue;
				processes.delete(processId);
				changed = markProcessDisconnected(processId) || changed;
			}
			expirePendingDeltas();
			changed = evictSessions() || changed;
			if (changed) broadcast();
	}, heartbeatSweepIntervalMs);
	heartbeatSweep.unref();

	const url = `${origin}/`;
	return {
		instanceId,
		port: address.port,
		url,
		viewerUrl: viewerToken === undefined ? url : `${url}#token=${encodeURIComponent(viewerToken)}`,
		async healthy() {
			return !stopped;
		},
		publish,
		heartbeat,
		disconnect,
			async stop() {
				if (stopPromise) return stopPromise;
				stopped = true;
			stopPromise = (async () => {
					clearInterval(heartbeatSweep);
					broadcastQueue.length = 0;
					broadcastQueueBytes = 0;
					const clientPumps = [...clients].flatMap((client) => client.pump ? [client.pump] : []);
					for (const client of [...clients]) closeSseClient(client);
					await broadcastPump;
					await Promise.all(clientPumps);
					pendingDeltas.clear();
					pendingDeltaBytes = 0;
						await new Promise<void>((resolve, reject) => {
							const forceClose = setTimeout(() => {
								for (const socket of sockets) socket.destroy();
							}, DEFAULT_SERVER_SHUTDOWN_GRACE_MS);
							server.close((error) => {
								clearTimeout(forceClose);
								error ? reject(error) : resolve();
							});
							server.closeIdleConnections();
						});
				})();
				return stopPromise;
			},
	};
}
