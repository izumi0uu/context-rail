import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
	applyRenderStatePatch as applyCanonicalRenderStatePatch,
	type RenderStatePatch,
} from "../src/hub-delta.ts";
import type { RenderState } from "../src/render.ts";
import type { ContextCaptureEntry, ContextCaptureArchiveSnapshot } from "../src/context-captures.ts";
import { emptyTimelineSnapshot, type ContextTimelineSnapshot, type HistoryItem } from "../src/timeline.ts";
import { applyCaptureArchivePatch, captureRenderState, compareCaptures } from "../web/src/capture-view.ts";
import { ContentIndex, projectContent } from "../web/src/content-view.ts";
import { copyableContextText } from "../web/src/inspector-view.ts";
import { contentState, sameOrderedIds, sameSceneTimeline } from "../web/src/reader.ts";
import { edgeIntersectsBounds, historyLodForScale } from "../web/src/pixi-history.ts";

const html = readFileSync(new URL("../web/index.html", import.meta.url), "utf8");
const coreSource = readFileSync(new URL("../web/src/scene-core.ts", import.meta.url), "utf8");
const pixiSource = readFileSync(new URL("../web/src/pixi-history.ts", import.meta.url), "utf8");
const inspectorSource = readFileSync(new URL("../web/src/inspector-view.ts", import.meta.url), "utf8");
const packageJson = JSON.parse(
	readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as {
	files?: string[];
	scripts?: Record<string, string>;
	devDependencies?: Record<string, string>;
};
const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];

assert.ok(script, "web/index.html must contain an inline script");

function sourceSlice(source: string, start: number, end: number): string {
	assert.ok(start >= 0, "source slice start marker must exist");
	assert.ok(end > start, "source slice end marker must follow its start marker");
	return source.slice(start, end);
}

function inlineFunction(name: string): string {
	assert.ok(script, "inline function extraction requires the viewer script");
	const start = script.match(new RegExp(`^(?:async )?function ${name}\\(`, "m"))?.index ?? -1;
	return sourceSlice(script, start, script.indexOf("\n}", start) + 2);
}

test("long-history zoom and responsive layout share safe boundaries", () => {
	const minimumScaleMatch = script.match(/const MIN_CAMERA_SCALE = ([\d.]+);/);
	assert.ok(minimumScaleMatch?.[1], "MIN_CAMERA_SCALE must be declared as a numeric constant");
	const minimumScale = Number(minimumScaleMatch[1]);
	assert.ok(minimumScale > 0 && minimumScale <= 0.012);
	assert.match(script, /const viewedBounds = viewedEpochIndex === null[\s\S]*?currentSceneLayout\?\.epochs\[viewedEpochIndex\]\?\.bounds;/);
	assert.match(script, /scale: cameraTarget\.scale,/);
	assert.match(script, /sceneEngine\.interactiveMinimumScale\(naturalFitScale, MIN_CAMERA_SCALE\)/);
	assert.match(script, /sceneEngine\.normalizeWheelDelta\(event\.deltaY, event\.deltaMode, viewportBounds\.height\)/);
	assert.match(html, /@media \(max-width: 720px\)/);
	assert.match(script, /return innerWidth <= MOBILE_BREAKPOINT;/);
	assert.doesNotMatch(script, /innerWidth\s*<\s*720/);
});

test("wheel zoom eases toward a constrained target without teleporting the rendered camera", () => {
	const wheelSource = sourceSlice(script,
		script.indexOf('viewport.addEventListener("wheel"'),
		script.indexOf("function updateChrome"),
	);
	assert.match(wheelSource, /const sourceCamera = \{ \.\.\.cameraTarget \};/);
	assert.match(wheelSource, /cameraTarget = cameraAtScreenPoint\(/);
	assert.match(wheelSource, /cameraTarget = constrainCamera\(cameraTarget, true\);/);
	assert.doesNotMatch(wheelSource, /camera = cameraAtScreenPoint|cameraTarget = \{ \.\.\.camera \}/);
	assert.match(script, /function constrainCamera\(candidate, requireContent = false\)[\s\S]*?sceneEngine\.constrainCameraToBounds\(/);
});

test("epoch travel and wheel-out share a monotonic scale transition", () => {
	const wheelSource = sourceSlice(script,
		script.indexOf('viewport.addEventListener("wheel"'),
		script.indexOf("function updateChrome"),
	);
	assert.match(wheelSource, /sceneEngine\.wheelZoomScale\(/);
	assert.doesNotMatch(
		wheelSource,
		/Math\.max\(interactiveScaleFloor\(\), sourceCamera\.scale \* factor\)/,
		"an epoch camera can be below the natural-view floor, where Math.max would make wheel-out zoom in",
	);
});

test("pinch and wheel share monotonic scale bounds below the natural-view floor", () => {
	const pointerSource = sourceSlice(script,
		script.indexOf('viewport.addEventListener("pointerdown"'),
		script.indexOf('viewport.addEventListener("wheel"'),
	);
	assert.match(pointerSource, /sceneEngine\.clampInteractiveScale\(/);
	assert.doesNotMatch(
		pointerSource,
		/Math\.max\(interactiveScaleFloor\(\), pinch\.scale \* distance \/ pinch\.distance\)/,
	);
	assert.equal(
		pointerSource.match(/if \(!touches\.has\(event\.pointerId\)\)/g)?.length,
		1,
		"pointer hover handling needs only one missing-touch guard",
	);
});

test("zero-delta wheel events leave automatic camera following untouched", () => {
	const wheelSource = sourceSlice(script,
		script.indexOf('viewport.addEventListener("wheel"'),
		script.indexOf("function updateChrome"),
	);
	const normalizedAt = wheelSource.indexOf("const normalizedDelta");
	const zeroGuardAt = wheelSource.indexOf("if (normalizedDelta === 0) return");
	const freeCameraAt = wheelSource.indexOf("freeCamera = true");

	assert.ok(normalizedAt >= 0, "wheel delta must be normalized before state changes");
	assert.ok(zeroGuardAt > normalizedAt, "zero delta must be detected after normalization");
	assert.ok(freeCameraAt > zeroGuardAt, "a zero delta must return before disabling automatic Fit");
	assert.doesNotMatch(wheelSource, /followActive\s*=/);
});

test("free-camera recovery constrains against actual item regions, not only aggregate bounds", () => {
	assert.match(script, /let cameraContentBounds = \[\];/);
	assert.match(script, /let activeCameraContentBounds = \[\];/);
	assert.match(script, /const reachedWorldEdge = differs\(candidate\.x, bounded\.x, POSITION_EPSILON\)[\s\S]*?if \(!requireContent && !reachedWorldEdge\) return bounded;/);
	assert.match(script, /sceneEngine\.constrainCameraToContent\([\s\S]*?cameraContentBounds/);
	assert.match(script, /cameraTarget = constrainCamera\([\s\S]*?true\);[\s\S]*?activeCameraContentBounds/);
});

test("pan uses incremental pointer deltas so reversing at an edge has no overscroll dead zone", () => {
	const pointerSource = sourceSlice(script,
		script.indexOf('viewport.addEventListener("pointerdown"'),
		script.indexOf('viewport.addEventListener("wheel"'),
	);
	assert.match(pointerSource, /sceneEngine\.cameraForPan\(\s*camera,[\s\S]*?\{ x: pan\.x, y: pan\.y \},[\s\S]*?\{ x: event\.clientX, y: event\.clientY \}/);
	assert.match(pointerSource, /pan\.x = event\.clientX;[\s\S]*?pan\.y = event\.clientY;/);
	assert.doesNotMatch(pointerSource, /cameraX: camera\.x|cameraY: camera\.y/);
});

test("an ordinary timeline append preserves a free camera parked in internal whitespace", () => {
	const updateBoundsSource = sourceSlice(script,
		script.indexOf("function updateBounds"),
		script.indexOf("function fitView"),
	);
	const appendClamp = updateBoundsSource.match(
		/cameraTarget = constrainCamera\(\{[\s\S]*?scale: Math\.min\([\s\S]*?\}\s*(?:,\s*(true|false))?\);/,
	);
	assert.ok(appendClamp, "free-camera scale and bounds must be revalidated after an append");
	assert.notEqual(
		appendClamp[1],
		"true",
		"ordinary appends must use bounds-only recovery; content recovery snaps intentional whitespace",
	);
});

test("viewport resize immediately rescues both rendered and target cameras onto real content", () => {
	const resizeSource = sourceSlice(script,
		script.indexOf('addEventListener("resize"'),
		script.indexOf("function demoPayload"),
	);
	assert.match(resizeSource, /if \(freeCamera\) \{[\s\S]*?camera = constrainCamera\(camera, true\);/);
	assert.match(resizeSource, /if \(freeCamera\) \{[\s\S]*?cameraTarget = constrainCamera\(cameraTarget, true\);/);
	assert.ok(
		resizeSource.indexOf("syncGraphViewport()") < resizeSource.indexOf("camera = constrainCamera(camera, true)"),
		"recovery must use the resized graph viewport",
	);
});

test("empty sessions remove stale spatial chrome from the previous session", () => {
	const clearGraphSource = sourceSlice(script,
		script.indexOf("function clearGraph"),
		script.indexOf("function syncModeChrome"),
	);
	const updateBoundsSource = sourceSlice(script,
		script.indexOf("function updateBounds"),
		script.indexOf("function fitView"),
	);
	assert.match(clearGraphSource, /windowFrame\.toggleAttribute\("hidden", true\);/);
	assert.match(updateBoundsSource, /windowFrame\.toggleAttribute\("hidden", false\);/);
	assert.match(html, /<rect id="window-frame"[^>]* hidden><\/rect>/);
});

test("short landscape view centers the graph between fixed chrome", () => {
	const functionSource = script.match(
		/function availableGraphViewport\(viewportHeight, sessionBottom, toolbarTop, statusTop\) \{[\s\S]*?\n\}/,
	)?.[0];
	assert.ok(functionSource);
	const availableGraphViewport = Function(`"use strict"; return (${functionSource});`)() as (
		viewportHeight: number,
		sessionBottom: number,
		toolbarTop: number,
		statusTop: number,
	) => { top: number; bottom: number; height: number; centerY: number };

	assert.deepEqual(availableGraphViewport(320, 78, 320, 264), {
		top: 78,
		bottom: 264,
		height: 186,
		centerY: 171,
	});
	assert.match(script, /const viewport = graphViewport\(\);[\s\S]*?viewport\.height/);
	assert.match(script, /viewport\.centerY - camera\.y \* camera\.scale/);
	assert.match(
		html,
		/clip-path: inset\(var\(--graph-clip-top, 0px\) var\(--graph-clip-right, 0px\) var\(--graph-clip-bottom, 0px\) 0\)/,
	);
	assert.match(script, /let graphViewportBounds = null;/);
	assert.match(
		script,
		/function graphViewport\(\) \{\s*if \(!graphViewportBounds\) syncGraphViewport\(\);\s*return graphViewportBounds;\s*\}/,
	);
	assert.match(script, /new ResizeObserver\(\(\) => \{[\s\S]*?syncGraphViewport\(\)[\s\S]*?fitView\(false\)[\s\S]*?markCameraDirty\(\)/);
	const renderFrameSource = sourceSlice(script,
		script.indexOf("function renderFrame"),
		script.indexOf("function attachNodeInteraction"),
	);
	assert.doesNotMatch(renderFrameSource, /getBoundingClientRect|style\.setProperty/);
});

test("focus matrix uses stable responsive column breakpoints", () => {
	const functionSource = script.match(
		/function focusGridColumns\(viewportWidth\) \{[\s\S]*?\n\}/,
	)?.[0];
	assert.ok(functionSource);
	const focusGridColumns = Function(`"use strict"; return (${functionSource});`)() as (
		viewportWidth: number,
	) => number;

	assert.equal(focusGridColumns(390), 2);
	assert.equal(focusGridColumns(480), 2);
	assert.equal(focusGridColumns(720), 2);
	assert.equal(focusGridColumns(721), 3);
	assert.equal(focusGridColumns(900), 3);
	assert.equal(focusGridColumns(960), 3);
	assert.equal(focusGridColumns(961), 4);
	assert.equal(focusGridColumns(1_120), 4);
	assert.equal(focusGridColumns(1_121), 5);
	assert.equal(focusGridColumns(1_280), 5);
	assert.equal(focusGridColumns(1_281), 6);
	assert.equal(focusGridColumns(1_440), 6);
	assert.match(script, /dimensionsKey = `\$\{dimensions\.width\}:\$\{dimensions\.height\}:\$\{focusColumns\}:/);
	assert.match(script, /focusColumns,/);
});

test("short landscape detection only controls compact scene spacing", () => {
	const functionSource = script.match(
		/function isShortLandscapeViewport\(viewportWidth, viewportHeight\) \{[\s\S]*?\n\}/,
	)?.[0];
	assert.ok(functionSource);
	const isShortLandscapeViewport = Function(`"use strict"; return (${functionSource});`)() as (
		viewportWidth: number,
		viewportHeight: number,
	) => boolean;

	assert.equal(isShortLandscapeViewport(568, 320), true);
	assert.equal(isShortLandscapeViewport(390, 844), false);
	assert.equal(isShortLandscapeViewport(721, 400), true);
	assert.match(html, /@media \(max-height: 420px\) and \(orientation: landscape\)/);
	assert.match(inlineFunction("nodeDimensions"), /height: isShortLandscapeLayout\(\) \? NODE_HEIGHT_SHORT_LANDSCAPE : NODE_HEIGHT/);
	const viewportSource = inlineFunction("syncGraphViewport");
	assert.match(viewportSource, /workspaceBar\.getBoundingClientRect\(\)\.bottom \+ \(\$\("#work-status"\)\.hidden \? 18 : 38\)/);
	assert.match(viewportSource, /captureBar\.getBoundingClientRect\(\)\.top - 18/);
	assert.match(viewportSource, /statusBar\.getBoundingClientRect\(\)\.top/);
});

test("DOM geometry and scene layout share the same node dimensions", () => {
	assert.match(html, /width: var\(--node-width\);/);
	assert.match(html, /height: var\(--node-height\);/);
	assert.match(
		script,
		/document\.documentElement\.style\.setProperty\("--node-width", `\$\{dimensions\.width\}px`\);/,
	);
	assert.match(
		script,
		/document\.documentElement\.style\.setProperty\("--node-height", `\$\{dimensions\.height\}px`\);/,
	);
	assert.doesNotMatch(html, /\.node\s*\{[^}]*\b(?:width: 176px|height: 92px)/);
});

test("only DOM-rendered graph items become keyboard controls", () => {
	assert.match(
		script,
		/function createNode[\s\S]*?document\.createElement\("div"\)[\s\S]*?element\.className = "node";/,
	);
	assert.doesNotMatch(script, /document\.createElement\("article"\)/);
	assert.match(script, /element\.setAttribute\("role", "button"\);/);
	assert.match(script, /element\.tabIndex = revealed \? 0 : -1;/);
	assert.match(script, /node\.element\.tabIndex = -1;/);
	const reconciliation = sourceSlice(
		script,
		script.indexOf("function reconcileNodes"),
		script.indexOf("function reconcileEdges"),
	);
	assert.ok(
		reconciliation.indexOf("if (!domWanted.has(key)) return") < reconciliation.indexOf("createNode("),
		"Pixi-only history must be excluded before creating DOM controls",
	);
	assert.match(script, /tab\.tabIndex = summary\.streamId === keyboardStreamId \? 0 : -1;/);
});

test("card details open without treating drag gestures as clicks and render content as text", () => {
	assert.match(html, /id="detail-panel" role="region"/);
	assert.match(inlineFunction("syncInspectorModality"), /detailPanel\.setAttribute\("role", modal \? "dialog" : "region"\)/);
	assert.match(script, /drag\.moved = true/);
	assert.match(script, /const shouldOpen = Boolean\(open && drag\?\.canOpen && !drag\.moved\)/);
	assert.match(script, /if \(shouldOpen\) openDetail\(node\)/);
	assert.match(
		script,
		/node\.element\.addEventListener\("keydown", \(event\) => \{[\s\S]*?event\.key !== "Enter" && event\.key !== " "[\s\S]*?openDetail\(node\);/,
	);
	assert.match(coreSource, /export \* from "\.\/inspector-view\.ts"/);
	assert.match(inlineFunction("syncDetailPanel"), /sceneEngine\.renderInspectorContent\(detailContent, item, detailMode\)/);
	assert.match(inspectorSource, /node\.textContent = text/);
	assert.match(inspectorSource, /inspectorToolText\(block\.argumentsJson \|\| "", mode\)/);
	assert.doesNotMatch(inspectorSource, /innerHTML|insertAdjacentHTML|document\.write/);
	assert.match(
		script,
		/if \(event\.key === "Escape" && detailSelection\) \{[\s\S]*?closeDetail\(\);[\s\S]*?return;[\s\S]*?\}/,
	);
});

test("card detail selection is scoped to its session stream", () => {
	const functionSource = script.match(
		/function detailSelectionMatches\(selection, streamId, itemId\) \{[\s\S]*?\n\}/,
	)?.[0];
	assert.ok(functionSource);
	const detailSelectionMatches = Function(`"use strict"; return (${functionSource});`)() as (
		selection: { streamId: string; itemId: string } | null,
		streamId: string | null,
		itemId: string,
	) => boolean;

	assert.equal(detailSelectionMatches({ streamId: "session-a", itemId: "system-prompt" }, "session-a", "system-prompt"), true);
	assert.equal(detailSelectionMatches({ streamId: "session-a", itemId: "system-prompt" }, "session-b", "system-prompt"), false);
	assert.equal(detailSelectionMatches({ streamId: "session-a", itemId: "system-prompt" }, null, "system-prompt"), false);
	assert.equal(detailSelectionMatches({ streamId: "session-a", itemId: "system-prompt" }, "session-a", "other-item"), false);
	assert.equal(detailSelectionMatches(null, "session-a", "system-prompt"), false);
	const currentDetailSource = sourceSlice(script,
		script.indexOf("function currentDetailItem"),
		script.indexOf("function detailState"),
	);
	assert.match(currentDetailSource, /detailSelectionMatches\(detailSelection, selectedStreamId/);
	assert.match(
		script,
		/function openDetailById\(itemId, override = null, before = null\) \{[\s\S]*?detailSelection = \{ streamId: selectedStreamId, itemId \};[\s\S]*?\n\}/,
	);
	assert.match(script, /function openDetail\(node\) \{[\s\S]*?openDetailById\(node\.key\);[\s\S]*?\n\}/);
	assert.match(script, /if \(detailSelection && !sessionStates\.has\(detailSelection\.streamId\)\) closeDetail\(\);/);
	assert.match(script, /function closeDetail\(\) \{[\s\S]*?detailContent\.replaceChildren\(\);[\s\S]*?\n\}/);
});

test("Pixi history virtualizes DOM nodes and recovers through the DOM fallback", () => {
	assert.match(html, /<script src="\.\/assets\/scene-core\.js"><\/script>/);
	assert.match(html, /<script src="\.\/assets\/pixi-history\.js"><\/script>/);
	assert.ok(
		html.indexOf("./assets/scene-core.js") < html.indexOf("./assets/pixi-history.js"),
		"the dependency-free scene core must load before the optional Pixi renderer",
	);
	const rendererBootstrap = sourceSlice(script,
		script.indexOf("if (historyEngine?.createHistoryRenderer)"),
		script.indexOf("function availableGraphViewport"),
	);
	assert.match(
		rendererBootstrap,
		/onContextLost\(\) \{[\s\S]*?enterHistoryRendererFallback\("WebGL context lost"\);/,
	);
	assert.match(
		rendererBootstrap,
		/\.catch\(\(error\) => \{[\s\S]*?enterHistoryRendererFallback\(error, true\);/,
	);
	assert.match(
		script,
		/function enterHistoryRendererFallback\(error, destroy = false\) \{[\s\S]*?historyRendererState = "fallback";[\s\S]*?historyHandoffIds\.clear\(\);[\s\S]*?failedRenderer\?\.destroy\(\);[\s\S]*?scheduleHistoryRendererReconcile\(\);/,
	);
	assert.match(
		script,
		/function useHistoryRenderer\(operation\) \{[\s\S]*?operation\(historyRenderer\);[\s\S]*?catch \(error\) \{[\s\S]*?enterHistoryRendererFallback\(error, true\);/,
	);
	assert.match(
		script,
		/function syncHistoryRendererDataset\(\) \{[\s\S]*?document\.body\.dataset\.renderer = historyRendererAvailable \? "pixi" : "dom";[\s\S]*?document\.body\.dataset\.rendererError = historyRendererError;/,
	);

	const reconciliation = sourceSlice(script,
		script.indexOf("function reconcileNodes"),
		script.indexOf("function updateEdge"),
	);
	assert.match(
		reconciliation,
		/const renderHistoryInDom = historyRendererState !== "pixi";[\s\S]*?const domWanted = renderHistoryInDom[\s\S]*?\? fallbackDomIds\(items, activeIds, pendingIds\)[\s\S]*?: new Set\(\[\.\.\.activeIds, \.\.\.pendingIds, \.\.\.historyHandoffIds\]\);/,
	);
	assert.match(
		script,
		/function fallbackDomIds\([\s\S]*?candidates\.length <= MAX_FALLBACK_HISTORY_NODES[\s\S]*?candidates\.slice\(0, MAX_FALLBACK_HISTORY_NODES\)/,
	);
	assert.match(
		script,
		/function scheduleFallbackRefresh\(\) \{[\s\S]*?const remaining = 80 - \(performance\.now\(\) - lastFallbackRefreshAt\);[\s\S]*?if \(remaining <= 0\)[\s\S]*?if \(fallbackRefreshTimer === null\) fallbackRefreshTimer = setTimeout\(refresh, remaining\);/,
	);
	assert.match(
		reconciliation,
		/if \(historyRendererAvailable\) \{[\s\S]*?clearTimeout\(node\.removeTimer\);[\s\S]*?node\.element\.remove\(\);[\s\S]*?nodes\.delete\(key\);[\s\S]*?continue;/,
	);
	assert.match(
		script,
		/drawCard: !activeIds\.has\(key\) && !pendingIds\.has\(key\) && !historyHandoffIds\.has\(key\),/,
	);
	assert.match(script, /const dynamicIds = new Set\(\[\.\.\.activeIds, \.\.\.pendingIds, \.\.\.historyHandoffIds\]\);/);
	assert.match(script, /const dynamic = dynamicIds\.has\(from\) \|\| dynamicIds\.has\(to\);/);
	assert.match(script, /renderer\.setOffsets\(handoffOffsets\);/);
	assert.match(pixiSource, /for \(const edge of staticSceneEdges\)/);
	assert.match(pixiSource, /for \(const edge of dynamicSceneEdges\)/);
	assert.match(pixiSource, /drawEdge\(staticEdges, edge, nodeMap, offsets, bounds\)/);
	assert.match(pixiSource, /drawEdge\(dynamicEdges, edge, nodeMap, offsets, bounds\)/);
	assert.match(
		pixiSource,
		/Math\.floor\(bounds\.left \* camera\.scale \/ CULL_SIGNATURE_SCREEN_STEP\)/,
	);
	assert.match(pixiSource, /if \(!node\?\.drawCard \|\| !visibleNodeIds\.has\(id\)\) continue;/);
	assert.match(pixiSource, /canvas\.addEventListener\("webglcontextlost", handleContextLost\);/);
	assert.match(pixiSource, /canvas\.addEventListener\("webglcontextrestored", handleContextRestored\);/);
	assert.match(rendererBootstrap, /onError\(error\) \{[\s\S]*?enterHistoryRendererFallback\(error, true\);/);
	assert.match(pixiSource, /catch \(error\) \{[\s\S]*?finishSceneTransition\(\);[\s\S]*?callbacks\.onError\?\.\(reportedError\);/);
	assert.match(pixiSource, /const finishSceneTransition = \(\): void => \{\s*for \(const id of clearSceneTransitionState\(\)\)/);
	assert.match(
		pixiSource,
		/const handleContextLost = \(event: Event\): void => \{[\s\S]*?event\.preventDefault\(\);[\s\S]*?contextLost = true;[\s\S]*?callbacks\.onContextLost\?\.\(\);[\s\S]*?\};/,
	);
	assert.match(pixiSource, /const render = \(\): void => \{\s*if \(contextLost \|\| destroyed\) return;/);
});

test("Pixi overview renders screen-space clusters that remain visible at 0.004 scale", () => {
	const silhouetteSize = Number(
		pixiSource.match(/const OVERVIEW_SILHOUETTE_SIZE_PX = ([\d.]+);/)?.[1],
	);
	assert.ok(
		silhouetteSize >= 8 && silhouetteSize <= 14,
		"overview silhouettes should be inspectable without dominating the canvas",
	);
	assert.match(pixiSource, /const OVERVIEW_CLUSTER_CELL_PX = [\d.]+;/);
	assert.match(pixiSource, /const OVERVIEW_CLUSTER_MAX_SCALE = [\d.]+;/);
	assert.match(
		pixiSource,
		/function drawOverviewClusters[\s\S]*?OVERVIEW_SILHOUETTE_SIZE_PX\s*\/\s*camera\.scale/,
		"world-space cluster size must invert camera scale to stay constant in screen pixels",
	);
	assert.match(
		pixiSource,
		/Math\.floor\([\s\S]*?camera\.scale\s*\/\s*OVERVIEW_CLUSTER_CELL_PX\)/,
		"cluster density must be quantized in screen space",
	);
	const drawCardsSource = sourceSlice(pixiSource,
		pixiSource.indexOf("const drawCards"),
		pixiSource.indexOf("const edgeIsDisplaced"),
	);
	assert.match(
		drawCardsSource,
		/if \(usesOverviewClusters\(camera\.scale\)\) \{[\s\S]*?drawOverviewClusters\(scene\.nodes\);[\s\S]*?return;[\s\S]*?\}[\s\S]*?drawCardVisuals\(/,
		"extreme overview LOD must replace full card geometry instead of drawing both layers",
	);
	assert.match(pixiSource, /clusterCount: number;/);
	assert.match(pixiSource, /clusterCount,/);
});

test("Pixi resumes viewport culling immediately above the cluster-only zoom level", () => {
	const visibilitySource = sourceSlice(pixiSource,
		pixiSource.indexOf("const nodeIsVisible"),
		pixiSource.indexOf("const visibleNodes"),
	);
	assert.doesNotMatch(
		visibilitySource,
		/if \(camera\.scale < CARD_LOD_SCALE\) return true;/,
		"moderate overview must not rebuild every offscreen card after leaving cluster LOD",
	);
	assert.match(
		pixiSource,
		/const nextSignature = usesOverviewClusters\(camera\.scale\)[\s\S]*?Math\.floor\(bounds\.left \* camera\.scale \/ CULL_SIGNATURE_SCREEN_STEP\)/,
		"cluster LOD can stay world-anchored, while card LOD must invalidate culling as the camera pans",
	);
});

test("Pixi LOD thresholds share one canonical decision helper", () => {
	assert.equal(historyLodForScale(0.01), "overview");
	assert.equal(historyLodForScale(0.16), "cards");
	assert.equal(historyLodForScale(0.48), "detail");
	assert.equal(pixiSource.match(/historyLodForScale\(camera\.scale\)/g)?.length, 2);
});

test("Pixi edge culling retains crossing edges and rejects wholly offscreen edges", () => {
	const bounds = { left: 0, right: 100, top: 0, bottom: 100 };
	assert.equal(edgeIntersectsBounds({ x: -20, y: 50 }, { x: 120, y: 50 }, bounds), true);
	assert.equal(edgeIntersectsBounds({ x: -20, y: -20 }, { x: 120, y: 120 }, bounds), true);
	assert.equal(edgeIntersectsBounds({ x: -20, y: -20 }, { x: -10, y: 120 }, bounds), false);
	assert.equal(edgeIntersectsBounds({ x: 20, y: 20 }, { x: 80, y: 80 }, bounds), true);
	assert.match(pixiSource, /const clippedStraight = clippedEdgeForBounds\(points\.from, points\.to, bounds\);/);
	assert.match(pixiSource, /!edgeIntersectsBounds\(points\.from, control, bounds\)/);
	assert.match(pixiSource, /drawDashedLine\(graphics, clippedStraight\.from, clippedStraight\.to/);
});

test("Pixi caches labels, owns supplied offsets, and counts cards without temporary arrays", () => {
	assert.match(pixiSource, /const labelCache = new Map<string, LabelCacheEntry>\(\);/);
	assert.match(pixiSource, /const cachedLabelFor = \(node: HistoryNodeVisual\): Container =>/);
	assert.match(pixiSource, /while \(labelCache\.size > MAX_CACHED_LABELS\)/);
	assert.match(pixiSource, /offsets\.set\(id, \{ x: point\.x, y: point\.y \}\);/);
	const diagnosticsSource = sourceSlice(pixiSource,
		pixiSource.lastIndexOf("diagnostics(): HistoryRendererDiagnostics"),
		pixiSource.lastIndexOf("destroy(): void"),
	);
	assert.match(diagnosticsSource, /cardCount,/);
	assert.doesNotMatch(diagnosticsSource, /\.filter\(/);
});

test("Pixi history hover never enters the DOM tooltip positioning path", () => {
	const renderFrameSource = sourceSlice(script,
		script.indexOf("function renderFrame"),
		script.indexOf("function attachNodeInteraction"),
	);
	assert.match(
		renderFrameSource,
		/if \(hoveredNode && !hoveredNode\.history && \(cameraMoving \|\| nodeUpdates > 0\)\)/,
	);
	assert.match(script, /hoveredNode = \{ history: true, key: visual\.id \};/);
});

test("history scene travel stays on the canvas and supports keyboard navigation", () => {
	const travelSource = sourceSlice(
		script,
		script.indexOf("function travelToEpoch"),
		script.indexOf("function returnToNaturalView"),
	);
	assert.match(travelSource, /cameraTarget = \{[\s\S]*?scale: cameraTarget\.scale,/);
	assert.doesNotMatch(
		travelSource,
		/scale: fitScaleForBounds\(epoch\.bounds\)/,
		"clicking history should pan to its epoch without changing the user's zoom",
	);
	assert.match(travelSource, /markCameraDirty\(\);/);
	assert.match(script, /const epoch = currentSceneLayout\.epochs\[boundedIndex\];\s*if \(!epoch\) return false;/);
	assert.match(script, /function travelToHistory\(itemId\) \{[\s\S]*?travelToEpoch\(placement\.epoch\);/);
	assert.match(
		script,
		/if \(event\.key !== "ArrowLeft" && event\.key !== "ArrowRight"\) return;[\s\S]*?navigateScene\(event\.key === "ArrowRight" \? 1 : -1\)/,
	);
	assert.match(script, /viewedEpochIndex = saved\?\.viewedEpochIndex \?\? null;/);
});

test("the offline package contains and builds independent core and Pixi viewer assets", () => {
	assert.ok(packageJson.files?.includes("web"));
	const pixiVersion = packageJson.devDependencies?.["pixi.js"];
	const esbuildVersion = packageJson.devDependencies?.esbuild;
	assert.ok(pixiVersion, "pixi.js must be declared");
	assert.ok(esbuildVersion, "esbuild must be declared");
	assert.doesNotMatch(pixiVersion, /^[~^<>=*]/, "pixi.js must use a pinned version");
	assert.doesNotMatch(esbuildVersion, /^[~^<>=*]/, "esbuild must use a pinned version");
	assert.match(coreSource, /export \* from "\.\/scene-layout\.ts";/);
	assert.match(coreSource, /export \* from "\.\/camera\.ts";/);
	assert.match(pixiSource, /^import "pixi\.js\/unsafe-eval";/);
	assert.match(
		packageJson.scripts?.["build:web:core"] ?? "",
		/--global-name=ContextRailCore/,
	);
	assert.match(
		packageJson.scripts?.["build:web:core"] ?? "",
		/--outfile=web\/assets\/scene-core\.js(?:\s|$)/,
	);
	assert.match(
		packageJson.scripts?.["build:web:pixi"] ?? "",
		/--global-name=ContextRailPixi/,
	);
	assert.match(
		packageJson.scripts?.["build:web:pixi"] ?? "",
		/--outfile=web\/assets\/pixi-history\.js(?:\s|$)/,
	);
	assert.match(packageJson.scripts?.["build:web"] ?? "", /npm run build:web:core/);
	assert.match(packageJson.scripts?.["build:web"] ?? "", /npm run build:web:pixi/);
	assert.match(packageJson.scripts?.build ?? "", /npm run build:web/);
});

test("the deterministic demo can exercise bounded long-history rendering", () => {
	assert.match(script, /function demoPayload\(itemCount = 23\)/);
	assert.match(script, /Math\.max\(6, Math\.min\(10_000, Math\.trunc\(itemCount\)/);
	assert.match(script, /const requestedDemoItems = Number\(query\.get\("items"\)\);/);
	assert.match(script, /demoPayload\(Number\.isFinite\(requestedDemoItems\) \? requestedDemoItems : undefined\)/);
});

test("session activity does not move the selected tab unless follow is enabled", () => {
	const followControl = html.match(/<input id="follow-toggle"[^>]*>/)?.[0];
	assert.ok(followControl);
	assert.doesNotMatch(followControl, /\schecked(?:\s|>|=)/);
	assert.match(script, /let followActive = false;/);
	assert.match(script, /followToggle\.addEventListener\("change", \(\) => setFollowActive\(followToggle\.checked\)\);/);
	assert.match(script, /if \(followActive\) \{[\s\S]*?target = activeStreamId/);
});

test("session tabs expose one keyboard entry point and label the graph panel", () => {
	assert.match(html, /<div id="viewport" role="tabpanel"/);
	assert.match(script, /tab\.setAttribute\("aria-controls", "viewport"\);/);
	assert.match(script, /const keyboardStreamId = sessionSummaries\.some/);
	assert.match(script, /tab\.tabIndex = summary\.streamId === keyboardStreamId \? 0 : -1;/);
	assert.match(script, /viewport\.setAttribute\("aria-labelledby", labelledTab\.id\);/);
});

test("bootstrap cleanup and tab focus use the pre-bootstrap session set", () => {
	assert.match(
		script,
		/const knownStreamIds = new Set\([\s\S]*?\.\.\.sessionStates\.keys\(\)[\s\S]*?sessionStates\.clear\(\)/,
	);
	assert.match(script, /if \(!selectedStreamId \|\| !sessionStates\.has\(selectedStreamId\)\) return;/);
	assert.match(
		script,
		/if \(selectedStreamId && sessionStates\.has\(selectedStreamId\)\) saveSessionView\(\);/,
	);
	assert.match(script, /if \(focusedStreamId && !available\.has\(focusedStreamId\)\)/);
	assert.match(script, /\(replacement \|\| followToggle\)\.focus\(\);/);
});

test("invalid event data closes the stream and reconnects for a bootstrap", () => {
	assert.match(
		script,
		/function restartEventSourceAfterInvalidData\(source\)[\s\S]*?source\.close\(\);[\s\S]*?connectEventSource\(\);/,
	);
	assert.match(
		script,
		/catch \(_\) \{\s*restartEventSourceAfterInvalidData\(source\);\s*\}/,
	);
	assert.match(script, /deltaTransfers\.clear\(\);/);
});

test("terminal event-stream authentication failures do not masquerade as reconnects", () => {
	const connectionSource = sourceSlice(
		script,
		script.indexOf("function connectEventSource"),
		script.indexOf("const query = new URLSearchParams"),
	);
	assert.match(connectionSource, /source\.readyState === EventSource\.CLOSED/);
	assert.match(connectionSource, /sessionStorage\.removeItem\(EVENT_CAPABILITY_STORAGE_KEY\)/);
	assert.match(connectionSource, /unauthorized - reopen the viewer link/);
	assert.match(connectionSource, /setConnection\("offline", "reconnecting"\);/);
});

test("delta assembly waits for the final transport chunk", () => {
	const applyDeltaSource = sourceSlice(
		script,
		script.indexOf("function applyDelta"),
		script.indexOf("function shouldMarkUnread"),
	);
	const completenessGuard = applyDeltaSource.indexOf("if (!delta.complete) return null");
	const decode = applyDeltaSource.indexOf("decodeDeltaChunks(transfer.chunks)");
	assert.ok(completenessGuard >= 0, "incomplete delta transfers must return without assembly");
	assert.ok(decode > completenessGuard, "delta decoding must happen only after the complete chunk");
});

test("viewer capability is tab-scoped, removed from the hash, and used only for SSE", () => {
	assert.match(script, /new URLSearchParams\(location\.hash\.slice\(1\)\)\.get\("token"\)/);
	assert.match(script, /sessionStorage\.setItem\(storageKey, fragmentToken\)/);
	assert.match(script, /sessionStorage\.getItem\(storageKey\)/);
	assert.doesNotMatch(script, /localStorage/);
	assert.match(
		script,
		/history\.replaceState\(history\.state, "", `\$\{location\.pathname\}\$\{location\.search\}`\)/,
	);
	assert.match(
		script,
		/const eventsUrl = new URL\("\/events", location\.href\);[\s\S]*?eventsUrl\.searchParams\.set\("token", eventCapabilityToken\);[\s\S]*?new EventSource\(eventsUrl\.href\)/,
	);
	assert.ok(
		script.indexOf("history.replaceState") < script.indexOf("new EventSource"),
		"the visible fragment must be cleared before the SSE request starts",
	);
});

test("large diffs and reduced-motion changes avoid unbounded animation work", () => {
	assert.match(
		script,
		/let diffAnimationBudget = animateDiff && !reducedMotion \? MAX_ANIMATED_NODES : 0;/,
	);
	assert.match(script, /if \(diff && diffAnimationBudget > 0\)/);
	assert.match(script, /diffAnimationBudget -= 1;/);
	assert.match(html, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?animation: none !important;/);
	assert.match(script, /reducedMotionQuery\.addEventListener\("change", handleReducedMotionChange\);/);
	assert.match(script, /if \(!diff \|\| reducedMotion\) return;/);
});

test("the event-driven render loop exposes when it is active and sleeping", () => {
	assert.match(script, /function scheduleRender\(\) \{[\s\S]*?document\.body\.dataset\.renderLoop = "active";/);
	assert.match(
		script,
		/renderLoopActive = false;[\s\S]*?document\.body\.dataset\.renderLoop = "sleeping";[\s\S]*?renderStats\.sleepingSince = time;/,
	);
});

test("small timeline patches use structural copies instead of full clones", () => {
	assert.match(script, /: \{ \.\.\.previous \};/);
	assert.match(script, /: \{ \.\.\.state\.timeline \};/);
	assert.doesNotMatch(script, /structuredClone\(previous\)|structuredClone\(state\.timeline\)/);
	assert.match(script, /if \(historyUpserts\.length > 0 \|\| patch\.timeline\.removedHistoryIds\?\.length\)/);
});

test("layout failures preserve the previously rendered scene", () => {
	const reconciliation = sourceSlice(
		script,
		script.indexOf("function reconcileNodes"),
		script.indexOf("function reconcileEdges"),
	);
	const build = reconciliation.indexOf("nextSceneLayout = buildLayout(timeline, dimensions)");
	const failureReturn = reconciliation.indexOf("return false", build);
	const assignment = reconciliation.indexOf("currentSceneLayout = nextSceneLayout", build);
	assert.ok(build >= 0, "layout construction must use a temporary value");
	assert.ok(failureReturn > build, "layout construction errors must abort reconciliation");
	assert.ok(assignment > failureReturn, "the current layout must change only after construction succeeds");
});

test("viewer patch helpers stay behaviorally aligned with the canonical delta implementation", () => {
	const helperSource = sourceSlice(
		script,
		script.indexOf("function emptyTimeline"),
		script.indexOf("function decodeDeltaChunks"),
	);
	const applyViewerRenderStatePatch = Function(
		"sceneEngine",
		`"use strict"; ${helperSource}\nreturn applyRenderStatePatch;`,
	)({ applyCaptureArchivePatch }) as (previous: RenderState | undefined, patch: RenderStatePatch) => RenderState;
	const captureEntry: ContextCaptureEntry = {
		id: "capture-1", capturedAt: 1, source: "context-hook",
		snapshot: { createdAt: 1, items: [{ id: "message-1", kind: "user" }] },
		itemCount: 1, itemRefs: [{ itemId: "message-1", versionId: "version-1" }], contentStatus: "available",
	};
	const patches: RenderStatePatch[] = [
		{
			reset: true,
			snapshot: { createdAt: 1, items: [{ id: "message-1", kind: "user" }] },
			phase: "context",
			activeTools: ["read"],
			captures: {
				reset: true, revision: 1, entryUpserts: [captureEntry],
				versionUpserts: [{ id: "message-1", kind: "user", versionId: "version-1" }],
			},
			timeline: {
				reset: true,
				revision: 1,
				historyUpserts: [{
					id: "message-1",
					kind: "user",
					order: 0,
					firstSeenAt: 1,
					lastSeenAt: 1,
					confirmedAt: 1,
				}],
				activeIds: ["message-1"],
				enteredIds: ["message-1"],
				retainedIds: [],
				exitedIds: [],
				observedIds: [],
				confirmedIds: ["message-1"],
				pendingIds: [],
			},
		},
		{
			snapshot: { createdAt: 2, items: [{ id: "message-2", kind: "assistant" }] },
			phase: "tool",
			activeTools: ["write"],
			timeline: {
				revision: 2,
				historyUpserts: [{
					id: "message-2",
					kind: "assistant",
					order: 1,
					firstSeenAt: 2,
					lastSeenAt: 2,
					confirmedAt: 2,
				}],
				activeIds: ["message-2"],
				enteredIds: ["message-2"],
				retainedIds: [],
				exitedIds: ["message-1"],
				observedIds: [],
				confirmedIds: ["message-2"],
				pendingIds: [],
				summaryEdgeUpserts: [{ from: "message-1", to: "message-2", kind: "summary" }],
			},
		},
		{
			timeline: {
				removedHistoryIds: ["message-1"],
				removedSummaryEdges: [{ from: "message-1", to: "message-2", kind: "summary" }],
				retention: { maxItems: 1, maxBytes: 1024, retainedItems: 1, retainedBytes: 200, pinnedItems: 1, pinnedBytes: 200, evictedItems: 1, evictedBytes: 200, overBudget: false },
			},
		},
		{ timeline: { retention: null } },
		{
			// Archive changes must still apply when the same patch removes the timeline.
			snapshot: null, phase: "idle", activeTools: [], timeline: null,
			captures: {
				revision: 2, removedEntryIds: ["capture-1"], removedVersionIds: ["version-1"],
				entryUpserts: [{ ...captureEntry, id: "capture-2", itemRefs: [], contentStatus: "omitted", omittedReason: "byte-limit" }],
			},
		},
		{ captures: { revision: 3, removedEntryIds: ["capture-2"] } },
		{ captures: null },
		{ reset: true, snapshot: null, captures: { reset: true, revision: 0 } },
	];
	let canonical: RenderState | undefined;
	let viewer: RenderState | undefined;
	for (const patch of patches) {
		canonical = applyCanonicalRenderStatePatch(canonical, patch);
		viewer = applyViewerRenderStatePatch(viewer, patch);
		assert.deepEqual(viewer, canonical);
	}
});

test("summary edge keys use collision-free tuples", () => {
	assert.match(
		script,
		/function summaryEdgeKey\(edge\) \{\s*return JSON\.stringify\(\[edge\.kind, edge\.from, edge\.to\]\);\s*\}/,
	);
	assert.match(script, /const key = JSON\.stringify\(\[type, from, to\]\);/);
	assert.doesNotMatch(script, /\$\{type\}:\$\{from\}->\$\{to\}/);
});

test("only activity updates mark an unselected session unread", () => {
	const functionSource = script.match(
		/function shouldMarkUnread\(payload, changed, selectedId\) \{[\s\S]*?\n\}/,
	)?.[0];
	assert.ok(functionSource);
	const shouldMarkUnread = Function(`"use strict"; return (${functionSource});`)() as (
		payload: { activity?: boolean },
		changed: { streamId: string } | null,
		selectedId: string | null,
	) => boolean;

	const changed = { streamId: "process:background" };
	assert.equal(shouldMarkUnread({ activity: false }, changed, "process:selected"), false);
	assert.equal(shouldMarkUnread({ activity: true }, changed, "process:selected"), true);
	assert.equal(shouldMarkUnread({}, changed, "process:selected"), true);
	assert.equal(shouldMarkUnread({ activity: true }, changed, changed.streamId), false);
	assert.equal(shouldMarkUnread({ activity: true }, null, "process:selected"), false);
});

test("desktop inspectors reserve graph width while mobile keeps the full canvas width", () => {
	const measure = Function("innerWidth", "open", "mobile", "panelWidth", `
		"use strict";
		const document = { body: { dataset: { detailOpen: String(open) } } };
		const isMobileLayout = () => mobile;
		const detailPanel = { getBoundingClientRect: () => ({ width: panelWidth }) };
		${inlineFunction("graphWidth")}
		return graphWidth();
	`) as (width: number, open: boolean, mobile: boolean, panelWidth: number) => number;
	assert.equal(measure(1_440, true, false, 480), 960);
	assert.equal(measure(1_440, false, false, 480), 1_440);
	assert.equal(measure(390, true, true, 390), 390);
	assert.equal(measure(900, true, false, 1_000), 1);
	assert.match(inlineFunction("syncGraphViewport"), /bounds\.width = graphWidth\(\);[\s\S]*bounds\.centerX = bounds\.width \/ 2/);
	assert.match(inlineFunction("buildLayout"), /focusGridColumns\(graphWidth\(\)\)/);
});

interface HarnessElement {
	textContent: string;
	title: string;
	value: string;
	dataset: Record<string, string>;
	hidden: boolean;
	disabled: boolean;
	scrollTop: number;
	replacements: number;
	children: HarnessElement[];
	attributes: Map<string, string>;
	classList: { toggle(name: string, value: boolean): void; remove(name: string): void };
	style: { setProperty(name: string, value: string): void };
	setAttribute(name: string, value: string): void;
	replaceChildren(...children: HarnessElement[]): void;
	append(...children: HarnessElement[]): void;
}

function harnessElement(): HarnessElement {
	return {
		textContent: "", title: "", value: "", dataset: {}, hidden: false, disabled: false, scrollTop: 0, replacements: 0,
		children: [], attributes: new Map(),
		classList: { toggle() {}, remove() {} }, style: { setProperty() {} },
		setAttribute(name, value) { this.attributes.set(name, value); },
		replaceChildren(...children) { this.children = [...children]; this.textContent = ""; this.replacements += 1; },
		append(...children) { this.children.push(...children); },
	};
}

interface Deferred<T> {
	promise: Promise<T>;
	resolve(value: T): void;
	reject(reason: unknown): void;
}

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}

interface HarnessLayoutJob extends Deferred<unknown> {
	key: string;
	timeline: ContextTimelineSnapshot;
	options: unknown;
}

type HarnessIndex = Pick<ContentIndex, "reconcile" | "reconcileAsync" | "cancelPendingReconcile" | "clear" | "diagnostics">;

interface ViewerHarnessOptions {
	index?: HarnessIndex;
	fallback?: (timeline: ContextTimelineSnapshot) => unknown;
}

interface ViewerHarness {
	apply(payload: RenderState, force?: boolean): void;
	applyHub(payload: unknown): void;
	showCapture(id: string): void;
	setMode(mode: string): void;
	selectDetail(id: string): void;
	acceptDetailUpdate(): void;
	setDimensions(key: string): void;
	removeSelectedSession(): void;
	cancel(): void;
	layoutJobs: HarnessLayoutJob[];
	errors: unknown[][];
	element(selector: string): HarnessElement;
	state(): {
		live: RenderState | null;
		current: RenderState | null;
		frozen: { entry: ContextCaptureEntry; archive: ContextCaptureArchiveSnapshot; state: RenderState } | null;
		displayed: HistoryItem | null;
		selection: { streamId: string; itemId: string } | null;
		selectedStreamId: string | null;
		chrome: RenderState | null;
		reconciliations: number;
		inspectorRenders: number;
		indexRevision: number;
		clears: number;
		searchSchedules: number;
		indexBusy: boolean;
		indexAborted: boolean | null;
		pendingTimeline: ContextTimelineSnapshot | null;
		committedTimeline: ContextTimelineSnapshot | null;
		committedLayout: unknown;
		workerCancels: number;
		workerForgets: string[];
		workerFallback: boolean;
		fallbackCalls: number;
	};
}

/** Execute real inline state-transition functions; substitute only the DOM, geometry, and transport edges. */
function viewerHarness(options: ViewerHarnessOptions = {}): ViewerHarness {
	const source = [
		"itemKey", "timelineFrom", "detailSelectionMatches", "currentDetailItem", "detailState",
		"cancelBackgroundWork", "syncWorkStatus", "startContentIndex", "commitScene", "prepareScene",
		"updateViewData", "syncDetailPanel", "captureDescription", "syncCaptureControls",
		"showCapture", "applyPayload", "setMode", "shouldMarkUnread", "applyHubPayload",
	].map(inlineFunction).join("\n");
	const layoutJobs: HarnessLayoutJob[] = [];
	const workerForgets: string[] = [];
	let workerCancels = 0, fallbackCalls = 0;
	const layoutWorker = {
		run(key: string, timeline: ContextTimelineSnapshot, layoutOptions: unknown) {
			const job = { ...deferred<unknown>(), key, timeline, options: layoutOptions };
			layoutJobs.push(job);
			return job.promise;
		},
		// Deliberately allow late replies after cancellation to test the UI's own job-identity guard.
		cancel() { workerCancels += 1; },
		forget(prefix: string) { workerForgets.push(prefix); },
	};
	const errors: unknown[][] = [];
	const index = options.index ?? new ContentIndex();
	const sceneEngine = {
		ContentIndex, projectContent, contentState, sameOrderedIds, sameSceneTimeline, captureRenderState, compareCaptures,
		buildSceneLayout(timeline: ContextTimelineSnapshot) {
			fallbackCalls += 1;
			return options.fallback ? options.fallback(timeline) : { fallback: true, timeline };
		},
		renderInspectorContent(container: HarnessElement, item: HistoryItem) { container.textContent = copyableContextText(item); },
	};
	const backgroundThreshold = Number(script.match(/const BACKGROUND_ITEM_THRESHOLD = (\d+);/)?.[1]);
	assert.ok(Number.isFinite(backgroundThreshold), "the async work threshold must exist");
	return Function("sceneEngine", "makeElement", "contentIndex", "layoutWorker", "BACKGROUND_ITEM_THRESHOLD", "edges", "console", `
		"use strict";
		const elements = new Map();
		const $ = (selector) => { if (!elements.has(selector)) elements.set(selector, makeElement()); return elements.get(selector); };
		const document = { activeElement: null };
		const Option = function(text, value) { const node = makeElement(); node.textContent = text; node.value = value; return node; };
		const sessionStates = new Map([["session-a", null]]), sessionViews = new Map(), sessionLayouts = new Map(), deltaTransfers = new Map();
		const unreadSessions = new Set();
		let sessionSummaries = [{ streamId: "session-a" }], selectedStreamId = "session-a", activeStreamId = null, followActive = false;
		let livePayload = null, currentPayload = null, frozenCapture = null, lastCaptureOptionsKey = null, lastCaptureArchive = null, captureChanges;
		let lastReconciledTimeline = null, lastReconciledMode = null, lastReconciledRendererState = null, lastReconciledDimensions = null;
		let viewMode = "window", historyRendererState = "pixi", freeCamera = false, viewedEpochIndex = null, dimensionsKey = "desktop";
		let detailSelection = null, detailDisplayedItem = null, detailOverride = null, detailBefore = null, detailMode = "read";
		let lastHistoryReference = null, lastIndexedTimeline = null, historyById = new Map();
		let currentActiveIds = new Set(), currentPendingIds = new Set(), currentSummarySources = new Map();
		let detailOrder = [], detailOrderPositions = new Map();
		let sceneJobGeneration = 0, pendingScene = null, preparedLayout = null, indexAbort = null, indexGeneration = 0, indexBusy = false, workerFallback = false;
		let searchGeneration = 0, searchTimer = null, currentSceneLayout = null, committedLayout = null;
		const detailContent = $("#detail-content"), detailPanel = $("#detail-panel"), viewport = $("#viewport");
		const kindMeta = Object.fromEntries(["user", "assistant", "system", "developer", "tool", "memory", "unknown"].map((kind) => [kind, { label: kind, color: "black" }]));
		const viewStats = { reconciliations: 0, inspectorRenders: 0, reconcileMs: 0, maxReconcileMs: 0 };
		let chrome = null, clears = 0, searchSchedules = 0;
		const updateChrome = (payload) => { chrome = payload; };
		const reconciliationDimensionsKey = () => dimensionsKey;
		const reconcileNodes = () => { committedLayout = preparedLayout?.layout || null; currentSceneLayout = committedLayout; return true; };
		const nodeDimensions = () => ({ width: 176, height: 92 });
		const isShortLandscapeLayout = () => false, isMobileLayout = () => false, focusGridColumns = () => 5, graphWidth = () => 1_200;
		const syncGraphViewport = () => {};
		const syncSelectionMarkers = () => {};
		const syncModeChrome = () => {};
		const renderSessionTabs = () => {};
		const selectSession = (id) => { selectedStreamId = id; applyPayload(sessionStates.get(id)); };
		const scheduleSearch = () => { searchSchedules += 1; };
		const fitView = () => {};
		const closeDetail = () => { detailSelection = null; detailDisplayedItem = null; detailOverride = null; detailBefore = null; detailContent.replaceChildren(); };
		const clearGraph = () => { clears += 1; cancelBackgroundWork(); closeDetail(); lastReconciledTimeline = null; lastHistoryReference = null; lastIndexedTimeline = null; currentSceneLayout = null; committedLayout = null; contentIndex.clear(); historyById.clear(); };
		${source}
		return {
			apply(payload, force = false) { if (selectedStreamId) sessionStates.set(selectedStreamId, payload); applyPayload(payload, false, force); },
			applyHub: applyHubPayload, showCapture, setMode,
			selectDetail(id) { detailSelection = { streamId: selectedStreamId, itemId: id }; detailDisplayedItem = null; syncDetailPanel(true); },
			acceptDetailUpdate() { syncDetailPanel(true); },
			setDimensions(key) { dimensionsKey = key; },
			removeSelectedSession() { sessionStates.delete(selectedStreamId); },
			cancel: cancelBackgroundWork, layoutJobs: edges.layoutJobs, errors: edges.errors,
			element: $,
			state() { return { live: livePayload, current: currentPayload, frozen: frozenCapture, displayed: detailDisplayedItem, selection: detailSelection, selectedStreamId, chrome, reconciliations: viewStats.reconciliations, inspectorRenders: viewStats.inspectorRenders, indexRevision: contentIndex.diagnostics().revision, clears, searchSchedules, indexBusy, indexAborted: indexAbort?.signal.aborted ?? null, pendingTimeline: pendingScene?.timeline ?? null, committedTimeline: lastReconciledTimeline, committedLayout, workerFallback, ...edges.stats() }; },
		};
	`)(sceneEngine, harnessElement, index, layoutWorker, backgroundThreshold, {
		layoutJobs, errors, stats: () => ({ workerCancels, workerForgets: [...workerForgets], fallbackCalls }),
	}, { error: (...args: unknown[]) => errors.push(args) }) as ViewerHarness;
}

function viewerItem(text: string, id = "message-1"): HistoryItem {
	return {
		id, kind: "user", order: 0, firstSeenAt: 1, lastSeenAt: 1,
		detail: { sourceRole: "user", modelMessages: [{ modelRole: "user", blocks: [{ type: "text", text }] }] },
	};
}

function viewerPayload(items: HistoryItem[]): RenderState {
	return {
		snapshot: { createdAt: 1, items: items.map(({ id, kind }) => ({ id, kind })) },
		phase: "context", activeTools: [],
		timeline: { ...emptyTimelineSnapshot(), revision: 1, history: items, activeIds: items.map(({ id }) => id) },
	};
}

function largeViewerPayload(prefix: string): RenderState {
	return viewerPayload(Array.from({ length: 750 }, (_, order) => ({ ...viewerItem(`${prefix} content`, `${prefix}-${order}`), order })));
}

function fastViewerHarness(options: ViewerHarnessOptions = {}): ViewerHarness {
	const index = new ContentIndex();
	const reconcileAsync = index.reconcileAsync.bind(index);
	index.reconcileAsync = (items, settings) => reconcileAsync(items, { ...settings, yieldControl: async () => {} });
	return viewerHarness({ index, ...options });
}

const flushViewerWork = () => new Promise<void>((resolve) => setTimeout(resolve, 10));

test("large layouts coalesce phase wrappers and discard superseded worker replies", async () => {
	const harness = fastViewerHarness();
	const first = largeViewerPayload("first");
	harness.apply(first);
	harness.apply({ ...first, phase: "tool", timeline: { ...first.timeline! } });
	assert.equal(harness.layoutJobs.length, 1);
	assert.equal(harness.state().reconciliations, 0);
	const second = largeViewerPayload("second");
	harness.apply(second);
	assert.equal(harness.layoutJobs.length, 2);
	harness.layoutJobs[0]!.resolve({ tag: "obsolete" });
	await flushViewerWork();
	assert.equal(harness.state().reconciliations, 0);
	assert.equal(harness.state().pendingTimeline, second.timeline);
	harness.layoutJobs[1]!.resolve({ tag: "latest" });
	await flushViewerWork();
	assert.equal(harness.state().committedTimeline, second.timeline);
	assert.deepEqual(harness.state().committedLayout, { tag: "latest" });
	assert.equal(harness.state().indexBusy, false);
	assert.equal(harness.element("#viewport").attributes.get("aria-busy"), "false");
});

test("switching to a small scene cancels pending layout and clears its busy status", async () => {
	const harness = fastViewerHarness();
	harness.apply(largeViewerPayload("large"));
	const small = viewerPayload([viewerItem("small")]);
	harness.apply(small);
	assert.equal(harness.state().workerCancels, 1);
	assert.equal(harness.element("#work-status").hidden, true);
	harness.layoutJobs[0]!.resolve({ tag: "stale large" });
	await flushViewerWork();
	assert.equal(harness.state().committedTimeline, small.timeline);
	assert.equal(harness.state().reconciliations, 1);
	assert.equal(harness.state().indexBusy, false);
});

test("worker failure falls back once and a failed fallback releases busy UI", async () => {
	const harness = fastViewerHarness();
	const payload = largeViewerPayload("fallback");
	harness.apply(payload);
	harness.layoutJobs[0]!.reject(new Error("blocked worker"));
	await flushViewerWork();
	assert.equal(harness.state().workerFallback, true);
	assert.equal(harness.state().fallbackCalls, 1);
	assert.equal(harness.state().committedTimeline, payload.timeline);
	assert.equal(harness.state().pendingTimeline, null);
	const broken = fastViewerHarness({ fallback: () => { throw new Error("bad layout"); } });
	broken.apply(payload);
	broken.layoutJobs[0]!.reject(new Error("blocked worker"));
	await flushViewerWork();
	assert.equal(broken.state().pendingTimeline, null);
	assert.equal(broken.state().reconciliations, 0);
	assert.equal(broken.errors.length, 1);
	assert.equal(broken.element("#viewport").attributes.get("aria-busy"), "false");
});

test("deleting a session cancels unpublished index and layout results", async () => {
	const harness = fastViewerHarness();
	harness.apply(largeViewerPayload("deleted"));
	harness.applyHub({ type: "bootstrap", sessions: [], states: [], activeStreamId: null });
	harness.layoutJobs[0]!.resolve({ tag: "deleted result" });
	await flushViewerWork();
	assert.equal(harness.state().selectedStreamId, null);
	assert.equal(harness.state().committedTimeline, null);
	assert.equal(harness.state().pendingTimeline, null);
	assert.equal(harness.state().indexBusy, false);
	assert.equal(harness.element("#work-status").hidden, true);
});

function viewerArchive(records: { id: string; item: HistoryItem }[]): ContextCaptureArchiveSnapshot {
	return {
		revision: records.length,
		entries: records.map(({ id, item }, index) => ({
			id, capturedAt: index + 1, source: "context-hook",
			snapshot: { createdAt: index + 1, items: [{ id: item.id, kind: item.kind }] },
			itemCount: 1, itemRefs: [{ itemId: item.id, versionId: `version-${id}` }], contentStatus: "available",
		})),
		versions: records.map(({ id, item }) => ({ id: item.id, kind: item.kind, versionId: `version-${id}`, ...(item.detail ? { detail: item.detail } : {}) })),
	};
}

test("tool-only wrappers keep the inspector body, search index, and scene reconciliation stable", () => {
	const harness = viewerHarness();
	const payload = viewerPayload([viewerItem("Selected original body")]);
	harness.apply(payload);
	harness.selectDetail("message-1");
	harness.element("#detail-content").scrollTop = 420;
	const before = harness.state();
	for (let revision = 2; revision <= 101; revision += 1) {
		harness.apply({ ...payload, phase: "tool", activeTools: ["read"], timeline: {
			...payload.timeline!, revision, activeIds: [...payload.timeline!.activeIds], pendingIds: [],
		} });
	}
	assert.equal(harness.state().reconciliations, before.reconciliations);
	assert.equal(harness.state().inspectorRenders, before.inspectorRenders);
	assert.equal(harness.state().indexRevision, before.indexRevision);
	assert.equal(harness.element("#detail-content").scrollTop, 420);
	assert.equal(harness.element("#detail-update").hidden, true);
	assert.equal(harness.state().chrome?.phase, "tool");
	assert.deepEqual(harness.state().chrome?.activeTools, ["read"]);
	// Geometry still invalidates the fast path even when content references are unchanged.
	harness.setDimensions("sidebar-open");
	harness.apply(payload);
	assert.equal(harness.state().reconciliations, before.reconciliations + 1);
	assert.equal(harness.state().inspectorRenders, before.inspectorRenders);
});

test("selected content stays readable across a replacement until its update is explicitly accepted", () => {
	const harness = viewerHarness();
	const original = viewerPayload([viewerItem("Earlier captured body")]);
	harness.apply(original);
	harness.selectDetail("message-1");
	harness.element("#detail-content").scrollTop = 777;
	const displayed = harness.state().displayed;
	const changed = viewerPayload([viewerItem("New captured body")]);
	harness.apply(changed);
	assert.strictEqual(harness.state().displayed, displayed);
	assert.equal(harness.element("#detail-update").hidden, false);
	assert.equal(harness.element("#detail-content").scrollTop, 777);
	assert.match(harness.element("#detail-content").textContent, /Earlier captured body/);
	assert.doesNotMatch(harness.element("#detail-content").textContent, /New captured body/);
	harness.acceptDetailUpdate();
	assert.strictEqual(harness.state().displayed?.detail, changed.timeline!.history[0]!.detail);
	assert.equal(harness.element("#detail-update").hidden, true);
	assert.equal(harness.element("#detail-content").scrollTop, 0);
	assert.match(harness.element("#detail-content").textContent, /New captured body/);
});

test("metadata-only kind and tool-name changes expose an update without silently replacing selected content", () => {
	const base = viewerItem("Captured output");
	const originalTool: HistoryItem = { ...base, kind: "tool", toolName: "read_file" };
	const cases: { original: HistoryItem; changed: HistoryItem }[] = [
		{ original: originalTool, changed: { ...originalTool, toolName: "read_document" } },
		{ original: base, changed: { ...base, kind: "memory" } },
	];
	for (const { original, changed } of cases) {
		assert.strictEqual(changed.detail, original.detail, "fixture must change metadata without replacing detail");
		const harness = viewerHarness();
		harness.apply(viewerPayload([original]));
		harness.selectDetail(original.id);
		harness.element("#detail-content").scrollTop = 92;
		const displayed = harness.state().displayed;
		harness.apply(viewerPayload([changed]));
		assert.equal(harness.element("#detail-update").hidden, false);
		assert.strictEqual(harness.state().displayed, displayed);
		assert.equal(harness.state().inspectorRenders, 1);
		assert.equal(harness.element("#detail-content").scrollTop, 92);
		harness.acceptDetailUpdate();
		assert.equal(harness.state().inspectorRenders, 2);
		assert.equal(harness.state().displayed?.kind, changed.kind);
		assert.equal(harness.state().displayed?.toolName, changed.toolName);
		assert.equal(harness.element("#detail-title").textContent, projectContent(changed).title);
		assert.equal(harness.element("#detail-content").textContent, copyableContextText(changed));
		assert.equal(harness.element("#detail-update").hidden, true);
	}
});

test("membership-only changes update selected context state without repainting its body", () => {
	const harness = viewerHarness();
	const original = viewerPayload([viewerItem("Still readable")]);
	harness.apply(original);
	harness.selectDetail("message-1");
	const renders = harness.state().inspectorRenders;
	harness.apply({ ...original, timeline: { ...original.timeline!, activeIds: [] } });
	assert.equal(harness.state().inspectorRenders, renders);
	assert.equal(harness.element("#detail-state").textContent, "Outside captured context");
	assert.match(harness.element("#detail-content").textContent, /Still readable/);
});

test("removed or empty detail immediately clears earlier selected text rather than preserving it", () => {
	const originalItem = viewerItem("Sensitive earlier text");
	const { detail: _detail, ...noDetail } = originalItem;
	const replacements: HistoryItem[] = [
		noDetail,
		{ ...originalItem, detail: { sourceRole: "user", modelMessages: [] } },
		{ ...originalItem, detail: { sourceRole: "user", modelMessages: [{ modelRole: "user", blocks: [] }] } },
		{ ...originalItem, kind: "memory", synthetic: true },
	];
	for (const replacement of replacements) {
		const harness = viewerHarness();
		harness.apply(viewerPayload([originalItem]));
		harness.selectDetail(originalItem.id);
		harness.apply(viewerPayload([replacement]));
		assert.doesNotMatch(harness.element("#detail-content").textContent, /Sensitive earlier text/);
		assert.equal(harness.state().inspectorRenders, 2);
		assert.equal(harness.element("#detail-update").hidden, true);
	}
	const harness = viewerHarness();
	harness.apply(viewerPayload([originalItem]));
	harness.selectDetail(originalItem.id);
	harness.apply(viewerPayload([]));
	assert.equal(harness.state().selection, null);
	assert.equal(harness.element("#detail-content").textContent, "");
});

test("frozen capture replay remains distinct from live arrivals and returns to the newest payload", () => {
	const harness = viewerHarness();
	const archive = viewerArchive([{ id: "capture-old", item: viewerItem("Old captured body") }]);
	const initial = { ...viewerPayload([viewerItem("Current live body")]), captures: archive };
	harness.apply(initial);
	harness.showCapture("capture-old");
	const frozen = harness.state().frozen!;
	assert.strictEqual(harness.state().current, frozen.state);
	assert.strictEqual(harness.state().live, initial);
	harness.selectDetail("message-1");
	assert.match(harness.element("#detail-content").textContent, /Old captured body/);
	const next = { ...viewerPayload([viewerItem("Newest live body")]), captures: viewerArchive([{ id: "capture-new", item: viewerItem("Newest live body") }]) };
	const renders = harness.state().inspectorRenders;
	const reconciliations = harness.state().reconciliations;
	harness.apply(next);
	assert.strictEqual(harness.state().live, next);
	assert.strictEqual(harness.state().current, frozen.state);
	assert.strictEqual(harness.state().frozen?.archive, archive);
	assert.equal(harness.state().inspectorRenders, renders);
	assert.equal(harness.state().reconciliations, reconciliations);
	assert.match(harness.element("#capture-label").textContent, /newer capture available/);
	assert.ok(harness.element("#capture-select").children.some((option) => option.value === "capture-old" && option.textContent.includes("held view")));
	harness.setMode("overview");
	assert.strictEqual(harness.state().live, next, "re-applying a frozen state for a mode change must not overwrite the newer live state");
	harness.showCapture("live");
	assert.equal(harness.state().frozen, null);
	assert.strictEqual(harness.state().current, next);
	harness.selectDetail("message-1");
	assert.match(harness.element("#detail-content").textContent, /Newest live body/);
});

test("byte-limited captures display an unavailable empty scene without borrowing live content", () => {
	const harness = viewerHarness();
	const archive = viewerArchive([{ id: "too-large", item: viewerItem("Must not appear") }]);
	archive.entries[0] = { ...archive.entries[0]!, snapshot: { createdAt: 1, items: [] }, itemRefs: [], contentStatus: "omitted", omittedReason: "byte-limit" };
	archive.versions = [];
	harness.apply({ ...viewerPayload([viewerItem("Live-only text")]), captures: archive });
	harness.showCapture("too-large");
	assert.deepEqual(harness.state().current?.timeline?.history, []);
	assert.match(harness.element("#empty-state").textContent, /Capture content unavailable.*byte limit/);
	assert.equal(harness.element("#changes-open").disabled, true);
	assert.notStrictEqual(harness.state().current, harness.state().live);
});

test("capture controls refresh when an archive is replaced with the same numeric revision", () => {
	const harness = viewerHarness();
	const first = viewerArchive([{ id: "archive-a", item: viewerItem("A") }]);
	const payload = { ...viewerPayload([viewerItem("Live")]), captures: first };
	harness.apply(payload);
	const options = harness.element("#capture-select");
	const builds = options.replacements;
	harness.apply({ ...payload, phase: "tool" });
	assert.equal(options.replacements, builds);
	const second = viewerArchive([{ id: "archive-b", item: viewerItem("B") }]);
	assert.equal(second.revision, first.revision);
	harness.apply({ ...payload, captures: second });
	assert.equal(options.replacements, builds + 1);
	assert.deepEqual(options.children.map(({ value }) => value), ["live", "archive-b"]);
});

test("Hub removal clears live and frozen captures and stale capture controls cannot reopen them", () => {
	const harness = viewerHarness();
	const payload = { ...viewerPayload([viewerItem("Removed session text")]), captures: viewerArchive([{ id: "removed-capture", item: viewerItem("Removed captured text") }]) };
	harness.apply(payload);
	harness.showCapture("removed-capture");
	harness.selectDetail("message-1");
	harness.applyHub({ type: "bootstrap", states: [], sessions: [] });
	assert.equal(harness.state().selectedStreamId, null);
	assert.equal(harness.state().selection, null);
	assert.equal(harness.state().current, null);
	assert.equal(harness.state().live, null);
	assert.equal(harness.state().frozen, null);
	assert.equal(harness.state().chrome?.phase, "idle");
	assert.equal(harness.element("#detail-content").textContent, "");
	assert.equal(harness.element("#capture-select").disabled, true);
	assert.deepEqual(harness.element("#capture-select").children.map(({ value }) => value), ["live"]);
	const clears = harness.state().clears;
	harness.showCapture("removed-capture");
	harness.showCapture("live");
	assert.equal(harness.state().clears, clears);
	assert.equal(harness.state().current, null);
});

test("capture selection also rejects a session removed before the next viewer cleanup", () => {
	const harness = viewerHarness();
	const payload = { ...viewerPayload([viewerItem("Live")]), captures: viewerArchive([{ id: "old", item: viewerItem("Archived") }]) };
	harness.apply(payload);
	harness.removeSelectedSession();
	harness.showCapture("old");
	assert.equal(harness.state().frozen, null);
	assert.strictEqual(harness.state().current, payload);
	assert.equal(harness.state().clears, 0);
});
