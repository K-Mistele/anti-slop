import { defineRule } from "@oxlint/plugins";

import type { ESTree, Scope, SourceCode, Variable } from "@oxlint/plugins";

function resolveVariable(
  sourceCode: SourceCode,
  identifier: ESTree.IdentifierReference,
): Variable | null {
  let scope: Scope | null = sourceCode.getScope(identifier);
  while (scope !== null) {
    const variable = scope.set.get(identifier.name);
    if (variable !== undefined) return variable;
    scope = scope.upper;
  }
  return null;
}

function globalReflectObject(
  sourceCode: SourceCode,
  expression: ESTree.Expression,
): ESTree.IdentifierReference | null {
  if (expression.type !== "Identifier" || expression.name !== "Reflect") return null;
  const variable = resolveVariable(sourceCode, expression);
  return variable === null || variable.defs.length === 0 ? expression : null;
}

function reflectGetObject(
  sourceCode: SourceCode,
  callee: ESTree.Expression,
): ESTree.IdentifierReference | null {
  if (!("property" in callee) || !("object" in callee) || !("computed" in callee)) return null;
  const property = callee.property;
  const isGet = callee.computed
    ? property.type === "Literal" && property.value === "get"
    : property.type === "Identifier" && property.name === "get";
  return isGet ? globalReflectObject(sourceCode, callee.object) : null;
}

/** Ban Reflect.get, which bypasses ordinary property access and useful type evidence. */
export const noReflectGetRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow Reflect.get; use typed property access or parse dynamic input into a domain type.",
    },
    messages: {
      reflectGet:
        "Replace `Reflect.get` with typed property access. Parse dynamic input into a named domain type before reading it.",
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        if (node.callee.type === "Super" || node.callee.type === "V8IntrinsicExpression") return;
        const reflect = reflectGetObject(context.sourceCode, node.callee);
        if (reflect !== null) context.report({ node, messageId: "reflectGet" });
      },
    };
  },
});
