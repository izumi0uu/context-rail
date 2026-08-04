export interface SceneItem {
	id: string;
	kind?: string;
	order?: number;
	synthetic?: boolean;
}

export interface SceneEdge {
	from: string;
	to: string;
	kind: "summary";
}

export interface SceneTimeline {
	history: SceneItem[];
	activeIds?: string[];
	pendingIds?: string[];
	summaryEdges?: SceneEdge[];
}

export interface Point {
	x: number;
	y: number;
}

export interface Bounds {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface ItemPlacement {
	id: string;
	epoch: number;
	home: Point;
	focus: Point;
	historyFocus: Point;
	pending: Point;
	isHub: boolean;
}

export interface EpochPlacement {
	index: number;
	anchor: Point;
	hubId?: string;
	itemIds: string[];
	bounds: Bounds;
}

export interface SceneLayoutOptions {
	nodeWidth: number;
	nodeHeight: number;
	compact?: boolean;
	mobile?: boolean;
}

export interface PushTargetOptions {
	nodeWidth: number;
	nodeHeight: number;
	gap?: number;
	gapX?: number;
	gapY?: number;
}

export interface SceneLayout {
	placements: Map<string, ItemPlacement>;
	epochs: EpochPlacement[];
	currentEpoch: number;
	focusHubId?: string;
	activeBounds: Bounds;
	pendingBounds?: Bounds;
	focusBounds: Bounds;
	homeBounds: Bounds;
	worldBounds: Bounds;
}

const EPOCH_COLUMNS = 3;
const EPOCH_START_X = 620;
const EPOCH_START_Y = 620;
const EPOCH_STEP_X = 2_240;
const EPOCH_STEP_Y = 1_720;
const EPOCH_ROW_GAP = 360;
const LAYOUT_NODE_WIDTH = 194;
const LAYOUT_NODE_HEIGHT = 104;
const RING_START_X = 300;
const RING_START_Y = 205;
const RING_STEP_X = 210;
const RING_STEP_Y = 150;

function itemId(item: SceneItem): string {
	return String(item.id);
}

export function epochAnchor(index: number): Point {
	const row = Math.floor(index / EPOCH_COLUMNS);
	const offset = index % EPOCH_COLUMNS;
	const column = row % 2 === 0 ? offset : EPOCH_COLUMNS - 1 - offset;
	return {
		x: EPOCH_START_X + column * EPOCH_STEP_X,
		y: EPOCH_START_Y + row * EPOCH_STEP_Y,
	};
}

interface EpochBlueprint {
	group: SceneItem[];
	hub?: SceneItem;
	offsets: Map<string, Point>;
	localBounds: Bounds;
}

function epochBlueprint(
	group: SceneItem[],
	summaryTargets: Set<string>,
	options: SceneLayoutOptions,
): EpochBlueprint {
	const hub = group.find((item) => summaryTargets.has(itemId(item)));
	const offsets = new Map<string, Point>();
	const points: Point[] = [];
	let ordinal = 0;
	for (const item of group) {
		const offset = item === hub
			? { x: 0, y: 0 }
			: fourSideRingPosition(ordinal++, 760, 7).point;
		offsets.set(itemId(item), offset);
		points.push(offset);
	}
	return {
		group,
		...(hub ? { hub } : {}),
		offsets,
		localBounds: boundsForPoints(
			points.length ? points : [{ x: 0, y: 0 }],
			options.nodeWidth,
			options.nodeHeight,
		),
	};
}

function epochAnchors(
	blueprints: EpochBlueprint[],
	previousLayout?: SceneLayout,
): Point[] {
	const rowCount = Math.ceil(blueprints.length / EPOCH_COLUMNS);
	const rowExtents = Array.from({ length: rowCount }, (_, row) => {
		const rowBlueprints = blueprints.slice(row * EPOCH_COLUMNS, (row + 1) * EPOCH_COLUMNS);
		return {
			top: Math.min(...rowBlueprints.map(({ localBounds }) => localBounds.y)),
			bottom: Math.max(
				...rowBlueprints.map(({ localBounds }) => localBounds.y + localBounds.height),
			),
		};
	});
	const rowY = [EPOCH_START_Y];
	for (let row = 1; row < rowCount; row += 1) {
		const previous = rowExtents[row - 1]!;
		const current = rowExtents[row]!;
		const collisionFreeStep = previous.bottom - current.top + EPOCH_ROW_GAP;
		rowY[row] = rowY[row - 1]! + Math.max(EPOCH_STEP_Y, collisionFreeStep);
	}
	const computed = blueprints.map((_blueprint, index) => ({
		x: epochAnchor(index).x,
		y: rowY[Math.floor(index / EPOCH_COLUMNS)]!,
	}));
	if (!previousLayout) return computed;

	return computed.map((candidate, index) => {
		const previousEpoch = previousLayout.epochs[index];
		if (previousEpoch) return { ...previousEpoch.anchor };

		const row = Math.floor(index / EPOCH_COLUMNS);
		const sameRowEpoch = previousLayout.epochs.find(
			(epoch) => Math.floor(epoch.index / EPOCH_COLUMNS) === row,
		);
		if (sameRowEpoch) return { x: candidate.x, y: sameRowEpoch.anchor.y };

		const previousRowEpochs = previousLayout.epochs.filter(
			(epoch) => Math.floor(epoch.index / EPOCH_COLUMNS) === row - 1,
		);
		if (previousRowEpochs.length === 0) return candidate;
		const previousBottom = Math.max(
			...previousRowEpochs.map(({ bounds }) => bounds.y + bounds.height),
		);
		const currentTop = rowExtents[row]?.top ?? 0;
		return {
			x: candidate.x,
			y: Math.max(candidate.y, previousBottom + EPOCH_ROW_GAP - currentTop),
		};
	});
}

interface RingGeometry {
	horizontal: number;
	vertical: number;
	radiusX: number;
	radiusY: number;
}

type RingSide = "top" | "right" | "bottom" | "left";

interface RingPosition {
	point: Point;
	ring: number;
	side: RingSide;
	sideIndex: number;
	sideCount: number;
}

function ringGeometry(ring: number, maxRadiusX: number, horizontalMaximum: number): RingGeometry {
	const radiusX = Math.min(maxRadiusX, RING_START_X + ring * RING_STEP_X);
	const radiusY = RING_START_Y + ring * RING_STEP_Y;
	const horizontalCapacity = Math.max(1, Math.floor(radiusX * 2 / LAYOUT_NODE_WIDTH) + 1);
	const horizontal = Math.min(horizontalMaximum, 3 + ring * 2, horizontalCapacity);
	const verticalCapacity = Math.max(0, Math.floor(radiusY * 2 / LAYOUT_NODE_HEIGHT) - 1);
	const previousRadiusX = ring === 0
		? 0
		: Math.min(maxRadiusX, RING_START_X + (ring - 1) * RING_STEP_X);
	const sideHasClearance = ring === 0 || radiusX - previousRadiusX >= LAYOUT_NODE_WIDTH;
	const vertical = sideHasClearance ? Math.min(2 + ring * 2, verticalCapacity) : 0;
	return { horizontal, vertical, radiusX, radiusY };
}

function ringCapacity(ring: number, maxRadiusX: number, horizontalMaximum: number): number {
	const geometry = ringGeometry(ring, maxRadiusX, horizontalMaximum);
	return geometry.horizontal * 2 + geometry.vertical * 2;
}

function perimeterPosition(offset: number, ring: number, geometry: RingGeometry): RingPosition {
	const { horizontal, vertical, radiusX, radiusY } = geometry;
	const topStep = horizontal === 1 ? 0 : radiusX * 2 / (horizontal - 1);
	const sideStep = radiusY * 2 / (vertical + 1);

	if (offset < horizontal) {
		return {
			point: { x: -radiusX + offset * topStep, y: -radiusY },
			ring,
			side: "top",
			sideIndex: offset,
			sideCount: horizontal,
		};
	}
	offset -= horizontal;
	if (offset < vertical) {
		return {
			point: { x: radiusX, y: -radiusY + (offset + 1) * sideStep },
			ring,
			side: "right",
			sideIndex: offset,
			sideCount: vertical,
		};
	}
	offset -= vertical;
	if (offset < horizontal) {
		return {
			point: { x: radiusX - offset * topStep, y: radiusY },
			ring,
			side: "bottom",
			sideIndex: offset,
			sideCount: horizontal,
		};
	}
	offset -= horizontal;
	return {
		point: { x: -radiusX, y: radiusY - (offset + 1) * sideStep },
		ring,
		side: "left",
		sideIndex: offset,
		sideCount: vertical,
	};
}

/** Stable rectangular rings: earlier positions never move when later items arrive. */
export function fourSidePosition(
	index: number,
	maxRadiusX: number,
	horizontalMaximum = 9,
): Point {
	return fourSideRingPosition(index, maxRadiusX, horizontalMaximum).point;
}

function fourSideRingPosition(
	index: number,
	maxRadiusX: number,
	horizontalMaximum = 9,
): RingPosition {
	let ring = 0;
	let offset = Math.max(0, index);
	while (offset >= ringCapacity(ring, maxRadiusX, horizontalMaximum)) {
		offset -= ringCapacity(ring, maxRadiusX, horizontalMaximum);
		ring += 1;
	}
	return perimeterPosition(offset, ring, ringGeometry(ring, maxRadiusX, horizontalMaximum));
}

export function boundsForPoints(
	points: Point[],
	nodeWidth: number,
	nodeHeight: number,
	paddingX = 110,
	paddingY = 92,
): Bounds {
	if (points.length === 0) {
		return { x: 180, y: 180, width: 520, height: 280 };
	}
	const halfWidth = nodeWidth / 2;
	const halfHeight = nodeHeight / 2;
	const minX = Math.min(...points.map((point) => point.x - halfWidth)) - paddingX;
	const maxX = Math.max(...points.map((point) => point.x + halfWidth)) + paddingX;
	const minY = Math.min(...points.map((point) => point.y - halfHeight)) - paddingY;
	const maxY = Math.max(...points.map((point) => point.y + halfHeight)) + paddingY;
	return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export function mergeBounds(left: Bounds, right: Bounds): Bounds {
	const minX = Math.min(left.x, right.x);
	const minY = Math.min(left.y, right.y);
	const maxX = Math.max(left.x + left.width, right.x + right.width);
	const maxY = Math.max(left.y + left.height, right.y + right.height);
	return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function containsPoint(bounds: Bounds, point: Point): boolean {
	return point.x >= bounds.x
		&& point.x <= bounds.x + bounds.width
		&& point.y >= bounds.y
		&& point.y <= bounds.y + bounds.height;
}

function expandBounds(bounds: Bounds, horizontal: number, vertical: number): Bounds {
	return {
		x: bounds.x - horizontal,
		y: bounds.y - vertical,
		width: bounds.width + horizontal * 2,
		height: bounds.height + vertical * 2,
	};
}

function nearestEdgeDirection(origin: Point, bounds: Bounds): Point {
	const candidates = [
		{ distance: Math.abs(origin.x - bounds.x), direction: { x: -1, y: 0 } },
		{ distance: Math.abs(bounds.x + bounds.width - origin.x), direction: { x: 1, y: 0 } },
		{ distance: Math.abs(origin.y - bounds.y), direction: { x: 0, y: -1 } },
		{ distance: Math.abs(bounds.y + bounds.height - origin.y), direction: { x: 0, y: 1 } },
	];
	candidates.sort((left, right) => left.distance - right.distance);
	return candidates[0]?.direction ?? { x: 1, y: 0 };
}

function rayBoundaryTarget(home: Point, origin: Point, bounds: Bounds): Point {
	let dx = home.x - origin.x;
	let dy = home.y - origin.y;
	if (Math.abs(dx) < Number.EPSILON && Math.abs(dy) < Number.EPSILON) {
		const fallback = nearestEdgeDirection(origin, bounds);
		dx = fallback.x;
		dy = fallback.y;
	}

	const candidates: number[] = [];
	if (dx > 0) candidates.push((bounds.x + bounds.width - origin.x) / dx);
	if (dx < 0) candidates.push((bounds.x - origin.x) / dx);
	if (dy > 0) candidates.push((bounds.y + bounds.height - origin.y) / dy);
	if (dy < 0) candidates.push((bounds.y - origin.y) / dy);
	const scale = Math.min(...candidates.filter((candidate) => candidate >= 0));
	if (!Number.isFinite(scale)) return { ...home };
	return {
		x: origin.x + dx * scale,
		y: origin.y + dy * scale,
	};
}

/**
 * Return a temporary window-mode target for a history node whose card overlaps
 * the focus frame. The permanent home coordinate is never mutated.
 */
export function pushTarget(
	home: Point,
	origin: Point,
	focusBounds: Bounds,
	options: PushTargetOptions,
): Point {
	const halfWidth = Math.max(0, options.nodeWidth) / 2;
	const halfHeight = Math.max(0, options.nodeHeight) / 2;
	const overlapBounds = expandBounds(focusBounds, halfWidth, halfHeight);
	if (!containsPoint(overlapBounds, home)) return { ...home };
	const sharedGap = Math.max(0, options.gap ?? 36);
	const gapX = Math.max(0, options.gapX ?? sharedGap);
	const gapY = Math.max(0, options.gapY ?? sharedGap);
	const targetBounds = expandBounds(focusBounds, halfWidth + gapX, halfHeight + gapY);
	return rayBoundaryTarget(home, origin, targetBounds);
}

function chooseFocusHub(
	itemsById: Map<string, SceneItem>,
	activeIds: string[],
	summaryTargets: Set<string>,
): string | undefined {
	const activeItems = activeIds.map((id) => itemsById.get(id)).filter(Boolean) as SceneItem[];
	return [...activeItems].reverse().find((item) => summaryTargets.has(itemId(item)))?.id
		?? [...activeItems].reverse().find((item) => item.kind === "memory")?.id
		?? activeItems.find((item) => item.kind === "system")?.id
		?? activeItems[0]?.id;
}

function pendingPosition(index: number, activeBounds: Bounds, nodeHeight: number): Point {
	const column = Math.floor(index / 8);
	const row = index % 8;
	return {
		x: activeBounds.x + activeBounds.width + 150 + column * 220,
		y: activeBounds.y + nodeHeight / 2 + 34 + row * (nodeHeight + 30),
	};
}

function appendCompatibleLayout(
	items: SceneItem[],
	previousLayout?: SceneLayout,
): SceneLayout | undefined {
	if (!previousLayout) return undefined;
	const previousIds = previousLayout.epochs.flatMap(({ itemIds }) => itemIds);
	if (previousIds.length > items.length) return undefined;
	for (const [index, id] of previousIds.entries()) {
		if (id !== itemId(items[index]!)) return undefined;
	}
	return previousLayout;
}

/**
 * Follow the original ray for the common case, then jump beyond the occupied
 * extent on one axis if the bounded probe is exhausted. The final assertion
 * keeps malformed/non-finite geometry from ever being accepted as overlap.
 */
function freePointAlongRay(
	candidate: Point,
	unit: Point,
	step: number,
	cellWidth: number,
	cellHeight: number,
	occupiedPoints: Point[],
	collides: (point: Point) => boolean,
	probeLimit: number,
): Point {
	let target = { ...candidate };
	for (let attempts = 0; attempts < probeLimit && collides(target); attempts += 1) {
		target = { x: target.x + unit.x * step, y: target.y + unit.y * step };
	}
	if (!collides(target)) return target;

	const useX = Math.abs(unit.x) >= Math.abs(unit.y);
	const axisUnit = useX ? unit.x : unit.y;
	const cellSize = useX ? cellWidth : cellHeight;
	if (
		occupiedPoints.length === 0
		|| !Number.isFinite(axisUnit)
		|| Math.abs(axisUnit) < Number.EPSILON
		|| !Number.isFinite(cellSize)
		|| cellSize <= 0
	) {
		throw new Error("Scene layout collision fallback received invalid geometry");
	}

	let extreme = useX ? occupiedPoints[0]!.x : occupiedPoints[0]!.y;
	for (const point of occupiedPoints.slice(1)) {
		const coordinate = useX ? point.x : point.y;
		extreme = axisUnit > 0
			? Math.max(extreme, coordinate)
			: Math.min(extreme, coordinate);
	}
	const clearCoordinate = extreme + Math.sign(axisUnit) * cellSize * 2;
	const currentCoordinate = useX ? target.x : target.y;
	const travel = (clearCoordinate - currentCoordinate) / axisUnit;
	if (!Number.isFinite(travel) || travel < 0) {
		throw new Error("Scene layout collision fallback could not advance outward");
	}
	target = {
		x: target.x + unit.x * travel,
		y: target.y + unit.y * travel,
	};
	if (collides(target)) {
		throw new Error("Scene layout collision fallback failed to find a free point");
	}
	return target;
}

export function buildSceneLayout(
	timeline: SceneTimeline,
	options: SceneLayoutOptions,
	previousLayout?: SceneLayout,
): SceneLayout {
	const items = [...(timeline.history || [])].sort(
		(left, right) => (left.order ?? 0) - (right.order ?? 0),
	);
	const stablePreviousLayout = appendCompatibleLayout(items, previousLayout);
	const itemsById = new Map(items.map((item) => [itemId(item), item]));
	const summaryTargets = new Set((timeline.summaryEdges || []).map((edge) => String(edge.to)));
	const epochItems = new Map<number, SceneItem[]>();
	const itemEpochs = new Map<string, number>();
	let epoch = 0;
	for (const item of items) {
		const id = itemId(item);
		if (summaryTargets.has(id) && (epochItems.get(epoch)?.length ?? 0) > 0) epoch += 1;
		const group = epochItems.get(epoch) || [];
		group.push(item);
		epochItems.set(epoch, group);
		itemEpochs.set(id, epoch);
	}
	const currentEpoch = Math.max(0, epoch);
	const activeIds = [...new Set((timeline.activeIds || []).map(String))].filter((id) => itemsById.has(id));
	const activeSet = new Set(activeIds);
	const pendingIds = [...new Set((timeline.pendingIds || []).map(String))]
		.filter((id) => itemsById.has(id) && !activeSet.has(id));
	const pendingSet = new Set(pendingIds);
	const focusHubId = chooseFocusHub(itemsById, activeIds, summaryTargets);
	const placements = new Map<string, ItemPlacement>();
	const epochs: EpochPlacement[] = [];
	const blueprints = Array.from({ length: currentEpoch + 1 }, (_, index) => (
		epochBlueprint(epochItems.get(index) || [], summaryTargets, options)
	));
	const anchors = epochAnchors(blueprints, stablePreviousLayout);
	const homeGap = 28;
	const homeCellWidth = options.nodeWidth + homeGap;
	const homeCellHeight = options.nodeHeight + homeGap;
	const occupiedHomes = new Map<string, Point[]>();
	const occupiedHomePoints: Point[] = [];
	const homeCellKey = (point: Point): string => (
		`${Math.floor(point.x / homeCellWidth)}:${Math.floor(point.y / homeCellHeight)}`
	);
	const occupyHome = (point: Point): void => {
		const key = homeCellKey(point);
		const cell = occupiedHomes.get(key) || [];
		cell.push(point);
		occupiedHomes.set(key, cell);
		occupiedHomePoints.push(point);
	};
	const homeCollides = (point: Point): boolean => {
		const column = Math.floor(point.x / homeCellWidth);
		const row = Math.floor(point.y / homeCellHeight);
		for (let x = column - 1; x <= column + 1; x += 1) {
			for (let y = row - 1; y <= row + 1; y += 1) {
				for (const other of occupiedHomes.get(`${x}:${y}`) || []) {
					if (
						Math.abs(point.x - other.x) < homeCellWidth
						&& Math.abs(point.y - other.y) < homeCellHeight
					) return true;
				}
			}
		}
		return false;
	};
	const retainedIds = new Set(items.map(itemId));
	for (const placement of stablePreviousLayout?.placements.values() || []) {
		if (retainedIds.has(placement.id)) occupyHome(placement.home);
	}
	const resolveNewHome = (candidate: Point, anchor: Point): Point => {
		if (!stablePreviousLayout || !homeCollides(candidate)) return candidate;
		let dx = candidate.x - anchor.x;
		let dy = candidate.y - anchor.y;
		let distance = Math.hypot(dx, dy);
		if (distance < Number.EPSILON) {
			dx = 0;
			dy = 1;
			distance = 1;
		}
		const unitX = dx / distance;
		const unitY = dy / distance;
		const step = Math.min(
			Math.abs(unitX) > Number.EPSILON
				? homeCellWidth / Math.abs(unitX)
				: Number.POSITIVE_INFINITY,
			Math.abs(unitY) > Number.EPSILON
				? homeCellHeight / Math.abs(unitY)
				: Number.POSITIVE_INFINITY,
		);
		return freePointAlongRay(
			candidate,
			{ x: unitX, y: unitY },
			step,
			homeCellWidth,
			homeCellHeight,
			occupiedHomePoints,
			homeCollides,
			2_048,
		);
	};

	for (let index = 0; index <= currentEpoch; index += 1) {
		const anchor = anchors[index] ?? epochAnchor(index);
		const blueprint = blueprints[index]!;
		const { group, hub } = blueprint;
		const points: Point[] = [];
		for (const item of group) {
			const id = itemId(item);
			const isHub = item === hub;
			const offset = blueprint.offsets.get(id) ?? { x: 0, y: 0 };
			const previousHome = stablePreviousLayout?.placements.get(id)?.home;
			const candidate = { x: anchor.x + offset.x, y: anchor.y + offset.y };
			const home = previousHome ? { ...previousHome } : resolveNewHome(candidate, anchor);
			if (!previousHome) occupyHome(home);
			points.push(home);
			placements.set(id, {
				id,
				epoch: index,
				home,
				focus: home,
				historyFocus: { ...home },
				pending: home,
				isHub,
			});
		}
		epochs.push({
			index,
			anchor,
			...(hub ? { hubId: itemId(hub) } : {}),
			itemIds: group.map(itemId),
			bounds: boundsForPoints(points.length ? points : [anchor], options.nodeWidth, options.nodeHeight),
		});
	}

	const focusAnchor = anchors[currentEpoch] ?? epochAnchor(currentEpoch);
	let focusOrdinal = 0;
	const focusPoints: Point[] = [];
	for (const id of activeIds) {
		const placement = placements.get(id);
		if (!placement) continue;
		const focus = id === focusHubId
			? { ...focusAnchor }
			: (() => {
				const offset = fourSidePosition(
					focusOrdinal++,
					options.compact ? 720 : options.mobile ? 820 : 1_050,
					options.compact ? 5 : options.mobile ? 7 : 9,
				);
				return { x: focusAnchor.x + offset.x, y: focusAnchor.y + offset.y };
			})();
		placement.focus = focus;
		focusPoints.push(focus);
	}

	const activeBounds = boundsForPoints(
		focusPoints.length ? focusPoints : [focusAnchor],
		options.nodeWidth,
		options.nodeHeight,
		options.compact ? 72 : 120,
		options.compact ? 46 : 98,
	);
	const pendingPoints: Point[] = [];
	for (const [index, id] of pendingIds.entries()) {
		const placement = placements.get(id);
		if (!placement) continue;
		placement.pending = pendingPosition(index, activeBounds, options.nodeHeight);
		pendingPoints.push(placement.pending);
	}
	const pendingBounds = pendingPoints.length
		? boundsForPoints(pendingPoints, options.nodeWidth, options.nodeHeight, 76, 64)
		: undefined;
	const focusBounds = pendingBounds ? mergeBounds(activeBounds, pendingBounds) : activeBounds;
	const focusOrigin = {
		x: activeBounds.x + activeBounds.width / 2,
		y: activeBounds.y + activeBounds.height / 2,
	};
	const historyPlacements = [...placements.values()]
		.filter((placement) => !activeSet.has(placement.id) && !pendingSet.has(placement.id));
	const rawHistoryTargets = new Map(historyPlacements.map((placement) => [
		placement.id,
		pushTarget(placement.home, focusOrigin, focusBounds, {
			nodeWidth: options.nodeWidth,
			nodeHeight: options.nodeHeight,
			gap: 36,
		}),
	]));

	// Keep permanent homes fixed, then advance only colliding push-out targets
	// along their original ray until they reach a free card-sized cell.
	const collisionGap = 28;
	const cellWidth = options.nodeWidth + collisionGap;
	const cellHeight = options.nodeHeight + collisionGap;
	const occupied = new Map<string, Point[]>();
	const occupiedPoints: Point[] = [];
	const cellKey = (point: Point): string => (
		`${Math.floor(point.x / cellWidth)}:${Math.floor(point.y / cellHeight)}`
	);
	const occupy = (point: Point): void => {
		const key = cellKey(point);
		const cell = occupied.get(key) || [];
		cell.push(point);
		occupied.set(key, cell);
		occupiedPoints.push(point);
	};
	const collides = (point: Point): boolean => {
		const column = Math.floor(point.x / cellWidth);
		const row = Math.floor(point.y / cellHeight);
		for (let x = column - 1; x <= column + 1; x += 1) {
			for (let y = row - 1; y <= row + 1; y += 1) {
				for (const other of occupied.get(`${x}:${y}`) || []) {
					if (
						Math.abs(point.x - other.x) < cellWidth
						&& Math.abs(point.y - other.y) < cellHeight
					) return true;
				}
			}
		}
		return false;
	};
	const pushed: ItemPlacement[] = [];
	for (const placement of historyPlacements) {
		const rawTarget = rawHistoryTargets.get(placement.id) ?? placement.home;
		if (rawTarget.x === placement.home.x && rawTarget.y === placement.home.y) {
			placement.historyFocus = rawTarget;
			occupy(rawTarget);
		} else pushed.push(placement);
	}
	for (const placement of pushed) {
		const rawTarget = rawHistoryTargets.get(placement.id) ?? placement.home;
		let dx = rawTarget.x - focusOrigin.x;
		let dy = rawTarget.y - focusOrigin.y;
		let distance = Math.hypot(dx, dy);
		if (distance < Number.EPSILON) {
			const fallback = nearestEdgeDirection(focusOrigin, focusBounds);
			dx = fallback.x;
			dy = fallback.y;
			distance = 1;
		}
		const unitX = dx / distance;
		const unitY = dy / distance;
		const step = Math.min(
			Math.abs(unitX) > Number.EPSILON ? cellWidth / Math.abs(unitX) : Number.POSITIVE_INFINITY,
			Math.abs(unitY) > Number.EPSILON ? cellHeight / Math.abs(unitY) : Number.POSITIVE_INFINITY,
		);
		const target = freePointAlongRay(
			rawTarget,
			{ x: unitX, y: unitY },
			step,
			cellWidth,
			cellHeight,
			occupiedPoints,
			collides,
			512,
		);
		placement.historyFocus = target;
		occupy(target);
	}
	const homePoints = [...placements.values()].map((placement) => placement.home);
	const homeBounds = boundsForPoints(homePoints, options.nodeWidth, options.nodeHeight, 180, 160);
	const historyFocusPoints = [...placements.values()].map((placement) => placement.historyFocus);
	const historyFocusBounds = boundsForPoints(
		historyFocusPoints,
		options.nodeWidth,
		options.nodeHeight,
		180,
		160,
	);
	const worldBounds = mergeBounds(mergeBounds(homeBounds, historyFocusBounds), focusBounds);

	return {
		placements,
		epochs,
		currentEpoch,
		...(focusHubId ? { focusHubId } : {}),
		activeBounds,
		...(pendingBounds ? { pendingBounds } : {}),
		focusBounds,
		homeBounds,
		worldBounds,
	};
}
