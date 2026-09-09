import assert from "node:assert/strict";
import test from "node:test";
import {
	boundsForPoints,
	buildSceneLayout,
	epochAnchor,
	fourSidePosition,
	pushTarget,
	type Bounds,
	type ItemPlacement,
	type Point,
	type SceneItem,
	type SceneLayout,
	type SceneTimeline,
} from "../web/src/scene-layout.ts";

const NODE_OPTIONS = { nodeWidth: 194, nodeHeight: 104 } as const;
const COLLISION_GAP = 28;

function history(count: number, start = 0): SceneItem[] {
	return Array.from({ length: count }, (_, index) => ({
		id: `item-${start + index}`,
		kind: index === 0 && start === 0 ? "system" : "user",
		order: start + index,
	}));
}

function layout(timeline: SceneTimeline, previous?: SceneLayout) {
	return buildSceneLayout(timeline, NODE_OPTIONS, previous);
}

function compactedTimeline(epochSizes: number[]): SceneTimeline {
	const items: SceneItem[] = [];
	const summaryEdges: NonNullable<SceneTimeline["summaryEdges"]> = [];
	let order = 0;
	for (const [epoch, size] of epochSizes.entries()) {
		if (epoch > 0) {
			const summaryId = `summary-${epoch}`;
			summaryEdges.push({ from: items.at(-1)!.id, to: summaryId, kind: "summary" });
			items.push({ id: summaryId, kind: "memory", order: order++, synthetic: true });
		}
		const ordinaryCount = Math.max(0, size - (epoch > 0 ? 1 : 0));
		for (let index = 0; index < ordinaryCount; index += 1) {
			items.push({ id: `epoch-${epoch}-item-${index}`, kind: "user", order: order++ });
		}
	}
	return {
		history: items,
		activeIds: items.slice(-5).map(({ id }) => id),
		summaryEdges,
	};
}

function assertHomesDoNotOverlap(result: SceneLayout): void {
	const occupied = new Map<string, ItemPlacement[]>();
	for (const placement of result.placements.values()) {
		const column = Math.floor(placement.home.x / NODE_OPTIONS.nodeWidth);
		const row = Math.floor(placement.home.y / NODE_OPTIONS.nodeHeight);
		for (let x = column - 1; x <= column + 1; x += 1) {
			for (let y = row - 1; y <= row + 1; y += 1) {
				for (const other of occupied.get(`${x}:${y}`) || []) {
					assert.ok(
						Math.abs(placement.home.x - other.home.x) >= NODE_OPTIONS.nodeWidth
							|| Math.abs(placement.home.y - other.home.y) >= NODE_OPTIONS.nodeHeight,
						`${placement.id} overlaps ${other.id} at their permanent homes`,
					);
				}
			}
		}
		const key = `${column}:${row}`;
		const cell = occupied.get(key) || [];
		cell.push(placement);
		occupied.set(key, cell);
	}
}

function relocatedLayout(base: SceneLayout, homes: Map<string, Point>): SceneLayout {
	return {
		...base,
		placements: new Map([...base.placements].map(([id, placement]) => [
			id,
			{
				...placement,
				home: { ...(homes.get(id) ?? placement.home) },
			},
		])),
	};
}

function assertPointClears(
	point: Point,
	other: Point,
	width: number,
	height: number,
	message: string,
): void {
	assert.ok(
		Math.abs(point.x - other.x) >= width || Math.abs(point.y - other.y) >= height,
		message,
	);
}

function largeCompactedTimeline(count: number, epochOrdinarySize = 71): SceneTimeline {
	const items: SceneItem[] = [];
	const summaryEdges: NonNullable<SceneTimeline["summaryEdges"]> = [];
	let ordinaryInEpoch = 0;
	let messageOrdinal = 0;
	let summaryOrdinal = 0;
	while (items.length < count) {
		if (ordinaryInEpoch === epochOrdinarySize) {
			const summaryId = `long-summary-${summaryOrdinal++}`;
			summaryEdges.push({ from: items.at(-1)!.id, to: summaryId, kind: "summary" });
			items.push({ id: summaryId, kind: "memory", order: items.length, synthetic: true });
			ordinaryInEpoch = 0;
			continue;
		}
		items.push({ id: `long-message-${messageOrdinal++}`, kind: "user", order: items.length });
		ordinaryInEpoch += 1;
	}
	return {
		history: items,
		activeIds: items.slice(-8).map(({ id }) => id),
		summaryEdges,
	};
}

function cardOverlapsFrame(point: Point, frame: Bounds): boolean {
	const halfWidth = NODE_OPTIONS.nodeWidth / 2;
	const halfHeight = NODE_OPTIONS.nodeHeight / 2;
	return point.x + halfWidth >= frame.x
		&& point.x - halfWidth <= frame.x + frame.width
		&& point.y + halfHeight >= frame.y
		&& point.y - halfHeight <= frame.y + frame.height;
}

function frameCenter(frame: Bounds): Point {
	return {
		x: frame.x + frame.width / 2,
		y: frame.y + frame.height / 2,
	};
}

function asymmetricWindowLayout() {
	const items = history(20);
	return {
		items,
		result: layout({
			history: items,
			activeIds: [items[0]!.id, items[10]!.id, items[11]!.id],
		}),
	};
}

test("appending history never changes existing item home positions", () => {
	const initialHistory = history(24);
	const initial = layout({
		history: initialHistory,
		activeIds: initialHistory.slice(-6).map(({ id }) => id),
	});
	const appendedHistory = [...initialHistory, ...history(32, initialHistory.length)];
	const appended = layout({
		history: appendedHistory,
		activeIds: appendedHistory.slice(-6).map(({ id }) => id),
	});

	for (const item of initialHistory) {
		assert.deepEqual(
			appended.placements.get(item.id)?.home,
			initial.placements.get(item.id)?.home,
			`home position changed for ${item.id}`,
		);
	}
});

test("a compaction summary opens the next epoch and becomes its hub", () => {
	const timeline: SceneTimeline = {
		history: [
			{ id: "message-0", kind: "user", order: 0 },
			{ id: "message-1", kind: "assistant", order: 1 },
			{ id: "summary-0", kind: "memory", order: 2, synthetic: true },
			{ id: "message-2", kind: "user", order: 3 },
		],
		activeIds: ["summary-0", "message-2"],
		summaryEdges: [
			{ from: "message-0", to: "summary-0", kind: "summary" },
			{ from: "message-1", to: "summary-0", kind: "summary" },
		],
	};
	const result = layout(timeline);

	assert.equal(result.currentEpoch, 1);
	assert.deepEqual(result.epochs.map(({ itemIds }) => itemIds), [
		["message-0", "message-1"],
		["summary-0", "message-2"],
	]);
	assert.equal(result.epochs[1]?.hubId, "summary-0");
	assert.equal(result.placements.get("summary-0")?.isHub, true);
	assert.deepEqual(result.placements.get("summary-0")?.home, epochAnchor(1));
});

test("long epochs remain collision-free across multiple serpentine rows", () => {
	const result = layout(compactedTimeline(Array.from({ length: 10 }, () => 120)));

	assert.equal(result.epochs.length, 10);
	assertHomesDoNotOverlap(result);
});

test("appending to a later epoch preserves existing homes and only places new cards", () => {
	const initialTimeline = compactedTimeline([83, 83, 83, 1]);
	const initial = layout(initialTimeline);
	const appended = layout(compactedTimeline([83, 83, 83, 21]), initial);

	for (const item of initialTimeline.history) {
		assert.deepEqual(
			appended.placements.get(item.id)?.home,
			initial.placements.get(item.id)?.home,
			`${item.id} moved after a later epoch grew`,
		);
	}
	assertHomesDoNotOverlap(appended);
});

test("randomized sequential appends preserve homes across 10k cards and many compactions", { timeout: 15_000 }, () => {
	const complete = largeCompactedTimeline(10_000);
	const summaryOrder = new Map(complete.history.map(({ id }, index) => [id, index]));
	let randomState = 0x9e3779b9;
	const nextBatchSize = () => {
		randomState = (Math.imul(randomState, 1_664_525) + 1_013_904_223) >>> 0;
		return 137 + randomState % 257;
	};
	let visibleCount = 0;
	let previous: SceneLayout | undefined;
	while (visibleCount < complete.history.length) {
		visibleCount = Math.min(complete.history.length, visibleCount + nextBatchSize());
		const visibleHistory = complete.history.slice(0, visibleCount);
		const current = layout({
			history: visibleHistory,
			activeIds: visibleHistory.slice(-8).map(({ id }) => id),
			summaryEdges: (complete.summaryEdges || []).filter(
				({ to }) => (summaryOrder.get(to) ?? Number.POSITIVE_INFINITY) < visibleCount,
			),
		}, previous);
		for (const [id, placement] of previous?.placements || []) {
			assert.deepEqual(current.placements.get(id)?.home, placement.home, `${id} moved during append`);
		}
		previous = current;
	}

	assert.ok(previous);
	assert.equal(previous.placements.size, 10_000);
	assert.ok(previous.currentEpoch > 100, "fixture must include many compaction epochs");
	assertHomesDoNotOverlap(previous);
});

test("bounds handle a large point set without spreading it onto the call stack", () => {
	const points = Array.from({ length: 200_000 }, (_, index) => ({
		x: index - 100_000,
		y: 100_000 - index * 2,
	}));
	assert.deepEqual(boundsForPoints(points, 20, 10, 0, 0), {
		x: -100_010,
		y: -300_003,
		width: 200_019,
		height: 400_008,
	});
});

test("placement modes never alias the permanent home point", () => {
	const [item] = history(1);
	assert.ok(item);
	const result = layout({ history: [item] });
	const placement = result.placements.get(item.id);
	assert.ok(placement);
	const originalHome = { ...placement.home };
	placement.focus.x += 10;
	placement.pending.y += 10;
	assert.deepEqual(placement.home, originalHome);
});

test("four-side layout rejects a non-positive horizontal capacity", () => {
	assert.throws(() => fourSidePosition(0, 1_050, 0), /horizontalMaximum must be greater than zero/);
});

test("a shrunk reset does not reuse stale homes even when item ids are reused", () => {
	const originalTimeline = compactedTimeline([40, 40, 40]);
	const original = layout(originalTimeline);
	const reusedIds = [originalTimeline.history.at(-1)!.id, originalTimeline.history[45]!.id];
	const resetTimeline: SceneTimeline = {
		history: reusedIds.map((id, order) => ({ id, kind: "user", order })),
		activeIds: reusedIds,
	};
	const freshReset = layout(resetTimeline);
	const resetAfterOldLayout = layout(resetTimeline, original);

	for (const id of reusedIds) {
		assert.deepEqual(
			resetAfterOldLayout.placements.get(id)?.home,
			freshReset.placements.get(id)?.home,
			`${id} inherited a stale pre-reset home`,
		);
	}
	assert.notDeepEqual(
		resetAfterOldLayout.placements.get(reusedIds[0]!)?.home,
		original.placements.get(reusedIds[0]!)?.home,
		"fixture must prove a reused id had an observable stale coordinate",
	);

	const appendedTimeline: SceneTimeline = {
		...resetTimeline,
		history: [
			...resetTimeline.history,
			{ id: "post-reset-item", kind: "assistant", order: resetTimeline.history.length },
		],
	};
	const appended = layout(appendedTimeline, resetAfterOldLayout);
	for (const id of reusedIds) {
		assert.deepEqual(
			appended.placements.get(id)?.home,
			resetAfterOldLayout.placements.get(id)?.home,
			`${id} moved after the reset timeline resumed appending`,
		);
	}
});

test("home collision fallback clears more than 2048 occupied ray positions", () => {
	const retained = history(2_050);
	const appendedItem: SceneItem = { id: "after-home-probe-cap", kind: "assistant", order: retained.length };
	const allItems = [...retained, appendedItem];
	const fresh = layout({ history: allItems });
	const previous = layout({ history: retained });
	const candidate = fresh.placements.get(appendedItem.id)!.home;
	const anchor = previous.epochs[0]!.anchor;
	let dx = candidate.x - anchor.x;
	let dy = candidate.y - anchor.y;
	let distance = Math.hypot(dx, dy);
	if (distance < Number.EPSILON) {
		dx = 0;
		dy = 1;
		distance = 1;
	}
	const unit = { x: dx / distance, y: dy / distance };
	const cellWidth = NODE_OPTIONS.nodeWidth + COLLISION_GAP;
	const cellHeight = NODE_OPTIONS.nodeHeight + COLLISION_GAP;
	const step = Math.min(
		Math.abs(unit.x) > Number.EPSILON ? cellWidth / Math.abs(unit.x) : Number.POSITIVE_INFINITY,
		Math.abs(unit.y) > Number.EPSILON ? cellHeight / Math.abs(unit.y) : Number.POSITIVE_INFINITY,
	);
	const blockerHomes = new Map(retained.map(({ id }, index) => [
		id,
		{ x: candidate.x + unit.x * step * index, y: candidate.y + unit.y * step * index },
	]));
	const adversarialPrevious = relocatedLayout(previous, blockerHomes);
	const result = layout({ history: allItems }, adversarialPrevious);
	const resolved = result.placements.get(appendedItem.id)!.home;

	for (const item of retained) {
		assert.deepEqual(
			result.placements.get(item.id)?.home,
			blockerHomes.get(item.id),
			`${item.id} moved while resolving the appended card`,
		);
		assertPointClears(
			resolved,
			blockerHomes.get(item.id)!,
			cellWidth,
			cellHeight,
			`appended home still overlaps ${item.id}`,
		);
	}
});

test("the first rectangular ring distributes cards across all four sides", () => {
	const points = Array.from({ length: 10 }, (_, index) => fourSidePosition(index, 1_050, 9));

	assert.ok(points.slice(0, 3).every((point) => point.y === -205), "top side is populated");
	assert.ok(points.slice(3, 5).every((point) => point.x === 300), "right side is populated");
	assert.ok(points.slice(5, 8).every((point) => point.y === 205), "bottom side is populated");
	assert.ok(points.slice(8, 10).every((point) => point.x === -300), "left side is populated");
	assert.equal(new Set(points.map(({ x, y }) => `${x}:${y}`)).size, points.length);
});

test("overlapping history is pushed past the frame along its center ray without moving home", () => {
	const home = { x: 100, y: 20 };
	const origin = { x: 0, y: 0 };
	const focusBounds = { x: -200, y: -100, width: 400, height: 200 };
	const pushed = pushTarget(home, origin, focusBounds, {
		nodeWidth: 80,
		nodeHeight: 60,
		gap: 20,
	});

	assert.deepEqual(home, { x: 100, y: 20 }, "push targeting must not mutate permanent home coordinates");
	assert.notDeepEqual(pushed, home);
	assert.ok(Math.abs(pushed.x * home.y - pushed.y * home.x) < 1e-9, "target stays on the center ray");
	assert.equal(pushed.x - 40, focusBounds.x + focusBounds.width + 20);
	assert.deepEqual(
		pushTarget({ x: 500, y: 0 }, origin, focusBounds, { nodeWidth: 80, nodeHeight: 60, gap: 20 }),
		{ x: 500, y: 0 },
		"history already clear of the frame should stay at home",
	);
});

test("window projection leaves every non-overlapping history card at its permanent home", () => {
	const { items, result } = asymmetricWindowLayout();
	const activeIds = new Set([items[0]!.id, items[10]!.id, items[11]!.id]);
	const distant = items
		.filter(({ id }) => !activeIds.has(id))
		.map(({ id }) => result.placements.get(id))
		.filter((placement): placement is ItemPlacement => Boolean(
			placement && !cardOverlapsFrame(placement.home, result.activeBounds),
		));

	assert.ok(distant.length > 0, "fixture must include history cards already outside the active frame");
	for (const placement of distant) {
		assert.deepEqual(
			placement.historyFocus,
			placement.home,
			`${placement.id} was outside the frame and must not be assigned a rail slot`,
		);
	}
});

test("window projection pushes only overlapping history cards radially beyond the frame", () => {
	const { items, result } = asymmetricWindowLayout();
	const activeIds = new Set([items[0]!.id, items[10]!.id, items[11]!.id]);
	const origin = frameCenter(result.activeBounds);
	const hubFocus = result.placements.get(result.focusHubId!)?.focus;
	assert.ok(hubFocus);
	assert.notDeepEqual(origin, hubFocus, "fixture must distinguish frame-center rays from hub rays");
	const overlapping = items
		.filter(({ id }) => !activeIds.has(id))
		.map(({ id }) => result.placements.get(id))
		.filter((placement): placement is ItemPlacement => Boolean(
			placement && cardOverlapsFrame(placement.home, result.activeBounds),
		));

	assert.ok(overlapping.length >= 2, "fixture must include multiple overlapping history cards");
	for (const placement of overlapping) {
		assert.notDeepEqual(placement.historyFocus, placement.home);
		const homeRay = { x: placement.home.x - origin.x, y: placement.home.y - origin.y };
		const targetRay = {
			x: placement.historyFocus.x - origin.x,
			y: placement.historyFocus.y - origin.y,
		};
		assert.ok(
			Math.abs(homeRay.x * targetRay.y - homeRay.y * targetRay.x) < 1e-8,
			`${placement.id} must follow its home ray`,
		);
		assert.ok(
			Math.hypot(targetRay.x, targetRay.y) > Math.hypot(homeRay.x, homeRay.y),
			`${placement.id} must move outward`,
		);
		assert.equal(
			cardOverlapsFrame(placement.historyFocus, result.activeBounds),
			false,
			`${placement.id} must clear the active frame after push-out`,
		);
	}
});

test("adjacent overlapping history cards keep distinct positions on their own rays", () => {
	const { items, result } = asymmetricWindowLayout();
	const activeIds = new Set([items[0]!.id, items[10]!.id, items[11]!.id]);
	const origin = frameCenter(result.activeBounds);
	let adjacent: [ItemPlacement, ItemPlacement] | undefined;
	for (let index = 0; index < items.length - 1; index += 1) {
		if (activeIds.has(items[index]!.id) || activeIds.has(items[index + 1]!.id)) continue;
		const first = result.placements.get(items[index]!.id);
		const second = result.placements.get(items[index + 1]!.id);
		if (
			first
			&& second
			&& cardOverlapsFrame(first.home, result.activeBounds)
			&& cardOverlapsFrame(second.home, result.activeBounds)
		) {
			adjacent = [first, second];
			break;
		}
	}
	assert.ok(adjacent, "fixture must contain adjacent overlapping history cards");

	const [first, second] = adjacent;
	assert.notDeepEqual(first.historyFocus, second.historyFocus, "push-out must not merge neighboring cards");
	for (const placement of [first, second]) {
		const homeRay = { x: placement.home.x - origin.x, y: placement.home.y - origin.y };
		const targetRay = {
			x: placement.historyFocus.x - origin.x,
			y: placement.historyFocus.y - origin.y,
		};
		assert.ok(
			Math.abs(homeRay.x * targetRay.y - homeRay.y * targetRay.x) < 1e-8,
			`${placement.id} was moved off its own radial line`,
		);
		assert.ok(homeRay.x * targetRay.x + homeRay.y * targetRay.y > 0, "push-out must stay on the outward ray");
	}
});

test("pushed history resolves collisions without moving stationary homes", () => {
	const items = history(80);
	const activeIds = [items[0]!.id, ...items.slice(-6).map(({ id }) => id)];
	const activeSet = new Set(activeIds);
	const result = layout({ history: items, activeIds });
	const pushed = items
		.filter(({ id }) => !activeSet.has(id))
		.map(({ id }) => result.placements.get(id))
		.filter((placement): placement is ItemPlacement => Boolean(
			placement
			&& (placement.historyFocus.x !== placement.home.x || placement.historyFocus.y !== placement.home.y),
		));

	assert.ok(pushed.length > 10, "fixture must exercise multiple permanent rings");
	for (let left = 0; left < pushed.length; left += 1) {
		for (let right = left + 1; right < pushed.length; right += 1) {
			const a = pushed[left]!;
			const b = pushed[right]!;
			assert.ok(
				Math.abs(a.historyFocus.x - b.historyFocus.x) >= NODE_OPTIONS.nodeWidth
					|| Math.abs(a.historyFocus.y - b.historyFocus.y) >= NODE_OPTIONS.nodeHeight,
				`${a.id} overlaps ${b.id} after push-out`,
			);
		}
	}
});

test("history push fallback clears more than 512 occupied ray positions", () => {
	const blockerCount = 513;
	const blockers = Array.from({ length: blockerCount }, (_, order) => ({
		id: `history-blocker-${order}`,
		kind: "user",
		order,
	}));
	const candidate: SceneItem = { id: "history-after-probe-cap", kind: "assistant", order: blockerCount };
	const active: SceneItem = { id: "active-hub", kind: "system", order: blockerCount + 1 };
	const timeline: SceneTimeline = {
		history: [...blockers, candidate, active],
		activeIds: [active.id],
	};
	const base = layout(timeline);
	const origin = frameCenter(base.focusBounds);
	const candidateHome = { ...origin };
	const rawTarget = pushTarget(candidateHome, origin, base.focusBounds, {
		nodeWidth: NODE_OPTIONS.nodeWidth,
		nodeHeight: NODE_OPTIONS.nodeHeight,
		gap: 36,
	});
	const dx = rawTarget.x - origin.x;
	const dy = rawTarget.y - origin.y;
	const distance = Math.hypot(dx, dy);
	const unit = { x: dx / distance, y: dy / distance };
	const cellWidth = NODE_OPTIONS.nodeWidth + COLLISION_GAP;
	const cellHeight = NODE_OPTIONS.nodeHeight + COLLISION_GAP;
	const step = Math.min(
		Math.abs(unit.x) > Number.EPSILON ? cellWidth / Math.abs(unit.x) : Number.POSITIVE_INFINITY,
		Math.abs(unit.y) > Number.EPSILON ? cellHeight / Math.abs(unit.y) : Number.POSITIVE_INFINITY,
	);
	const homes = new Map<string, Point>([
		...blockers.map(({ id }, index): [string, Point] => [
			id,
			{ x: rawTarget.x + unit.x * step * index, y: rawTarget.y + unit.y * step * index },
		]),
		[candidate.id, candidateHome],
	]);
	const adversarialPrevious = relocatedLayout(base, homes);
	const result = layout(timeline, adversarialPrevious);
	const resolved = result.placements.get(candidate.id)!.historyFocus;

	for (const blocker of blockers) {
		assertPointClears(
			resolved,
			homes.get(blocker.id)!,
			cellWidth,
			cellHeight,
			`history target still overlaps ${blocker.id}`,
		);
	}
	const resolvedRay = { x: resolved.x - origin.x, y: resolved.y - origin.y };
	assert.ok(
		Math.abs(resolvedRay.x * dy - resolvedRay.y * dx) < 1e-8,
		"fallback must preserve the original history ray",
	);
	assert.ok(resolvedRay.x * dx + resolvedRay.y * dy > 0, "fallback must continue outward");
});

test("pending cards participate in the history exclusion frame", () => {
	const items = history(10);
	const pendingId = items.at(-1)!.id;
	const result = layout({
		history: items,
		activeIds: [items[0]!.id],
		pendingIds: [pendingId],
	});
	const pending = result.placements.get(pendingId)!;

	for (const item of items.slice(1, -1)) {
		const placement = result.placements.get(item.id)!;
		assert.ok(
			Math.abs(placement.historyFocus.x - pending.pending.x) >= NODE_OPTIONS.nodeWidth
				|| Math.abs(placement.historyFocus.y - pending.pending.y) >= NODE_OPTIONS.nodeHeight,
			`${item.id} overlaps the pending card`,
		);
	}
});

test("focus window lays out active context left to right and then top to bottom", () => {
	const items = history(8);
	items[2]!.kind = "memory";
	const activeIds = [
		items[0]!.id,
		items[4]!.id,
		items[2]!.id,
		items[7]!.id,
		items[1]!.id,
	];
	const result = buildSceneLayout({ history: items, activeIds }, {
		...NODE_OPTIONS,
		focusColumns: 3,
	});
	const points = activeIds.map((id) => result.placements.get(id)!.focus);

	assert.deepEqual(points[0], epochAnchor(0), "the first context item anchors the matrix");
	assert.ok(points[0]!.x < points[1]!.x && points[1]!.x < points[2]!.x);
	assert.equal(points[0]!.y, points[1]!.y);
	assert.equal(points[1]!.y, points[2]!.y);
	assert.equal(points[3]!.x, points[0]!.x);
	assert.equal(points[4]!.x, points[1]!.x);
	assert.equal(points[3]!.y, points[4]!.y);
	assert.ok(points[3]!.y > points[0]!.y);
	assert.equal(result.focusHubId, items[2]!.id);
	assert.deepEqual(
		result.placements.get(result.focusHubId!)!.focus,
		points[2],
		"hub metadata must not pull a context item out of sequence",
	);
});

test("focus matrix removes unknown and duplicate ids without leaving empty cells", () => {
	const items = history(3);
	const result = buildSceneLayout({
		history: items,
		activeIds: ["ghost", items[2]!.id, "missing", items[0]!.id, items[2]!.id, items[1]!.id],
	}, {
		...NODE_OPTIONS,
		focusColumns: 2,
	});
	const anchor = epochAnchor(0);

	assert.deepEqual(result.placements.get(items[2]!.id)!.focus, anchor);
	assert.deepEqual(result.placements.get(items[0]!.id)!.focus, {
		x: anchor.x + NODE_OPTIONS.nodeWidth + 30,
		y: anchor.y,
	});
	assert.deepEqual(result.placements.get(items[1]!.id)!.focus, {
		x: anchor.x,
		y: anchor.y + NODE_OPTIONS.nodeHeight + 30,
	});
});

test("focus matrix appends into the next cell without moving earlier active cards", () => {
	const items = history(7);
	const buildActiveLayout = (itemCount: number) => buildSceneLayout({
		history: items,
		activeIds: items.slice(0, itemCount).map(({ id }) => id),
	}, {
		...NODE_OPTIONS,
		focusColumns: 6,
	});
	const five = buildActiveLayout(5);
	const six = buildActiveLayout(6);
	const seven = buildActiveLayout(7);

	for (const item of items.slice(0, 5)) {
		assert.deepEqual(six.placements.get(item.id)!.focus, five.placements.get(item.id)!.focus);
	}
	for (const item of items.slice(0, 6)) {
		assert.deepEqual(seven.placements.get(item.id)!.focus, six.placements.get(item.id)!.focus);
	}
	assert.equal(seven.placements.get(items[6]!.id)!.focus.x, seven.placements.get(items[0]!.id)!.focus.x);
	assert.ok(seven.placements.get(items[6]!.id)!.focus.y > seven.placements.get(items[0]!.id)!.focus.y);
});

test("focus matrix enforces its maximum width at the layout boundary", () => {
	const items = history(7);
	const timeline = { history: items, activeIds: items.map(({ id }) => id) };
	const capped = buildSceneLayout(timeline, { ...NODE_OPTIONS, focusColumns: 6 });
	const oversized = buildSceneLayout(timeline, { ...NODE_OPTIONS, focusColumns: 99 });

	assert.equal(oversized.activeBounds.width, capped.activeBounds.width);
	assert.equal(
		oversized.placements.get(items[6]!.id)!.focus.x,
		oversized.placements.get(items[0]!.id)!.focus.x,
	);
	assert.ok(
		oversized.placements.get(items[6]!.id)!.focus.y
			> oversized.placements.get(items[0]!.id)!.focus.y,
	);
	assert.throws(
		() => buildSceneLayout(timeline, { ...NODE_OPTIONS, focusColumns: 0 }),
		/focusColumns must be greater than zero/,
	);
});

test("focus matrix defaults to two columns on mobile", () => {
	const items = history(3);
	const result = buildSceneLayout({
		history: items,
		activeIds: items.map(({ id }) => id),
	}, {
		...NODE_OPTIONS,
		mobile: true,
	});

	assert.equal(result.placements.get(items[0]!.id)!.focus.y, result.placements.get(items[1]!.id)!.focus.y);
	assert.equal(result.placements.get(items[2]!.id)!.focus.x, result.placements.get(items[0]!.id)!.focus.x);
	assert.ok(result.placements.get(items[2]!.id)!.focus.y > result.placements.get(items[0]!.id)!.focus.y);
});

test("focus column count never changes permanent history geometry", () => {
	const items = history(18);
	const timeline = {
		history: items,
		activeIds: items.slice(-6).map(({ id }) => id),
	};
	const twoColumns = buildSceneLayout(timeline, { ...NODE_OPTIONS, focusColumns: 2 });
	const sixColumns = buildSceneLayout(timeline, { ...NODE_OPTIONS, focusColumns: 6 });

	for (const item of items) {
		assert.deepEqual(twoColumns.placements.get(item.id)!.home, sixColumns.placements.get(item.id)!.home);
	}
	assert.deepEqual(twoColumns.epochs, sixColumns.epochs);
	assert.deepEqual(twoColumns.homeBounds, sixColumns.homeBounds);
});

test("focus layout stops widening and grows vertically after reaching its width cap", () => {
	const buildActiveLayout = (itemCount: number) => {
		const items = history(itemCount);
		return buildSceneLayout({ history: items, activeIds: items.map(({ id }) => id) }, {
			...NODE_OPTIONS,
			focusColumns: 6,
		});
	};
	const widthSaturated = buildActiveLayout(6);
	const verticallyExpanded = buildActiveLayout(7);

	assert.equal(verticallyExpanded.activeBounds.width, widthSaturated.activeBounds.width);
	assert.ok(
		verticallyExpanded.activeBounds.height > widthSaturated.activeBounds.height,
		"later rows should add height after horizontal growth is capped",
	);
	assert.equal(verticallyExpanded.focusHubId, "item-0");
	assert.deepEqual(verticallyExpanded.placements.get("item-0")?.focus, epochAnchor(0));
});
