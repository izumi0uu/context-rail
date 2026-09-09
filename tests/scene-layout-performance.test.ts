import assert from "node:assert/strict";
import test from "node:test";
import {
	buildSceneLayout,
	fourSidePosition,
	type SceneItem,
	type SceneTimeline,
} from "../web/src/scene-layout.ts";

const options = { nodeWidth: 194, nodeHeight: 104, focusColumns: 6 };

function history(count: number, start = 0): SceneItem[] {
	return Array.from({ length: count }, (_, index) => ({
		id: `item-${start + index}`,
		kind: "user",
		order: start + index,
	}));
}

function timeline(items: SceneItem[]): SceneTimeline {
	return {
		history: items,
		activeIds: items.slice(-24).map(({ id }) => id),
		pendingIds: [],
		summaryEdges: [],
	};
}

test("sequential epoch ring positions exactly match all first 10,000 public lookups", () => {
	const items = history(10_000);
	const result = buildSceneLayout(timeline(items), options);
	const anchor = result.epochs[0]!.anchor;
	for (const [index, item] of items.entries()) {
		const expected = fourSidePosition(index, 760, 7);
		assert.deepEqual(result.placements.get(item.id)!.home, {
			x: anchor.x + expected.x,
			y: anchor.y + expected.y,
		}, `ring sequence diverged at ordinal ${index}`);
	}
});

test("each summary epoch resets its cursor and its hub does not consume a perimeter position", () => {
	const items = history(2_003);
	items[1_001] = { ...items[1_001]!, kind: "memory", synthetic: true };
	const result = buildSceneLayout({
		...timeline(items),
		summaryEdges: [{ from: items[1_000]!.id, to: items[1_001]!.id, kind: "summary" }],
	}, options);
	assert.equal(result.epochs.length, 2);
	for (const epoch of result.epochs) {
		let ordinal = 0;
		for (const id of epoch.itemIds) {
			const expected = id === epoch.hubId ? { x: 0, y: 0 } : fourSidePosition(ordinal++, 760, 7);
			assert.deepEqual(result.placements.get(id)!.home, {
				x: epoch.anchor.x + expected.x,
				y: epoch.anchor.y + expected.y,
			}, `epoch ${epoch.index} differs at ${id}`);
		}
	}
	assert.deepEqual(result.placements.get(items[1_001]!.id)!.home, result.epochs[1]!.anchor);
});

test("appending across ring boundaries preserves all previous homes and epoch anchors", () => {
	// Include each early geometry transition, width saturation, and a long capped epoch.
	for (const count of [9, 10, 27, 28, 53, 54, 1_000, 10_000]) {
		const items = history(count);
		const previous = buildSceneLayout(timeline(items), options);
		const next = buildSceneLayout(timeline([...items, ...history(1, count)]), options, previous);
		assert.deepEqual(next.epochs.map(({ anchor }) => anchor), previous.epochs.map(({ anchor }) => anchor));
		for (const [id, placement] of previous.placements) {
			assert.deepEqual(next.placements.get(id)!.home, placement.home, `${id} moved at append boundary ${count}`);
		}
	}
});

test("empty, hub-only, and later summary epochs do not share cursor state", () => {
	assert.equal(buildSceneLayout(timeline([]), options).placements.size, 0);
	const items = history(3);
	items[1] = { ...items[1]!, kind: "memory", synthetic: true };
	items[2] = { ...items[2]!, kind: "memory", synthetic: true };
	const source = {
		...timeline(items),
		summaryEdges: [
			{ from: items[0]!.id, to: items[1]!.id, kind: "summary" as const },
			{ from: items[1]!.id, to: items[2]!.id, kind: "summary" as const },
		],
	};
	const previous = buildSceneLayout(source, options);
	assert.equal(previous.epochs.length, 3);
	for (const epoch of previous.epochs.slice(1)) {
		assert.equal(epoch.itemIds.length, 1);
		assert.deepEqual(previous.placements.get(epoch.hubId!)!.home, epoch.anchor);
	}
	const nextItems = [...items, ...history(1_000, items.length)];
	const next = buildSceneLayout({ ...source, history: nextItems }, options, previous);
	assert.deepEqual(next.epochs.map(({ anchor }) => anchor), previous.epochs.map(({ anchor }) => anchor));
	assert.deepEqual(next.placements.get(items[2]!.id)!.home, previous.placements.get(items[2]!.id)!.home);
});

function layoutFloorOperations(count: number): number {
	const source = timeline(history(count));
	const floor = Math.floor;
	let operations = 0;
	try {
		// Geometry and occupancy use floor operations. Count work rather than asserting
		// wall-clock timing, which varies with concurrent tests and development machines.
		Math.floor = (value: number): number => { operations += 1; return floor(value); };
		buildSceneLayout(source, options);
	} finally {
		Math.floor = floor;
	}
	return operations;
}

test("long single epochs perform bounded linear ring/occupancy arithmetic", () => {
	const small = layoutFloorOperations(1_000);
	const large = layoutFloorOperations(10_000);
	assert.ok(large < 10_000 * 8 + 2_000, `10k layout used ${large} floor operations`);
	assert.ok(large < small * 12, `10x more cards grew arithmetic by ${(large / small).toFixed(2)}x`);
});
