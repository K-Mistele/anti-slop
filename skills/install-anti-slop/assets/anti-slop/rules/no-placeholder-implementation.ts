// Ported from eslint-plugin-ai-guard 1.4.7 (`src/rules/ai-patterns/no-placeholder-implementation.ts`, MIT); see
// `src/vendor/ai-guard/UPSTREAM.md`.
import { defineRule } from "@oxlint/plugins";

import type { ESTree, SourceCode } from "@oxlint/plugins";

import { someDescendant } from "../shared/ast-walk.ts";
import { isNonProductionFile, isTestFile } from "../shared/file-context.ts";

// ─── Elision comments ────────────────────────────────────────────────────────
// Left when a model rewrites a file and replaces code it did not reproduce with a marker. Shipping one usually
// means real code was deleted.

const CODE_NOUN =
	"(?:code|file|implementation|function|functions|component|components|class|logic|methods?|handlers?|routes?|tests?|cases|module|config|configuration|properties|fields|imports|exports|jsx|markup|styles?|content|body|types|interfaces|hooks|state|props|endpoints|queries|reducers|actions|selectors|middleware|helpers|utils|setup)";

const ELLIPSIS = "(?:\\.{3}|\\u2026)";

/** "rest of the code", "existing methods", "other tests". */
const SUBJECT =
	`(?:(?:all\\s+)?(?:the\\s+)?(?:rest|remainder)\\s+of\\s+(?:the\\s+|this\\s+|your\\s+)?${CODE_NOUN}` +
	`|(?:keep(?:ing)?\\s+)?(?:all\\s+)?(?:the\\s+|your\\s+)?(?:existing|previous|original|other|remaining|same|old|more)\\s+${CODE_NOUN})`;

/** "remains the same", "unchanged", "here", "omitted for brevity". */
const TAIL =
	"(?:\\s+(?:(?:remains?|stays?|is|are|left)\\s+)?(?:the same|unchanged|as is|as before|here|goes here|go here|omitted|elided|truncated|not shown|for brevity|omitted for brevity))";

const END = `\\s*(?:${ELLIPSIS})?\\s*[)\\].]?\\s*$`;

/** Forms that are elisions wherever they appear. */
const STRONG_ELISION: ReadonlyArray<RegExp> = [
	// "... existing code", "... rest of the code remains the same", "…(unchanged)"
	new RegExp(`^${ELLIPSIS}\\s*[(\\[]?\\s*${SUBJECT}${TAIL}?${END}`),
	new RegExp(`^${ELLIPSIS}\\s*[(\\[]?\\s*(?:unchanged|omitted|truncated|snip|same as (?:before|above))${END}`),
	// "existing code here", "other methods unchanged", "rest of the file stays the same"
	new RegExp(`^${SUBJECT}${TAIL}${END}`),
	// "your code here", "add your logic here", "implementation goes here"
	/^(?:\/\/\s*)?(?:todo:?\s*)?(?:your|add(?:\s+your)?|insert(?:\s+your)?|put(?:\s+your)?|implement(?:\s+your)?|write(?:\s+your)?)\s+(?:own\s+)?(?:code|logic|implementation|business logic)\s+(?:goes\s+)?here\b/,
	/^(?:the\s+)?(?:code|logic|implementation)\s+(?:goes|would go|omitted|truncated)\s+(?:here|for brevity)\b/,
];

/**
 * Forms that are also normal section labels ("// Rest of the implementation", "// same as before"). They count
 * only when no code follows before the block closes.
 */
const WEAK_ELISION: ReadonlyArray<RegExp> = [
	new RegExp(`^${SUBJECT}${END}`),
	new RegExp(`^[(\\[]?\\s*(?:unchanged|same as (?:before|above)|as before)${END}`),
];

/** Elision markers are short notes, not prose; long comments are documentation. */
const MAX_ELISION_COMMENT_LENGTH = 100;

function normalizeComment(comment: ESTree.Comment): string {
	return comment.value
		.split("\n")
		.map((line) => line.replace(/^\s*\*?\s?/, ""))
		.join(" ")
		.trim()
		.toLowerCase();
}

function isElisionText(comment: ESTree.Comment): "strong" | "weak" | null {
	// JSDoc blocks hold examples where elision is a normal writing device.
	if (comment.type === "Block" && comment.value.startsWith("*")) return null;
	const text = normalizeComment(comment);
	if (text.length === 0 || text.length > MAX_ELISION_COMMENT_LENGTH) return null;
	if (/^(?:eslint|ai-guard|@ts-|prettier|istanbul|c8|webpack|vite)/.test(text)) return null;
	if (STRONG_ELISION.some((pattern) => pattern.test(text))) return "strong";
	if (WEAK_ELISION.some((pattern) => pattern.test(text))) return "weak";
	return null;
}

const CLOSING_TOKENS: ReadonlySet<string> = new Set(["}", "]", ")"]);

const TYPE_ONLY_CONTAINERS: ReadonlySet<string> = new Set(["TSInterfaceBody", "TSTypeLiteral", "TSModuleBlock"]);

/**
 * `interface Session { // ...other properties }` is a hint for whoever extends the type; nothing at runtime was
 * deleted, and tsc reports missing members.
 */
function isInTypeOnlyContext(comment: ESTree.Comment, sourceCode: SourceCode): boolean {
	for (let node = sourceCode.getNodeByRangeIndex(comment.start); node !== null && node !== undefined; node = node.parent ?? null) {
		if (TYPE_ONLY_CONTAINERS.has(node.type)) return true;
	}
	return false;
}

function isElisionComment(comment: ESTree.Comment, sourceCode: SourceCode): boolean {
	const strength = isElisionText(comment);
	if (strength === "strong") return true;
	if (strength !== "weak") return false;
	// A weak marker is an elision only when nothing follows it in the block.
	const next = sourceCode.getTokenAfter(comment, { includeComments: false });
	return next === null || CLOSING_TOKENS.has(next.value);
}

// ─── Stub bodies ─────────────────────────────────────────────────────────────

/**
 * Markers of unfinished work. Bare "implementation" is deliberately absent: "// default implementation: no-op"
 * documents an intentional empty body.
 */
const STUB_COMMENT_PATTERN =
	/\b(?:todo|fixme|xxx|tbd|stub|stubbed|placeholder|not (?:yet )?implemented|to be implemented|implement (?:this|me|later|here|logic)|needs? (?:an )?implementation|add (?:the )?(?:implementation|logic)|fill (?:this )?in)\b/i;

const NOT_IMPLEMENTED_MESSAGE =
	/^(?:(?:method|function|feature|endpoint|handler|this)\s+)?(?:is\s+)?(?:not\s+(?:yet\s+)?implemented|unimplemented|todo|implement me|not supported yet)\b/i;

/** Wording that marks an intentional "subclasses must override" contract. */
const OVERRIDE_CONTRACT = /\b(?:subclass|sub-class|override|overridden|derived|abstract|must be implemented|should be implemented|implemented by|child class)\b/i;

type FunctionNode = ESTree.Function | ESTree.ArrowFunctionExpression;

function isPromiseResolve(node: ESTree.CallExpression): boolean {
	const callee = node.callee;
	return (
		callee.type === "MemberExpression" &&
		callee.object.type === "Identifier" &&
		callee.object.name === "Promise" &&
		callee.property.type === "Identifier" &&
		callee.property.name === "resolve"
	);
}

function isTrivialValue(node: ESTree.Node | null | undefined): boolean {
	if (node === null || node === undefined) return true;
	switch (node.type) {
		case "Literal":
			return node.value === null || node.value === "" || node.value === 0 || typeof node.value === "boolean";
		case "Identifier":
			return node.name === "undefined";
		case "ArrayExpression":
			return node.elements.length === 0;
		case "ObjectExpression":
			return node.properties.length === 0;
		case "CallExpression":
			// Promise.resolve() / Promise.resolve(null)
			return isPromiseResolve(node) && node.arguments.length <= 1 && (node.arguments.length === 0 || isTrivialValue(node.arguments[0]));
		case "TSAsExpression":
		case "TSNonNullExpression":
			return isTrivialValue(node.expression);
		default:
			return false;
	}
}

function isConsoleCall(statement: ESTree.Node): boolean {
	return (
		statement.type === "ExpressionStatement" &&
		statement.expression.type === "CallExpression" &&
		statement.expression.callee.type === "MemberExpression" &&
		statement.expression.callee.object.type === "Identifier" &&
		statement.expression.callee.object.name === "console"
	);
}

function describeValue(node: ESTree.Node): string {
	if (node.type === "Literal") return node.raw ?? String(node.value);
	if (node.type === "Identifier") return node.name;
	if (node.type === "ArrayExpression") return "[]";
	if (node.type === "ObjectExpression") return "{}";
	if (node.type === "TSAsExpression" || node.type === "TSNonNullExpression") return describeValue(node.expression);
	return "Promise.resolve()";
}

/** Describes a body that does nothing real, or returns null when it does something. */
function describeTrivialBody(body: ESTree.FunctionBody): string | null {
	const statements = body.body;
	if (statements.length === 0) return "is empty";
	if (statements.length > 2) return null;

	const nonLogging = statements.filter((statement) => !isConsoleCall(statement));
	if (nonLogging.length === 0) return "only logs";
	const [only] = nonLogging;
	if (nonLogging.length > 1 || only === undefined) return null;

	if (only.type === "ReturnStatement" && isTrivialValue(only.argument)) {
		return only.argument === null ? "only returns" : `only returns \`${describeValue(only.argument)}\``;
	}
	return null;
}

function getFunctionName(fn: FunctionNode): string {
	if (fn.type !== "ArrowFunctionExpression" && fn.id !== null && fn.id !== undefined) return fn.id.name;
	const parent = fn.parent;
	if (parent?.type === "VariableDeclarator" && parent.id.type === "Identifier") return parent.id.name;
	if ((parent?.type === "MethodDefinition" || parent?.type === "Property" || parent?.type === "PropertyDefinition") && parent.key.type === "Identifier") {
		return parent.key.name;
	}
	return "anonymous function";
}

function getEnclosingClass(fn: FunctionNode): ESTree.Class | null {
	const parent = fn.parent;
	if (parent?.type !== "MethodDefinition" && parent?.type !== "PropertyDefinition") return null;
	const cls = parent.parent?.parent;
	return cls?.type === "ClassDeclaration" || cls?.type === "ClassExpression" ? cls : null;
}

/** Base classes legitimately throw "not implemented" to force an override. */
function isOverridableBaseMethod(fn: FunctionNode, sourceCode: SourceCode): boolean {
	const cls = getEnclosingClass(fn);
	const member = fn.parent;
	if (cls === null || member === null || member === undefined) return false;
	if (cls.abstract === true) return true;
	const name = cls.id?.name ?? "";
	if (/^(?:Abstract|Base)[A-Z_]|Base$/.test(name)) return true;

	// Plain JS has no `abstract`: base classes document it with JSDoc instead.
	const docs = [...sourceCode.getCommentsBefore(member), ...sourceCode.getCommentsBefore(cls)];
	if (docs.some((comment) => /@(?:abstract|virtual)\b/.test(comment.value))) return true;

	// A class extended in the same file is a base class.
	return (
		name !== "" &&
		someDescendant(
			sourceCode.ast,
			(node) =>
				(node.type === "ClassDeclaration" || node.type === "ClassExpression") &&
				node.superClass?.type === "Identifier" &&
				node.superClass.name === name,
		)
	);
}

function getThrownMessage(statement: ESTree.Node): { readonly message: string | null; readonly errorName: string } | null {
	if (statement.type !== "ThrowStatement") return null;
	const argument = statement.argument;
	if ((argument.type !== "NewExpression" && argument.type !== "CallExpression") || argument.callee.type !== "Identifier") return null;
	const [first] = argument.arguments;
	let message: string | null = null;
	if (first?.type === "Literal" && typeof first.value === "string") message = first.value;
	else if (first?.type === "TemplateLiteral") message = first.quasis.map((quasi) => quasi.value.cooked ?? "").join("${...}");
	return { message, errorName: argument.callee.name };
}

// ─── Mock data in production code ───────────────────────────────────────────

const MOCK_NAME = /^(?:mock|mocked|dummy|fake|stub|stubbed|hardcoded)(?:[A-Z0-9_]|$)|^(?:MOCK|DUMMY|FAKE|STUB|HARDCODED)_/;

const RESPONSE_METHODS: ReadonlySet<string> = new Set(["json", "send", "jsonp"]);

const WRAPPER_TYPES: ReadonlySet<string> = new Set([
	"MemberExpression",
	"SpreadElement",
	"ArrayExpression",
	"Property",
	"ObjectExpression",
	"AwaitExpression",
	"TSAsExpression",
]);

/** True when a reference to the mock variable is what the code hands back. */
function isServedReference(identifier: ESTree.Node): boolean {
	let node: ESTree.Node = identifier;
	// Allow simple wrappers: mockUsers.filter(...), [...mockUsers], { data: mockUsers }
	for (let depth = 0; depth < 4; depth += 1) {
		const parent: ESTree.Node | null | undefined = node.parent;
		if (parent === null || parent === undefined) return false;
		if (parent.type === "ReturnStatement") return true;
		if (parent.type === "ArrowFunctionExpression" && parent.body === node) return true;
		if (parent.type === "CallExpression" && parent.arguments.some((argument) => argument === node)) {
			const callee = parent.callee;
			if (callee.type === "MemberExpression" && callee.property.type === "Identifier") {
				if (RESPONSE_METHODS.has(callee.property.name)) return true;
				if (callee.property.name === "resolve" && callee.object.type === "Identifier" && callee.object.name === "Promise") {
					node = parent;
					continue;
				}
			}
			return callee.type === "Identifier" && (callee.name === "useState" || callee.name === "json");
		}
		// mockUsers.filter(...): keep walking from the call result
		if (WRAPPER_TYPES.has(parent.type) || (parent.type === "CallExpression" && parent.callee === node)) {
			node = parent;
			continue;
		}
		return false;
	}
	return false;
}

function truncate(text: string): string {
	const oneLine = text.replace(/\s+/g, " ");
	return oneLine.length > 60 ? `${oneLine.slice(0, 57)}...` : oneLine;
}

/** Reject elision comments, TODO stubs, "Not implemented" bodies and mock data served from production code. */
export const noPlaceholderImplementationRule = defineRule({
	meta: {
		type: "problem",
		docs: {
			description:
				'Disallow placeholder code left by AI agents: elision comments that replace deleted code ("// ... rest of the code"), stub functions that only hold a TODO, functions whose whole body throws "Not implemented", and hardcoded mock data served from production code. Agents leave these behind and report the task as finished.',
		},
		schema: [],
		messages: {
			elidedCode:
				'Elision comment "{{comment}}" stands in for code that is not there. AI tools write this when they rewrite a file without reproducing all of it, which silently deletes the original code. Restore the missing code from version control or write it out in full.',
			stubBody:
				'`{{name}}` is a placeholder: its body {{what}} next to a "{{comment}}" comment. AI agents leave stubs like this and report the task as done. Implement it, or throw an explicit error if it must not be called yet.',
			notImplemented:
				"`{{name}}` only throws `{{thrown}}`, so every call fails at runtime. This is a stub an AI agent or IDE quick fix generated. Implement it before shipping.",
			mockData:
				"`{{name}}` is hardcoded mock data served from production code. Agents substitute mock data when they cannot reach the real data source, so the feature looks finished while returning fake results. Load it from the real source, or move it into a test fixture.",
		},
	},
	create(context) {
		const filename = context.physicalFilename || context.filename;
		const nonProduction = isNonProductionFile(filename);
		const testFile = isTestFile(filename);
		const { sourceCode } = context;

		function checkFunction(fn: FunctionNode): void {
			const body = fn.body;
			if (body === null || body === undefined || body.type !== "BlockStatement") return;

			// throw new Error('Not implemented') as the entire body
			const [onlyStatement] = body.body;
			if (body.body.length === 1 && onlyStatement !== undefined) {
				const thrown = getThrownMessage(onlyStatement);
				if (thrown !== null) {
					const isNotImplementedError = /^NotImplemented(?:Error|Exception)?$/.test(thrown.errorName);
					const matches = isNotImplementedError || (thrown.message !== null && NOT_IMPLEMENTED_MESSAGE.test(thrown.message.trim()));
					if (matches && !OVERRIDE_CONTRACT.test(thrown.message ?? "") && !isOverridableBaseMethod(fn, sourceCode)) {
						context.report({
							node: onlyStatement,
							messageId: "notImplemented",
							data: {
								name: getFunctionName(fn),
								thrown: thrown.message === null ? `${thrown.errorName}()` : `${thrown.errorName}('${truncate(thrown.message)}')`,
							},
						});
					}
					return;
				}
			}

			const what = describeTrivialBody(body);
			if (what === null) return;
			const stubComment = sourceCode
				.getCommentsInside(body)
				.find((comment) => STUB_COMMENT_PATTERN.test(comment.value) && !isElisionComment(comment, sourceCode));
			if (stubComment === undefined) return;

			context.report({
				loc: stubComment.loc,
				messageId: "stubBody",
				data: { name: getFunctionName(fn), what, comment: truncate(stubComment.value.trim()) },
			});
		}

		function checkComments(): void {
			// Examples, stories and demos elide code on purpose; tests do not.
			if (nonProduction && !testFile) return;
			for (const comment of sourceCode.getAllComments()) {
				if (comment.type === "Shebang") continue;
				if (isElisionComment(comment, sourceCode) && !isInTypeOnlyContext(comment, sourceCode)) {
					context.report({ loc: comment.loc, messageId: "elidedCode", data: { comment: truncate(comment.value.trim()) } });
				}
			}
		}

		if (nonProduction) return { Program: checkComments };

		return {
			Program: checkComments,
			FunctionDeclaration: checkFunction,
			FunctionExpression: checkFunction,
			ArrowFunctionExpression: checkFunction,
			VariableDeclarator(node) {
				if (node.id.type !== "Identifier" || !MOCK_NAME.test(node.id.name)) return;
				const init = node.init;
				const isDataLiteral =
					(init?.type === "ArrayExpression" && init.elements.length > 0) || (init?.type === "ObjectExpression" && init.properties.length > 0);
				if (!isDataLiteral) return;

				const [variable] = sourceCode.getDeclaredVariables(node);
				if (variable === undefined) return;
				if (!variable.references.some((reference) => !reference.init && isServedReference(reference.identifier))) return;

				context.report({ node: node.id, messageId: "mockData", data: { name: node.id.name } });
			},
		};
	},
});
