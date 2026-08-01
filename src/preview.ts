import type { ContextRailSessionSource } from "./hub-types.ts";
import { startContextRailServer } from "./server.ts";
import type { ContextItem, ContextItemDetail, ContextItemKind } from "./snapshot.ts";
import { ContextTimeline, type ContextTimelineSnapshot } from "./timeline.ts";

interface PreviewRuntime {
	turn: number;
	items: ContextItem[];
	timeline: ContextTimeline;
	source: ContextRailSessionSource;
	model: string;
}

const viewer = await startContextRailServer();
const contextWindow = 200_000;
const contextConfirmationDelay = 1_100;
const kinds: ContextItemKind[] = ["user", "assistant", "tool", "assistant"];
const pendingTimers = new Set<ReturnType<typeof setTimeout>>();

function detailFor(item: ContextItem): ContextItemDetail {
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
					? "You are the ContextRail preview agent."
					: `${item.kind} preview context for ${item.id}.`,
			}],
		}],
	};
}

function detailsFor(items: readonly ContextItem[]): Map<string, ContextItemDetail> {
	return new Map(items.map((item) => [item.id, detailFor(item)]));
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
		source: { processId, processLabel, sessionId, sessionLabel, active },
		model,
	};
}

const runtimes = [
	previewRuntime("preview-main", "context-rail", "main", "Main build", "claude-sonnet-4.5", 0),
	previewRuntime("preview-worker", "api-worker", "hub", "Hub protocol", "gpt-5.4", 4),
	previewRuntime("preview-main", "context-rail", "archive", "Earlier session", "claude-opus-4.1", 8, false),
];

function snapshotFor(runtime: PreviewRuntime) {
	const activeTool = runtime.turn % 4 === 2 ? [`tool-${runtime.turn}`] : [];
	const tokens = Math.min(contextWindow, 18_000 + runtime.items.length * 4_200);
	const snapshot = {
		createdAt: Date.now(),
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
): void {
	const { activeTool, snapshot } = snapshotFor(runtime);
	viewer.publish(
		{
			phase: compacting ? "compacting" : activeTool.length > 0 ? "tool" : "context",
			activeTools: activeTool,
			snapshot,
			timeline,
		},
		runtime.source,
	);
}

function publishContext(runtime: PreviewRuntime, compacting = false): void {
	const { snapshot } = snapshotFor(runtime);
	publishState(runtime, runtime.timeline.apply(snapshot, {
		compaction: compacting,
		details: detailsFor(runtime.items),
	}), compacting);
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

for (const runtime of runtimes) publishContext(runtime);
let tick = 0;
const timer = setInterval(() => {
	const runtime = runtimes[tick % 2];
	if (runtime) advance(runtime);
	tick += 1;
}, 1_600);

console.log(viewer.viewerUrl);

const shutdown = async (): Promise<void> => {
	clearInterval(timer);
	for (const pendingTimer of pendingTimers) clearTimeout(pendingTimer);
	await viewer.stop();
	process.exit(0);
};

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
