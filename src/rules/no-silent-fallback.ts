// Ported from eslint-plugin-ai-guard 1.4.7 (`src/rules/reliability/no-silent-fallback.ts`, MIT); see
// `src/vendor/ai-guard/UPSTREAM.md`.
import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

import { isFunctionNode, someDescendant } from "../shared/ast-walk.ts";
import { getEnvAccess, isGenericSecretEnvName, isImportMetaEnv, isProcessEnv } from "../shared/env-access.ts";
import { isNonProductionFile } from "../shared/file-context.ts";

/** Test-runner configs legitimately hardcode throwaway secrets. */
const TEST_CONFIG_FILE = /(?:^|[\\/])(?:vitest|jest|playwright|cypress|karma)\.(?:config|setup)[^\\/]*$/i;

/** Fallbacks that are durations or numbers, e.g. `JWT_SECRET_TTL || '15m'`. */
const NON_SECRET_VALUE = /^(?:\d+(?:\.\d+)?[a-z]{0,3}|true|false)$/i;

function getStaticString(node: ESTree.Node): string | null {
	if (node.type === "Literal" && typeof node.value === "string") return node.value;
	if (node.type === "TemplateLiteral" && node.expressions.length === 0) return node.quasis[0]?.value.cooked ?? null;
	return null;
}

/** Leftmost operands of `a || b || 'x'` (same operator), excluding the final fallback. */
function collectPrimaryOperands(node: ESTree.LogicalExpression): ESTree.Node[] {
	const operands: ESTree.Node[] = [];
	let current: ESTree.Node = node.left;
	while (current.type === "LogicalExpression" && current.operator === node.operator) {
		operands.unshift(current.right);
		current = current.left;
	}
	operands.unshift(current);
	return operands;
}

const ENVIRONMENT_ENV_NAME = /^(?:NODE_ENV|APP_ENV|ENVIRONMENT|ENV|VERCEL_ENV|DEV|PROD|MODE)$/;
const ENVIRONMENT_FLAG_NAME = /^(?:is)?(?:dev|development|local|test|testing|debug)(?:mode|env|build)?$/i;

function containsEnvironmentCheck(node: ESTree.Node): boolean {
	return someDescendant(node, (candidate) => {
		const access = getEnvAccess(candidate);
		if (access !== null) return ENVIRONMENT_ENV_NAME.test(access.name);
		return candidate.type === "Identifier" && ENVIRONMENT_FLAG_NAME.test(candidate.name);
	});
}

/** Inside `if (process.env.NODE_ENV !== 'production') { ... }` or `isDev ? ... : ...`. */
function isGuardedByEnvironmentCheck(node: ESTree.Node): boolean {
	let child: ESTree.Node = node;
	for (let parent = node.parent; parent !== null && parent !== undefined; parent = parent.parent) {
		if (parent.type === "IfStatement" && parent.test !== child && containsEnvironmentCheck(parent.test)) return true;
		if (parent.type === "ConditionalExpression" && parent.test !== child && containsEnvironmentCheck(parent.test)) return true;
		if (parent.type === "LogicalExpression" && parent.right === child && containsEnvironmentCheck(parent.left)) return true;
		if (isFunctionNode(parent)) return false;
		child = parent;
	}
	return false;
}

/** Awaits inside nested functions belong to those functions, not this try block. */
function containsAwait(node: ESTree.Node): boolean {
	return someDescendant(node, (candidate) => candidate.type === "AwaitExpression", { skipFunctions: true });
}

function emptyCollection(node: ESTree.Node | null): "[]" | "{}" | null {
	if (node === null) return null;
	if (node.type === "ArrayExpression" && node.elements.length === 0) return "[]";
	if (node.type === "ObjectExpression" && node.properties.length === 0) return "{}";
	if (node.type === "TSAsExpression") return emptyCollection(node.expression);
	return null;
}

function displayValue(value: string): string {
	return value.length > 24 ? `${value.slice(0, 21)}...` : value;
}

/** Reject hardcoded secret fallbacks and catch blocks that turn a failed await into an empty result. */
export const noSilentFallbackRule = defineRule({
	meta: {
		type: "problem",
		docs: {
			description:
				'Disallow fallbacks that hide failures: secret env vars that default to a hardcoded value (`process.env.JWT_SECRET || "secret"`) and catch blocks that turn a failed awaited call into an empty result (`catch { return [] }`). AI tools add these to make code run without configuration or to make an error go away, and the failure resurfaces later as forged tokens or silently empty data.',
		},
		schema: [],
		messages: {
			hardcodedSecretFallback:
				'`{{name}}` falls back to the hardcoded value "{{value}}" when the env var is missing. In production that means running with a secret anyone can read in the repository (for a JWT secret, anyone can forge tokens). Fail at startup instead: `if (!process.env.{{name}}) throw new Error("{{name}} is not set")`.',
			swallowedFailure:
				'This catch block turns any failure of the awaited call into `{{value}}`. Callers cannot tell "no data" from "the request failed", and the error is never logged. Log and rethrow, or return an explicit error state the caller must handle.',
		},
	},
	create(context) {
		const filename = context.physicalFilename || context.filename;
		if (isNonProductionFile(filename) || TEST_CONFIG_FILE.test(filename)) return {};

		function reportSecretFallback(node: ESTree.Node, name: string, value: string): void {
			if (value.trim() === "" || NON_SECRET_VALUE.test(value.trim())) return;
			if (isGuardedByEnvironmentCheck(node)) return;
			context.report({ node, messageId: "hardcodedSecretFallback", data: { name, value: displayValue(value) } });
		}

		return {
			LogicalExpression(node) {
				if (node.operator !== "||" && node.operator !== "??") return;
				// Only the outermost expression of a chain carries the final fallback.
				const parent = node.parent;
				if (parent?.type === "LogicalExpression" && parent.left === node && parent.operator === node.operator) return;
				const value = getStaticString(node.right);
				if (value === null) return;

				const secretName = collectPrimaryOperands(node)
					.map((operand) => getEnvAccess(operand))
					.find((access) => access !== null && isGenericSecretEnvName(access.name))?.name;
				if (secretName === undefined) return;

				reportSecretFallback(node, secretName, value);
			},

			// process.env.JWT_SECRET ? process.env.JWT_SECRET : 'dev-secret'
			ConditionalExpression(node) {
				const tested = getEnvAccess(node.test);
				const used = getEnvAccess(node.consequent);
				if (tested === null || used === null || tested.name !== used.name || !isGenericSecretEnvName(tested.name)) return;
				const value = getStaticString(node.alternate);
				if (value === null) return;
				reportSecretFallback(node, tested.name, value);
			},

			// const { JWT_SECRET = 'dev-secret' } = process.env;
			VariableDeclarator(node) {
				if (node.init === null || node.id.type !== "ObjectPattern") return;
				if (!isProcessEnv(node.init) && !isImportMetaEnv(node.init)) return;
				for (const property of node.id.properties) {
					if (property.type !== "Property" || property.value.type !== "AssignmentPattern" || property.key.type !== "Identifier") continue;
					const name = property.key.name;
					if (!isGenericSecretEnvName(name)) continue;
					const value = getStaticString(property.value.right);
					if (value === null) continue;
					reportSecretFallback(property, name, value);
				}
			},

			CatchClause(node) {
				const statements = node.body.body;
				const [only] = statements;
				if (statements.length !== 1 || only?.type !== "ReturnStatement") return;
				const value = emptyCollection(only.argument);
				if (value === null) return;
				// A comment in the catch documents that the fallback is deliberate.
				if (context.sourceCode.getCommentsInside(node.body).length > 0) return;

				const tryStatement = node.parent;
				if (tryStatement?.type !== "TryStatement" || !containsAwait(tryStatement.block)) return;

				context.report({ node: only, messageId: "swallowedFailure", data: { value } });
			},
		};
	},
});
