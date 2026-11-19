// oxlint-disable effecttsgo/global-console -- a test runner outside any Effect runtime
// The test declarations and assertions integrity analysis reads from a source file.
import assert from "node:assert/strict";

import { activeTests, analyzeJs, type JsFacts } from "./js-facts.ts";

const tests: Array<[string, () => void]> = [];
const test = (name: string, run: () => void): void => {
	tests.push([name, run]);
};

function facts(code: string, file = "src/user.test.ts"): JsFacts {
	const outcome = analyzeJs(code, file);
	if (!outcome.ok) assert.fail(outcome.error);
	return outcome.facts;
}

/** Each declaration as `kind path [flags]`, in source order. */
const declarations = (source: JsFacts): string[] =>
	source.tests.map((decl) => {
		const flags = (["skipped", "focused", "todo", "conditional", "parameterized"] as const).filter((flag) => decl[flag]);
		return `${decl.kind} ${decl.path}${flags.length === 0 ? "" : ` [${flags.join(", ")}]`}`;
	});

const EFFECT_IMPORTS = 'import { assert, expect, it, layer } from "@effect/vitest";\nimport { Effect } from "effect";\n';

test("counts plain Vitest tests and their assertions", () => {
	const source = facts(`describe("cart", () => {\n  it("adds", () => { expect(add(1, 2)).toBe(3); assert.strictEqual(add(0, 0), 0); });\n  it.skip("removes", () => {});\n});\n`);
	assert.deepEqual(declarations(source), ["suite cart", "test cart > adds", "test cart > removes [skipped]"]);
	assert.deepEqual(source.assertions, { total: 2, strict: 2, loose: 0 });
});

test("it.effect, it.scoped, it.live and it.scopedLive declare tests", () => {
	const source = facts(
		`${EFFECT_IMPORTS}describe("user", () => {\n${["effect", "scoped", "live", "scopedLive"]
			.map((variant) => `  it.${variant}("${variant}", () => Effect.gen(function* () { assert.strictEqual(yield* load(), 1); }));`)
			.join("\n")}\n});\n`,
	);
	assert.deepEqual(declarations(source), ["suite user", "test user > effect", "test user > scoped", "test user > live", "test user > scopedLive"]);
	assert.equal(activeTests(source).length, 4);
	assert.deepEqual(source.assertions, { total: 4, strict: 4, loose: 0 });
});

test("Effect test variants combine with skip, only, fails, each, skipIf and runIf", () => {
	const source = facts(
		[
			EFFECT_IMPORTS,
			'it.effect.skip("skipped", () => Effect.void);',
			'it.live.only("focused", () => Effect.void);',
			'it.effect.fails("fails", () => Effect.fail("x"));',
			'it.effect.each([1, 2])("handles %i", (n) => Effect.sync(() => expect(n).toBeGreaterThan(0)));',
			'it.scoped.skipIf(process.env.CI)("locally", () => Effect.void);',
			'it.live.runIf(process.env.CI)("in CI", () => Effect.void);',
		].join("\n"),
	);
	assert.deepEqual(declarations(source), [
		"test skipped [skipped]",
		"test focused [focused]",
		"test fails",
		"test handles %i [parameterized]",
		"test locally [conditional]",
		"test in CI [conditional]",
	]);
});

test("it.prop and it.effect.prop declare property tests", () => {
	const source = facts(
		[
			EFFECT_IMPORTS,
			'it.prop("round-trips", [Schema.Number], ([n]) => { expect(decode(encode(n))).toBe(n); });',
			'it.effect.prop("decodes", [Schema.Number], ([n]) => Effect.gen(function* () { expect(yield* decode(n)).toBe(n); }));',
		].join("\n"),
	);
	assert.deepEqual(declarations(source), ["test round-trips", "test decodes"]);
	assert.equal(activeTests(source).length, 2);
});

test("a named layer block is a suite, an anonymous one adds no title, and it.flakyTest is not a test", () => {
	const source = facts(
		[
			EFFECT_IMPORTS,
			'layer(Database.layer)("repository", (it) => {',
			'  it.effect("saves", () => Effect.gen(function* () { assert.isTrue(yield* save()); }));',
			'  it.layer(Cache.layer)("cache", (it) => {',
			'    it.effect("hits", () => it.flakyTest(Effect.gen(function* () { assert.strictEqual(yield* hit(), 1); }), "5 seconds"));',
			"  });",
			'  it.layer(Clock.layer, { buildPerTest: true })((it) => {',
			'    it.effect("ticks", () => Effect.gen(function* () { assert.deepStrictEqual(yield* tick(), [1]); }));',
			"  });",
			"});",
			'layer(NodeServices.layer)((it) => {',
			'  it.live.skip("reads", () => Effect.void);',
			"});",
		].join("\n"),
	);
	assert.deepEqual(declarations(source), [
		"suite repository",
		"test repository > saves",
		"suite repository > cache",
		"test repository > cache > hits",
		"test repository > ticks",
		"test reads [skipped]",
	]);
	assert.deepEqual(source.assertions, { total: 3, strict: 2, loose: 1 });
});

test("a skipped layer block skips its tests", () => {
	const source = facts(`${EFFECT_IMPORTS}describe.skip("off", () => {\n  layer(Database.layer)("repository", (it) => {\n    it.effect("saves", () => Effect.void);\n  });\n});\n`);
	assert.deepEqual(
		source.tests.map((decl) => [decl.path, decl.effectiveSkipped]),
		[
			["off", true],
			["off > repository", true],
			["off > repository > saves", true],
		],
	);
	assert.deepEqual(activeTests(source), []);
});

test("look-alikes are not tests", () => {
	const source = facts(`${EFFECT_IMPORTS}const program = Effect.gen(function* () {});\nlayer("x");\nit.effect;\nservice.effect("name", () => program);\nit.flakyTest(program);\n`);
	assert.deepEqual(declarations(source), []);
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
