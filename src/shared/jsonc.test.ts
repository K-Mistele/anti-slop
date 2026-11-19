// oxlint-disable effecttsgo/global-console -- a test runner outside any Effect runtime
// Ported from eslint-plugin-ai-guard 1.4.7 (`tests/utils/jsonc.test.ts`, MIT); see `src/vendor/ai-guard/UPSTREAM.md`.
import assert from "node:assert/strict";

import { parseJsonc } from "./jsonc.ts";

const tests: Array<[string, () => void]> = [];
const test = (name: string, run: () => void): void => {
	tests.push([name, run]);
};

test("parses plain JSON", () => {
	assert.deepEqual(parseJsonc('{"a": [1, 2], "b": {"c": null}}'), { a: [1, 2], b: { c: null } });
});

test("strips line and block comments outside strings", () => {
	assert.deepEqual(parseJsonc('{\n  // note\n  "a": 1, /* inline */ "b": 2\n}'), { a: 1, b: 2 });
});

test("removes trailing commas in objects and arrays, including nested ones", () => {
	assert.deepEqual(parseJsonc('{ "a": [1, 2,], "b": { "c": 3, }, }'), { a: [1, 2], b: { c: 3 } });
	assert.deepEqual(parseJsonc("[1,\n  // last\n]"), [1]);
});

test("never alters string contents", () => {
	const value = { url: "http://x/*y*/", arg: "a,]", b: "c,}", path: "//not-a-comment" };
	assert.deepEqual(parseJsonc(JSON.stringify(value)), value);
});

test("keeps escaped quotes inside strings", () => {
	assert.deepEqual(parseJsonc('{ "a": "say \\"hi\\", ok", }'), { a: 'say "hi", ok' });
});

test("accepts a byte-order mark", () => {
	assert.deepEqual(parseJsonc(`${String.fromCharCode(0xfeff)}{"a": 1}`), { a: 1 });
});

test("throws on invalid JSON", () => {
	assert.throws(() => parseJsonc('{ "a": }'));
});

let failed = 0;
for (const [name, run] of tests) {
	try {
		run();
		console.log(`ok - ${name}`);
	} catch (error) {
		failed += 1;
		console.error(`not ok - ${name}`);
		console.error(error);
	}
}
if (failed > 0) process.exit(1);
