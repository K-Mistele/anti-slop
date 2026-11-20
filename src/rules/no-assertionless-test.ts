// Ported from eslint-plugin-ai-guard 1.4.7 (`src/rules/ai-patterns/no-assertionless-test.ts`, MIT); see
// `src/vendor/ai-guard/UPSTREAM.md`.
import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

import { someDescendant, isFunctionNode } from "../shared/ast-walk.ts";
import { isTestFile } from "../shared/file-context.ts";
import { collectAssertionBindings, getAssertionKind, getTestCall, type AssertionContext, type TestCall } from "../shared/test-patterns.ts";

/** Titles that state "not throwing" is the whole point of the test. */
const SMOKE_TEST_TITLE =
	/\b(?:does(?:n'?t| not) (?:throw|crash|fail|error)|(?:not|never) throws?|without (?:crashing|errors?|throwing|exceptions?|failing)|smoke)\b/i;

/** Files driven by end-to-end runners, where actions auto-wait and fail by themselves. */
const E2E_MODULES: ReadonlySet<string> = new Set(["@playwright/test", "playwright/test"]);

type FunctionNode = ESTree.Function | ESTree.ArrowFunctionExpression;

/** Mocha, Jasmine and Jest completion-callback parameter names. */
const DONE_PARAM_NAME = /^(?:done|cb|callback|next|finish)$/;

function paramNames(fn: FunctionNode): Set<string> {
	const names = new Set<string>();
	for (const param of fn.params) if (param.type === "Identifier") names.add(param.name);
	return names;
}

/**
 * Mocha and Jest callback tests: `app.on('x', done)`, `server.close(done)` or `{ end: done }` only finish when the
 * callback runs, so passing `done` along (or calling it from a nested callback) is the assertion. A synchronous
 * `done()` at the end asserts nothing.
 */
function usesDoneAsAssertion(callback: FunctionNode): boolean {
	const [first] = callback.params;
	if (first?.type !== "Identifier" || callback.body === null) return false;
	// Only completion callbacks; in it.each((row) => ...) the parameter is table data.
	if (!DONE_PARAM_NAME.test(first.name)) return false;
	const done = first.name;
	return someDescendant(callback.body, (node) => {
		if (node.type !== "Identifier" || node.name !== done) return false;
		const parent = node.parent;
		if (parent?.type !== "CallExpression" || parent.callee !== node) return true;
		for (let current: ESTree.Node | null | undefined = parent.parent; current !== null && current !== undefined && current !== callback; current = current.parent) {
			if (isFunctionNode(current)) return true;
		}
		return false;
	});
}

const COMPARISON_OPERATORS: ReadonlySet<string> = new Set(["===", "!==", "==", "!=", "<", ">", "<=", ">=", "instanceof", "in"]);

function isBooleanCheck(node: ESTree.Node): boolean {
	if (node.type === "BinaryExpression") return COMPARISON_OPERATORS.has(node.operator);
	if (node.type === "UnaryExpression") return node.operator === "!";
	if (node.type === "LogicalExpression") return isBooleanCheck(node.left) && isBooleanCheck(node.right);
	return false;
}

/** A property test fails when its callback returns false, so a returned comparison is its assertion. */
function returnsBooleanCheck(callback: FunctionNode): boolean {
	const body = callback.body;
	if (body === null) return false;
	if (body.type !== "BlockStatement") return isBooleanCheck(body);
	return body.body.some((statement) => statement.type === "ReturnStatement" && statement.argument !== null && isBooleanCheck(statement.argument));
}

function calleeName(node: ESTree.CallExpression): string | null {
	const callee = node.callee;
	if (callee.type === "Identifier") return callee.name;
	if (callee.type === "MemberExpression" && callee.object.type === "ThisExpression" && callee.property.type === "Identifier") {
		return callee.property.name;
	}
	return null;
}

/** Reject test cases with no assertion: they pass whatever the code does. */
export const noAssertionlessTestRule = defineRule({
	meta: {
		type: "problem",
		docs: {
			description:
				"Disallow test cases that contain no assertion, so they pass whatever the code does. AI agents write such tests to show coverage or to make a failing suite pass. Counts expect/assert/chai/should/sinon/AVA assertions, supertest `.expect()`, Testing Library `getBy*` queries, thrown errors, and local helper functions that assert.",
		},
		schema: [],
		messages: {
			noAssertions:
				'Test "{{title}}" has no assertions, so it passes no matter what the code does. AI agents write tests like this to show coverage or to make a failing suite pass. Add an expect(...) for the behaviour the test name describes.',
		},
	},
	create(context) {
		if (!isTestFile(context.physicalFilename || context.filename)) return {};

		const tests: TestCall[] = [];
		const functions = new Map<string, FunctionNode>();

		return {
			CallExpression(node) {
				const test = getTestCall(node);
				if (test?.kind === "test") tests.push(test);
			},
			FunctionDeclaration(node) {
				if (node.id !== null) functions.set(node.id.name, node);
			},
			VariableDeclarator(node) {
				if (node.id.type === "Identifier" && (node.init?.type === "ArrowFunctionExpression" || node.init?.type === "FunctionExpression")) {
					functions.set(node.id.name, node.init);
				}
			},
			MethodDefinition(node) {
				// Abstract and overload signatures (TSEmptyBodyFunctionExpression) have no body to inspect.
				if (node.key.type === "Identifier" && node.value.type === "FunctionExpression") functions.set(node.key.name, node.value);
			},
			"Program:exit"(program) {
				const isE2E = program.body.some(
					(statement) => statement.type === "ImportDeclaration" && E2E_MODULES.has(statement.source.value),
				);
				if (isE2E) return;

				const bindings = collectAssertionBindings(program);

				// Local helpers that assert, directly or through another asserting helper.
				const assertingHelpers = new Set<string>();
				const containsAssertion = (root: ESTree.Node, assertionContext: AssertionContext): boolean =>
					someDescendant(root, (node) => {
						if (node.type === "ThrowStatement") return true;
						if (node.type !== "CallExpression") return false;
						if (getAssertionKind(node, assertionContext) !== null) return true;
						const name = calleeName(node);
						return name !== null && assertingHelpers.has(name);
					});

				for (let pass = 0; pass < 3; pass += 1) {
					let added = false;
					for (const [name, fn] of functions) {
						if (assertingHelpers.has(name) || fn.body === null) continue;
						if (containsAssertion(fn.body, { bindings, testContextNames: paramNames(fn) })) {
							assertingHelpers.add(name);
							added = true;
						}
					}
					if (!added) break;
				}

				for (const test of tests) {
					const callback = test.callback;
					if (callback === null || callback.body === null || test.modifiers.has("todo") || test.modifiers.has("skip")) continue;
					if (SMOKE_TEST_TITLE.test(test.title)) continue;
					const assertionContext: AssertionContext = { bindings, testContextNames: paramNames(callback) };
					if (containsAssertion(callback.body, assertionContext) || usesDoneAsAssertion(callback)) continue;
					if (test.property && returnsBooleanCheck(callback)) continue;
					context.report({ node: test.node, messageId: "noAssertions", data: { title: test.title.slice(0, 60) } });
				}
			},
		};
	},
});
