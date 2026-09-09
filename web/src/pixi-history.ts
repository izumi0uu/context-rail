import "pixi.js/unsafe-eval";
import { Application, CanvasTextMetrics, Container, Graphics, Text } from "pixi.js";

export interface HistoryNodeVisual {
	id: string;
	kind: string;
	title: string;
	detail: string;
	x: number;
	y: number;
	width: number;
	height: number;
	color: number;
	opacity: number;
	summary?: boolean;
	drawCard: boolean;
}

export interface HistoryEdgeVisual {
	from: string;
	to: string;
	type: "sequence" | "summary" | "bundle";
	dynamic: boolean;
	opacity: number;
}

export interface HistoryScene {
	nodes: HistoryNodeVisual[];
	edges: HistoryEdgeVisual[];
}

export interface HistorySceneTransitionOptions {
	animate?: boolean;
	duration?: number;
}

export interface CameraTransform {
	x: number;
	y: number;
	scale: number;
	centerX: number;
	centerY: number;
	viewportWidth: number;
	viewportHeight: number;
}

export interface HistoryRendererCallbacks {
	onContextLost?: () => void;
	onContextRestored?: () => void;
	onError?: (error: unknown) => void;
}

export interface HistoryRendererDiagnostics {
	backend: string;
	contextLost: boolean;
	contextLosses: number;
	contextRestores: number;
	destroyed: boolean;
	frames: number;
	cardCount: number;
	visibleCardCount: number;
	transitioningCardCount: number;
	labelCount: number;
	staticEdgeCount: number;
	dynamicEdgeCount: number;
	clusterCount: number;
	lod: "overview" | "cards" | "detail";
}

interface VisibleBounds {
	left: number;
	right: number;
	top: number;
	bottom: number;
}

interface LabelCacheEntry {
	container: Container;
	kind: string;
	title: string;
	detail: string;
	color: number;
	width: number;
	height: number;
}

const DETAIL_LOD_SCALE = 0.48;
const CARD_LOD_SCALE = 0.16;
const OVERVIEW_SILHOUETTE_SIZE_PX = 10;
const OVERVIEW_CLUSTER_CELL_PX = 18;
const OVERVIEW_CLUSTER_MAX_SCALE = 0.06;
const MAX_LABELS = 220;
const MAX_CACHED_LABELS = MAX_LABELS * 2;
const MAX_SCENE_TRANSITIONS = 720;
const DEFAULT_SCENE_TRANSITION_MS = 260;
const GRID_SIZE = 256;
const CULL_SIGNATURE_SCREEN_STEP = 128;
const MAX_INDEX_CELLS_PER_NODE = 64;
const HISTORY_EDGE_COLOR = 0xc7cbc4;
const SUMMARY_EDGE_COLOR = 0x4e8a35;

export function historyLodForScale(scale: number): HistoryRendererDiagnostics["lod"] {
	if (scale < CARD_LOD_SCALE) return "overview";
	if (scale < DETAIL_LOD_SCALE) return "cards";
	return "detail";
}

function clippedEdgeForBounds(
	from: { x: number; y: number },
	to: { x: number; y: number },
	bounds: VisibleBounds,
): { from: { x: number; y: number }; to: { x: number; y: number } } | null {
	if (![from.x, from.y, to.x, to.y].every(Number.isFinite)) return null;
	let minimum = 0;
	let maximum = 1;
	const dx = to.x - from.x;
	const dy = to.y - from.y;
	const clip = (direction: number, distance: number): boolean => {
		if (direction === 0) return distance >= 0;
		const ratio = distance / direction;
		if (direction < 0) {
			if (ratio > maximum) return false;
			minimum = Math.max(minimum, ratio);
		} else {
			if (ratio < minimum) return false;
			maximum = Math.min(maximum, ratio);
		}
		return true;
	};
	const intersects = clip(-dx, from.x - bounds.left)
		&& clip(dx, bounds.right - from.x)
		&& clip(-dy, from.y - bounds.top)
		&& clip(dy, bounds.bottom - from.y)
		&& minimum <= maximum;
	if (!intersects) return null;
	return {
		from: { x: from.x + dx * minimum, y: from.y + dy * minimum },
		to: { x: from.x + dx * maximum, y: from.y + dy * maximum },
	};
}

export function edgeIntersectsBounds(
	from: { x: number; y: number },
	to: { x: number; y: number },
	bounds: VisibleBounds,
): boolean {
	return clippedEdgeForBounds(from, to, bounds) !== null;
}

function clampText(value: string, maximum: number): string {
	if (value.length <= maximum) return value;
	return `${value.slice(0, Math.max(1, maximum - 1))}…`;
}

/** Fit bounded label input in actual pixels; character counts alone overflow CJK/wide fonts. */
export function fitHistoryLabel(value: string, width: number, measure: (text: string) => number): string {
	if (!Number.isFinite(width) || width <= 0) return "";
	const clipped = value.length > 256;
	let bounded = value.slice(0, 256);
	if (bounded.length < value.length && /[\uD800-\uDBFF]$/u.test(bounded)) bounded = bounded.slice(0, -1);
	bounded = bounded.replace(/\s+/gu, " ").trim();
	if (!clipped && measure(bounded) <= width) return bounded;
	if (width <= 0 || measure("…") > width) return "";
	const characters = Array.from(bounded);
	let low = 0, high = characters.length;
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		if (measure(characters.slice(0, middle).join("") + "…") <= width) low = middle;
		else high = middle - 1;
	}
	return characters.slice(0, low).join("") + "…";
}

function cellKey(column: number, row: number): string {
	return `${column}:${row}`;
}

function pointFor(node: HistoryNodeVisual, offsets: Map<string, { x: number; y: number }>): { x: number; y: number } {
	const offset = offsets.get(node.id);
	return { x: node.x + (offset?.x ?? 0), y: node.y + (offset?.y ?? 0) };
}

function drawDashedLine(
	graphics: Graphics,
	from: { x: number; y: number },
	to: { x: number; y: number },
	dash = 12,
	gap = 9,
): void {
	const dx = to.x - from.x;
	const dy = to.y - from.y;
	const distance = Math.hypot(dx, dy);
	if (distance === 0) return;
	const stepX = dx / distance;
	const stepY = dy / distance;
	for (let cursor = 0; cursor < distance; cursor += dash + gap) {
		const end = Math.min(distance, cursor + dash);
		graphics
			.moveTo(from.x + stepX * cursor, from.y + stepY * cursor)
			.lineTo(from.x + stepX * end, from.y + stepY * end);
	}
}

function edgeEndpoints(
	edge: HistoryEdgeVisual,
	nodes: Map<string, HistoryNodeVisual>,
	offsets: Map<string, { x: number; y: number }>,
): { from: { x: number; y: number }; to: { x: number; y: number } } | null {
	const fromNode = nodes.get(edge.from);
	const toNode = nodes.get(edge.to);
	if (!fromNode || !toNode) return null;
	return { from: pointFor(fromNode, offsets), to: pointFor(toNode, offsets) };
}

function drawEdge(
	graphics: Graphics,
	edge: HistoryEdgeVisual,
	nodes: Map<string, HistoryNodeVisual>,
	offsets: Map<string, { x: number; y: number }>,
	bounds: VisibleBounds,
): boolean {
	const points = edgeEndpoints(edge, nodes, offsets);
	if (!points) return false;
	const middleX = (points.from.x + points.to.x) / 2;
	const middleY = (points.from.y + points.to.y) / 2;
	const curve = ((edge.from.length + edge.to.length) % 2 === 0 ? -1 : 1) * 18;
	const control = { x: middleX, y: middleY + curve };
	const clippedStraight = clippedEdgeForBounds(points.from, points.to, bounds);
	if (
		!clippedStraight
		&& (
			edge.type !== "sequence"
			|| (
				!edgeIntersectsBounds(points.from, control, bounds)
				&& !edgeIntersectsBounds(control, points.to, bounds)
			)
		)
	) return false;
	const summary = edge.type !== "sequence";
	if (summary) {
		if (!clippedStraight) return false;
		drawDashedLine(graphics, clippedStraight.from, clippedStraight.to, edge.type === "bundle" ? 18 : 11, 9);
		graphics.stroke({
			color: SUMMARY_EDGE_COLOR,
			alpha: edge.opacity,
			width: edge.type === "bundle" ? 4 : 1.8,
		});
		return true;
	}
	graphics
		.moveTo(points.from.x, points.from.y)
		.quadraticCurveTo(middleX, middleY + curve, points.to.x, points.to.y)
		.stroke({ color: HISTORY_EDGE_COLOR, alpha: edge.opacity, width: 1.5 });
	return true;
}

function labelFor(node: HistoryNodeVisual): Container {
	const label = new Container();
	label.label = node.id;
	const kind = new Text({
		text: clampText(node.kind.toUpperCase(), 18),
		style: {
			fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
			fontSize: 9,
			fontWeight: "700",
			fill: node.color,
		},
	});
	kind.position.set(14, 12);
	const title = new Text({
		text: clampText(node.title, 24),
		style: {
			fontFamily: "Inter, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
			fontSize: 14,
			fontWeight: "700",
			fill: 0x1d1f23,
		},
	});
	title.position.set(14, 34);
	const detail = new Text({
		text: clampText(node.detail, 30),
		style: {
			fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
			fontSize: 9,
			fill: 0x686d75,
		},
	});
	detail.position.set(14, 66);
	for (const [text, value] of [[kind, node.kind.toUpperCase()], [title, node.title], [detail, node.detail]] as const) {
		text.text = fitHistoryLabel(value, node.width - 28, (candidate) => CanvasTextMetrics.measureText(candidate, text.style).width);
	}
	label.addChild(kind, title);
	if (node.height >= 80) label.addChild(detail);
	else detail.destroy();
	return label;
}

export async function createHistoryRenderer(
	host: HTMLElement,
	callbacks: HistoryRendererCallbacks = {},
): Promise<{
	setScene(scene: HistoryScene, options?: HistorySceneTransitionOptions): void;
	setCamera(camera: CameraTransform): void;
	setNodePositions(positions: Record<string, { x: number; y: number }>): void;
	setNodeDrawCard(id: string, drawCard: boolean): void;
	getNodePosition(id: string): { x: number; y: number } | null;
	setOffsets(offsets: Record<string, { x: number; y: number }>): void;
	setOffset(id: string, x: number, y: number): void;
	clearOffset(id: string): void;
	hitTestWorld(x: number, y: number): HistoryNodeVisual | null;
	render(): void;
	resize(width: number, height: number): void;
	diagnostics(): HistoryRendererDiagnostics;
	destroy(): void;
}> {
	const app = new Application();
	await app.init({
		width: Math.max(1, host.clientWidth),
		height: Math.max(1, host.clientHeight),
		preference: "webgl",
		preferWebGLVersion: 2,
		powerPreference: "high-performance",
		backgroundAlpha: 0,
		antialias: true,
		autoDensity: true,
		resolution: Math.min(window.devicePixelRatio || 1, 2),
		autoStart: false,
		sharedTicker: false,
	});
	app.stop();
	app.canvas.id = "history-canvas";
	app.canvas.setAttribute("aria-hidden", "true");
	app.canvas.tabIndex = -1;
	host.prepend(app.canvas);

	const world = new Container();
	const staticEdges = new Graphics();
	const dynamicEdges = new Graphics();
	const displacedEdges = new Graphics();
	const cards = new Graphics();
	const labels = new Container();
	const displacedCards = new Graphics();
	const displacedLabels = new Container();
	const overviewClusters = new Graphics();
	world.addChild(staticEdges, dynamicEdges, displacedEdges, cards, labels, displacedCards, displacedLabels, overviewClusters);
	app.stage.addChild(world);

	let scene: HistoryScene = { nodes: [], edges: [] };
	let nodeMap = new Map<string, HistoryNodeVisual>();
	let camera: CameraTransform = {
		x: 0,
		y: 0,
		scale: 1,
		centerX: host.clientWidth / 2,
		centerY: host.clientHeight / 2,
		viewportWidth: host.clientWidth,
		viewportHeight: host.clientHeight,
	};
	let contextLost = false;
	let contextLosses = 0;
	let contextRestores = 0;
	let destroyed = false;
	let frames = 0;
	let cardCount = 0;
	let visibleCardCount = 0;
	let clusterCount = 0;
	let labelCount = 0;
	let staticEdgeCount = 0;
	let dynamicEdgeCount = 0;
	let cullSignature = "";
	let edgeCullSignature = "";
	let lod: HistoryRendererDiagnostics["lod"] = "detail";
	const offsets = new Map<string, { x: number; y: number }>();
	const sceneTransitionIds = new Set<string>();
	let sceneTransitionFrame: number | null = null;
	const spatialIndex = new Map<string, Set<string>>();
	const indexedCells = new Map<string, string[]>();
	const nodeOrder = new Map<string, number>();
	const incidentEdges = new Map<string, Set<HistoryEdgeVisual>>();
	const staticSceneEdges: HistoryEdgeVisual[] = [];
	const dynamicSceneEdges: HistoryEdgeVisual[] = [];
	const labelCache = new Map<string, LabelCacheEntry>();
	let visibleNodeIds = new Set<string>();
	const rendererGl = "gl" in app.renderer
		? (app.renderer as typeof app.renderer & { gl: WebGLRenderingContext | WebGL2RenderingContext }).gl
		: null;
	const backend = rendererGl
		&& typeof WebGL2RenderingContext !== "undefined"
		&& rendererGl instanceof WebGL2RenderingContext
		? "webgl2"
		: "webgl1";

	const visibleBounds = (): VisibleBounds => {
		const margin = 260 / Math.max(camera.scale, 0.01);
		const halfWidth = camera.viewportWidth / 2 / camera.scale;
		const halfHeight = camera.viewportHeight / 2 / camera.scale;
		return {
			left: camera.x - halfWidth - margin,
			right: camera.x + halfWidth + margin,
			top: camera.y - halfHeight - margin,
			bottom: camera.y + halfHeight + margin,
		};
	};

	const nodeIsVisible = (
		node: HistoryNodeVisual,
		bounds = visibleBounds(),
	): boolean => {
		if (!node.drawCard) return false;
		const point = pointFor(node, offsets);
		return point.x + node.width / 2 >= bounds.left
			&& point.x - node.width / 2 <= bounds.right
			&& point.y + node.height / 2 >= bounds.top
			&& point.y - node.height / 2 <= bounds.bottom;
	};

	const visibleNodes = (): HistoryNodeVisual[] => {
		const bounds = visibleBounds();
		return scene.nodes.filter((node) => nodeIsVisible(node, bounds));
	};

	const detachLabels = (container: Container): void => {
		container.removeChildren();
	};

	const labelMatchesNode = (entry: LabelCacheEntry, node: HistoryNodeVisual): boolean => {
		return entry.kind === node.kind
			&& entry.title === node.title
			&& entry.detail === node.detail
			&& entry.color === node.color
			&& entry.width === node.width
			&& entry.height === node.height;
	};

	const destroyCachedLabel = (id: string): void => {
		const entry = labelCache.get(id);
		if (!entry) return;
		entry.container.removeFromParent();
		entry.container.destroy({ children: true });
		labelCache.delete(id);
	};

	const cachedLabelFor = (node: HistoryNodeVisual): Container => {
		const cached = labelCache.get(node.id);
		if (cached && labelMatchesNode(cached, node)) {
			labelCache.delete(node.id);
			labelCache.set(node.id, cached);
			return cached.container;
		}
		if (cached) destroyCachedLabel(node.id);
		const container = labelFor(node);
		labelCache.set(node.id, {
			container,
			kind: node.kind,
			title: node.title,
			detail: node.detail,
			color: node.color,
			width: node.width,
			height: node.height,
		});
		while (labelCache.size > MAX_CACHED_LABELS) {
			const oldestId = labelCache.keys().next().value;
			if (oldestId === undefined) break;
			destroyCachedLabel(oldestId);
		}
		return container;
	};

	const pruneLabelCache = (): void => {
		for (const [id, entry] of labelCache) {
			const node = nodeMap.get(id);
			if (!node?.drawCard || !labelMatchesNode(entry, node)) destroyCachedLabel(id);
		}
	};

	const clearLabelCache = (): void => {
		for (const id of [...labelCache.keys()]) destroyCachedLabel(id);
	};

	const drawCardShape = (graphics: Graphics, node: HistoryNodeVisual): { left: number; top: number } => {
		const point = pointFor(node, offsets);
		const left = point.x - node.width / 2;
		const top = point.y - node.height / 2;
		graphics
			.roundRect(left, top, node.width, node.height, 8)
			.fill({ color: 0xffffff, alpha: Math.min(0.98, 0.72 + node.opacity * 0.25) })
			.stroke({ color: node.color, alpha: Math.max(0.28, node.opacity), width: node.summary ? 2.2 : 1.4 });
		graphics
			.rect(left + 13, top, 28, 3)
			.fill({ color: node.color, alpha: Math.max(0.38, node.opacity) });
		return { left, top };
	};

	const drawCardVisuals = (
		graphics: Graphics,
		container: Container,
		nodes: HistoryNodeVisual[],
		showLabels: boolean,
	): void => {
		graphics.clear();
		detachLabels(container);
		for (const node of nodes) {
			const { left, top } = drawCardShape(graphics, node);
			if (!showLabels) continue;
			const label = cachedLabelFor(node);
			label.position.set(left, top);
			label.alpha = Math.max(0.5, node.opacity);
			container.addChild(label);
		}
	};

	const updateLabelCount = (): void => {
		labelCount = labels.children.length + displacedLabels.children.length;
	};

	function drawOverviewClusters(nodes: HistoryNodeVisual[]): void {
		overviewClusters.clear();
		clusterCount = 0;
		if (nodes.length === 0 || camera.scale <= 0) return;
		const clusters = new Map<string, {
			x: number;
			y: number;
			count: number;
			color: number;
			opacity: number;
			summary: boolean;
		}>();
		for (const node of nodes) {
			const point = pointFor(node, offsets);
			const column = Math.floor(point.x * camera.scale / OVERVIEW_CLUSTER_CELL_PX);
			const row = Math.floor(point.y * camera.scale / OVERVIEW_CLUSTER_CELL_PX);
			const key = cellKey(column, row);
			const cluster = clusters.get(key);
			if (cluster) {
				cluster.x += point.x;
				cluster.y += point.y;
				cluster.count += 1;
				cluster.opacity = Math.max(cluster.opacity, node.opacity);
				if (node.summary) {
					cluster.color = node.color;
					cluster.summary = true;
				}
			} else {
				clusters.set(key, {
					x: point.x,
					y: point.y,
					count: 1,
					color: node.color,
					opacity: node.opacity,
					summary: Boolean(node.summary),
				});
			}
		}

		const silhouetteSize = OVERVIEW_SILHOUETTE_SIZE_PX / camera.scale;
		const strokeWidth = 1 / camera.scale;
		for (const cluster of clusters.values()) {
			const radius = silhouetteSize * Math.min(0.82, 0.38 + Math.log2(cluster.count + 1) * 0.1);
			overviewClusters
				.circle(cluster.x / cluster.count, cluster.y / cluster.count, radius)
				.fill({
					color: cluster.color,
					alpha: Math.max(0.5, Math.min(0.9, cluster.opacity + (cluster.summary ? 0.24 : 0.08))),
				})
				.stroke({ color: 0xffffff, alpha: 0.86, width: strokeWidth });
		}
		clusterCount = clusters.size;
	}

	const drawDisplacedCards = (): void => {
		const showLabels = lod === "detail" && visibleCardCount <= MAX_LABELS;
		const visible = [...offsets.keys()]
			.map((id) => nodeMap.get(id))
			.filter((node): node is HistoryNodeVisual => Boolean(node && visibleNodeIds.has(node.id)));
		displacedCards.clear();
		displacedLabels.removeChildren();
		for (const node of visible) {
			const { left, top } = drawCardShape(displacedCards, node);
			if (!showLabels) continue;
			const label = cachedLabelFor(node);
			label.position.set(left, top);
			label.alpha = Math.max(0.5, node.opacity);
			displacedLabels.addChild(label);
		}
		updateLabelCount();
	};

	const usesOverviewClusters = (scale: number): boolean => {
		return historyLodForScale(scale) === "overview" && scale <= OVERVIEW_CLUSTER_MAX_SCALE;
	};

	const drawCards = (): void => {
		const visible = visibleNodes();
		visibleNodeIds = new Set(visible.map((node) => node.id));
		visibleCardCount = visibleNodeIds.size;
		lod = historyLodForScale(camera.scale);
		const showLabels = lod === "detail" && visibleCardCount <= MAX_LABELS;
		if (usesOverviewClusters(camera.scale)) {
			cards.clear();
			detachLabels(labels);
			displacedCards.clear();
			detachLabels(displacedLabels);
			updateLabelCount();
			drawOverviewClusters(scene.nodes);
			return;
		}
		drawCardVisuals(cards, labels, visible.filter((node) => !offsets.has(node.id)), showLabels);
		drawDisplacedCards();
		overviewClusters.clear();
		clusterCount = 0;
	};

	const edgeIsDisplaced = (edge: HistoryEdgeVisual): boolean => offsets.has(edge.from) || offsets.has(edge.to);

	const drawStaticEdges = (): void => {
		staticEdges.clear();
		const bounds = visibleBounds();
		for (const edge of staticSceneEdges) {
			if (edgeIsDisplaced(edge)) continue;
			drawEdge(staticEdges, edge, nodeMap, offsets, bounds);
		}
	};

	const drawDynamicEdges = (): void => {
		dynamicEdges.clear();
		const bounds = visibleBounds();
		for (const edge of dynamicSceneEdges) {
			if (edgeIsDisplaced(edge)) continue;
			drawEdge(dynamicEdges, edge, nodeMap, offsets, bounds);
		}
	};

	const drawDisplacedEdges = (): void => {
		displacedEdges.clear();
		const bounds = visibleBounds();
		const edges = new Set<HistoryEdgeVisual>();
		for (const id of offsets.keys()) {
			for (const edge of incidentEdges.get(id) || []) edges.add(edge);
		}
		for (const edge of edges) drawEdge(displacedEdges, edge, nodeMap, offsets, bounds);
	};

	const removeNodeFromSpatialIndex = (id: string): void => {
		for (const key of indexedCells.get(id) || []) {
			const ids = spatialIndex.get(key);
			ids?.delete(id);
			if (ids?.size === 0) spatialIndex.delete(key);
		}
		indexedCells.delete(id);
	};

	const addNodeToSpatialIndex = (node: HistoryNodeVisual): void => {
		if (!node.drawCard) return;
		const point = pointFor(node, offsets);
		if (![point.x, point.y, node.width, node.height].every(Number.isFinite)) return;
		const minColumn = Math.floor((point.x - node.width / 2) / GRID_SIZE);
		const maxColumn = Math.floor((point.x + node.width / 2) / GRID_SIZE);
		const minRow = Math.floor((point.y - node.height / 2) / GRID_SIZE);
		const maxRow = Math.floor((point.y + node.height / 2) / GRID_SIZE);
		if (![minColumn, maxColumn, minRow, maxRow].every(Number.isSafeInteger)) return;
		const columnCount = maxColumn - minColumn + 1;
		const rowCount = maxRow - minRow + 1;
		if (columnCount <= 0 || rowCount <= 0 || columnCount * rowCount > MAX_INDEX_CELLS_PER_NODE) return;
		const keys: string[] = [];
		for (let column = minColumn; column <= maxColumn; column += 1) {
			for (let row = minRow; row <= maxRow; row += 1) {
				const key = cellKey(column, row);
				const ids = spatialIndex.get(key) || new Set<string>();
				ids.add(node.id);
				spatialIndex.set(key, ids);
				keys.push(key);
			}
		}
		indexedCells.set(node.id, keys);
	};

	const updateNodeInSpatialIndex = (node: HistoryNodeVisual): void => {
		removeNodeFromSpatialIndex(node.id);
		addNodeToSpatialIndex(node);
	};

	const rebuildSpatialIndex = (): void => {
		spatialIndex.clear();
		indexedCells.clear();
		for (const node of scene.nodes) {
			addNodeToSpatialIndex(node);
		}
	};

	const rebuildEdgeIndex = (): void => {
		incidentEdges.clear();
		staticSceneEdges.length = 0;
		dynamicSceneEdges.length = 0;
		for (const edge of scene.edges) {
			if (!nodeMap.has(edge.from) || !nodeMap.has(edge.to)) continue;
			const fromEdges = incidentEdges.get(edge.from) || new Set<HistoryEdgeVisual>();
			fromEdges.add(edge);
			incidentEdges.set(edge.from, fromEdges);
			const toEdges = incidentEdges.get(edge.to) || new Set<HistoryEdgeVisual>();
			toEdges.add(edge);
			incidentEdges.set(edge.to, toEdges);
			if (edge.dynamic) dynamicSceneEdges.push(edge);
			else staticSceneEdges.push(edge);
		}
		staticEdgeCount = staticSceneEdges.length;
		dynamicEdgeCount = dynamicSceneEdges.length;
	};

	const render = (): void => {
		if (contextLost || destroyed) return;
		app.renderer.render({ container: app.stage });
		frames += 1;
	};

	const refreshCulling = (): void => {
		const bounds = visibleBounds();
		const nextLod = historyLodForScale(camera.scale);
		const nextSignature = usesOverviewClusters(camera.scale)
			? `clusters:${scene.nodes.length}:${Math.round(Math.log(camera.scale) * 40)}`
			: [
				nextLod,
				Math.floor(bounds.left * camera.scale / CULL_SIGNATURE_SCREEN_STEP),
				Math.floor(bounds.right * camera.scale / CULL_SIGNATURE_SCREEN_STEP),
				Math.floor(bounds.top * camera.scale / CULL_SIGNATURE_SCREEN_STEP),
				Math.floor(bounds.bottom * camera.scale / CULL_SIGNATURE_SCREEN_STEP),
			].join(":");
		if (nextSignature !== cullSignature) {
			cullSignature = nextSignature;
			drawCards();
		}
		const nextEdgeSignature = [
			Math.floor(bounds.left * camera.scale / CULL_SIGNATURE_SCREEN_STEP),
			Math.floor(bounds.right * camera.scale / CULL_SIGNATURE_SCREEN_STEP),
			Math.floor(bounds.top * camera.scale / CULL_SIGNATURE_SCREEN_STEP),
			Math.floor(bounds.bottom * camera.scale / CULL_SIGNATURE_SCREEN_STEP),
		].join(":");
		if (nextEdgeSignature === edgeCullSignature) return;
		edgeCullSignature = nextEdgeSignature;
		drawStaticEdges();
		drawDynamicEdges();
		drawDisplacedEdges();
	};

	const clearSceneTransitionState = (): string[] => {
		const ids = [...sceneTransitionIds];
		for (const id of ids) offsets.delete(id);
		sceneTransitionIds.clear();
		sceneTransitionFrame = null;
		return ids;
	};

	const stopSceneTransition = (): void => {
		if (sceneTransitionFrame !== null) cancelAnimationFrame(sceneTransitionFrame);
		clearSceneTransitionState();
	};

	const finishSceneTransition = (): void => {
		for (const id of clearSceneTransitionState()) {
			const node = nodeMap.get(id);
			if (node) updateNodeInSpatialIndex(node);
		}
		cullSignature = "";
		edgeCullSignature = "";
		refreshCulling();
		render();
	};

	const startSceneTransition = (
		starts: Map<string, { x: number; y: number }>,
		duration: number,
	): void => {
		if (starts.size === 0) return;
		const startedAt = performance.now();
		const tick = (now: number): void => {
			try {
				if (destroyed || contextLost) {
					finishSceneTransition();
					return;
				}
				const progress = Math.min(1, Math.max(0, (now - startedAt) / duration));
				const remaining = Math.pow(1 - progress, 4);
				for (const [id, start] of starts) {
					if (!sceneTransitionIds.has(id)) continue;
					const node = nodeMap.get(id);
					if (!node) continue;
					offsets.set(id, { x: start.x * remaining, y: start.y * remaining });
					updateNodeInSpatialIndex(node);
				}
				drawDisplacedCards();
				drawDisplacedEdges();
				render();
				if (progress >= 1 || sceneTransitionIds.size === 0) {
					finishSceneTransition();
					return;
				}
				sceneTransitionFrame = requestAnimationFrame(tick);
			} catch (error) {
				let reportedError = error;
				try {
					finishSceneTransition();
				} catch (cleanupError) {
					reportedError = new AggregateError([error, cleanupError], "Scene transition cleanup failed");
				}
				callbacks.onError?.(reportedError);
			}
		};
		sceneTransitionFrame = requestAnimationFrame(tick);
	};

	const applyOffsets = (nextOffsets: Record<string, { x: number; y: number }>): void => {
		let changed = false;
		let addedOffset = false;
		for (const [id, point] of Object.entries(nextOffsets)) {
			if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
			const node = nodeMap.get(id);
			if (!node) continue;
			sceneTransitionIds.delete(id);
			const previous = offsets.get(id);
			if (previous?.x === point.x && previous.y === point.y) continue;
			addedOffset ||= !previous;
			offsets.set(id, { x: point.x, y: point.y });
			updateNodeInSpatialIndex(node);
			changed = true;
		}
		if (!changed) return;
		if (addedOffset) {
			drawCards();
			drawStaticEdges();
			drawDynamicEdges();
		} else {
			drawDisplacedCards();
		}
		drawDisplacedEdges();
		render();
	};

	const canvas = app.canvas;
	const handleContextLost = (event: Event): void => {
		event.preventDefault();
		if (destroyed || contextLost) return;
		contextLost = true;
		contextLosses += 1;
		callbacks.onContextLost?.();
	};
	const handleContextRestored = (): void => {
		if (destroyed || !contextLost) return;
		try {
			contextLost = false;
			contextRestores += 1;
			cullSignature = "";
			edgeCullSignature = "";
			refreshCulling();
			render();
			callbacks.onContextRestored?.();
		} catch (error) {
			callbacks.onError?.(error);
		}
	};
	canvas.addEventListener("webglcontextlost", handleContextLost);
	canvas.addEventListener("webglcontextrestored", handleContextRestored);

	return {
		setScene(nextScene, options = {}): void {
			if (destroyed) return;
			const previousPoints = new Map(
				[...nodeMap].map(([id, node]) => [id, pointFor(node, offsets)]),
			);
			const previousDrawCard = new Map(
				[...nodeMap].map(([id, node]) => [id, node.drawCard]),
			);
			stopSceneTransition();
			for (const id of [...offsets.keys()]) {
				if (!previousDrawCard.get(id)) offsets.delete(id);
			}
			scene = nextScene;
			nodeMap = new Map(scene.nodes.map((node) => [node.id, node]));
			cardCount = 0;
			for (const node of scene.nodes) cardCount += Number(node.drawCard);
			pruneLabelCache();
			nodeOrder.clear();
			scene.nodes.forEach((node, index) => nodeOrder.set(node.id, index));
			for (const id of [...offsets.keys()]) {
				if (!nodeMap.has(id)) offsets.delete(id);
			}
			const transitionStarts = new Map<string, { x: number; y: number }>();
			if (options.animate) {
				const bounds = visibleBounds();
				const candidates = scene.nodes.flatMap((node) => {
					const previous = previousPoints.get(node.id);
					if (
						!previous
						|| !node.drawCard
						|| !previousDrawCard.get(node.id)
						|| offsets.has(node.id)
					) return [];
					const offset = { x: previous.x - node.x, y: previous.y - node.y };
					if (Math.abs(offset.x) < 0.08 && Math.abs(offset.y) < 0.08) return [];
					const visible = (
						previous.x + node.width / 2 >= bounds.left
						&& previous.x - node.width / 2 <= bounds.right
						&& previous.y + node.height / 2 >= bounds.top
						&& previous.y - node.height / 2 <= bounds.bottom
					) || (
						node.x + node.width / 2 >= bounds.left
						&& node.x - node.width / 2 <= bounds.right
						&& node.y + node.height / 2 >= bounds.top
						&& node.y - node.height / 2 <= bounds.bottom
					);
					return [{
						id: node.id,
						offset,
						visible,
						distance: Math.hypot(node.x - camera.x, node.y - camera.y),
					}];
				});
				candidates.sort((left, right) => Number(right.visible) - Number(left.visible) || left.distance - right.distance);
				for (const candidate of candidates.slice(0, MAX_SCENE_TRANSITIONS)) {
					offsets.set(candidate.id, candidate.offset);
					sceneTransitionIds.add(candidate.id);
					transitionStarts.set(candidate.id, candidate.offset);
				}
			}
			cullSignature = "";
			edgeCullSignature = "";
			rebuildSpatialIndex();
			rebuildEdgeIndex();
			refreshCulling();
			render();
			startSceneTransition(
				transitionStarts,
				Math.max(1, options.duration ?? DEFAULT_SCENE_TRANSITION_MS),
			);
		},
		setCamera(nextCamera): void {
			if (destroyed) return;
			if (![
				nextCamera.x,
				nextCamera.y,
				nextCamera.scale,
				nextCamera.centerX,
				nextCamera.centerY,
				nextCamera.viewportWidth,
				nextCamera.viewportHeight,
			].every(Number.isFinite) || nextCamera.scale <= 0) return;
			camera = nextCamera;
			world.position.set(
				camera.centerX - camera.x * camera.scale,
				camera.centerY - camera.y * camera.scale,
			);
			world.scale.set(camera.scale);
			refreshCulling();
			render();
		},
		setNodePositions(positions): void {
			if (destroyed) return;
			let changed = false;
			let cardsChanged = false;
			let staticEdgesChanged = false;
			let dynamicEdgesChanged = false;
			let displacedEdgesChanged = false;
			for (const [id, point] of Object.entries(positions)) {
				const node = nodeMap.get(id);
				if (!node || !Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
				if (node.x === point.x && node.y === point.y) continue;
				if (node.drawCard) removeNodeFromSpatialIndex(id);
				node.x = point.x;
				node.y = point.y;
				if (node.drawCard) {
					addNodeToSpatialIndex(node);
					cardsChanged = true;
				}
				for (const edge of incidentEdges.get(id) || []) {
					if (edgeIsDisplaced(edge)) displacedEdgesChanged = true;
					else if (edge.dynamic) dynamicEdgesChanged = true;
					else staticEdgesChanged = true;
				}
				changed = true;
			}
			if (!changed) return;
			if (cardsChanged) drawCards();
			if (staticEdgesChanged) drawStaticEdges();
			if (dynamicEdgesChanged) drawDynamicEdges();
			if (displacedEdgesChanged) drawDisplacedEdges();
			render();
		},
		setNodeDrawCard(id, drawCard): void {
			if (destroyed) return;
			const node = nodeMap.get(id);
			if (!node || node.drawCard === drawCard) return;
			removeNodeFromSpatialIndex(id);
			node.drawCard = drawCard;
			cardCount += drawCard ? 1 : -1;
			if (drawCard) addNodeToSpatialIndex(node);
			cullSignature = "";
			drawCards();
			drawStaticEdges();
			drawDynamicEdges();
			drawDisplacedEdges();
			render();
		},
		getNodePosition(id): { x: number; y: number } | null {
			const node = nodeMap.get(id);
			return node ? pointFor(node, offsets) : null;
		},
		setOffsets(nextOffsets): void {
			if (destroyed) return;
			applyOffsets(nextOffsets);
		},
		setOffset(id, x, y): void {
			if (destroyed) return;
			applyOffsets({ [id]: { x, y } });
		},
		clearOffset(id): void {
			if (destroyed) return;
			const node = nodeMap.get(id);
			sceneTransitionIds.delete(id);
			if (!offsets.delete(id)) return;
			if (node) updateNodeInSpatialIndex(node);
			drawCards();
			drawStaticEdges();
			drawDynamicEdges();
			drawDisplacedEdges();
			render();
		},
		hitTestWorld(x, y): HistoryNodeVisual | null {
			if (destroyed) return null;
			if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
			const ids = spatialIndex.get(cellKey(Math.floor(x / GRID_SIZE), Math.floor(y / GRID_SIZE)));
			let match: HistoryNodeVisual | null = null;
			let matchPriority = -1;
			for (const id of ids || []) {
				const node = nodeMap.get(id);
				if (!node?.drawCard || !visibleNodeIds.has(id)) continue;
				const point = pointFor(node, offsets);
				if (
					x >= point.x - node.width / 2
					&& x <= point.x + node.width / 2
					&& y >= point.y - node.height / 2
					&& y <= point.y + node.height / 2
				) {
					const priority = (offsets.has(id) ? scene.nodes.length : 0) + (nodeOrder.get(id) ?? 0);
					if (priority >= matchPriority) {
						match = node;
						matchPriority = priority;
					}
				}
			}
			return match;
		},
		render,
		resize(width, height): void {
			if (destroyed) return;
			if (!Number.isFinite(width) || !Number.isFinite(height)) return;
			const viewportWidth = Math.max(1, width);
			const viewportHeight = Math.max(1, height);
			camera = { ...camera, viewportWidth, viewportHeight };
			app.renderer.resize(viewportWidth, viewportHeight);
			cullSignature = "";
			edgeCullSignature = "";
			refreshCulling();
			render();
		},
		diagnostics(): HistoryRendererDiagnostics {
			return {
				backend,
				contextLost,
				contextLosses,
				contextRestores,
				destroyed,
				frames,
				cardCount,
					visibleCardCount,
					transitioningCardCount: sceneTransitionIds.size,
				labelCount,
				staticEdgeCount,
				dynamicEdgeCount,
				clusterCount,
				lod,
			};
		},
		destroy(): void {
			if (destroyed) return;
			destroyed = true;
			if (sceneTransitionFrame !== null) cancelAnimationFrame(sceneTransitionFrame);
			sceneTransitionFrame = null;
			sceneTransitionIds.clear();
			canvas.removeEventListener("webglcontextlost", handleContextLost);
			canvas.removeEventListener("webglcontextrestored", handleContextRestored);
			clearLabelCache();
			offsets.clear();
			spatialIndex.clear();
			indexedCells.clear();
			nodeOrder.clear();
			incidentEdges.clear();
			staticSceneEdges.length = 0;
			dynamicSceneEdges.length = 0;
			visibleNodeIds.clear();
			nodeMap.clear();
			scene = { nodes: [], edges: [] };
			app.destroy(true, { children: true, texture: true, textureSource: true });
		},
	};
}
