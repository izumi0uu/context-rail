import assert from "node:assert/strict";
import test from "node:test";
import { fitHistoryLabel } from "../web/src/pixi-history.ts";

const measure = (text: string): number => [...text].reduce((width, character) => width + (/^[\x00-\x7F]$/u.test(character) ? 7 : 14), 0);

test("history labels fit real width for long Latin and wide Unicode text", () => {
	for (const text of ["Inspect the extremely long workspace path", "上下文历史内容以及工具结果", "🌱🧑🏽‍💻 带表情的内容卡片"]) {
		const result = fitHistoryLabel(text, 80, measure);
		assert.ok(measure(result) <= 80);
		assert.ok(result.endsWith("…"));
		assert.ok(!/[\uD800-\uDBFF]…$/u.test(result));
	}
	assert.equal(fitHistoryLabel("Short", 80, measure), "Short");
	assert.equal(fitHistoryLabel("Long title", 4, measure), "");
});

test("history fitting bounds input and measurement work independently of message size", () => {
	let calls = 0, maxInput = 0;
	const result = fitHistoryLabel("x".repeat(1_000_000), 130, (text) => {
		calls += 1;
		maxInput = Math.max(maxInput, text.length);
		return measure(text);
	});
	assert.ok(measure(result) <= 130);
	assert.ok(calls <= 11);
	assert.ok(maxInput <= 257);
});
