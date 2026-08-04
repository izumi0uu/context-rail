export interface CameraPoint {
	x: number;
	y: number;
}

export interface CameraState extends CameraPoint {
	scale: number;
}

export interface CameraBounds extends CameraPoint {
	width: number;
	height: number;
}

export interface CameraViewport {
	width: number;
	height: number;
}

const WHEEL_LINE_PIXELS = 16;
const MAX_WHEEL_DELTA_PIXELS = 240;
const INTERACTIVE_FIT_SCALE_RATIO = 0.25;

function clamp(value: number, minimum: number, maximum: number): number {
	return Math.min(maximum, Math.max(minimum, value));
}

export function normalizeWheelDelta(
	delta: number,
	deltaMode: number,
	viewportHeight: number,
): number {
	if (!Number.isFinite(delta)) return 0;
	const pagePixels = Number.isFinite(viewportHeight) && viewportHeight > 0
		? viewportHeight
		: 1;
	const unit = deltaMode === 1
		? WHEEL_LINE_PIXELS
		: deltaMode === 2
			? pagePixels
			: 1;
	return clamp(delta * unit, -MAX_WHEEL_DELTA_PIXELS, MAX_WHEEL_DELTA_PIXELS);
}

export function interactiveMinimumScale(
	fitScale: number,
	absoluteMinimum: number,
): number {
	const minimum = Number.isFinite(absoluteMinimum) && absoluteMinimum > 0
		? absoluteMinimum
		: Number.EPSILON;
	return Number.isFinite(fitScale) && fitScale > 0
		? Math.max(minimum, fitScale * INTERACTIVE_FIT_SCALE_RATIO)
		: minimum;
}

export function clampInteractiveScale(
	currentScale: number,
	requestedScale: number,
	minimumScale: number,
	maximumScale: number,
): number {
	if (!Number.isFinite(currentScale) || currentScale <= 0) return currentScale;
	if (!Number.isFinite(requestedScale) || requestedScale <= 0) return currentScale;
	const floor = Number.isFinite(minimumScale) && minimumScale > 0
		? Math.min(currentScale, minimumScale)
		: currentScale;
	const ceiling = Number.isFinite(maximumScale) && maximumScale > 0
		? Math.max(currentScale, maximumScale)
		: currentScale;
	return clamp(requestedScale, floor, ceiling);
}

export function wheelZoomScale(
	currentScale: number,
	normalizedDelta: number,
	sensitivity: number,
	minimumScale: number,
	maximumScale: number,
): number {
	if (!Number.isFinite(currentScale) || currentScale <= 0) return currentScale;
	if (!Number.isFinite(normalizedDelta) || normalizedDelta === 0) return currentScale;
	if (!Number.isFinite(sensitivity) || sensitivity <= 0) return currentScale;
	return clampInteractiveScale(
		currentScale,
		currentScale * Math.exp(-normalizedDelta * sensitivity),
		minimumScale,
		maximumScale,
	);
}

export function constrainCameraToBounds(
	camera: CameraState,
	bounds: CameraBounds,
	viewport: CameraViewport,
	minimumVisiblePixels = 48,
): CameraState {
	if (
		!Number.isFinite(camera.x) ||
		!Number.isFinite(camera.y) ||
		!Number.isFinite(camera.scale) ||
		camera.scale <= 0 ||
		!Number.isFinite(bounds.x) ||
		!Number.isFinite(bounds.y) ||
		!Number.isFinite(bounds.width) ||
		!Number.isFinite(bounds.height) ||
		bounds.width <= 0 ||
		bounds.height <= 0 ||
		!Number.isFinite(viewport.width) ||
		!Number.isFinite(viewport.height) ||
		viewport.width <= 0 ||
		viewport.height <= 0
	) return { ...camera };

	const halfWidth = viewport.width / (2 * camera.scale);
	const halfHeight = viewport.height / (2 * camera.scale);
	const requestedVisible = Math.max(0, Number.isFinite(minimumVisiblePixels) ? minimumVisiblePixels : 0);
	const visibleWidth = Math.min(bounds.width, requestedVisible / camera.scale);
	const visibleHeight = Math.min(bounds.height, requestedVisible / camera.scale);
	return {
		x: clamp(
			camera.x,
			bounds.x - halfWidth + visibleWidth,
			bounds.x + bounds.width + halfWidth - visibleWidth,
		),
		y: clamp(
			camera.y,
			bounds.y - halfHeight + visibleHeight,
			bounds.y + bounds.height + halfHeight - visibleHeight,
		),
		scale: camera.scale,
	};
}

export function constrainCameraToContent(
	camera: CameraState,
	contentBounds: readonly CameraBounds[],
	viewport: CameraViewport,
	minimumVisiblePixels = 48,
): CameraState {
	if (
		!Number.isFinite(camera.x) ||
		!Number.isFinite(camera.y) ||
		!Number.isFinite(camera.scale) ||
		camera.scale <= 0 ||
		!Number.isFinite(viewport.width) ||
		!Number.isFinite(viewport.height) ||
		viewport.width <= 0 ||
		viewport.height <= 0
	) return { ...camera };

	const halfWidth = viewport.width / (2 * camera.scale);
	const halfHeight = viewport.height / (2 * camera.scale);
	const viewportLeft = camera.x - halfWidth;
	const viewportRight = camera.x + halfWidth;
	const viewportTop = camera.y - halfHeight;
	const viewportBottom = camera.y + halfHeight;
	const requestedVisible = Math.max(
		0,
		Number.isFinite(minimumVisiblePixels) ? minimumVisiblePixels / camera.scale : 0,
	);

	let nearest: CameraState | undefined;
	let nearestDistance = Number.POSITIVE_INFINITY;
	let validContentCount = 0;
	for (const bounds of contentBounds) {
		if (
			!Number.isFinite(bounds.x) ||
			!Number.isFinite(bounds.y) ||
			!Number.isFinite(bounds.width) ||
			!Number.isFinite(bounds.height) ||
			bounds.width <= 0 ||
			bounds.height <= 0
		) continue;
		validContentCount += 1;
		const overlapWidth = Math.max(
			0,
			Math.min(viewportRight, bounds.x + bounds.width) - Math.max(viewportLeft, bounds.x),
		);
		const overlapHeight = Math.max(
			0,
			Math.min(viewportBottom, bounds.y + bounds.height) - Math.max(viewportTop, bounds.y),
		);
		if (
			overlapWidth >= Math.min(bounds.width, requestedVisible) &&
			overlapHeight >= Math.min(bounds.height, requestedVisible)
		) return { ...camera };
		const candidate = constrainCameraToBounds(
			camera,
			bounds,
			viewport,
			minimumVisiblePixels,
		);
		const distance = (candidate.x - camera.x) ** 2 + (candidate.y - camera.y) ** 2;
		if (distance >= nearestDistance) continue;
		nearest = candidate;
		nearestDistance = distance;
	}
	if (validContentCount === 0) return { ...camera };
	return nearest ?? { ...camera };
}

export function screenPointToWorld(
	point: CameraPoint,
	camera: CameraState,
	viewportCenter: CameraPoint,
): CameraPoint {
	return {
		x: camera.x + (point.x - viewportCenter.x) / camera.scale,
		y: camera.y + (point.y - viewportCenter.y) / camera.scale,
	};
}

export function worldPointToScreen(
	point: CameraPoint,
	camera: CameraState,
	viewportCenter: CameraPoint,
): CameraPoint {
	return {
		x: viewportCenter.x + (point.x - camera.x) * camera.scale,
		y: viewportCenter.y + (point.y - camera.y) * camera.scale,
	};
}

export function cameraForScreenPoint(
	worldPoint: CameraPoint,
	screenPoint: CameraPoint,
	scale: number,
	viewportCenter: CameraPoint,
): CameraState {
	if (
		!Number.isFinite(worldPoint.x) ||
		!Number.isFinite(worldPoint.y) ||
		!Number.isFinite(screenPoint.x) ||
		!Number.isFinite(screenPoint.y) ||
		!Number.isFinite(scale) ||
		scale <= 0 ||
		!Number.isFinite(viewportCenter.x) ||
		!Number.isFinite(viewportCenter.y)
	) {
		throw new RangeError("Camera anchoring requires finite coordinates and a positive scale");
	}
	return {
		x: worldPoint.x - (screenPoint.x - viewportCenter.x) / scale,
		y: worldPoint.y - (screenPoint.y - viewportCenter.y) / scale,
		scale,
	};
}

export function cameraForPan(
	camera: CameraState,
	previousPointer: CameraPoint,
	nextPointer: CameraPoint,
): CameraState {
	if (
		!Number.isFinite(camera.x) ||
		!Number.isFinite(camera.y) ||
		!Number.isFinite(camera.scale) ||
		camera.scale <= 0 ||
		!Number.isFinite(previousPointer.x) ||
		!Number.isFinite(previousPointer.y) ||
		!Number.isFinite(nextPointer.x) ||
		!Number.isFinite(nextPointer.y)
	) return { ...camera };
	return {
		x: camera.x - (nextPointer.x - previousPointer.x) / camera.scale,
		y: camera.y - (nextPointer.y - previousPointer.y) / camera.scale,
		scale: camera.scale,
	};
}
