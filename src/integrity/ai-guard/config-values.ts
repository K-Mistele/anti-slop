// Ported from eslint-plugin-ai-guard 1.4.7 (`cli/utils/integrity/config-values.ts`, MIT); see `src/vendor/ai-guard/UPSTREAM.md`.
// Static configuration values for integrity analysis. Config files are never executed. JSON/JSONC/YAML documents are
// parsed as data; JavaScript/TypeScript configs (eslint.config.js, vitest.config.ts, ...) are parsed to an AST and only
// literal values inside object literals are read. Anything computed is UNKNOWN, so analyzers can report a conservative
// advisory instead of claiming a confirmed weakening.

import { load } from "js-yaml";

import { isNode, type AstNode } from "./js-facts.ts";

export const UNKNOWN: unique symbol = Symbol("unknown");
export type Scalar = string | number | boolean | null | typeof UNKNOWN;

export interface PathEntry {
	/** Object keys from the outermost literal; array elements appear as `[i]`. */
	readonly path: ReadonlyArray<string>;
	readonly value: Scalar;
}

export { parseJsonc } from "../../shared/jsonc.ts";

/** Parse YAML as data (no custom types). Throws on invalid input. */
export function parseYaml(text: string): unknown {
	return load(text);
}

const isPlainObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function scalarOf(value: unknown): Scalar {
	if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
	return UNKNOWN;
}

/** Flatten a parsed JSON/YAML value into scalar path entries. */
export function entriesFromValue(value: unknown, prefix: ReadonlyArray<string> = []): PathEntry[] {
	const out: PathEntry[] = [];
	const walk = (current: unknown, path: ReadonlyArray<string>): void => {
		if (Array.isArray(current)) current.forEach((element: unknown, i) => walk(element, [...path, `[${i}]`]));
		else if (isPlainObject(current)) for (const [key, child] of Object.entries(current)) walk(child, [...path, key]);
		else out.push({ path, value: scalarOf(current) });
	};
	walk(value, prefix);
	return out;
}

function keyName(property: AstNode): string | null {
	if (property.computed === true) return null;
	const key = property.key;
	if (!isNode(key)) return null;
	if (key.type === "Identifier" && typeof key.name === "string") return key.name;
	if (key.type === "Literal" && (typeof key.value === "string" || typeof key.value === "number")) return String(key.value);
	return null;
}

function literalValue(node: AstNode): Scalar {
	if (node.type === "Literal") return scalarOf(node.value);
	if (node.type === "TemplateLiteral" && Array.isArray(node.expressions) && node.expressions.length === 0) {
		const [first] = Array.isArray(node.quasis) ? node.quasis : [];
		const cooked = isNode(first) && isPlainObject(first.value) ? first.value.cooked : undefined;
		return typeof cooked === "string" ? cooked : "";
	}
	if (node.type === "UnaryExpression" && node.operator === "-" && isNode(node.argument) && node.argument.type === "Literal") {
		const value = node.argument.value;
		if (typeof value === "number") return -value;
	}
	if ((node.type === "TSAsExpression" || node.type === "TSSatisfiesExpression") && isNode(node.expression)) return literalValue(node.expression);
	return UNKNOWN;
}

const SKIP_KEYS: ReadonlySet<string> = new Set(["parent", "loc", "range", "tokens", "comments"]);

const nodesOf = (value: unknown): AstNode[] => (Array.isArray(value) ? value.filter(isNode) : isNode(value) ? [value] : []);

/** Collect literal values from every object literal in a JS/TS config AST. */
export function entriesFromAst(ast: AstNode): PathEntry[] {
	const out: PathEntry[] = [];

	const visitAny = (node: AstNode): void => {
		if (node.type === "ObjectExpression") {
			visitObject(node, []);
			return;
		}
		for (const [key, value] of Object.entries(node)) {
			if (!SKIP_KEYS.has(key)) for (const child of nodesOf(value)) visitAny(child);
		}
	};

	const visitValue = (node: AstNode, path: ReadonlyArray<string>): void => {
		if (node.type === "ObjectExpression") {
			visitObject(node, path);
			return;
		}
		if (node.type === "ArrayExpression") {
			const elements: unknown[] = Array.isArray(node.elements) ? node.elements : [];
			elements.forEach((element, i) => {
				if (isNode(element)) visitValue(element, [...path, `[${i}]`]);
			});
			return;
		}
		const value = literalValue(node);
		out.push({ path, value });
		if (value === UNKNOWN) visitAny(node);
	};

	const visitObject = (object: AstNode, path: ReadonlyArray<string>): void => {
		for (const property of nodesOf(object.properties)) {
			if (property.type !== "Property") {
				visitAny(property);
				continue;
			}
			const name = keyName(property);
			const value = property.value;
			if (!isNode(value)) continue;
			if (name === null) visitAny(value);
			else visitValue(value, [...path, name]);
		}
	};

	visitAny(ast);
	return out;
}

export function pathKey(path: ReadonlyArray<string>): string {
	return JSON.stringify(path);
}

export function displayPath(path: ReadonlyArray<string>): string {
	return path.map((segment, i) => (segment.startsWith("[") ? segment : i === 0 ? segment : `.${segment}`)).join("");
}

export function formatScalar(value: Scalar | undefined): string {
	if (value === undefined) return "(not set)";
	if (value === UNKNOWN) return "(computed)";
	return JSON.stringify(value);
}
