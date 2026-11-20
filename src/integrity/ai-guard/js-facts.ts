// Ported from eslint-plugin-ai-guard 1.4.7 (`cli/utils/integrity/js-facts.ts`, MIT); see `src/vendor/ai-guard/UPSTREAM.md`.
// Parse JavaScript/TypeScript and extract the facts integrity analysis compares: directive comments, test
// declarations, assertion counts and `as any` casts. Upstream parses through ESLint's Linter with espree or
// @typescript-eslint/parser; this port uses oxc-parser, the parser Oxlint is built on, which yields the same ESTree
// shape. Comments and strings are handled by a real parser, so `it.skip` inside a string or comment never counts.

// oxlint-disable effecttsgo/node-builtin-import -- a standalone CLI outside any Effect runtime, so Effect's platform services do not apply

import { extname } from "node:path";

import { parseSync } from "oxc-parser";

import { parseEslintDirectives, parseTsDirectives, type CommentLike, type EslintDirective, type TsDirective } from "./directives.ts";

export interface TestDecl {
	readonly kind: "test" | "suite";
	readonly title: string;
	/** Titles from the outermost suite to this declaration, joined with " > ". */
	readonly path: string;
	readonly line: number;
	/** Skipped by this declaration itself (`.skip`, `xit`, `fixme`). */
	readonly skipped: boolean;
	/** Skipped by itself or by an enclosing suite. */
	readonly effectiveSkipped: boolean;
	readonly focused: boolean;
	readonly todo: boolean;
	readonly conditional: boolean;
	readonly parameterized: boolean;
}

export interface JsFacts {
	readonly eslintDirectives: ReadonlyArray<EslintDirective>;
	readonly tsDirectives: ReadonlyArray<TsDirective>;
	readonly tests: ReadonlyArray<TestDecl>;
	readonly assertions: { readonly total: number; readonly strict: number; readonly loose: number };
	readonly anyCasts: ReadonlyArray<number>;
}

export type ParseOutcome = { readonly ok: true; readonly facts: JsFacts } | { readonly ok: false; readonly error: string };

/** An ESTree node as oxc-parser produces it, read field by field. */
export interface AstNode {
	readonly type: string;
	readonly start?: unknown;
	readonly [key: string]: unknown;
}

export const isNode = (value: unknown): value is AstNode =>
	typeof value === "object" && value !== null && "type" in value && typeof value.type === "string";

const TEST_BASES: ReadonlySet<string> = new Set(["it", "test", "specify", "xit", "xtest", "xspecify", "fit", "ftest"]);
const SUITE_BASES: ReadonlySet<string> = new Set(["describe", "suite", "context", "xdescribe", "xcontext", "xsuite", "fdescribe"]);
const SKIP_BASES: ReadonlySet<string> = new Set(["xit", "xtest", "xspecify", "xdescribe", "xcontext", "xsuite"]);
const FOCUS_BASES: ReadonlySet<string> = new Set(["fit", "ftest", "fdescribe"]);
const MODIFIERS: ReadonlySet<string> = new Set([
	"skip",
	"only",
	"todo",
	"each",
	"for",
	"concurrent",
	"sequential",
	"failing",
	"fails",
	"skipIf",
	"runIf",
	"fixme",
	"describe",
	"serial",
	"parallel",
	"fail",
	"slow",
	"shuffle",
	// @effect/vitest: `it.effect`, `it.scoped`, `it.live` and `it.scopedLive` take an Effect; `it.prop` and `it.effect.prop`
	// are property tests. `it.flakyTest` wraps an Effect inside a test and declares nothing.
	"effect",
	"scoped",
	"live",
	"scopedLive",
	"prop",
]);
const TABLE_MODIFIERS: ReadonlySet<string> = new Set(["each", "for"]);
const CONDITIONAL_MODIFIERS: ReadonlySet<string> = new Set(["skipIf", "runIf"]);

const LOOSE_MATCHERS: ReadonlySet<string> = new Set(["toBeTruthy", "toBeFalsy", "toBeDefined", "toHaveBeenCalled", "toBeCalled"]);
const STRICT_MATCHERS: ReadonlySet<string> = new Set([
	"toBe",
	"toEqual",
	"toStrictEqual",
	"toMatchObject",
	"toHaveBeenCalledWith",
	"toBeCalledWith",
	"toHaveBeenLastCalledWith",
	"toHaveBeenNthCalledWith",
	"toHaveReturnedWith",
	"toHaveBeenCalledTimes",
	"toContain",
	"toContainEqual",
	"toHaveLength",
	"toMatch",
	"toBeNull",
	"toBeUndefined",
	"toBeNaN",
	"toBeCloseTo",
	"toBeGreaterThan",
	"toBeGreaterThanOrEqual",
	"toBeLessThan",
	"toBeLessThanOrEqual",
	"toHaveProperty",
	"toBeInstanceOf",
]);
const ASSERT_STRICT: ReadonlySet<string> = new Set([
	"equal",
	"strictEqual",
	"deepEqual",
	"deepStrictEqual",
	"notEqual",
	"notStrictEqual",
	"notDeepStrictEqual",
	"throws",
	"rejects",
	"doesNotThrow",
	"match",
	"doesNotMatch",
]);

// ─── Parsing ──────────────────────────────────────────────────────────────────

const TS_EXT: ReadonlySet<string> = new Set([".ts", ".tsx", ".mts", ".cts"]);
export const JS_TS_EXTENSIONS: ReadonlySet<string> = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"]);

/** 1-based line and 0-based column of offsets into one source text. */
export interface LineIndex {
	readonly lineOf: (offset: number) => number;
	readonly columnOf: (offset: number) => number;
}

function lineIndex(code: string): LineIndex {
	const starts = [0];
	for (let i = code.indexOf("\n"); i !== -1; i = code.indexOf("\n", i + 1)) starts.push(i + 1);
	const lineOf = (offset: number): number => {
		let lo = 0;
		let hi = starts.length - 1;
		while (lo < hi) {
			const mid = (lo + hi + 1) >> 1;
			if ((starts[mid] ?? 0) <= offset) lo = mid;
			else hi = mid - 1;
		}
		return lo + 1;
	};
	return { lineOf, columnOf: (offset) => offset - (starts[lineOf(offset) - 1] ?? 0) };
}

export interface ParsedSource {
	readonly ast: AstNode;
	readonly comments: ReadonlyArray<CommentLike>;
	readonly lines: LineIndex;
}

type Lang = "js" | "jsx" | "ts" | "tsx";

function langOf(extension: string): Lang {
	if (extension === ".tsx") return "tsx";
	// Upstream parses every JavaScript file with JSX enabled.
	return TS_EXT.has(extension) ? "ts" : "jsx";
}

/** Parse as a module, then as a script; the error is the script parse's, as upstream reports it. */
export function parseSource(code: string, repoPath: string): ParsedSource | { readonly error: string } {
	const extension = extname(repoPath).toLowerCase();
	const lang = langOf(extension);
	const lines = lineIndex(code);
	let lastError = "could not parse";
	for (const sourceType of ["module", "script"] as const) {
		const result = parseSync(`integrity-input${extension === "" ? ".js" : extension}`, code, { lang, sourceType });
		const [error] = result.errors;
		const program: unknown = result.program;
		if (error === undefined && isNode(program)) {
			const comments = result.comments.map((comment) => ({
				type: comment.type,
				value: comment.value,
				line: lines.lineOf(comment.start),
				column: lines.columnOf(comment.start),
				endLine: lines.lineOf(comment.end),
				endColumn: lines.columnOf(comment.end),
			}));
			return { ast: program, comments, lines };
		}
		if (error !== undefined) {
			const start = error.labels[0]?.start;
			lastError = `${error.message}${start === undefined ? "" : ` (line ${lines.lineOf(start)})`}`;
		}
	}
	return { error: `PARSE_ERROR: ${lastError}` };
}

// ─── AST helpers ──────────────────────────────────────────────────────────────

const SKIP_KEYS: ReadonlySet<string> = new Set(["parent", "loc", "range", "tokens", "comments"]);

function children(node: AstNode): AstNode[] {
	const out: AstNode[] = [];
	for (const [key, value] of Object.entries(node)) {
		if (SKIP_KEYS.has(key)) continue;
		if (Array.isArray(value)) out.push(...value.filter(isNode));
		else if (isNode(value)) out.push(value);
	}
	return out;
}

function identName(node: unknown): string | null {
	return isNode(node) && node.type === "Identifier" && typeof node.name === "string" ? node.name : null;
}

function memberProp(node: AstNode): string | null {
	if (node.type !== "MemberExpression" || node.computed === true) return null;
	return identName(node.property);
}

const argumentsOf = (node: AstNode): unknown[] => (Array.isArray(node.arguments) ? node.arguments : []);

interface CalleeInfo {
	readonly base: string;
	readonly modifiers: ReadonlyArray<string>;
	readonly tableApplied: boolean;
	readonly conditional: boolean;
	/** `layer(L)` or `it.layer(L)` from @effect/vitest, whose result is called like `describe`. */
	readonly layerBlock: boolean;
}

const isLayerCallee = (info: CalleeInfo): boolean =>
	(info.base === "layer" && info.modifiers.length === 0) || (TEST_BASES.has(info.base) && info.modifiers.length === 1 && info.modifiers[0] === "layer");

function flattenCallee(node: unknown): CalleeInfo | null {
	if (!isNode(node)) return null;
	const name = identName(node);
	if (name !== null) return { base: name, modifiers: [], tableApplied: false, conditional: false, layerBlock: false };
	if (node.type === "MemberExpression") {
		const prop = memberProp(node);
		const inner = flattenCallee(node.object);
		if (prop === null || inner === null) return null;
		return { ...inner, modifiers: [...inner.modifiers, prop] };
	}
	if (node.type === "CallExpression" || node.type === "TaggedTemplateExpression") {
		const inner = flattenCallee(node.type === "CallExpression" ? node.callee : node.tag);
		if (inner === null) return null;
		if (node.type === "CallExpression" && isLayerCallee(inner)) return { ...inner, layerBlock: true };
		const last = inner.modifiers.at(-1) ?? "";
		if (TABLE_MODIFIERS.has(last)) return { ...inner, tableApplied: true };
		if (node.type === "CallExpression" && CONDITIONAL_MODIFIERS.has(last)) return { ...inner, conditional: true };
		return null;
	}
	return null;
}

function titleOf(argument: unknown, hasCallback: boolean): string | null {
	if (!isNode(argument)) return null;
	if (argument.type === "Literal" && typeof argument.value === "string") return argument.value;
	if (argument.type === "TemplateLiteral") {
		const quasis: unknown[] = Array.isArray(argument.quasis) ? argument.quasis : [];
		return quasis
			.map((quasi) => {
				const value = isNode(quasi) ? quasi.value : undefined;
				if (typeof value !== "object" || value === null) return "";
				if ("cooked" in value && typeof value.cooked === "string") return value.cooked;
				return "raw" in value && typeof value.raw === "string" ? value.raw : "";
			})
			.join("${…}");
	}
	if (hasCallback && argument.type === "Identifier") return `<${identName(argument) ?? ""}>`;
	if (hasCallback && argument.type === "MemberExpression") return "<expression>";
	return null;
}

const CALLBACK_TYPES: ReadonlySet<string> = new Set(["FunctionExpression", "ArrowFunctionExpression", "Identifier", "MemberExpression", "CallExpression"]);

function isCallbackLike(node: unknown): boolean {
	return isNode(node) && CALLBACK_TYPES.has(node.type);
}

interface Recognized {
	readonly kind: "test" | "suite";
	readonly title: string;
	readonly skipped: boolean;
	readonly focused: boolean;
	readonly todo: boolean;
	readonly conditional: boolean;
	readonly parameterized: boolean;
}

function recognizeDeclaration(call: AstNode): Recognized | null {
	const info = flattenCallee(call.callee);
	if (info === null) return null;
	if (info.layerBlock) return recognizeLayerBlock(call);
	const isTest = TEST_BASES.has(info.base);
	const isSuite = SUITE_BASES.has(info.base);
	if (!isTest && !isSuite) return null;
	if (!info.modifiers.every((modifier) => MODIFIERS.has(modifier))) return null;
	// `it.each(table)` is the table call; the declaration is the outer call.
	if (info.modifiers.some((modifier) => TABLE_MODIFIERS.has(modifier)) && !info.tableApplied) return null;
	const args = argumentsOf(call);
	const hasCallback = args.length > 1 && isCallbackLike(args[1]);
	const title = titleOf(args[0], hasCallback);
	if (title === null) return null;
	const todo = info.modifiers.includes("todo") || (!hasCallback && isTest && args.length === 1);
	return {
		kind: isSuite || info.modifiers.includes("describe") ? "suite" : "test",
		title,
		skipped: SKIP_BASES.has(info.base) || info.modifiers.includes("skip") || info.modifiers.includes("fixme"),
		focused: FOCUS_BASES.has(info.base) || info.modifiers.includes("only"),
		todo,
		conditional: info.conditional,
		parameterized: info.tableApplied,
	};
}

/** A named `layer(L)("name", (it) => ...)` block is a suite; an anonymous `layer(L)((it) => ...)` adds no title. */
function recognizeLayerBlock(call: AstNode): Recognized | null {
	const args = argumentsOf(call);
	const title = args.length > 1 && isCallbackLike(args[1]) ? titleOf(args[0], true) : null;
	if (title === null) return null;
	return { kind: "suite", title, skipped: false, focused: false, todo: false, conditional: false, parameterized: false };
}

const EXPECT_CHAIN: ReadonlySet<string> = new Set(["not", "resolves", "rejects"]);

/** Matcher name for `expect(x)[.not|.resolves|.rejects].matcher(...)`, else null. */
function expectMatcher(call: AstNode): string | null {
	const callee = call.callee;
	if (!isNode(callee) || callee.type !== "MemberExpression") return null;
	const matcher = memberProp(callee);
	if (matcher === null) return null;
	let object: unknown = callee.object;
	while (isNode(object) && object.type === "MemberExpression" && EXPECT_CHAIN.has(memberProp(object) ?? "")) object = object.object;
	if (!isNode(object) || object.type !== "CallExpression") return null;
	const expectCallee = object.callee;
	if (identName(expectCallee) === "expect") return matcher;
	if (isNode(expectCallee) && expectCallee.type === "MemberExpression" && identName(expectCallee.object) === "expect" && memberProp(expectCallee) === "soft") {
		return matcher;
	}
	return null;
}

// ─── Extraction ───────────────────────────────────────────────────────────────

function extractFacts(parsed: ParsedSource): JsFacts {
	const tests: TestDecl[] = [];
	const assertions = { total: 0, strict: 0, loose: 0 };
	const anyCasts: number[] = [];
	const lineOfNode = (node: AstNode): number => (typeof node.start === "number" ? parsed.lines.lineOf(node.start) : 0);

	const countAssertion = (node: AstNode): void => {
		const matcher = expectMatcher(node);
		if (matcher !== null) {
			assertions.total += 1;
			const argCount = argumentsOf(node).length;
			const isThrow = matcher === "toThrow" || matcher === "toThrowError";
			if (LOOSE_MATCHERS.has(matcher) || (isThrow && argCount === 0)) assertions.loose += 1;
			else if (STRICT_MATCHERS.has(matcher) || isThrow) assertions.strict += 1;
			return;
		}
		const callee = node.callee;
		if (!isNode(callee)) return;
		if (identName(callee) === "assert") {
			assertions.total += 1;
			assertions.loose += 1;
		} else if (callee.type === "MemberExpression" && identName(callee.object) === "assert") {
			assertions.total += 1;
			if (ASSERT_STRICT.has(memberProp(callee) ?? "")) assertions.strict += 1;
			else assertions.loose += 1;
		} else if (callee.type === "MemberExpression" && identName(callee.object) === "expect" && ["anything", "any"].includes(memberProp(callee) ?? "")) {
			assertions.loose += 1;
		}
	};

	const visit = (node: AstNode, suitePath: ReadonlyArray<string>, ancestorSkipped: boolean): void => {
		if (node.type === "CallExpression") {
			const declaration = recognizeDeclaration(node);
			if (declaration !== null) {
				const fullPath = [...suitePath, declaration.title];
				const effectiveSkipped = declaration.skipped || ancestorSkipped;
				tests.push({ ...declaration, path: fullPath.join(" > "), line: lineOfNode(node), effectiveSkipped });
				const nextPath = declaration.kind === "suite" ? fullPath : suitePath;
				for (const argument of argumentsOf(node)) if (isNode(argument)) visit(argument, nextPath, effectiveSkipped);
				return;
			}
			countAssertion(node);
		} else if ((node.type === "TSAsExpression" || node.type === "TSTypeAssertion") && isNode(node.typeAnnotation) && node.typeAnnotation.type === "TSAnyKeyword") {
			anyCasts.push(lineOfNode(node));
		}
		for (const child of children(node)) visit(child, suitePath, ancestorSkipped);
	};
	visit(parsed.ast, [], false);

	return {
		eslintDirectives: parseEslintDirectives(parsed.comments),
		tsDirectives: parseTsDirectives(parsed.comments),
		tests,
		assertions,
		anyCasts,
	};
}

export function analyzeJs(code: string, repoPath: string): ParseOutcome {
	const parsed = parseSource(code, repoPath);
	if ("error" in parsed) return { ok: false, error: parsed.error };
	return { ok: true, facts: extractFacts(parsed) };
}

/** True for files that look like test files by name or location. */
export function isTestPath(repoPath: string): boolean {
	const path = repoPath.replace(/\\/g, "/");
	if (!JS_TS_EXTENSIONS.has(extname(path).toLowerCase())) return false;
	return /\.(test|spec|e2e|cy)\.[cm]?[jt]sx?$/i.test(path) || /(^|\/)(__tests__|tests?|e2e|cypress)\//i.test(path);
}

export function activeTests(facts: JsFacts): TestDecl[] {
	return facts.tests.filter((test) => test.kind === "test" && !test.effectiveSkipped && !test.todo);
}
