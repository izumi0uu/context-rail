import { createHash, randomUUID } from "node:crypto";
import { projectItemDetail } from "./hub-schema.ts";
import type { ContextCapture, ContextItem, ContextItemDetail, ContextSnapshot } from "./snapshot.ts";

export type ContextCaptureSource = "context-hook" | "session-reconstruction";
export type ContextCaptureReason = "session-start" | "session-tree" | "session-compaction" | "context-compaction";

export interface ContextCaptureVersion extends ContextItem {
	versionId: string;
	detail?: ContextItemDetail;
}

export interface ContextCaptureEntry {
	id: string;
	capturedAt: number;
	source: ContextCaptureSource;
	reason?: ContextCaptureReason;
	snapshot: ContextSnapshot;
	itemCount: number;
	itemRefs: { itemId: string; versionId: string }[];
	contentStatus: "available" | "omitted";
	omittedReason?: "byte-limit";
}

export interface ContextCaptureArchiveSnapshot {
	revision: number;
	entries: ContextCaptureEntry[];
	versions: ContextCaptureVersion[];
}

export interface ContextCaptureArchiveOptions {
	maxCaptures?: number;
	/** Retained UTF-8 JSON payload budget, not an exact JavaScript heap limit. */
	maxBytes?: number;
}

export function emptyCaptureArchive(): ContextCaptureArchiveSnapshot {
	return { revision: 0, entries: [], versions: [] };
}

function freeze<T>(value: T): T {
	if (value && typeof value === "object" && !Object.isFrozen(value)) {
		for (const child of Object.values(value)) freeze(child);
		Object.freeze(value);
	}
	return value;
}

// Compare shared scalar strings directly: unchanged multi-megabyte detail blocks
// do not need serialization, hashing, or structured cloning on every capture.
function equal(left: unknown, right: unknown): boolean {
	if (left === right) return true;
	if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
	const leftKeys = Object.keys(left);
	const rightKeys = Object.keys(right);
	return leftKeys.length === rightKeys.length && leftKeys.every((key) =>
		Object.hasOwn(right, key) && equal(
			(left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key],
		));
}

function versionHash(item: ContextItem, detail: ContextItemDetail | undefined): string {
	const hash = createHash("sha256");
	const visit = (value: unknown): void => {
		if (typeof value === "string") {
			// Preserve JavaScript code units, including isolated surrogates. UTF-8
			// encoding would collapse those into U+FFFD and alias distinct content.
			hash.update(`s${value.length}:`);
			hash.update(value, "utf16le");
		} else if (value && typeof value === "object") {
			hash.update(Array.isArray(value) ? "[" : "{");
			for (const [key, child] of Object.entries(value)) { visit(key); visit(child); }
			hash.update(Array.isArray(value) ? "]" : "}");
		} else hash.update(`${typeof value}:${String(value)};`);
	};
	visit(item);
	visit(detail);
	return `v-${hash.digest("hex")}`;
}

function bytes(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value));
}

/** Producer-owned, bounded archive of active contexts; not a provider-call log.
 * Returned snapshots and all reachable objects are immutable. Only new versions
 * copy object/array shells; their string content is structurally shared.
 */
export class ContextCaptureArchive {
	private readonly archiveId = randomUUID();
	private readonly maxCaptures: number;
	private readonly maxBytes: number;
	private revision = 0;
	private entries: ContextCaptureEntry[] = [];
	private readonly versions = new Map<string, ContextCaptureVersion>();
	private readonly latestByItem = new Map<string, ContextCaptureVersion>();
	private readonly versionBytes = new Map<string, number>();
	private readonly entryBytes = new Map<string, number>();
	private snapshot = freeze(emptyCaptureArchive());

	constructor(options: ContextCaptureArchiveOptions = {}) {
		this.maxCaptures = Number.isFinite(options.maxCaptures)
			? Math.max(1, Math.floor(options.maxCaptures!)) : 24;
		// Enough room to retain a compact, explicit unavailable marker.
		this.maxBytes = Number.isFinite(options.maxBytes)
			? Math.max(1024, Math.floor(options.maxBytes!)) : 8 * 1024 * 1024;
	}

	current(): ContextCaptureArchiveSnapshot { return this.snapshot; }

	append(capture: ContextCapture, options: {
		source?: ContextCaptureSource;
		reason?: ContextCaptureReason;
	} = {}): ContextCaptureArchiveSnapshot {
		const itemRefs: ContextCaptureEntry["itemRefs"] = [];
		const candidates = new Map<string, ContextCaptureVersion>();
		for (const rawItem of capture.snapshot.items) {
			const item: ContextItem = {
				id: rawItem.id, kind: rawItem.kind,
				...(rawItem.toolName !== undefined ? { toolName: rawItem.toolName } : {}),
			};
			const rawDetail = capture.details.get(item.id);
			const detail = rawDetail === undefined ? undefined : projectItemDetail(rawDetail, "capture.detail");
			const previous = this.latestByItem.get(item.id);
			let version = previous && previous.kind === item.kind && previous.toolName === item.toolName
				&& equal(previous.detail, detail) ? previous : undefined;
			if (!version) {
				const versionId = versionHash(item, detail);
				version = this.versions.get(versionId) ?? candidates.get(versionId) ?? freeze({
					...item, versionId, ...(detail !== undefined ? { detail } : {}),
				});
			}
			candidates.set(version.versionId, version);
			itemRefs.push({ itemId: item.id, versionId: version.versionId });
		}
		const snapshot = capture.snapshot;
		let entry: ContextCaptureEntry = {
			id: `capture-${this.archiveId}-${++this.revision}`,
			capturedAt: snapshot.createdAt,
			source: options.source ?? "context-hook",
			...(options.reason ? { reason: options.reason } : {}),
			snapshot: {
				createdAt: snapshot.createdAt,
				...(snapshot.model !== undefined ? { model: snapshot.model } : {}),
				...(snapshot.tokens !== undefined ? { tokens: snapshot.tokens } : {}),
				...(snapshot.contextWindow !== undefined ? { contextWindow: snapshot.contextWindow } : {}),
				...(snapshot.percent !== undefined ? { percent: snapshot.percent } : {}),
				items: itemRefs.map(({ versionId }) => {
					const version = candidates.get(versionId)!;
					return { id: version.id, kind: version.kind, ...(version.toolName !== undefined ? { toolName: version.toolName } : {}) };
				}),
			},
			itemCount: snapshot.items.length,
			itemRefs,
			contentStatus: "available",
		};
		const candidateBytes = new Map([...candidates].map(([id, version]) => [id, this.versionBytes.get(id) ?? bytes(version)]));
		// Include JSON envelope/array overhead, not just content strings.
		const standaloneBytes = bytes(entry) + [...candidateBytes.values()].reduce((sum, size) => sum + size + 1, 0) + 128;
		if (standaloneBytes > this.maxBytes) {
			entry = {
				...entry, snapshot: { ...entry.snapshot, items: [] }, itemRefs: [],
				contentStatus: "omitted", omittedReason: "byte-limit",
			};
			if (bytes(entry) + 128 > this.maxBytes) delete entry.snapshot.model;
			candidates.clear();
		}
		freeze(entry);
		this.entries.push(entry);
		this.entryBytes.set(entry.id, bytes(entry));
		for (const [id, version] of candidates) {
			this.versions.set(id, version);
			this.versionBytes.set(id, candidateBytes.get(id)!);
		}
		this.pruneVersions();
		while (this.entries.length > 1 && (this.entries.length > this.maxCaptures || this.retainedBytes() > this.maxBytes)) {
			this.entryBytes.delete(this.entries.shift()!.id);
			this.pruneVersions();
		}
		this.latestByItem.clear();
		for (const retained of this.entries) {
			for (const ref of retained.itemRefs) this.latestByItem.set(ref.itemId, this.versions.get(ref.versionId)!);
		}
		this.snapshot = freeze({ revision: this.revision, entries: [...this.entries], versions: [...this.versions.values()] });
		return this.snapshot;
	}

	private retainedBytes(): number {
		return 128 + [...this.entryBytes.values(), ...this.versionBytes.values()].reduce((sum, size) => sum + size + 1, 0);
	}

	private pruneVersions(): void {
		const retained = new Set(this.entries.flatMap((entry) => entry.itemRefs.map((ref) => ref.versionId)));
		for (const id of this.versions.keys()) {
			if (!retained.has(id)) { this.versions.delete(id); this.versionBytes.delete(id); }
		}
	}
}
