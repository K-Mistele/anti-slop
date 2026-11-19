// Ported from eslint-plugin-ai-guard 1.4.7 (`tests/rules/no-assertionless-test.test.ts`, MIT); see `src/vendor/ai-guard/UPSTREAM.md`.
import { RuleTester } from "oxlint/plugins-dev";

import { noAssertionlessTestRule } from "./no-assertionless-test.ts";

const ruleTester = new RuleTester({ languageOptions: { sourceType: "module" } });
const tsRuleTester = new RuleTester({ languageOptions: { sourceType: "module", parserOptions: { lang: "ts" } } });

const testFile = "src/user.test.js";
const jsx = { languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } } } };

ruleTester.run("no-assertionless-test", noAssertionlessTestRule, {
	valid: [
		// Every common assertion style counts
		{ code: 'it("adds", () => { expect(add(1, 2)).toBe(3); });', filename: testFile },
		{ code: 'test("adds", async () => { await expect(load()).resolves.toEqual([]); });', filename: testFile },
		{ code: 'it("adds", () => { assert.equal(add(1, 2), 3); });', filename: testFile },
		{ code: 'import { strictEqual } from "node:assert"; test("adds", () => { strictEqual(add(1, 2), 3); });', filename: testFile },
		{ code: 'it("adds", () => { add(1, 2).should.equal(3); });', filename: testFile },
		{ code: 'it("calls", () => { run(spy); sinon.assert.calledOnce(spy); });', filename: testFile },
		{ code: 'test("adds", (t) => { t.is(add(1, 2), 3); });', filename: testFile },
		{ code: 'test("adds", (t) => { t.assert.strictEqual(add(1, 2), 3); });', filename: testFile },
		{ code: 'it("waits", async () => { await waitFor(() => expect(spy).toHaveBeenCalled()); });', filename: testFile },
		{ code: 'it("has assertions", () => { expect.assertions(1); return load().then((u) => expect(u).toBeTruthy()); });', filename: testFile },
		// supertest
		{ code: 'it("GET /health", () => request(app).get("/health").expect(200));', filename: testFile },
		// Testing Library queries throw when the element is missing
		{ code: 'it("shows the title", () => { render(<App />); screen.getByText("Welcome"); });', filename: "src/App.test.jsx", ...jsx },
		{ code: 'it("shows the title", () => { const { getByRole } = render(<App />); getByRole("heading"); });', filename: "src/App.test.jsx", ...jsx },
		// Cypress
		{ code: 'it("logs in", () => { cy.visit("/login"); cy.get("#user").type("a"); });', filename: "cypress/e2e/login.cy.js" },
		// Manual checks that throw
		{ code: 'it("parses", () => { const r = parse("1"); if (r !== 1) throw new Error("bad"); });', filename: testFile },
		// Local helpers that assert, including helpers calling helpers
		{ code: 'function expectValid(u) { expect(u.id).toBeDefined(); }\nit("creates", () => { expectValid(create()); });', filename: testFile },
		{ code: 'const check = (u) => { expect(u.ok).toBe(true); };\nconst run = (x) => check(load(x));\nit("loads", () => { run(1); });', filename: testFile },
		{ code: 'it("loads", () => { assertValidUser(load()); });', filename: testFile },
		// Smoke tests that say so in the title
		{ code: 'it("renders without crashing", () => { render(<App />); });', filename: "src/App.test.jsx", ...jsx },
		{ code: 'it("does not throw on empty input", () => { parse(""); });', filename: testFile },
		// Pending, skipped, and body-less tests
		{ code: 'it.todo("handles refunds");', filename: testFile },
		{ code: 'it("handles refunds");', filename: testFile },
		{ code: 'it.skip("flaky", () => { load(); });', filename: testFile },
		{ code: 'xit("flaky", () => { load(); });', filename: testFile },
		// Suites are not tests
		{ code: 'describe("user", () => { beforeEach(() => setup()); });', filename: testFile },
		// Playwright: actions auto-wait and fail on their own
		{ code: 'import { test } from "@playwright/test";\ntest("checkout", async ({ page }) => { await page.goto("/"); await page.click("text=Buy"); });', filename: "e2e/checkout.spec.ts" },
		// Not a test file
		{ code: 'it("x", () => { run(); });', filename: "src/iterator.js" },
		// Mocha callback tests (shapes from expressjs/express): finishing is the assertion
		{ code: 'it("should inherit from event emitter", function (done) { var app = express(); app.on("foo", done); app.emit("foo"); });', filename: "test/app.js" },
		{ code: 'it("should wrap with an HTTP server", function (done) { var server = app.listen(0, function () { server.close(done); }); });', filename: "test/app.listen.js" },
		{ code: 'it("routes", function (done) { router.handle({ url: "/", method: "GET" }, { end: done }, function () {}); });', filename: "test/Router.js" },
		{ code: 'it("emits", (done) => { emitter.on("ready", () => { done(); }); emitter.start(); });', filename: testFile },
		// Helpers returned by other helpers (shape from vercel/swr): ensure*() asserts
		{ code: 'it("hydrates", async () => { const ensureAndUnmock = mockConsole(); await hydrate(); ensureAndUnmock(); });', filename: "test/ssr.test.tsx" },
	],
	invalid: [
		{
			code: 'it("creates a user", () => { const user = createUser("a"); });',
			filename: testFile,
			errors: [{ messageId: "noAssertions", data: { title: "creates a user" } }],
		},
		{
			code: 'test("works", () => {});',
			filename: testFile,
			errors: [{ messageId: "noAssertions", data: { title: "works" } }],
		},
		{
			code: 'describe("cart", () => {\n  it("adds items", async () => {\n    const cart = new Cart();\n    await cart.add({ id: 1 });\n  });\n});',
			filename: testFile,
			errors: [{ messageId: "noAssertions", data: { title: "adds items" }, line: 2 }],
		},
		{
			code: 'it("renders the user name", () => { render(<Profile name="Ana" />); });',
			filename: "src/Profile.test.jsx",
			...jsx,
			errors: [{ messageId: "noAssertions", data: { title: "renders the user name" } }],
		},
		{
			code: 'it.each([1, 2])("handles %i", (n) => { handle(n); });',
			filename: testFile,
			errors: [{ messageId: "noAssertions", data: { title: "handles %i" } }],
		},
		{
			code: 'test.only("focused", () => { compute(); });',
			filename: testFile,
			errors: [{ messageId: "noAssertions" }],
		},
		// A helper that does not assert does not count
		{
			code: 'function setup() { return mount(); }\nit("mounts", () => { setup(); });',
			filename: testFile,
			errors: [{ messageId: "noAssertions", data: { title: "mounts" } }],
		},
		// Logging the result is not asserting it
		{
			code: 'it("calculates tax", () => { const tax = calc(100); console.log(tax); });',
			filename: testFile,
			errors: [{ messageId: "noAssertions" }],
		},
		{
			code: 'test("options form", { timeout: 1000 }, () => { compute(); });',
			filename: testFile,
			errors: [{ messageId: "noAssertions", data: { title: "options form" } }],
		},
		// A synchronous done() at the end asserts nothing
		{
			code: 'it("computes", (done) => { compute(); done(); });',
			filename: testFile,
			errors: [{ messageId: "noAssertions", data: { title: "computes" } }],
		},
	],
});

tsRuleTester.run("no-assertionless-test (TypeScript)", noAssertionlessTestRule, {
	valid: [
		{ code: 'import { expect, test } from "vitest";\ntest("typed", () => { expect(parse("1") as number).toBe(1); });', filename: "src/parse.test.ts" },
	],
	invalid: [
		{
			code: 'import { test } from "vitest";\ntest("typed", async (): Promise<void> => { await load(); });',
			filename: "src/load.test.ts",
			errors: [{ messageId: "noAssertions", data: { title: "typed" } }],
		},
	],
});

// @effect/vitest: `it.effect` and its variants register tests whose body is an Effect, and `assert` from
// @effect/vitest asserts.
const effectTestFile = "src/user.test.ts";
const effectImports = 'import { assert, it, layer } from "@effect/vitest";\nimport { Effect } from "effect";\n';

tsRuleTester.run("no-assertionless-test (@effect/vitest)", noAssertionlessTestRule, {
	valid: [
		{ code: `${effectImports}it.effect("adds", () => Effect.gen(function* () { assert.strictEqual(yield* add(1, 2), 3); }));`, filename: effectTestFile },
		{ code: `${effectImports}it.live("reads", () => Effect.gen(function* () { const user = yield* load(); assert.deepStrictEqual(user, { id: 1 }); }));`, filename: effectTestFile },
		{ code: 'import { assert as check, it } from "@effect/vitest";\nit.effect("adds", () => Effect.gen(function* () { check.strictEqual(yield* add(1, 2), 3); }));', filename: effectTestFile },
		{ code: 'import { it } from "@effect/vitest";\nimport { deepStrictEqual } from "@effect/vitest/utils";\nit.effect("adds", () => Effect.gen(function* () { deepStrictEqual(yield* add(1, 2), 3); }));', filename: effectTestFile },
		{ code: `${effectImports}it.effect("retries", () => it.flakyTest(Effect.gen(function* () { assert.isTrue(yield* ready()); }), "5 seconds"));`, filename: effectTestFile },
		{ code: `${effectImports}it.effect.skip("flaky", () => Effect.gen(function* () { yield* load(); }));`, filename: effectTestFile },
		{ code: `${effectImports}it.prop("round-trips", [Schema.Number], ([n]) => decode(encode(n)) === n);`, filename: effectTestFile },
		{ code: `${effectImports}it.prop("round-trips", [Schema.Number], ([n]) => { return !Number.isNaN(decode(encode(n))); });`, filename: effectTestFile },
		{ code: `${effectImports}it.effect.prop("round-trips", [Schema.Number], ([n]) => Effect.gen(function* () { expect(yield* decode(n)).toBe(n); }));`, filename: effectTestFile },
	],
	invalid: [
		{
			code: `${effectImports}it.effect("creates a user", () => Effect.gen(function* () { yield* createUser("a"); }));`,
			filename: effectTestFile,
			errors: [{ messageId: "noAssertions", data: { title: "creates a user" } }],
		},
		...["scoped", "live", "scopedLive"].map((variant) => ({
			code: `${effectImports}it.${variant}("opens", () => Effect.gen(function* () { yield* open(); }));`,
			filename: effectTestFile,
			errors: [{ messageId: "noAssertions", data: { title: "opens" } }],
		})),
		...["only", "fails"].map((modifier) => ({
			code: `${effectImports}it.effect.${modifier}("opens", () => Effect.gen(function* () { yield* open(); }));`,
			filename: effectTestFile,
			errors: [{ messageId: "noAssertions", data: { title: "opens" } }],
		})),
		{
			code: `${effectImports}it.effect.each([1, 2])("handles %i", (n) => Effect.gen(function* () { yield* handle(n); }));`,
			filename: effectTestFile,
			errors: [{ messageId: "noAssertions", data: { title: "handles %i" } }],
		},
		{
			code: `${effectImports}it.effect.skipIf(false)("runs", () => Effect.gen(function* () { yield* run(); }));`,
			filename: effectTestFile,
			errors: [{ messageId: "noAssertions", data: { title: "runs" } }],
		},
		{
			code: `${effectImports}it.effect("retries", () => it.flakyTest(Effect.gen(function* () { yield* ready(); }), "5 seconds"));`,
			filename: effectTestFile,
			errors: [{ messageId: "noAssertions", data: { title: "retries" } }],
		},
		{
			code: `${effectImports}it.prop("decodes", [Schema.Number], ([n]) => { decode(encode(n)); });`,
			filename: effectTestFile,
			errors: [{ messageId: "noAssertions", data: { title: "decodes" } }],
		},
		// An Effect is not a falsifiable result: only a returned boolean check asserts in a property test.
		{
			code: `${effectImports}it.effect.prop("decodes", [Schema.Number], ([n]) => Effect.gen(function* () { yield* decode(n); }));`,
			filename: effectTestFile,
			errors: [{ messageId: "noAssertions", data: { title: "decodes" } }],
		},
		{
			code: `${effectImports}layer(Database.layer)("repository", (it) => {\n  it.effect("saves", () => Effect.gen(function* () { yield* save(); }));\n  it.layer(Cache.layer)((it) => {\n    it.effect("caches", () => Effect.gen(function* () { yield* cache(); }));\n  });\n});`,
			filename: effectTestFile,
			errors: [
				{ messageId: "noAssertions", data: { title: "saves" }, line: 4 },
				{ messageId: "noAssertions", data: { title: "caches" }, line: 6 },
			],
		},
	],
});
