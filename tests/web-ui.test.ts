import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const html = readFileSync(new URL("../web/index.html", import.meta.url), "utf8");
const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];

assert.ok(script, "web/index.html must contain an inline script");

test("long-history zoom and responsive layout share safe boundaries", () => {
	const minimumScale = Number(script.match(/const MIN_CAMERA_SCALE = ([\d.]+);/)?.[1]);
	assert.ok(minimumScale > 0 && minimumScale <= 0.012);
	assert.equal(script.match(/Math\.max\(MIN_CAMERA_SCALE/g)?.length, 3);
	assert.match(html, /@media \(max-width: 720px\)/);
	assert.match(script, /return innerWidth <= MOBILE_BREAKPOINT;/);
	assert.doesNotMatch(script, /innerWidth\s*<\s*720/);
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
	assert.match(script, /if \(event\.key === "Escape" && detailSelection\) closeDetail\(\)/);
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
	assert.match(script, /detailSelection = \{ streamId: selectedStreamId, itemId: node\.key \};/);
	assert.match(script, /if \(detailSelection && !sessionStates\.has\(detailSelection\.streamId\)\) closeDetail\(\);/);
	assert.match(script, /function closeDetail\(\) \{[\s\S]*?detailContent\.replaceChildren\(\);[\s\S]*?\n\}/);
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
