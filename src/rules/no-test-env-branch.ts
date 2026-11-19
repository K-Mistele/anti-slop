// Ported from eslint-plugin-ai-guard 1.4.7 (`src/rules/ai-patterns/no-test-env-branch.ts`, MIT); see
// `src/vendor/ai-guard/UPSTREAM.md`.
import { defineRule } from "@oxlint/plugins";

import type { ESTree, SourceCode } from "@oxlint/plugins";

import { isFunctionNode } from "../shared/ast-walk.ts";
import { getEnvAccess } from "../shared/env-access.ts";
import { isNonProductionFile } from "../shared/file-context.ts";
import { resolveVariable } from "../shared/scope.ts";

/** Env vars compared against 'test': NODE_ENV === 'test'. */
const MODE_ENV_NAMES: ReadonlySet<string> = new Set(["NODE_ENV", "APP_ENV", "ENV", "ENVIRONMENT", "BABEL_ENV", "MODE"]);
/** Env vars that are only set by test runners. */
const TEST_FLAG_ENV_NAMES: ReadonlySet<string> = new Set([
	"VITEST",
	"VITEST_WORKER_ID",
	"VITEST_POOL_ID",
	"JEST_WORKER_ID",
	"MOCHA_WORKER_ID",
	"NODE_TEST_CONTEXT",
	"TEST",
	"IS_TEST",
	"TESTING",
]);
/** Globals that exist only inside a test runner: typeof jest !== 'undefined'. */
const TEST_GLOBALS: ReadonlySet<string> = new Set(["jest", "vi", "describe", "it", "expect", "beforeEach"]);

/** Test setup, helpers and tooling config legitimately branch on the test environment. */
const TEST_SUPPORT_FILE =
	/(?:^|[\\/])(?:setup-?tests?|test-?setup|vitest\.setup|jest\.setup|jest\.config|vitest\.config|test-?utils?|test-?helpers?)\.[cm]?[jt]sx?$|[\\/](?:testing|test-?utils|test-?helpers|__testutils__)[\\/]|(?:^|[\\/])[^\\/]*\.config\.[cm]?[jt]s$|(?:^|[\\/])\.?(?:babel|eslint|prettier)rc\.[cm]?js$/i;

type Polarity = "test" | "not-test" | "in-source" | null;

type FunctionNode = ESTree.Function | ESTree.ArrowFunctionExpression;

function isTestString(node: ESTree.Node): boolean {
	return node.type === "Literal" && typeof node.value === "string" && /^test(?:ing)?$/i.test(node.value);
}

function isImportMetaVitest(node: ESTree.Node): boolean {
	return (
		node.type === "MemberExpression" &&
		node.object.type === "MetaProperty" &&
		node.property.type === "Identifier" &&
		node.property.name === "vitest"
	);
}

function flip(polarity: Polarity): Polarity {
	if (polarity === "test") return "not-test";
	if (polarity === "not-test") return "test";
	return polarity;
}

/** The initializer of a `const`/`let` that is never reassigned, or null. */
function variableInitializer(sourceCode: SourceCode, identifier: ESTree.Node & { readonly name: string }): ESTree.Node | null {
	const variable = resolveVariable(sourceCode, identifier);
	const definition = variable?.defs[0];
	if (variable === null || definition?.type !== "Variable" || definition.node.type !== "VariableDeclarator") return null;
	if (variable.references.some((reference) => reference.isWrite() && !reference.init)) return null;
	return definition.node.init;
}

/** Whether the code inside `if (expr)` runs only (or always) under a test runner. */
function polarityOf(expression: ESTree.Node, sourceCode: SourceCode, depth = 0): Polarity {
	if (depth > 3) return null;
	if (isImportMetaVitest(expression)) return "in-source";

	const access = getEnvAccess(expression);
	if (access !== null && TEST_FLAG_ENV_NAMES.has(access.name)) return "test";

	switch (expression.type) {
		case "UnaryExpression":
			return expression.operator === "!" ? flip(polarityOf(expression.argument, sourceCode, depth + 1)) : null;
		case "BinaryExpression": {
			if (!["===", "==", "!==", "!="].includes(expression.operator)) return null;
			const equal = expression.operator === "===" || expression.operator === "==";
			const sides: ReadonlyArray<readonly [ESTree.Node, ESTree.Node]> = [
				[expression.left, expression.right],
				[expression.right, expression.left],
			];
			for (const [a, b] of sides) {
				const env = getEnvAccess(a);
				if (env !== null && MODE_ENV_NAMES.has(env.name) && isTestString(b)) return equal ? "test" : "not-test";
				// typeof jest !== 'undefined'
				if (
					a.type === "UnaryExpression" &&
					a.operator === "typeof" &&
					a.argument.type === "Identifier" &&
					TEST_GLOBALS.has(a.argument.name) &&
					b.type === "Literal" &&
					typeof b.value === "string"
				) {
					const defined = b.value !== "undefined";
					return equal === defined ? "test" : "not-test";
				}
			}
			return null;
		}
		case "LogicalExpression": {
			const left = polarityOf(expression.left, sourceCode, depth + 1);
			const right = polarityOf(expression.right, sourceCode, depth + 1);
			if (left === "in-source" || right === "in-source") return "in-source";
			if (expression.operator === "&&") return left === "test" || right === "test" ? "test" : null;
			return left ?? right;
		}
		case "Identifier": {
			// const isTest = process.env.NODE_ENV === 'test'
			const init = variableInitializer(sourceCode, expression);
			return init === null ? null : polarityOf(init, sourceCode, depth + 1);
		}
		case "CallExpression": {
			// const isTestEnv = () => process.env.NODE_ENV === 'test'
			if (expression.callee.type !== "Identifier" || expression.arguments.length > 0) return null;
			const definition = resolveVariable(sourceCode, expression.callee)?.defs[0];
			let fn: FunctionNode | null = null;
			if (definition?.type === "FunctionName" && definition.node.type === "FunctionDeclaration") fn = definition.node;
			if (definition?.type === "Variable" && definition.node.type === "VariableDeclarator") {
				const init = definition.node.init;
				if (init?.type === "ArrowFunctionExpression" || init?.type === "FunctionExpression") fn = init;
			}
			if (fn === null || fn.body === null || fn.body === undefined) return null;
			if (fn.body.type !== "BlockStatement") return polarityOf(fn.body, sourceCode, depth + 1);
			const only = fn.body.body.length === 1 ? fn.body.body[0] : undefined;
			return only?.type === "ReturnStatement" && only.argument !== null ? polarityOf(only.argument, sourceCode, depth + 1) : null;
		}
		default:
			return null;
	}
}

/** A hard-coded result: a literal, a literal object/array, a mock-named value, Promise.resolve(literal). */
function isCanned(node: ESTree.Node | null | undefined, sourceCode: SourceCode, depth = 0): boolean {
	if (node === null || node === undefined || depth > 6) return false;
	switch (node.type) {
		case "Literal":
			return !("regex" in node && node.regex !== undefined && node.regex !== null);
		case "TemplateLiteral":
			return node.expressions.length === 0;
		case "Identifier": {
			if (node.name === "undefined") return true;
			// const MOCK_USER = { id: 1 }: a constant bound to a literal value
			const definition = resolveVariable(sourceCode, node)?.defs[0];
			if (definition?.type !== "Variable" || definition.node.type !== "VariableDeclarator") return false;
			const declarator = definition.node;
			const declaration = declarator.parent;
			return (
				declaration?.type === "VariableDeclaration" &&
				declaration.kind === "const" &&
				declarator.id.type === "Identifier" &&
				isCanned(declarator.init, sourceCode, depth + 1)
			);
		}
		case "UnaryExpression":
			return isCanned(node.argument, sourceCode, depth + 1);
		case "ArrayExpression":
			return node.elements.every((element) => element !== null && element.type !== "SpreadElement" && isCanned(element, sourceCode, depth + 1));
		case "ObjectExpression":
			return node.properties.every((property) => property.type === "Property" && !property.computed && isCanned(property.value, sourceCode, depth + 1));
		case "CallExpression": {
			const callee = node.callee;
			return (
				callee.type === "MemberExpression" &&
				callee.object.type === "Identifier" &&
				callee.object.name === "Promise" &&
				callee.property.type === "Identifier" &&
				callee.property.name === "resolve" &&
				(node.arguments.length === 0 || isCanned(node.arguments[0], sourceCode, depth + 1))
			);
		}
		case "AwaitExpression":
			return isCanned(node.argument, sourceCode, depth + 1);
		case "TSAsExpression":
		case "TSNonNullExpression":
		case "TSSatisfiesExpression":
			return isCanned(node.expression, sourceCode, depth + 1);
		default:
			return false;
	}
}

function isNullish(node: ESTree.Node): boolean {
	if (node.type === "Literal") return node.value === null;
	if (node.type === "Identifier") return node.name === "undefined";
	if (node.type === "UnaryExpression") return node.operator === "void";
	return false;
}

/** A fabricated result: canned, and not just null/undefined ("do nothing in tests"). */
function isFabricated(node: ESTree.Node, sourceCode: SourceCode): boolean {
	return isCanned(node, sourceCode) && !isNullish(node);
}

/** Return statements in a branch, not counting nested functions. */
function cannedReturns(
	node: ESTree.Node | null | undefined,
	sourceCode: SourceCode,
	out: ESTree.ReturnStatement[] = [],
): ESTree.ReturnStatement[] {
	if (node === null || node === undefined) return out;
	switch (node.type) {
		case "ReturnStatement":
			if (node.argument !== null && isFabricated(node.argument, sourceCode)) out.push(node);
			return out;
		case "BlockStatement":
			for (const statement of node.body) cannedReturns(statement, sourceCode, out);
			return out;
		case "IfStatement":
			cannedReturns(node.consequent, sourceCode, out);
			cannedReturns(node.alternate, sourceCode, out);
			return out;
		case "TryStatement":
			cannedReturns(node.block, sourceCode, out);
			return out;
		default:
			return out;
	}
}

function enclosingFunction(node: ESTree.Node): FunctionNode | null {
	for (let current = node.parent; current !== null && current !== undefined; current = current.parent) {
		if (isFunctionNode(current)) return current;
	}
	return null;
}

const isNode = (value: unknown): value is ESTree.Node =>
	typeof value === "object" && value !== null && "type" in value && typeof value.type === "string";

/** Every return statement of a function, not counting nested functions. */
function allReturns(node: ESTree.Node, out: ESTree.ReturnStatement[] = []): ESTree.ReturnStatement[] {
	if (node.type === "ReturnStatement") {
		out.push(node);
		return out;
	}
	for (const [key, value] of Object.entries(node)) {
		if (key === "parent") continue;
		for (const child of Array.isArray(value) ? value : [value]) {
			if (isNode(child) && !isFunctionNode(child)) allReturns(child, out);
		}
	}
	return out;
}

/**
 * `function logLevel() { if (isTest) return 'silent'; return 'info'; }` picks between constants: configuration,
 * not a shortcut. True when the function has other returns and all of them are constants too.
 */
function isConstantSelector(fn: FunctionNode, testReturns: ReadonlySet<ESTree.ReturnStatement>, sourceCode: SourceCode): boolean {
	if (fn.body === null || fn.body === undefined || fn.body.type !== "BlockStatement") return false;
	const others = allReturns(fn.body).filter((statement) => !testReturns.has(statement));
	return others.length > 0 && others.every((statement) => statement.argument !== null && isCanned(statement.argument, sourceCode));
}

function enclosingFunctionName(node: ESTree.Node): string | null {
	for (let current = node.parent; current !== null && current !== undefined; current = current.parent) {
		if (current.type === "FunctionDeclaration" && current.id !== null && current.id !== undefined) return current.id.name;
		if (current.type === "FunctionExpression" || current.type === "ArrowFunctionExpression") {
			const parent = current.parent;
			if (parent?.type === "VariableDeclarator" && parent.id.type === "Identifier") return parent.id.name;
			if ((parent?.type === "MethodDefinition" || parent?.type === "Property") && parent.key.type === "Identifier") return parent.key.name;
			if (current.type === "FunctionExpression" && current.id !== null && current.id !== undefined) return current.id.name;
			return null;
		}
	}
	return null;
}

/** Reject production code that returns a hard-coded result when it detects a test runner. */
export const noTestEnvBranchRule = defineRule({
	meta: {
		type: "problem",
		docs: {
			description:
				'Disallow production code that returns a hard-coded result when it detects a test runner (`if (process.env.NODE_ENV === "test") return { ok: true }`). Tests then pass without running the real code. AI agents add these shortcuts to make failing tests pass. Test-environment checks that skip side effects (`if (NODE_ENV !== "test") app.listen()`) are allowed.',
		},
		schema: [],
		messages: {
			cannedTestResult:
				"{{name}} returns a hard-coded result when running under tests (`{{condition}}`), so tests pass without exercising the real code. AI agents add shortcuts like this to make failing tests pass. Remove the branch and make the real path testable: inject the dependency, or mock it in the test.",
		},
	},
	create(context) {
		const filename = context.physicalFilename || context.filename;
		if (isNonProductionFile(filename) || TEST_SUPPORT_FILE.test(filename)) return {};
		const { sourceCode } = context;

		function report(node: ESTree.Node, condition: ESTree.Node): void {
			// Module-level test switches are configuration, not shortcuts.
			if (enclosingFunction(node) === null) return;
			const name = enclosingFunctionName(node);
			const text = sourceCode.getText(condition).replace(/\s+/g, " ");
			context.report({
				node,
				messageId: "cannedTestResult",
				data: {
					name: name === null ? "This function" : `\`${name}\``,
					condition: text.length > 60 ? `${text.slice(0, 57)}...` : text,
				},
			});
		}

		return {
			IfStatement(node) {
				const polarity = polarityOf(node.test, sourceCode);
				if (polarity !== "test" && polarity !== "not-test") return;
				const testBranch = polarity === "test" ? node.consequent : node.alternate;
				const returns = cannedReturns(testBranch, sourceCode);
				if (returns.length === 0) return;
				const fn = enclosingFunction(node);
				if (fn !== null && isConstantSelector(fn, new Set(returns), sourceCode)) return;
				for (const statement of returns) report(statement, node.test);
			},
			// return process.env.NODE_ENV === 'test' ? { ok: true } : realCall()
			ConditionalExpression(node) {
				const parent = node.parent;
				const isReturned = parent?.type === "ReturnStatement" || (parent?.type === "ArrowFunctionExpression" && parent.body === node);
				if (!isReturned) return;
				const polarity = polarityOf(node.test, sourceCode);
				if (polarity !== "test" && polarity !== "not-test") return;
				const testValue = polarity === "test" ? node.consequent : node.alternate;
				const realValue = polarity === "test" ? node.alternate : node.consequent;
				// Choosing between two constants (log levels, labels) is configuration, not a shortcut.
				if (isFabricated(testValue, sourceCode) && !isCanned(realValue, sourceCode)) report(testValue, node.test);
			},
		};
	},
});
