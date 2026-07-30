import { startContextRailServer } from "./server.ts";
import type { ContextItem, ContextItemKind } from "./snapshot.ts";

const viewer = await startContextRailServer();
const contextWindow = 200_000;
const kinds: ContextItemKind[] = ["user", "assistant", "tool", "assistant"];
let turn = 0;
let items: ContextItem[] = [
	{ id: "system-prompt", kind: "system" },
	{ id: "message-seed-user", kind: "user" },
	{ id: "message-seed-assistant", kind: "assistant" },
];

const publish = (): void => {
	const compacting = turn > 0 && turn % 10 === 0;
	const activeTool = turn % 4 === 2 ? [`tool-${turn}`] : [];
	const tokens = Math.min(contextWindow, 18_000 + items.length * 4_200);
	viewer.publish({
		phase: compacting ? "compacting" : activeTool.length > 0 ? "tool" : "context",
		activeTools: activeTool,
		snapshot: {
			createdAt: Date.now(),
			model: "context-rail-preview",
			tokens,
			contextWindow,
			percent: (tokens / contextWindow) * 100,
			items,
		},
	});
};

publish();
const timer = setInterval(() => {
	turn += 1;
	if (turn % 10 === 0) {
		items = [
			items[0] ?? { id: "system-prompt", kind: "system" },
			{ id: `memory-${turn}`, kind: "memory" },
			...items.slice(-4),
		];
	} else {
		const kind = kinds[(turn - 1) % kinds.length] ?? "unknown";
		items = [
			...items,
			{
				id: `message-preview-${turn}`,
				kind,
				...(kind === "tool" ? { toolName: `tool-${turn}` } : {}),
			},
		];
	}
	publish();
}, 1_600);

console.log(viewer.url);

const shutdown = async (): Promise<void> => {
	clearInterval(timer);
	await viewer.stop();
	process.exit(0);
};

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
