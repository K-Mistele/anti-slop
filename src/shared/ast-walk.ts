// Ported from eslint-plugin-ai-guard 1.4.7 (`src/utils/ast-helpers.ts`, MIT); see `src/vendor/ai-guard/UPSTREAM.md`.
import type { ESTree } from "@oxlint/plugins";

const isNode = (value: unknown): value is ESTree.Node =>
	typeof value === "object" && value !== null && "type" in value && typeof value.type === "string";

export const isFunctionNode = (node: ESTree.Node): node is ESTree.Function | ESTree.ArrowFunctionExpression =>
	node.type === "FunctionDeclaration" || node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression";

/** The child nodes of `node`, skipping its `parent` link. */
export function childNodes(node: ESTree.Node): ESTree.Node[] {
	const children: ESTree.Node[] = [];
	for (const [key, value] of Object.entries(node)) {
		if (key === "parent") continue;
		if (Array.isArray(value)) {
			for (const item of value) if (isNode(item)) children.push(item);
		} else if (isNode(value)) {
			children.push(value);
		}
	}
	return children;
}

/**
 * True if `predicate` matches `node` or any descendant. With `skipFunctions`, nested function bodies are not
 * entered (their awaits and returns are their own).
 */
export function someDescendant(
	node: ESTree.Node,
	predicate: (candidate: ESTree.Node) => boolean,
	options: { readonly skipFunctions?: boolean } = {},
): boolean {
	const stack: ESTree.Node[] = [node];
	for (let current = stack.pop(); current !== undefined; current = stack.pop()) {
		if (predicate(current)) return true;
		if (options.skipFunctions === true && current !== node && isFunctionNode(current)) continue;
		stack.push(...childNodes(current));
	}
	return false;
}
