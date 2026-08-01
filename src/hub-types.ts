import type { RenderState } from "./render.ts";
import type { ChunkedRenderStatePatch } from "./hub-delta.ts";

export interface ContextRailSessionSource {
	processId: string;
	processLabel: string;
	sessionId: string;
	sessionLabel: string;
	active?: boolean;
	activity?: boolean;
}

export interface ContextRailSessionSummary {
	streamId: string;
	processId: string;
	processLabel: string;
	sessionId: string;
	sessionLabel: string;
	active: boolean;
	connected: boolean;
	phase: RenderState["phase"];
	model?: string;
	activeItems: number;
	historyItems: number;
	lastActivityAt: number;
	updatedAt: number;
}

export interface ContextRailSessionState {
	streamId: string;
	state: RenderState;
}

export interface ContextRailSessionDelta extends ChunkedRenderStatePatch {
	streamId: string;
	transferId: string;
}

export interface ContextRailHubBootstrap {
	type: "bootstrap";
	sequence: number;
	publishedAt: number;
	activeStreamId?: string;
	sessions: ContextRailSessionSummary[];
	states: ContextRailSessionState[];
}

export interface ContextRailHubUpdate {
	type: "update";
	sequence: number;
	publishedAt: number;
	/** False when a state change came from background synchronization. */
	activity?: boolean;
	activeStreamId?: string;
	sessions?: ContextRailSessionSummary[];
	changed?: ContextRailSessionState;
	delta?: ContextRailSessionDelta;
}

export interface ContextRailPublishRequest {
	source: ContextRailSessionSource;
	state: RenderState;
}

export interface ContextRailPublishDeltaRequest extends ChunkedRenderStatePatch {
	source: ContextRailSessionSource;
	transferId: string;
	baseVersion: number;
}

export interface ContextRailPublishResponse {
	ok: true;
	version?: number;
}

export interface ContextRailVersionConflict {
	ok: false;
	error: "version_conflict";
	version: number;
}

export interface ContextRailProcessRequest {
	processId: string;
}

export interface ContextRailHubDiscovery {
	version: 1;
	instanceId: string;
	pid: number;
	port: number;
	url: string;
	token: string;
	viewerToken: string;
	startedAt: number;
}

function escapeStreamIdPart(value: string): string {
	return value.replaceAll("%", "%25").replaceAll(":", "%3A");
}

export function streamIdFor(source: Pick<ContextRailSessionSource, "processId" | "sessionId">): string {
	return `${escapeStreamIdPart(source.processId)}:${escapeStreamIdPart(source.sessionId)}`;
}
