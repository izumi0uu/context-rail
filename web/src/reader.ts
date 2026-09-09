/** Small, safe reading primitives. No HTML from message content is interpreted. */
export const READER_PAGE_CHARACTERS = 16_000;
export const READER_PAGE_BLOCKS = 24;

export interface ReadingSection {
	kind: "paragraph" | "heading" | "code" | "list";
	text: string;
}

export function readingSections(text: string): ReadingSection[] {
	const sections: ReadingSection[] = [];
	let lines: string[] = [];
	let inCode = false;
	const flush = (): void => {
		if (!lines.length) return;
		sections.push({ kind: inCode ? "code" : "paragraph", text: lines.join("\n") });
		lines = [];
	};
	for (const line of text.split("\n")) {
		if (/^\s*```/.test(line)) {
			flush();
			inCode = !inCode;
		} else if (inCode) {
			lines.push(line);
		} else if (/^#{1,6}\s+/.test(line)) {
			flush();
			sections.push({ kind: "heading", text: line.replace(/^#{1,6}\s+/, "") });
		} else if (/^\s*(?:[-*+] |\d+[.)] )/.test(line)) {
			flush();
			sections.push({ kind: "list", text: line });
		} else if (!line.trim()) flush();
		else lines.push(line);
	}
	flush();
	return sections;
}

export function contentState(item: { synthetic?: boolean; pending?: boolean; active?: boolean }): string {
	if (item.synthetic) return "Compaction event · not model content";
	if (item.pending) return "Observed · awaiting context";
	return item.active ? "In captured context" : "Outside captured context";
}

/** Equality at render granularity, without serializing message bodies or image data. */
export function sameOrderedIds(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
	return a === b || Boolean(a && b && a.length === b.length && a.every((id, index) => id === b[index]));
}

export function sameSceneTimeline(
	a: { history: readonly unknown[]; activeIds?: string[]; pendingIds?: string[]; summaryEdges?: readonly unknown[] } | null,
	b: { history: readonly unknown[]; activeIds?: string[]; pendingIds?: string[]; summaryEdges?: readonly unknown[] },
): boolean {
	return a === b || Boolean(a
		&& a.history === b.history
		&& a.summaryEdges === b.summaryEdges
		&& sameOrderedIds(a.activeIds, b.activeIds)
		&& sameOrderedIds(a.pendingIds, b.pendingIds));
}
