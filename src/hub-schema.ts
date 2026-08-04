import type { RenderStatePatch } from "./hub-delta.ts";
import type { ContextRailSessionSource } from "./hub-types.ts";
import type { RenderState } from "./render.ts";
import type {
	ContextDetailBlock,
	ContextDetailModelMessage,
	ContextDetailModelRole,
	ContextItem,
	ContextItemDetail,
	ContextItemKind,
	ContextSnapshot,
} from "./snapshot.ts";
import type { ContextTimelineSnapshot, HistoryItem, SummaryEdge } from "./timeline.ts";

const ITEM_KINDS = new Set<ContextItemKind>([
	"system",
	"memory",
	"developer",
	"user",
	"assistant",
	"tool",
	"unknown",
]);
const PHASES = new Set<RenderState["phase"]>(["idle", "context", "tool", "compacting"]);
const DETAIL_MODEL_ROLES = new Set<ContextDetailModelRole>([
	"system",
	"user",
	"developer",
	"assistant",
	"toolResult",
]);

function record(value: unknown, path: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${path} must be an object`);
	}
	return value as Record<string, unknown>;
}

function stringValue(value: unknown, path: string): string {
	if (typeof value !== "string") throw new Error(`${path} must be a string`);
	return value;
}

function nonEmptyString(value: unknown, path: string): string {
	const result = stringValue(value, path);
	if (!result) throw new Error(`${path} must not be empty`);
	return result;
}

function booleanValue(value: unknown, path: string): boolean {
	if (typeof value !== "boolean") throw new Error(`${path} must be a boolean`);
	return value;
}

function finiteNonNegative(value: unknown, path: string): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		throw new Error(`${path} must be a finite non-negative number`);
	}
	return value;
}

function nonNegativeInteger(value: unknown, path: string): number {
	const result = finiteNonNegative(value, path);
	if (!Number.isSafeInteger(result)) throw new Error(`${path} must be a non-negative safe integer`);
	return result;
}

function stringArray(value: unknown, path: string): string[] {
	if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
	return value.map((entry, index) => stringValue(entry, `${path}[${index}]`));
}

function itemKind(value: unknown, path: string): ContextItemKind {
	if (typeof value !== "string" || !ITEM_KINDS.has(value as ContextItemKind)) {
		throw new Error(`${path} must be a supported item kind`);
	}
	return value as ContextItemKind;
}

function phaseValue(value: unknown, path: string): RenderState["phase"] {
	if (typeof value !== "string" || !PHASES.has(value as RenderState["phase"])) {
		throw new Error(`${path} must be a supported phase`);
	}
	return value as RenderState["phase"];
}

function detailModelRole(value: unknown, path: string): ContextDetailModelRole {
	if (
		typeof value !== "string" ||
		!DETAIL_MODEL_ROLES.has(value as ContextDetailModelRole)
	) {
		throw new Error(`${path} must be a supported model role`);
	}
	return value as ContextDetailModelRole;
}

function projectDetailBlock(value: unknown, path: string): ContextDetailBlock {
	const input = record(value, path);
	switch (input.type) {
		case "text":
			return { type: "text", text: stringValue(input.text, `${path}.text`) };
		case "thinking":
			if (input.redacted !== undefined && input.redacted !== true) {
				throw new Error(`${path}.redacted must be true when present`);
			}
			return {
				type: "thinking",
				text: stringValue(input.text, `${path}.text`),
				...(input.redacted === true ? { redacted: true } : {}),
			};
		case "image":
			return {
				type: "image",
				mimeType: nonEmptyString(input.mimeType, `${path}.mimeType`),
				data: stringValue(input.data, `${path}.data`),
			};
		case "toolCall":
			return {
				type: "toolCall",
				name: nonEmptyString(input.name, `${path}.name`),
				argumentsJson: stringValue(input.argumentsJson, `${path}.argumentsJson`),
			};
		default:
			throw new Error(`${path}.type must be a supported detail block`);
	}
}

function projectDetailModelMessage(value: unknown, path: string): ContextDetailModelMessage {
	const input = record(value, path);
	return {
		modelRole: detailModelRole(input.modelRole, `${path}.modelRole`),
		blocks: projectArray(input.blocks, `${path}.blocks`, projectDetailBlock),
	};
}

function projectItemDetail(value: unknown, path: string): ContextItemDetail {
	const input = record(value, path);
	return {
		sourceRole: nonEmptyString(input.sourceRole, `${path}.sourceRole`),
		modelMessages: projectArray(
			input.modelMessages,
			`${path}.modelMessages`,
			projectDetailModelMessage,
		),
		...(input.isError !== undefined
			? { isError: booleanValue(input.isError, `${path}.isError`) }
			: {}),
	};
}

function projectItem(value: unknown, path: string): ContextItem {
	const input = record(value, path);
	return {
		id: nonEmptyString(input.id, `${path}.id`),
		kind: itemKind(input.kind, `${path}.kind`),
		...(input.toolName !== undefined
			? { toolName: stringValue(input.toolName, `${path}.toolName`) }
			: {}),
	};
}

function projectHistoryItem(value: unknown, path: string): HistoryItem {
	const input = record(value, path);
	const item = projectItem(input, path);
	if (input.pending !== undefined && input.pending !== true) {
		throw new Error(`${path}.pending must be true when present`);
	}
	return {
		...item,
		order: nonNegativeInteger(input.order, `${path}.order`),
		firstSeenAt: finiteNonNegative(input.firstSeenAt, `${path}.firstSeenAt`),
		lastSeenAt: finiteNonNegative(input.lastSeenAt, `${path}.lastSeenAt`),
		...(input.pending === true ? { pending: true } : {}),
		...(input.confirmedAt !== undefined
			? { confirmedAt: finiteNonNegative(input.confirmedAt, `${path}.confirmedAt`) }
			: {}),
		...(input.synthetic !== undefined
			? { synthetic: booleanValue(input.synthetic, `${path}.synthetic`) }
			: {}),
		...(input.detail !== undefined
			? { detail: projectItemDetail(input.detail, `${path}.detail`) }
			: {}),
	};
}

function projectSummaryEdge(value: unknown, path: string): SummaryEdge {
	const input = record(value, path);
	if (input.kind !== "summary") throw new Error(`${path}.kind must be summary`);
	return {
		from: nonEmptyString(input.from, `${path}.from`),
		to: nonEmptyString(input.to, `${path}.to`),
		kind: "summary",
	};
}

function projectArray<T>(
	value: unknown,
	path: string,
	project: (entry: unknown, path: string) => T,
): T[] {
	if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
	return value.map((entry, index) => project(entry, `${path}[${index}]`));
}

function projectSnapshot(value: unknown, path: string): ContextSnapshot {
	const input = record(value, path);
	return {
		createdAt: finiteNonNegative(input.createdAt, `${path}.createdAt`),
		...(input.model !== undefined ? { model: stringValue(input.model, `${path}.model`) } : {}),
		...(input.tokens !== undefined
			? { tokens: finiteNonNegative(input.tokens, `${path}.tokens`) }
			: {}),
		...(input.contextWindow !== undefined
			? { contextWindow: finiteNonNegative(input.contextWindow, `${path}.contextWindow`) }
			: {}),
		...(input.percent !== undefined
			? { percent: finiteNonNegative(input.percent, `${path}.percent`) }
			: {}),
		items: projectArray(input.items, `${path}.items`, projectItem),
	};
}

function projectTimeline(value: unknown, path: string): ContextTimelineSnapshot {
	const input = record(value, path);
	return {
		revision: nonNegativeInteger(input.revision, `${path}.revision`),
		history: projectArray(input.history, `${path}.history`, projectHistoryItem),
		activeIds: stringArray(input.activeIds, `${path}.activeIds`),
		enteredIds: stringArray(input.enteredIds, `${path}.enteredIds`),
		retainedIds: stringArray(input.retainedIds, `${path}.retainedIds`),
		exitedIds: stringArray(input.exitedIds, `${path}.exitedIds`),
		observedIds: stringArray(input.observedIds, `${path}.observedIds`),
		confirmedIds: stringArray(input.confirmedIds, `${path}.confirmedIds`),
		pendingIds: stringArray(input.pendingIds, `${path}.pendingIds`),
		summaryEdges: projectArray(input.summaryEdges, `${path}.summaryEdges`, projectSummaryEdge),
	};
}

export function projectRenderState(value: unknown): RenderState {
	const input = record(value, "state");
	return {
		snapshot: input.snapshot === undefined
			? undefined
			: projectSnapshot(input.snapshot, "state.snapshot"),
		phase: phaseValue(input.phase, "state.phase"),
		activeTools: stringArray(input.activeTools, "state.activeTools"),
		...(input.timeline !== undefined
			? { timeline: projectTimeline(input.timeline, "state.timeline") }
			: {}),
	};
}

export function projectSessionSource(value: unknown): ContextRailSessionSource {
	const input = record(value, "source");
	return {
		processId: nonEmptyString(input.processId, "source.processId"),
		processLabel: nonEmptyString(input.processLabel, "source.processLabel"),
		sessionId: nonEmptyString(input.sessionId, "source.sessionId"),
		sessionLabel: nonEmptyString(input.sessionLabel, "source.sessionLabel"),
		...(input.active !== undefined ? { active: booleanValue(input.active, "source.active") } : {}),
		...(input.activity !== undefined
			? { activity: booleanValue(input.activity, "source.activity") }
			: {}),
	};
}

export function projectRenderStatePatch(value: unknown): RenderStatePatch {
	const input = record(value, "patch");
	const result: RenderStatePatch = {};
	if (input.reset !== undefined) result.reset = booleanValue(input.reset, "patch.reset");
	if (input.snapshot !== undefined) {
		result.snapshot = input.snapshot === null ? null : projectSnapshot(input.snapshot, "patch.snapshot");
	}
	if (input.phase !== undefined) result.phase = phaseValue(input.phase, "patch.phase");
	if (input.activeTools !== undefined) {
		result.activeTools = stringArray(input.activeTools, "patch.activeTools");
	}
	if (input.timeline === null) {
		result.timeline = null;
	} else if (input.timeline !== undefined) {
		const timeline = record(input.timeline, "patch.timeline");
		const projected: NonNullable<RenderStatePatch["timeline"]> = {};
		if (timeline.reset !== undefined) {
			projected.reset = booleanValue(timeline.reset, "patch.timeline.reset");
		}
		if (timeline.revision !== undefined) {
			projected.revision = nonNegativeInteger(timeline.revision, "patch.timeline.revision");
		}
		if (timeline.historyUpserts !== undefined) {
			projected.historyUpserts = projectArray(
				timeline.historyUpserts,
				"patch.timeline.historyUpserts",
				projectHistoryItem,
			);
		}
		for (const key of [
			"activeIds",
			"enteredIds",
			"retainedIds",
			"exitedIds",
			"observedIds",
			"confirmedIds",
			"pendingIds",
		] as const) {
			if (timeline[key] !== undefined) {
				projected[key] = stringArray(timeline[key], `patch.timeline.${key}`);
			}
		}
		if (timeline.summaryEdgeUpserts !== undefined) {
			projected.summaryEdgeUpserts = projectArray(
				timeline.summaryEdgeUpserts,
				"patch.timeline.summaryEdgeUpserts",
				projectSummaryEdge,
			);
		}
		result.timeline = projected;
	}
	return result;
}
