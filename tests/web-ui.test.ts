import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const html = readFileSync(new URL("../web/index.html", import.meta.url), "utf8");
const coreSource = readFileSync(new URL("../web/src/scene-core.ts", import.meta.url), "utf8");
const pixiSource = readFileSync(new URL("../web/src/pixi-history.ts", import.meta.url), "utf8");
const packageJson = JSON.parse(
	readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as {
	files?: string[];
	scripts?: Record<string, string>;
	devDependencies?: Record<string, string>;
};
const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];

assert.ok(script, "web/index.html must contain an inline script");

test("long-history zoom and responsive layout share safe boundaries", () => {
	const minimumScale = Number(script.match(/const MIN_CAMERA_SCALE = ([\d.]+);/)?.[1]);
	assert.ok(minimumScale > 0 && minimumScale <= 0.012);
	assert.match(script, /const viewedBounds = viewedEpochIndex === null[\s\S]*?currentSceneLayout\?\.epochs\[viewedEpochIndex\]\?\.bounds;/);
	assert.match(script, /scale: fitScaleForBounds\(epoch\.bounds\)/);
	assert.match(script, /sceneEngine\.interactiveMinimumScale\(naturalFitScale, MIN_CAMERA_SCALE\)/);
	assert.match(script, /sceneEngine\.normalizeWheelDelta\(event\.deltaY, event\.deltaMode, viewportBounds\.height\)/);
	assert.match(html, /@media \(max-width: 720px\)/);
	assert.match(script, /return innerWidth <= MOBILE_BREAKPOINT;/);
	assert.doesNotMatch(script, /innerWidth\s*<\s*720/);
});

test("wheel zoom eases toward a constrained target without teleporting the rendered camera", () => {
	const wheelSource = script.slice(
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
	const wheelSource = script.slice(
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
	const pointerSource = script.slice(
		script.indexOf('viewport.addEventListener("pointerdown"'),
		script.indexOf('viewport.addEventListener("wheel"'),
	);
	assert.match(pointerSource, /sceneEngine\.clampInteractiveScale\(/);
	assert.doesNotMatch(
		pointerSource,
		/Math\.max\(interactiveScaleFloor\(\), pinch\.scale \* distance \/ pinch\.distance\)/,
	);
});

test("zero-delta wheel events leave automatic camera following untouched", () => {
	const wheelSource = script.slice(
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
	const pointerSource = script.slice(
		script.indexOf('viewport.addEventListener("pointerdown"'),
		script.indexOf('viewport.addEventListener("wheel"'),
	);
	assert.match(pointerSource, /sceneEngine\.cameraForPan\(\s*camera,[\s\S]*?\{ x: pan\.x, y: pan\.y \},[\s\S]*?\{ x: event\.clientX, y: event\.clientY \}/);
	assert.match(pointerSource, /pan\.x = event\.clientX;[\s\S]*?pan\.y = event\.clientY;/);
	assert.doesNotMatch(pointerSource, /cameraX: camera\.x|cameraY: camera\.y/);
});

test("an ordinary timeline append preserves a free camera parked in internal whitespace", () => {
	const updateBoundsSource = script.slice(
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
	const resizeSource = script.slice(
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
	const clearGraphSource = script.slice(
		script.indexOf("function clearGraph"),
		script.indexOf("function syncModeChrome"),
	);
	const updateBoundsSource = script.slice(
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
		/clip-path: inset\(var\(--graph-clip-top, 0px\) 0 var\(--graph-clip-bottom, 0px\) 0\)/,
	);
	assert.match(script, /let graphViewportBounds = null;/);
	assert.match(
		script,
		/function graphViewport\(\) \{\s*if \(!graphViewportBounds\) syncGraphViewport\(\);\s*return graphViewportBounds;\s*\}/,
	);
	assert.match(script, /new ResizeObserver\(\(\) => \{[\s\S]*?syncGraphViewport\(\)[\s\S]*?fitView\(false\)[\s\S]*?markCameraDirty\(\)/);
	const renderFrameSource = script.slice(
		script.indexOf("function renderFrame"),
		script.indexOf("function attachNodeInteraction"),
	);
	assert.doesNotMatch(renderFrameSource, /getBoundingClientRect|style\.setProperty/);
});

test("short landscape uses a readable five-column compact rail", () => {
	const functionSource = script.match(
		/function shortLandscapeColumns\(viewportWidth, viewportHeight, itemCount\) \{[\s\S]*?\n\}/,
	)?.[0];
	assert.ok(functionSource);
	const shortLandscapeColumns = Function(`"use strict"; return (${functionSource});`)() as (
		viewportWidth: number,
		viewportHeight: number,
		itemCount: number,
	) => number;

	assert.equal(shortLandscapeColumns(568, 320, 11), 5);
	assert.equal(shortLandscapeColumns(390, 844, 11), 0);
	assert.equal(shortLandscapeColumns(721, 400, 3), 3);
	assert.match(html, /@media \(max-height: 420px\) and \(orientation: landscape\)/);
	assert.match(script, /isShortLandscapeLayout\(\) \? innerHeight : toolbar\.getBoundingClientRect\(\)\.top/);
});

test("graph items do not create one keyboard control per history item", () => {
	assert.match(
		script,
		/function createNode[\s\S]*?document\.createElement\("div"\)[\s\S]*?element\.className = "node";/,
	);
	assert.doesNotMatch(script, /document\.createElement\("article"\)/);
	assert.doesNotMatch(script, /node\.element\.tabIndex|element\.tabIndex/);
	assert.match(script, /tab\.tabIndex = summary\.streamId === selectedStreamId \? 0 : -1;/);
});

test("card details open without treating drag gestures as clicks and render content as text", () => {
	assert.match(html, /id="detail-panel" role="dialog"/);
	assert.match(script, /drag\.moved = true/);
	assert.match(script, /const shouldOpen = Boolean\(open && drag\?\.canOpen && !drag\.moved\)/);
	assert.match(script, /if \(shouldOpen\) openDetail\(node\)/);
	const detailSource = script.slice(
		script.indexOf("function appendDetailBlock"),
		script.indexOf("const touches = new Map"),
	);
	assert.match(detailSource, /text\.textContent = block\.text/);
	assert.match(detailSource, /text\.textContent = prettyJson\(block\.argumentsJson\)/);
	assert.doesNotMatch(detailSource, /innerHTML|insertAdjacentHTML|document\.write/);
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
	const currentDetailSource = script.slice(
		script.indexOf("function currentDetailItem"),
		script.indexOf("function detailState"),
	);
	assert.match(currentDetailSource, /detailSelectionMatches\(detailSelection, selectedStreamId/);
	assert.match(
		script,
		/function openDetailById\(itemId\) \{[\s\S]*?detailSelection = \{ streamId: selectedStreamId, itemId \};[\s\S]*?\n\}/,
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
	const rendererBootstrap = script.slice(
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

	const reconciliation = script.slice(
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
	assert.match(
		pixiSource,
		/Math\.floor\(bounds\.left \* camera\.scale \/ CULL_SIGNATURE_SCREEN_STEP\)/,
	);
	assert.match(pixiSource, /if \(!node\?\.drawCard \|\| !visibleNodeIds\.has\(id\)\) continue;/);
	assert.match(pixiSource, /canvas\.addEventListener\("webglcontextlost", handleContextLost\);/);
	assert.match(pixiSource, /canvas\.addEventListener\("webglcontextrestored", handleContextRestored\);/);
	assert.match(rendererBootstrap, /onError\(error\) \{[\s\S]*?enterHistoryRendererFallback\(error, true\);/);
	assert.match(pixiSource, /catch \(error\) \{[\s\S]*?callbacks\.onError\?\.\(error\);/);
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
	const drawCardsSource = pixiSource.slice(
		pixiSource.indexOf("const drawCards"),
		pixiSource.indexOf("const edgeIsDisplaced"),
	);
	assert.match(drawCardsSource, /if \(lod === "overview"\)[\s\S]*?drawOverviewClusters\(/);
	assert.match(
		drawCardsSource,
		/const useOverviewClusters = [\s\S]*?if \(useOverviewClusters\) \{[\s\S]*?drawOverviewClusters\(scene\.nodes\);[\s\S]*?\} else \{[\s\S]*?drawCardVisuals\(/,
		"extreme overview LOD must replace full card geometry instead of drawing both layers",
	);
	assert.match(pixiSource, /clusterCount: number;/);
	assert.match(pixiSource, /clusterCount,/);
});

test("Pixi resumes viewport culling immediately above the cluster-only zoom level", () => {
	const visibilitySource = pixiSource.slice(
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
		/const nextSignature = nextLod === "overview" && camera\.scale <= OVERVIEW_CLUSTER_MAX_SCALE[\s\S]*?Math\.floor\(bounds\.left \* camera\.scale \/ CULL_SIGNATURE_SCREEN_STEP\)/,
		"cluster LOD can stay world-anchored, while card LOD must invalidate culling as the camera pans",
	);
});

test("Pixi history hover never enters the DOM tooltip positioning path", () => {
	const renderFrameSource = script.slice(
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
	assert.match(script, /function travelToEpoch\(epochIndex\) \{[\s\S]*?cameraTarget = \{[\s\S]*?markCameraDirty\(\);/);
	assert.match(script, /function travelToHistory\(itemId\) \{[\s\S]*?travelToEpoch\(placement\.epoch\);/);
	assert.match(
		script,
		/if \(event\.key !== "ArrowLeft" && event\.key !== "ArrowRight"\) return;[\s\S]*?navigateScene\(event\.key === "ArrowRight" \? 1 : -1\)/,
	);
	assert.match(script, /viewedEpochIndex = saved\?\.viewedEpochIndex \?\? null;/);
});

test("the offline package contains and builds independent core and Pixi viewer assets", () => {
	assert.ok(packageJson.files?.includes("web"));
	assert.equal(packageJson.devDependencies?.["pixi.js"], "8.19.0");
	assert.equal(packageJson.devDependencies?.esbuild, "0.28.1");
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
	assert.match(script, /if \(historyUpserts\.length > 0\)/);
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
	assert.match(script, /if \(!delta\.complete\) return null;/);
});
