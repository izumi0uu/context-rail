import type { ContextItem, ContextItemKind, ContextSnapshot } from "./snapshot.ts";
import type { ContextTimelineSnapshot } from "./timeline.ts";

const ITEM_LABELS: Record<ContextItemKind, string> = {
	system: "SYS",
	memory: "MEM",
	developer: "DEV",
	user: "USR",
	assistant: "AST",
	tool: "TOL",
	unknown: "???",
};

export interface RenderState {
	snapshot: ContextSnapshot | undefined;
	timeline?: ContextTimelineSnapshot;
	phase: "idle" | "context" | "tool" | "compacting";
	activeTools: readonly string[];
}

export function formatTokens(value: number | undefined): string {
	if (value === undefined) return "?";
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
	if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
	return Math.round(value).toString();
}

function itemLabel(item: ContextItem): string {
	return `[${ITEM_LABELS[item.kind]}]`;
}

export function renderStrip(items: readonly ContextItem[], maxBlocks = 12): string {
	if (items.length === 0) return "[empty]";
	if (items.length <= maxBlocks) return items.map(itemLabel).join("");

	const first = items[0];
	const preserveHead = first?.kind === "system";
	const reserved = preserveHead ? 2 : 1;
	const tailCount = Math.max(1, maxBlocks - reserved);
	const tail = items.slice(-tailCount).map(itemLabel).join("");
	const hidden = items.length - tailCount - (preserveHead ? 1 : 0);
	return `${preserveHead && first ? itemLabel(first) : ""}[...+${hidden}]${tail}`;
}

export function renderStatus(state: RenderState): string {
	const snapshot = state.snapshot;
	if (!snapshot) return "ctx waiting";

	const percent = snapshot.percent === undefined ? "?" : `${Math.round(snapshot.percent)}%`;
	const toolSuffix = state.activeTools.length > 0 ? ` | ${state.activeTools.length} tool` : "";
	return `ctx ${percent} | ${formatTokens(snapshot.tokens)}/${formatTokens(snapshot.contextWindow)} | ${snapshot.items.length} items${toolSuffix}`;
}

export function renderWidget(state: RenderState): string[] {
	const snapshot = state.snapshot;
	if (!snapshot) return ["Context window | waiting for the next model call"];

	const model = snapshot.model ? ` | ${snapshot.model}` : "";
	const percent = snapshot.percent === undefined ? "?" : `${Math.round(snapshot.percent)}%`;
	const phase = state.activeTools.length > 0 ? `tool: ${state.activeTools.join(", ")}` : state.phase;

	return [
		`Context window${model}`,
		`${formatTokens(snapshot.tokens)} / ${formatTokens(snapshot.contextWindow)} tokens | ${percent}`,
		renderStrip(snapshot.items),
		`phase: ${phase}`,
	];
}
