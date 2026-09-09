import type { ContextRailSessionSource } from "./hub-types.ts";
import { ContextCaptureArchive } from "./context-captures.ts";
import { startContextRailServer } from "./server.ts";
import type { ContextItem, ContextItemDetail, ContextItemKind } from "./snapshot.ts";
import { ContextTimeline, type ContextTimelineSnapshot } from "./timeline.ts";

interface PreviewRuntime {
	turn: number;
	items: ContextItem[];
	timeline: ContextTimeline;
	captures: ContextCaptureArchive;
	contentRevision: number;
	source: ContextRailSessionSource;
	model: string;
}

const viewer = await startContextRailServer();
const contextWindow = 200_000;
const contextConfirmationDelay = 1_100;
const staticPreview = process.env.CONTEXT_RAIL_PREVIEW_STATIC === "1";
const fixtureStartAt = Date.UTC(2026, 0, 1, 12);
const kinds: ContextItemKind[] = ["user", "assistant", "tool", "assistant"];
const pendingTimers = new Set<ReturnType<typeof setTimeout>>();

function detailFor(item: ContextItem, revision = 0): ContextItemDetail {
	return {
		sourceRole: item.kind === "tool" ? "toolResult" : item.kind,
		modelMessages: [{
			modelRole:
				item.kind === "system"
					? "system"
					: item.kind === "assistant"
						? "assistant"
						: item.kind === "tool"
							? "toolResult"
							: "user",
			blocks: [{
				type: "text",
				text: item.kind === "system"
					? "Synthetic ContextRail preview fixture. These examples are not captured provider requests."
					: item.id.endsWith("-user")
						? `[Synthetic preview fixture · revision ${revision}]\n${revision % 2 === 0
							? "The capture reader should preserve exact earlier contents."
							: "The capture reader should preserve exact earlier contents and distinguish content updates from newly entered items."}`
						: `[Synthetic preview fixture] ${item.kind} context for ${item.id}.`,
			}],
		}],
	};
}

function detailsFor(items: readonly ContextItem[], revision: number): Map<string, ContextItemDetail> {
	return new Map(items.map((item) => [item.id, detailFor(item, revision)]));
}

function previewRuntime(
	processId: string,
	processLabel: string,
	sessionId: string,
	sessionLabel: string,
	model: string,
	seed: number,
	active = true,
): PreviewRuntime {
	return {
		turn: seed,
		items: [
			{ id: "system-prompt", kind: "system" },
			{ id: `message-${sessionId}-user`, kind: "user" },
			{ id: `message-${sessionId}-assistant`, kind: "assistant" },
		],
		timeline: new ContextTimeline(),
		captures: new ContextCaptureArchive(),
		contentRevision: 0,
		source: {
			processId, processLabel: `${processLabel} · synthetic preview`, sessionId,
			sessionLabel: `${sessionLabel} · preview`, active,
		},
		model: `${model} · synthetic preview`,
	};
}

const runtimes = [
	previewRuntime("preview-main", "context-rail", "main", "Main build", "claude-sonnet-4.5", 0),
	previewRuntime("preview-worker", "api-worker", "hub", "Hub protocol", "gpt-5.4", 4),
	previewRuntime("preview-main", "context-rail", "archive", "Earlier session", "claude-opus-4.1", 8, false),
];

function snapshotFor(runtime: PreviewRuntime, capturedAt = Date.now()) {
	const activeTool = runtime.turn % 4 === 2 ? [`tool-${runtime.turn}`] : [];
	const tokens = Math.min(contextWindow, 18_000 + runtime.items.length * 4_200);
	const snapshot = {
		createdAt: capturedAt,
		model: runtime.model,
		tokens,
		contextWindow,
		percent: (tokens / contextWindow) * 100,
		items: runtime.items,
	};
	return { activeTool, snapshot };
}

function publishState(
	runtime: PreviewRuntime,
	timeline: ContextTimelineSnapshot,
	compacting = false,
	captured = snapshotFor(runtime),
): void {
	const { activeTool, snapshot } = captured;
	viewer.publish(
		{
			phase: compacting ? "compacting" : activeTool.length > 0 ? "tool" : "context",
			activeTools: activeTool,
			snapshot,
			timeline,
			captures: runtime.captures.current(),
		},
		runtime.source,
	);
}

function publishContext(runtime: PreviewRuntime, compacting = false, fixtureAt?: number): void {
	const captured = snapshotFor(runtime, fixtureAt);
	runtime.contentRevision += 1;
	const details = detailsFor(runtime.items, runtime.contentRevision);
	// Only simulated context boundaries enter the archive. Pending-only timeline
	// observations below keep the most recent archive revision unchanged.
	runtime.captures.append({ snapshot: captured.snapshot, details }, fixtureAt !== undefined
		? { source: "session-reconstruction", reason: "session-start" }
		: { source: "context-hook", ...(compacting ? { reason: "context-compaction" as const } : {}) });
	publishState(runtime, runtime.timeline.apply(captured.snapshot, {
		compaction: compacting,
		details,
	}), compacting, captured);
}

function advance(runtime: PreviewRuntime): void {
	runtime.turn += 1;
	let compacting = false;
	if (runtime.turn % 10 === 0) {
		compacting = true;
		runtime.items = [
			runtime.items[0] ?? { id: "system-prompt", kind: "system" },
			{ id: `memory-${runtime.source.sessionId}-${runtime.turn}`, kind: "memory" },
			...runtime.items.slice(-4),
		];
		publishContext(runtime, compacting);
		return;
	}

	const kind = kinds[(runtime.turn - 1) % kinds.length] ?? "unknown";
	const item: ContextItem = {
		id: `message-${runtime.source.sessionId}-${runtime.turn}`,
		kind,
		...(kind === "tool" ? { toolName: `tool-${runtime.turn}` } : {}),
	};
	publishState(runtime, runtime.timeline.observe(item, Date.now(), detailFor(item)));
	const timer = setTimeout(() => {
		pendingTimers.delete(timer);
		runtime.items = [...runtime.items, item];
		publishContext(runtime);
	}, contextConfirmationDelay);
	pendingTimers.add(timer);
}

// Seed all sessions with deterministic content before exposing the URL. The
// first pair demonstrates entered/exited IDs, and the second demonstrates a
// same-ID content revision. End on the original three-item demo active context.
for (const runtime of runtimes) {
	const initialItems = runtime.items;
	runtime.items = [initialItems[0]!, { id: `message-${runtime.source.sessionId}-retired`, kind: "user" }];
	publishContext(runtime, false, fixtureStartAt);
	runtime.items = initialItems;
	publishContext(runtime, false, fixtureStartAt + 1_000);
	publishContext(runtime, false, fixtureStartAt + 2_000);
}
let tick = 0;
const timer = staticPreview ? undefined : setInterval(() => {
	const runtime = runtimes[tick % 2];
	if (runtime) advance(runtime);
	tick += 1;
}, 1_600);

console.log(viewer.viewerUrl);

const shutdown = async (): Promise<void> => {
	if (timer) clearInterval(timer);
	for (const pendingTimer of pendingTimers) clearTimeout(pendingTimer);
	await viewer.stop();
	process.exit(0);
};

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
