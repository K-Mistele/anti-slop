// Ported from eslint-plugin-ai-guard 1.4.7 (`src/rules/ai-patterns/no-tautological-assertion.ts`, MIT); see
// `src/vendor/ai-guard/UPSTREAM.md`.
import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

import { getExpectMatcher, type ExpectMatcher } from "../shared/test-patterns.ts";

/**
 * Type-level test files (`types.test.ts`, `*.test-d.ts`) check types at compile time; a runtime
 * `expect(true).toBeTruthy()` there is a deliberate placeholder.
 */
const TYPE_TEST_FILE = /(?:^|[\\/.\-_])(?:types?|typings?)(?:[.\-_](?:test|spec))?\.(?:test|spec)\.[cm]?[jt]sx?$|\.test-d\.[cm]?tsx?$|[\\/]type-?tests?[\\/]/i;

// ─── Static evaluation ───────────────────────────────────────────────────────

type Static = { readonly value: unknown } | null;

const MAX_STATIC_DEPTH = 8;

/** JavaScript truthiness of a statically evaluated value, as `if (value)` would read it at runtime. */
const isTruthy = (value: unknown): boolean => Boolean(value);

function staticUnary(operator: ESTree.UnaryExpression["operator"], value: unknown): Static {
	switch (operator) {
		case "!":
			return { value: !isTruthy(value) };
		case "-":
			return { value: -Number(value) };
		case "+":
			return { value: Number(value) };
		case "~":
			return { value: ~Number(value) };
		case "typeof":
			return { value: typeof value };
		case "void":
			return { value: undefined };
		default:
			return null;
	}
}

// The operands are constants the test wrote, evaluated the way JavaScript would; loose comparisons mirror what the
// code under evaluation wrote.
function staticBinary(operator: ESTree.BinaryExpression["operator"], left: unknown, right: unknown): Static {
	const a = left as number;
	const b = right as number;
	switch (operator) {
		case "+":
			return { value: (a as unknown as string) + (b as unknown as string) };
		case "-":
			return { value: a - b };
		case "*":
			return { value: a * b };
		case "/":
			return { value: a / b };
		case "%":
			return { value: a % b };
		case "**":
			return { value: a ** b };
		case "===":
			return { value: a === b };
		case "!==":
			return { value: a !== b };
		case "==":
			return { value: a == b };
		case "!=":
			return { value: a != b };
		case "<":
			return { value: a < b };
		case ">":
			return { value: a > b };
		case "<=":
			return { value: a <= b };
		case ">=":
			return { value: a >= b };
		default:
			return null;
	}
}

function staticKey(key: ESTree.Node): string | null {
	if (key.type === "Identifier") return key.name;
	if (key.type === "Literal") return String(key.value);
	return null;
}

/** The value of an expression that does not depend on any code under test. */
export function staticValue(node: ESTree.Node | null | undefined, depth = 0): Static {
	if (node === null || node === undefined || depth > MAX_STATIC_DEPTH) return null;
	switch (node.type) {
		case "Literal":
			if ("regex" in node && node.regex !== undefined && node.regex !== null) return null;
			return { value: node.value };
		case "TemplateLiteral":
			return node.expressions.length === 0 ? { value: node.quasis[0]?.value.cooked ?? "" } : null;
		case "Identifier":
			if (node.name === "undefined") return { value: undefined };
			if (node.name === "NaN") return { value: NaN };
			if (node.name === "Infinity") return { value: Infinity };
			return null;
		case "UnaryExpression": {
			if (node.operator === "delete") return null;
			const inner = staticValue(node.argument, depth + 1);
			return inner === null ? null : staticUnary(node.operator, inner.value);
		}
		case "BinaryExpression": {
			const left = staticValue(node.left, depth + 1);
			const right = staticValue(node.right, depth + 1);
			return left === null || right === null ? null : staticBinary(node.operator, left.value, right.value);
		}
		case "LogicalExpression": {
			const left = staticValue(node.left, depth + 1);
			if (left === null) return null;
			if (node.operator === "&&") return isTruthy(left.value) ? staticValue(node.right, depth + 1) : left;
			if (node.operator === "||") return isTruthy(left.value) ? left : staticValue(node.right, depth + 1);
			return left.value === null || left.value === undefined ? staticValue(node.right, depth + 1) : left;
		}
		case "ArrayExpression": {
			const items: unknown[] = [];
			for (const element of node.elements) {
				if (element === null || element.type === "SpreadElement") return null;
				const item = staticValue(element, depth + 1);
				if (item === null) return null;
				items.push(item.value);
			}
			return { value: items };
		}
		case "ObjectExpression": {
			const result: Record<string, unknown> = {};
			for (const property of node.properties) {
				if (property.type !== "Property" || property.computed || property.kind !== "init") return null;
				const key = staticKey(property.key);
				if (key === null) return null;
				const value = staticValue(property.value, depth + 1);
				if (value === null) return null;
				result[key] = value.value;
			}
			return { value: result };
		}
		case "TSAsExpression":
		case "TSNonNullExpression":
		case "TSSatisfiesExpression":
			return staticValue(node.expression, depth + 1);
		default:
			return null;
	}
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

function deepEqual(a: unknown, b: unknown): boolean {
	if (Object.is(a, b)) return true;
	if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((item, index) => deepEqual(item, b[index]));
	if (isRecord(a) && isRecord(b)) {
		const aKeys = Object.keys(a).filter((key) => a[key] !== undefined);
		const bKeys = Object.keys(b).filter((key) => b[key] !== undefined);
		return aKeys.length === bKeys.length && aKeys.every((key) => deepEqual(a[key], b[key]));
	}
	return false;
}

const contains = (subject: unknown, expected: unknown): boolean =>
	typeof subject === "string" ? typeof expected === "string" && subject.includes(expected) : Array.isArray(subject) && subject.includes(expected);

const lengthIs = (subject: unknown, expected: unknown): boolean =>
	(typeof subject === "string" || Array.isArray(subject)) && subject.length === expected;

// The subject and expected value are constants the test wrote; ordering compares them as JavaScript would.
const ordered = (subject: unknown, expected: unknown, compare: (a: number, b: number) => boolean): boolean =>
	compare(subject as number, expected as number);

/** Outcome of an expect matcher on a constant subject: true (always passes), false (always fails), null (unknown). */
function evaluateMatcher(subject: unknown, matcher: ExpectMatcher): boolean | null {
	const argument = matcher.args[0];
	const expected = argument === undefined ? null : staticValue(argument);
	const needsArg = (check: (value: unknown) => boolean): boolean | null => (expected === null ? null : check(expected.value));
	let result: boolean | null;

	switch (matcher.name) {
		case "toBe":
			result = needsArg((value) => Object.is(subject, value));
			break;
		case "toEqual":
		case "toStrictEqual":
		case "eql":
			result = needsArg((value) => deepEqual(subject, value));
			break;
		case "equal":
		case "equals":
			result = matcher.chain.includes("deep") ? needsArg((value) => deepEqual(subject, value)) : needsArg((value) => subject === value);
			break;
		case "toBeTruthy":
		case "ok":
			result = Boolean(subject);
			break;
		case "toBeFalsy":
			result = !isTruthy(subject);
			break;
		case "toBeDefined":
			result = subject !== undefined;
			break;
		case "toBeUndefined":
		case "undefined":
			result = subject === undefined;
			break;
		case "toBeNull":
		case "null":
			result = subject === null;
			break;
		case "toBeNaN":
		case "NaN":
			result = Number.isNaN(subject);
			break;
		case "true":
			result = subject === true;
			break;
		case "false":
			result = subject === false;
			break;
		case "exist":
			result = subject !== null && subject !== undefined;
			break;
		case "toBeGreaterThan":
		case "above":
			result = needsArg((value) => ordered(subject, value, (a, b) => a > b));
			break;
		case "toBeGreaterThanOrEqual":
		case "least":
			result = needsArg((value) => ordered(subject, value, (a, b) => a >= b));
			break;
		case "toBeLessThan":
		case "below":
			result = needsArg((value) => ordered(subject, value, (a, b) => a < b));
			break;
		case "toBeLessThanOrEqual":
		case "most":
			result = needsArg((value) => ordered(subject, value, (a, b) => a <= b));
			break;
		case "toContain":
		case "include":
		case "contain":
			result = needsArg((value) => contains(subject, value));
			break;
		case "toHaveLength":
		case "lengthOf":
			result = needsArg((value) => lengthIs(subject, value));
			break;
		case "toBeTypeOf":
			result = needsArg((value) => typeof subject === value);
			break;
		case "toMatch":
			if (argument?.type === "Literal" && "regex" in argument && argument.regex !== null && argument.regex !== undefined && typeof subject === "string") {
				result = new RegExp(argument.regex.pattern, argument.regex.flags).test(subject);
			} else {
				result = needsArg((value) => typeof subject === "string" && typeof value === "string" && subject.includes(value));
			}
			break;
		default:
			result = null;
	}
	if (result === null) return null;
	return matcher.negated ? !result : result;
}

// ─── Identity comparisons: expect(x).toBe(x) ────────────────────────────────

function isPureReference(node: ESTree.Node): boolean {
	if (node.type === "Identifier" || node.type === "ThisExpression") return true;
	if (node.type === "MemberExpression") {
		if (node.computed && node.property.type !== "Literal") return false;
		return isPureReference(node.object);
	}
	if (node.type === "TSNonNullExpression" || node.type === "TSAsExpression") return isPureReference(node.expression);
	return false;
}

/** The outermost node of an `expect(x).not.toBe(y)` chain, for reporting. */
function chainEnd(expectCall: ESTree.CallExpression): ESTree.Node {
	let node: ESTree.Node = expectCall;
	for (let parent: ESTree.Node | null | undefined = node.parent; parent !== null && parent !== undefined; parent = node.parent) {
		const continues =
			(parent.type === "MemberExpression" && parent.object === node) || (parent.type === "CallExpression" && parent.callee === node);
		if (!continues) break;
		node = parent;
	}
	return node;
}

const EQUALITY_MATCHERS: ReadonlySet<string> = new Set(["toBe", "toEqual", "toStrictEqual", "toMatchObject", "equal", "equals", "eql"]);

// ─── Assert-style APIs ──────────────────────────────────────────────────────

const ASSERT_MODULES: ReadonlySet<string> = new Set(["assert", "node:assert", "assert/strict", "node:assert/strict", "chai", "power-assert"]);

type AssertCheck =
	| { readonly kind: "truthy" }
	| { readonly kind: "falsy" }
	| { readonly kind: "equal"; readonly strictness: "loose" | "strict" | "deep"; readonly negated: boolean }
	| { readonly kind: "is"; readonly expected: unknown };

const ASSERT_METHODS: ReadonlyMap<string, AssertCheck> = new Map<string, AssertCheck>([
	["ok", { kind: "truthy" }],
	["isOk", { kind: "truthy" }],
	["isTrue", { kind: "is", expected: true }],
	["isFalse", { kind: "is", expected: false }],
	["isNull", { kind: "is", expected: null }],
	["isUndefined", { kind: "is", expected: undefined }],
	["isNotOk", { kind: "falsy" }],
	["equal", { kind: "equal", strictness: "loose", negated: false }],
	["strictEqual", { kind: "equal", strictness: "strict", negated: false }],
	["deepEqual", { kind: "equal", strictness: "deep", negated: false }],
	["deepStrictEqual", { kind: "equal", strictness: "deep", negated: false }],
	["notEqual", { kind: "equal", strictness: "loose", negated: true }],
	["notStrictEqual", { kind: "equal", strictness: "strict", negated: true }],
	["notDeepEqual", { kind: "equal", strictness: "deep", negated: true }],
	["notDeepStrictEqual", { kind: "equal", strictness: "deep", negated: true }],
]);

interface AssertBindings {
	/** Callable assert namespaces: `assert`, `import assert from 'node:assert'`. */
	readonly namespaces: Set<string>;
	/** Directly imported assert methods, local name to method name. */
	readonly methods: Map<string, string>;
	/** Local aliases of `expect` from test runners and chai. */
	readonly expectNames: Set<string>;
}

const defaultBindings = (): AssertBindings => ({ namespaces: new Set(["assert"]), methods: new Map(), expectNames: new Set(["expect"]) });

function requiredModule(init: ESTree.Node | null | undefined): string | null {
	if (init?.type !== "CallExpression" || init.callee.type !== "Identifier" || init.callee.name !== "require") return null;
	const [first] = init.arguments;
	return first?.type === "Literal" && typeof first.value === "string" ? first.value : null;
}

function addRequire(bindings: AssertBindings, declarator: ESTree.VariableDeclarator): void {
	const source = requiredModule(declarator.init);
	if (source === null || !ASSERT_MODULES.has(source)) return;
	if (declarator.id.type === "Identifier") bindings.namespaces.add(declarator.id.name);
	if (declarator.id.type !== "ObjectPattern") return;
	for (const property of declarator.id.properties) {
		if (property.type !== "Property" || property.key.type !== "Identifier" || property.value.type !== "Identifier") continue;
		if (property.key.name === "expect") bindings.expectNames.add(property.value.name);
		else if (property.key.name === "assert" || property.key.name === "strict") bindings.namespaces.add(property.value.name);
		else bindings.methods.set(property.value.name, property.key.name);
	}
}

function collectBindings(program: ESTree.Program): AssertBindings {
	const bindings = defaultBindings();
	for (const statement of program.body) {
		if (statement.type === "VariableDeclaration") for (const declarator of statement.declarations) addRequire(bindings, declarator);
		if (statement.type !== "ImportDeclaration") continue;
		const source = statement.source.value;
		for (const specifier of statement.specifiers) {
			if (specifier.type === "ImportSpecifier") {
				const imported = specifier.imported.type === "Identifier" ? specifier.imported.name : String(specifier.imported.value);
				if (imported === "expect") bindings.expectNames.add(specifier.local.name);
				else if (imported === "assert" || imported === "strict") bindings.namespaces.add(specifier.local.name);
				else if (ASSERT_MODULES.has(source)) bindings.methods.set(specifier.local.name, imported);
			} else if (ASSERT_MODULES.has(source)) {
				bindings.namespaces.add(specifier.local.name);
			}
		}
	}
	return bindings;
}

function describeStatic(value: unknown): string {
	if (typeof value === "string") return JSON.stringify(value).slice(0, 40);
	if (typeof value === "number" && Number.isNaN(value)) return "NaN";
	if (value === undefined) return "undefined";
	const text = JSON.stringify(value);
	return text.length > 40 ? `${text.slice(0, 37)}...` : text;
}

const isExpression = (node: ESTree.Argument | undefined): node is ESTree.Expression => node !== undefined && node.type !== "SpreadElement";

/** Reject assertions that pass no matter what the code does. */
export const noTautologicalAssertionRule = defineRule({
	meta: {
		type: "problem",
		docs: {
			description:
				'Disallow assertions that pass no matter what the code does: `expect(true).toBe(true)`, `expect(1 + 1).toBe(2)`, `expect(x).toEqual(x)`, `assert.ok(1)`. AI agents add these to make a failing test pass or to make a placeholder test look real. Assertions that always fail (used as "should have thrown" sentinels) are not reported.',
		},
		schema: [],
		messages: {
			alwaysPasses:
				"This assertion always passes: it checks {{subject}}, a constant, instead of anything your code produced. AI agents write assertions like `expect(true).toBe(true)` to make a test pass. Assert on the result of the code under test.",
			comparesWithItself:
				"This assertion compares `{{subject}}` with itself, so it always passes. AI agents write these to make a test pass. Compare the result of the code under test with an independent expected value.",
			constantSubject: "This assertion checks a constant ({{subject}}), so it never tests your code. Pass the value produced by the code under test to expect().",
		},
	},
	create(context) {
		if (TYPE_TEST_FILE.test(context.physicalFilename || context.filename)) return {};
		const sourceCode = context.sourceCode;
		let bindings = defaultBindings();
		const normalized = (node: ESTree.Node): string => sourceCode.getText(node).replace(/\s+/g, "");

		function checkExpect(expectCall: ESTree.CallExpression): void {
			const subjectNode = expectCall.arguments[0];
			if (!isExpression(subjectNode)) return;
			const matcher = getExpectMatcher(expectCall);
			if (matcher === null) return;
			const reportNode = chainEnd(expectCall);

			const subject = staticValue(subjectNode);
			if (subject !== null) {
				// expect(200).toBe(res.status): the constant is on the wrong side, but the assertion still checks a value the code produced.
				if (matcher.args.some((argument) => argument.type === "SpreadElement" || staticValue(argument) === null)) return;
				const outcome = evaluateMatcher(subject.value, matcher);
				// Always fails: an intentional "should not reach" sentinel.
				if (outcome === false) return;
				context.report({
					node: reportNode,
					messageId: outcome === true ? "alwaysPasses" : "constantSubject",
					data: { subject: describeStatic(subject.value) },
				});
				return;
			}

			const expected = matcher.args[0];
			if (
				!matcher.negated &&
				EQUALITY_MATCHERS.has(matcher.name) &&
				isExpression(expected) &&
				isPureReference(subjectNode) &&
				normalized(subjectNode) === normalized(expected)
			) {
				context.report({ node: reportNode, messageId: "comparesWithItself", data: { subject: normalized(subjectNode).slice(0, 40) } });
			}
		}

		function checkAssert(call: ESTree.CallExpression, check: AssertCheck): void {
			const [first, second] = call.arguments;
			if (!isExpression(first)) return;

			if (check.kind === "equal") {
				if (!isExpression(second)) return;
				if (!check.negated && isPureReference(first) && normalized(first) === normalized(second)) {
					context.report({ node: call, messageId: "comparesWithItself", data: { subject: normalized(first).slice(0, 40) } });
					return;
				}
				const a = staticValue(first);
				const b = staticValue(second);
				if (a === null || b === null) return;
				// assert.equal compares loosely, like ==
				const equal = check.strictness === "deep" ? deepEqual(a.value, b.value) : check.strictness === "strict" ? Object.is(a.value, b.value) : a.value == b.value;
				if (equal !== check.negated) context.report({ node: call, messageId: "alwaysPasses", data: { subject: describeStatic(a.value) } });
				return;
			}

			const value = staticValue(first);
			if (value === null) return;
			const passes = check.kind === "truthy" ? Boolean(value.value) : check.kind === "falsy" ? !isTruthy(value.value) : Object.is(value.value, check.expected);
			if (passes) context.report({ node: call, messageId: "alwaysPasses", data: { subject: describeStatic(value.value) } });
		}

		return {
			Program(node) {
				bindings = collectBindings(node);
			},
			CallExpression(node) {
				const callee = node.callee;
				if (callee.type === "Identifier") {
					if (bindings.expectNames.has(callee.name)) {
						checkExpect(node);
						return;
					}
					if (bindings.namespaces.has(callee.name)) {
						// assert(value) is assert.ok(value)
						checkAssert(node, { kind: "truthy" });
						return;
					}
					const method = bindings.methods.get(callee.name);
					const check = method === undefined ? undefined : ASSERT_METHODS.get(method);
					if (check !== undefined) checkAssert(node, check);
					return;
				}
				if (callee.type !== "MemberExpression" || callee.computed || callee.property.type !== "Identifier") return;

				// chai.expect(x)
				if (callee.object.type === "Identifier" && callee.object.name === "chai" && callee.property.name === "expect") {
					checkExpect(node);
					return;
				}
				// assert.equal(a, b), chai.assert.isTrue(x), assert.strict.equal(a, b)
				let objectNode: ESTree.Node = callee.object;
				if (
					objectNode.type === "MemberExpression" &&
					!objectNode.computed &&
					objectNode.property.type === "Identifier" &&
					(objectNode.property.name === "strict" || objectNode.property.name === "assert")
				) {
					objectNode = objectNode.object;
				}
				if (objectNode.type !== "Identifier") return;
				if (!bindings.namespaces.has(objectNode.name) && objectNode.name !== "chai") return;
				const check = ASSERT_METHODS.get(callee.property.name);
				if (check !== undefined) checkAssert(node, check);
			},
		};
	},
});
