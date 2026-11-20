// Ported from eslint-plugin-ai-guard 1.4.7 (`src/utils/test-patterns.ts`, MIT); see `src/vendor/ai-guard/UPSTREAM.md`.
// Recognition of test cases and assertions in JS/TS test files, shared by `no-assertionless-test` and
// `no-tautological-assertion`. Covers Jest, Vitest, Mocha, Jasmine, node:test, AVA/tap, Chai, should.js, Sinon,
// Testing Library and Cypress conventions.
import type { ESTree } from "@oxlint/plugins";

export type TestKind = "test" | "suite";
export type TestModifier = "skip" | "only" | "todo";
export type TestCallback = ESTree.Function | ESTree.ArrowFunctionExpression;

export interface TestCall {
	readonly kind: TestKind;
	readonly node: ESTree.CallExpression;
	/** Title as written: string value, template text, or identifier name. */
	readonly title: string;
	readonly modifiers: ReadonlySet<TestModifier>;
	readonly callback: TestCallback | null;
	/** A property test (@effect/vitest `it.prop`, `it.effect.prop`): returning false falsifies it. */
	readonly property: boolean;
}

const TEST_NAMES: ReadonlySet<string> = new Set(["it", "test", "specify"]);
const SUITE_NAMES: ReadonlySet<string> = new Set(["describe", "context", "suite"]);

const PREFIXED: Readonly<Record<string, { readonly kind: TestKind; readonly modifier: TestModifier }>> = {
	xit: { kind: "test", modifier: "skip" },
	xtest: { kind: "test", modifier: "skip" },
	xspecify: { kind: "test", modifier: "skip" },
	xdescribe: { kind: "suite", modifier: "skip" },
	xcontext: { kind: "suite", modifier: "skip" },
	fit: { kind: "test", modifier: "only" },
	fdescribe: { kind: "suite", modifier: "only" },
};

/** Chain properties allowed between the test function and the call, and the modifier each implies. */
const CHAIN_PROPS: ReadonlyMap<string, TestModifier | null> = new Map<string, TestModifier | null>([
	["skip", "skip"],
	["only", "only"],
	["todo", "todo"],
	["concurrent", null],
	["sequential", null],
	["shuffle", null],
	["fails", null],
	["failing", null],
	["serial", null],
	["each", null],
	["for", null],
	["skipIf", null],
	["runIf", null],
	// @effect/vitest: `it.effect` and friends take an Effect, `it.prop` is a property test. `it.flakyTest` wraps an
	// Effect inside a test and declares nothing, so it is not listed.
	["effect", null],
	["scoped", null],
	["live", null],
	["scopedLive", null],
	["prop", null],
]);

/** Calls that produce a test function: `test.each(table)`, `test.skipIf(cond)`. */
const FACTORY_PROPS: ReadonlySet<string> = new Set(["each", "for", "skipIf", "runIf"]);

interface ResolvedCallee {
	readonly root: string;
	readonly props: ReadonlyArray<string>;
	readonly conditional: { readonly prop: string; readonly argument: ESTree.Node | undefined } | null;
}

function resolveChain(node: ESTree.Node): { readonly root: string; readonly props: ReadonlyArray<string> } | null {
	const props: string[] = [];
	let current = node;
	while (current.type === "MemberExpression") {
		if (current.computed || current.property.type !== "Identifier") return null;
		props.unshift(current.property.name);
		current = current.object;
	}
	if (current.type !== "Identifier") return null;
	return { root: current.name, props };
}

function resolveTestCallee(callee: ESTree.Node): ResolvedCallee | null {
	// test.each(table)('title', fn), test.skipIf(cond)('title', fn)
	if (callee.type === "CallExpression" || callee.type === "TaggedTemplateExpression") {
		const inner = callee.type === "CallExpression" ? callee.callee : callee.tag;
		const chain = resolveChain(inner);
		const last = chain?.props.at(-1);
		if (chain === null || last === undefined || !FACTORY_PROPS.has(last)) return null;
		const argument = callee.type === "CallExpression" ? callee.arguments[0] : undefined;
		return { root: chain.root, props: chain.props, conditional: { prop: last, argument } };
	}
	const chain = resolveChain(callee);
	return chain === null ? null : { ...chain, conditional: null };
}

function isLiteralTruthy(node: ESTree.Node | undefined): boolean | null {
	if (node === undefined) return null;
	if (node.type === "Literal") return Boolean(node.value);
	if (node.type === "UnaryExpression" && node.operator === "!") {
		const inner = isLiteralTruthy(node.argument);
		return inner === null ? null : !inner;
	}
	return null;
}

/** Text of a test or suite title, as a reviewer would read it. */
export function getTitleText(node: ESTree.Node | undefined): string {
	if (node === undefined) return "<untitled>";
	if (node.type === "Literal" && typeof node.value === "string") return node.value;
	if (node.type === "TemplateLiteral") return node.quasis.map((quasi) => quasi.value.cooked ?? quasi.value.raw).join("${...}");
	if (node.type === "Identifier") return node.name;
	if (node.type === "MemberExpression") {
		const chain = resolveChain(node);
		if (chain !== null) return [chain.root, ...chain.props].join(".");
	}
	return "<dynamic>";
}

const isCallback = (node: ESTree.Node | undefined): node is TestCallback =>
	node?.type === "ArrowFunctionExpression" || node?.type === "FunctionExpression";

/** Recognises `it(...)`, `describe.only(...)`, `test.each(t)(...)`, `xit(...)` and friends. */
export function getTestCall(node: ESTree.CallExpression): TestCall | null {
	const resolved = resolveTestCallee(node.callee);
	if (resolved === null) return null;

	let kind: TestKind;
	const modifiers = new Set<TestModifier>();
	const prefixed = PREFIXED[resolved.root];
	if (prefixed !== undefined) {
		kind = prefixed.kind;
		modifiers.add(prefixed.modifier);
	} else if (TEST_NAMES.has(resolved.root)) {
		kind = "test";
	} else if (SUITE_NAMES.has(resolved.root)) {
		kind = "suite";
	} else {
		return null;
	}

	for (const prop of resolved.props) {
		// test.extend(...), it.name, ...
		if (!CHAIN_PROPS.has(prop)) return null;
		const modifier = CHAIN_PROPS.get(prop);
		if (modifier !== undefined && modifier !== null) modifiers.add(modifier);
	}
	// `it.each(table)` itself only builds the test function; the test is the call on its result.
	if (resolved.conditional === null && FACTORY_PROPS.has(resolved.props.at(-1) ?? "")) return null;

	if (resolved.conditional !== null) {
		const truthy = isLiteralTruthy(resolved.conditional.argument);
		if (resolved.conditional.prop === "skipIf" && truthy === true) modifiers.add("skip");
		if (resolved.conditional.prop === "runIf" && truthy === false) modifiers.add("skip");
	}

	const [titleArgument, ...rest] = node.arguments;
	if (titleArgument === undefined) return null;
	// Vitest allows an options object before the callback: test('t', { timeout }, fn)
	const callback = rest.find(isCallback) ?? null;
	// it('title') with no body is a pending test in Mocha and Jasmine.
	if (kind === "test" && callback === null && !modifiers.has("todo") && rest.length === 0) modifiers.add("todo");
	return { kind, node, title: getTitleText(titleArgument), modifiers, callback, property: resolved.props.includes("prop") };
}

// ─── Assertions ─────────────────────────────────────────────────────────────

/** Modules whose exports are assertion functions. */
const ASSERTION_MODULES: ReadonlySet<string> = new Set([
	"assert",
	"node:assert",
	"assert/strict",
	"node:assert/strict",
	"chai",
	"power-assert",
	"should",
	"expect",
	"expect.js",
	"unexpected",
	"@effect/vitest/utils",
]);
/** Test-runner modules that export `expect` or `assert` alongside other helpers. */
const RUNNER_MODULES: ReadonlySet<string> = new Set([
	"vitest",
	"@jest/globals",
	"bun:test",
	"@playwright/test",
	"node:test",
	"uvu/assert",
	"tap",
	"@effect/vitest",
]);
const RUNNER_ASSERTION_EXPORTS: ReadonlySet<string> = new Set(["expect", "assert", "should"]);

/** AVA, tap and node:test context methods that do not assert anything. */
const T_NON_ASSERTIONS: ReadonlySet<string> = new Set([
	"plan", "teardown", "before", "after", "beforeEach", "afterEach", "mock", "test", "skip", "todo",
	"log", "diagnostic", "comment", "timeout", "context", "signal", "name", "runOnly", "fullName", "end",
]);

export type AssertionKind = "value" | "meta" | "implicit";

function requiredModule(init: ESTree.Node | null | undefined): string | null {
	if (init?.type !== "CallExpression" || init.callee.type !== "Identifier" || init.callee.name !== "require") return null;
	const [first] = init.arguments;
	return first?.type === "Literal" && typeof first.value === "string" ? first.value : null;
}

/**
 * Local names bound to assertion functions by imports or requires: `import assert from 'node:assert'`,
 * `import { equal } from 'assert'`, `import { expect as e } from 'vitest'`, `const { strictEqual } = require('assert')`.
 */
export function collectAssertionBindings(program: ESTree.Program): Set<string> {
	const names = new Set<string>();
	for (const statement of program.body) {
		if (statement.type === "ImportDeclaration" && typeof statement.source.value === "string") {
			const source = statement.source.value;
			const isAssertionModule = ASSERTION_MODULES.has(source);
			if (!isAssertionModule && !RUNNER_MODULES.has(source)) continue;
			for (const specifier of statement.specifiers) {
				if (specifier.type === "ImportSpecifier") {
					const imported = specifier.imported.type === "Identifier" ? specifier.imported.name : String(specifier.imported.value);
					if (isAssertionModule || RUNNER_ASSERTION_EXPORTS.has(imported)) names.add(specifier.local.name);
				} else if (isAssertionModule) {
					names.add(specifier.local.name);
				}
			}
		}
		if (statement.type !== "VariableDeclaration") continue;
		for (const declarator of statement.declarations) {
			const source = requiredModule(declarator.init);
			if (source === null || !ASSERTION_MODULES.has(source)) continue;
			if (declarator.id.type === "Identifier") names.add(declarator.id.name);
			if (declarator.id.type !== "ObjectPattern") continue;
			for (const property of declarator.id.properties) {
				if (property.type === "Property" && property.value.type === "Identifier") names.add(property.value.name);
			}
		}
	}
	return names;
}

/** expectValidUser(), assertNoErrors(), verifyResponse(), ensureVisible(): helpers that assert. */
const HELPER_ASSERTION_NAME = /^(?:expect|assert|verify|should|ensure)(?:[A-Z0-9_]|$)/;
const TESTING_LIBRARY_QUERY = /^(?:getBy|getAllBy|findBy|findAllBy)[A-Z]/;

export interface AssertionContext {
	/** Names bound to assertion functions (see `collectAssertionBindings`). */
	readonly bindings: ReadonlySet<string>;
	/** Parameter names of the enclosing test callback (AVA and tap `t`). */
	readonly testContextNames?: ReadonlySet<string>;
}

function memberName(node: ESTree.MemberExpression): string | null {
	return !node.computed && node.property.type === "Identifier" ? node.property.name : null;
}

/**
 * Classifies a call as an assertion:
 * - `value`: asserts something about a value (`expect(x)`, `assert.equal`, `t.is`)
 * - `meta`: constrains assertions (`expect.assertions(1)`, `t.plan(2)`)
 * - `implicit`: throws when the thing is missing (Testing Library `getBy*`, Cypress `cy.*`)
 *
 * For an `expect(x).toBe(y)` chain only the inner `expect(x)` call is an assertion, so each assertion counts once.
 */
export function getAssertionKind(node: ESTree.CallExpression, context: AssertionContext): AssertionKind | null {
	const callee = node.callee;

	if (callee.type === "Identifier") {
		const name = callee.name;
		if (name === "expect" || name === "assert" || name === "should" || context.bindings.has(name)) return "value";
		if (HELPER_ASSERTION_NAME.test(name)) return "value";
		if (TESTING_LIBRARY_QUERY.test(name)) return "implicit";
		return null;
	}

	if (callee.type !== "MemberExpression") return null;
	const property = memberName(callee);

	// x.should.equal(1), cy.get(...).should('be.visible')
	if (property === "should") return "value";
	// screen.getByText(...), within(el).getByRole(...): throw when nothing matches
	if (property !== null && TESTING_LIBRARY_QUERY.test(property)) return "implicit";
	// supertest request(app).get('/').expect(200), td.verify(...), page.expectVisible()
	if (property !== null && HELPER_ASSERTION_NAME.test(property)) return "value";
	let current = callee.object;
	while (current.type === "MemberExpression") {
		if (memberName(current) === "should") return "value";
		current = current.object;
	}

	const chain = resolveChain(callee);
	if (chain === null) {
		// cy.get('x').click(): chains rooted in a call on `cy`
		let root: ESTree.Node = callee;
		while (root.type === "MemberExpression" || root.type === "CallExpression") {
			root = root.type === "MemberExpression" ? root.object : root.callee;
		}
		return root.type === "Identifier" && root.name === "cy" ? "implicit" : null;
	}

	const { root, props } = chain;
	const first = props[0];
	if (root === "expect") {
		if (first === "assertions" || first === "hasAssertions") return "meta";
		if (first === "soft" || first === "poll" || first === "element") return "value";
		// expect.extend, expect.any, expect.objectContaining
		return null;
	}
	if (root === "assert" || context.bindings.has(root)) return "value";
	if (root === "chai" && (first === "expect" || first === "assert")) return "value";
	if (root === "sinon" && first === "assert") return "value";
	if (root === "cy") return "implicit";
	if (context.testContextNames?.has(root) === true) {
		if (first === "plan") return "meta";
		// node:test t.assert.strictEqual
		if (first === "assert") return "value";
		if (first !== undefined && !T_NON_ASSERTIONS.has(first)) return "value";
	}
	return null;
}

// ─── expect() chains ────────────────────────────────────────────────────────

export interface ExpectMatcher {
	/** The `expect(...)` call. */
	readonly expectCall: ESTree.CallExpression;
	/** Matcher name: `toBe`, or a chai word such as `true` or `equal`. */
	readonly name: string;
	readonly negated: boolean;
	/** Arguments of the matcher call; empty for chai property assertions. */
	readonly args: ReadonlyArray<ESTree.Argument>;
	/** True when the matcher is invoked (`.toBe(x)`), false for chai properties (`.to.be.true`). */
	readonly called: boolean;
	/** Every property name after `expect(...)`, such as `['not', 'toBe']`. */
	readonly chain: ReadonlyArray<string>;
}

/** Given the inner `expect(x)` call, the matcher at the end of its chain. */
export function getExpectMatcher(expectCall: ESTree.CallExpression): ExpectMatcher | null {
	const chain: string[] = [];
	let node: ESTree.Node = expectCall;
	for (let parent = node.parent; parent?.type === "MemberExpression" && parent.object === node; parent = node.parent) {
		const name = memberName(parent);
		if (name === null) return null;
		chain.push(name);
		node = parent;
	}
	const name = chain.at(-1);
	if (name === undefined) return null;
	const call = node.parent?.type === "CallExpression" && node.parent.callee === node ? node.parent : null;
	return { expectCall, name, negated: chain.includes("not"), args: call?.arguments ?? [], called: call !== null, chain };
}
