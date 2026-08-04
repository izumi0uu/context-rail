import assert from "node:assert/strict";
import test from "node:test";
import {
	clampInteractiveScale,
	cameraForScreenPoint,
	cameraForPan,
	constrainCameraToBounds,
	constrainCameraToContent,
	interactiveMinimumScale,
	normalizeWheelDelta,
	screenPointToWorld,
	wheelZoomScale,
	worldPointToScreen,
} from "../web/src/camera.ts";

test("camera coordinates round-trip around the graph viewport center", () => {
	const camera = { x: 2_860, y: 620, scale: 0.73 };
	const viewportCenter = { x: 640, y: 392 };
	const screen = { x: 183, y: 611 };
	const world = screenPointToWorld(screen, camera, viewportCenter);
	const roundTrip = worldPointToScreen(world, camera, viewportCenter);

	assert.ok(Math.abs(roundTrip.x - screen.x) < 1e-9);
	assert.ok(Math.abs(roundTrip.y - screen.y) < 1e-9);
});

test("zooming around a cursor keeps its world point anchored", () => {
	const initialCamera = { x: 620, y: 620, scale: 0.42 };
	const viewportCenter = { x: 720, y: 418 };
	const cursor = { x: 1_108, y: 244 };
	const world = screenPointToWorld(cursor, initialCamera, viewportCenter);
	const zoomedCamera = cameraForScreenPoint(world, cursor, 1.16, viewportCenter);
	const anchored = worldPointToScreen(world, zoomedCamera, viewportCenter);

	assert.ok(Math.abs(anchored.x - cursor.x) < 1e-9);
	assert.ok(Math.abs(anchored.y - cursor.y) < 1e-9);
});

test("camera anchoring rejects every non-finite input and non-positive scale", () => {
	const validPoint = { x: 10, y: 20 };
	assert.throws(
		() => cameraForScreenPoint({ x: Number.NaN, y: 20 }, validPoint, 1, validPoint),
		/finite coordinates and a positive scale/,
	);
	assert.throws(
		() => cameraForScreenPoint(validPoint, { x: 10, y: Number.POSITIVE_INFINITY }, 1, validPoint),
		/finite coordinates and a positive scale/,
	);
	assert.throws(
		() => cameraForScreenPoint(validPoint, validPoint, 0, validPoint),
		/finite coordinates and a positive scale/,
	);
	assert.throws(
		() => cameraForScreenPoint(validPoint, validPoint, 1, { x: Number.NEGATIVE_INFINITY, y: 20 }),
		/finite coordinates and a positive scale/,
	);
});

test("wheel deltas use one bounded pixel scale across trackpads, mice, and pages", () => {
	assert.equal(normalizeWheelDelta(32, 0, 800), 32);
	assert.equal(normalizeWheelDelta(3, 1, 800), 48);
	assert.equal(normalizeWheelDelta(0.5, 2, 800), 240);
	assert.equal(normalizeWheelDelta(-1, 2, 800), -240);
	assert.equal(normalizeWheelDelta(Number.NaN, 0, 800), 0);
});

test("interactive zoom cannot turn a readable fitted scene into subpixel dust", () => {
	assert.equal(interactiveMinimumScale(0.8, 0.004), 0.2);
	assert.equal(interactiveMinimumScale(0.008, 0.004), 0.004);
	assert.equal(interactiveMinimumScale(Number.NaN, 0.004), 0.004);
});

test("wheel-out never enlarges an epoch camera that starts below the natural-view floor", () => {
	const epochScale = 0.1;
	const naturalViewFloor = 0.25;
	assert.equal(
		wheelZoomScale(epochScale, 120, 0.0012, naturalViewFloor, 2.4),
		epochScale,
		"zooming out from a travelToEpoch scale must clamp in place, never jump up to the higher natural-view floor",
	);
	assert.ok(
		wheelZoomScale(epochScale, -120, 0.0012, naturalViewFloor, 2.4) > epochScale,
		"the same epoch camera must still zoom in",
	);
	assert.equal(wheelZoomScale(epochScale, 0, 0.0012, naturalViewFloor, 2.4), epochScale);
});

test("pinch-out never enlarges an epoch camera that starts below the natural-view floor", () => {
	const epochScale = 0.1;
	const naturalViewFloor = 0.25;
	assert.equal(clampInteractiveScale(epochScale, 0.08, naturalViewFloor, 2.4), epochScale);
	assert.equal(clampInteractiveScale(epochScale, 0.12, naturalViewFloor, 2.4), 0.12);
	assert.equal(clampInteractiveScale(0.8, 0.4, naturalViewFloor, 2.4), 0.4);
});

test("a free camera keeps a recoverable strip of the scene in view", () => {
	const bounds = { x: 100, y: 200, width: 600, height: 400 };
	const viewport = { width: 1_000, height: 700 };

	assert.deepEqual(
		constrainCameraToBounds(
			{ x: 1_000_000, y: -1_000_000, scale: 1 },
			bounds,
			viewport,
			48,
		),
		{ x: 1_152, y: -102, scale: 1 },
	);
	assert.deepEqual(
		constrainCameraToBounds(
			{ x: 420, y: 360, scale: 0.5 },
			bounds,
			viewport,
			48,
		),
		{ x: 420, y: 360, scale: 0.5 },
	);
});

test("scene recovery lands on occupied content instead of an empty bounds corner", () => {
	const viewport = { width: 400, height: 300 };
	const content = [
		{ x: 100, y: 400, width: 100, height: 80 },
		{ x: 500, y: 100, width: 100, height: 80 },
	];
	const aggregateBounds = { x: 100, y: 100, width: 500, height: 380 };
	const boundsOnly = constrainCameraToBounds(
		{ x: -10_000, y: -10_000, scale: 1 },
		aggregateBounds,
		viewport,
		48,
	);

	assert.deepEqual(boundsOnly, { x: -52, y: -2, scale: 1 });
	assert.deepEqual(
		constrainCameraToContent(boundsOnly, content, viewport, 48),
		{ x: -52, y: 298, scale: 1 },
	);
});

test("bounds-only reconciliation preserves intentional whitespace inside the scene", () => {
	const camera = { x: 350, y: 250, scale: 1 };
	const viewport = { width: 300, height: 240 };
	const worldBounds = { x: 0, y: 0, width: 700, height: 500 };
	const content = [
		{ x: 0, y: 0, width: 100, height: 80 },
		{ x: 600, y: 420, width: 100, height: 80 },
	];

	assert.deepEqual(constrainCameraToBounds(camera, worldBounds, viewport, 48), camera);
	assert.notDeepEqual(
		constrainCameraToContent(camera, content, viewport, 48),
		camera,
		"content recovery is deliberately stronger and must not run for an ordinary timeline append",
	);
});

test("resizing an edge camera re-establishes visible overlap with real content", () => {
	const content = [{ x: 100, y: 200, width: 100, height: 80 }];
	const wideViewport = { width: 1_000, height: 700 };
	const narrowViewport = { width: 400, height: 300 };
	const oldEdge = constrainCameraToContent(
		{ x: -10_000, y: -10_000, scale: 1 },
		content,
		wideViewport,
		48,
	);

	assert.deepEqual(oldEdge, { x: -352, y: -102, scale: 1 });
	assert.deepEqual(
		constrainCameraToContent(oldEdge, content, narrowViewport, 48),
		{ x: -52, y: 98, scale: 1 },
	);
});

test("incremental panning reverses immediately after a bounds clamp", () => {
	const viewport = { width: 1_000, height: 700 };
	const bounds = { x: 100, y: 200, width: 600, height: 400 };
	let camera = { x: 420, y: 360, scale: 1 };
	let pointer = { x: 500, y: 350 };

	camera = constrainCameraToBounds(
		cameraForPan(camera, pointer, { x: 2_000, y: 350 }),
		bounds,
		viewport,
		48,
	);
	pointer = { x: 2_000, y: 350 };
	const reversed = constrainCameraToBounds(
		cameraForPan(camera, pointer, { x: 1_980, y: 350 }),
		bounds,
		viewport,
		48,
	);

	assert.ok(reversed.x > camera.x, "a 20px reverse gesture must move the camera immediately");
});

test("scene recovery remains well-defined for tiny and invalid bounds", () => {
	assert.deepEqual(
		constrainCameraToBounds(
			{ x: 5_000, y: 5_000, scale: 2 },
			{ x: 100, y: 200, width: 12, height: 8 },
			{ width: 1_000, height: 700 },
			48,
		),
		{ x: 350, y: 375, scale: 2 },
	);
	assert.deepEqual(
		constrainCameraToBounds(
			{ x: 10, y: 20, scale: 0.5 },
			{ x: 0, y: 0, width: 0, height: 0 },
			{ width: 1_000, height: 700 },
			48,
		),
		{ x: 10, y: 20, scale: 0.5 },
	);
});
