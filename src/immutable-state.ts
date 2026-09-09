import type { RenderState } from "./render.ts";

const verifiedFrozen = new WeakSet<object>();

function plainObject(value: object): boolean {
	const prototype = Object.getPrototypeOf(value);
	return Array.isArray(value) || prototype === Object.prototype || prototype === null;
}

/** Frozen roots alone are not a trust boundary: externally supplied nested
 * objects, accessors, Maps, and Dates must not become shared mutable state.
 */
export function isDeeplyFrozen(value: unknown): boolean {
	if (typeof value === "function") return false;
	if (!value || typeof value !== "object") return true;
	if (verifiedFrozen.has(value)) return true;
	const checked = new Set<object>();
	const visit = (entry: unknown): boolean => {
		if (typeof entry === "function") return false;
		if (!entry || typeof entry !== "object" || verifiedFrozen.has(entry) || checked.has(entry)) return true;
		if (!plainObject(entry) || !Object.isFrozen(entry)) return false;
		checked.add(entry);
		const descriptors = Object.getOwnPropertyDescriptors(entry);
		return Reflect.ownKeys(descriptors).every((key) => {
			const descriptor = descriptors[key as keyof typeof descriptors]!;
			return "value" in descriptor && visit(descriptor.value);
		});
	};
	if (!visit(value)) return false;
	// Cache only after the entire graph passes; caching a cycle's child before
	// checking the parent's remaining fields could incorrectly trust that child.
	for (const entry of checked) verifiedFrozen.add(entry);
	return true;
}

/** Use only for fresh producer-owned JSON object/array shells. Strings are
 * already immutable and are deliberately not serialized or copied.
 */
export function freezeJson<T>(value: T): T {
	if (!value || typeof value !== "object" || verifiedFrozen.has(value)) return value;
	const visited = new Set<object>();
	const freeze = (entry: unknown): void => {
		if (!entry || typeof entry !== "object" || verifiedFrozen.has(entry) || visited.has(entry) || !plainObject(entry)) return;
		visited.add(entry);
		const descriptors = Object.getOwnPropertyDescriptors(entry);
		for (const key of Reflect.ownKeys(descriptors)) {
			const descriptor = descriptors[key as keyof typeof descriptors]!;
			if ("value" in descriptor) freeze(descriptor.value);
		}
		Object.freeze(entry);
	};
	freeze(value);
	isDeeplyFrozen(value);
	return value;
}

export function immutableCopy<T>(value: T): T {
	return isDeeplyFrozen(value) ? value : freezeJson(structuredClone(value));
}

/** Compare JSON-shaped data without materializing serialized heavy bodies. */
export function sameJsonValue(left: unknown, right: unknown): boolean {
	if (left === right) return true;
	if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
	if (Array.isArray(left) !== Array.isArray(right)) return false;
	const keys = Object.keys(left);
	if (keys.length !== Object.keys(right).length) return false;
	return keys.every((key) => Object.hasOwn(right, key) && sameJsonValue(
		(left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key],
	));
}

/** One defensive handoff for mutable callers; producer-owned immutable
 * snapshot/timeline/archive data stays shared across enqueue and drain.
 */
export function captureRenderStateForTransport(state: RenderState): RenderState {
	if (isDeeplyFrozen(state)) return state;
	return freezeJson({
		snapshot: state.snapshot ? immutableCopy(state.snapshot) : undefined,
		phase: state.phase,
		activeTools: immutableCopy(state.activeTools),
		...(state.timeline ? { timeline: immutableCopy(state.timeline) } : {}),
		...(state.captures ? { captures: immutableCopy(state.captures) } : {}),
	});
}
