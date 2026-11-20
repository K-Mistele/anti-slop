# Vendored eslint-plugin-ai-guard

Source: [eslint-plugin-ai-guard](https://github.com/ai-guard-dev/eslint-plugin-ai-guard) 1.4.7, tag `v1.4.7`, commit `34f37cd966c10c7cf1456edc1b334e1c567e1f7d`. MIT, Copyright (c) 2026 eslint-plugin-ai-guard contributors; `LICENSE` here is upstream's, verbatim. Keep it with every copy of the ported files. Each ported file starts with a comment naming the upstream file it came from.

The ported code lives with the rest of anti-slop, not in this directory:

| Upstream | Here |
| --- | --- |
| `src/rules/ai-patterns/no-assertionless-test.ts`, `no-placeholder-implementation.ts`, `no-tautological-assertion.ts`, `no-test-env-branch.ts`; `src/rules/reliability/no-silent-fallback.ts`; `src/rules/security/no-invisible-unicode.ts`, `no-undeclared-import.ts` | `src/rules/<name>.ts`, loaded under the plugin name `ai-guard` by `src/plugins/ai-guard.ts` |
| `src/utils/ast-helpers.ts`, `env-access.ts`, `file-context.ts`, `invisible-unicode.ts`, `jsonc.ts`, `test-patterns.ts` | `src/shared/` (`ast-helpers.ts` is `ast-walk.ts`) |
| `cli/utils/integrity/*.ts`, `cli/utils/directives.ts`, the acceptance loading in `cli/utils/baseline.ts`, the `integrity` printing in `cli/commands/integrity.ts` | `src/integrity/ai-guard/`, run by `src/integrity/run.ts` |
| `tests/rules/<name>.test.ts`, `tests/utils/*.test.ts`, `tests/integrity/*.test.ts`, `tests/cli/directives.test.ts` | the `*.test.ts` file next to each port |

Only the six rules anti-slop's install enables, `no-invisible-unicode` (which older installations still enable), and the `ai-guard integrity --enforce` path are ported. Not ported: upstream's other rules and presets, the `ai-guard` CLI's other commands (`changed`, `baseline`, `init`, hooks, dependency checks), the MCP server, SARIF and JSON output, `--accept`, `--staged`, per-file (`paths`) and workspace-scoped integrity. Acceptances are read from `.ai-guard-baseline.json` as upstream reads them. Nothing here writes that file: an acceptance is a reviewed edit to it, and integrity reports each acceptance a change adds as advisory.

## Local adaptations

- Rules use Oxlint's `defineRule` and ESTree types instead of `@typescript-eslint/utils`, and their tests use Oxlint's `RuleTester`. Rule ids, options, messages and fixes are upstream's.
- Integrity parses JavaScript and TypeScript with `oxc-parser`, the parser Oxlint is built on, instead of ESLint's `Linter` with espree or `@typescript-eslint/parser`. It produces the same ESTree shapes and parses TypeScript 7 code without the TypeScript JS API. YAML is read with `js-yaml`, as upstream does.
- `@effect/vitest` tests are recognised, in both the rules (`src/shared/test-patterns.ts`, `no-assertionless-test`) and integrity (`src/integrity/ai-guard/js-facts.ts`). Upstream does not know them, so it never counts an `it.effect` test and reads replacing `it(...)` with `it.effect(...)` as deleting the test:
  - `it.effect`, `it.scoped`, `it.live`, `it.scopedLive`, `it.prop` and `it.effect.prop` declare tests, alone or with `.skip`, `.only`, `.fails`, `.each(table)`, `.skipIf(cond)` and `.runIf(cond)`;
  - a named `layer(L)("name", (it) => ...)` or `it.layer(L)("name", (it) => ...)` block is a suite; an anonymous `layer(L)((it) => ...)` adds no title;
  - `it.flakyTest(effect)` wraps an Effect inside a test and declares nothing; assertions inside it count for the enclosing test;
  - `assert` imported from `@effect/vitest` (under any local name) and the assertion functions of `@effect/vitest/utils` are assertions;
  - a property test (`it.prop`, `it.effect.prop`) whose callback returns a comparison asserts through that result, since returning `false` falsifies it.
- Errors carry a `_tag` and are checked with `isIntegrityGitError`, not `instanceof`; `errorMessage` is `src/shared/error-message.ts`'s.
- Small edits for anti-slop's own lint, with the same behaviour: `no-tautological-assertion` reads truthiness through `isTruthy`, `no-placeholder-implementation` compares `abstract` with `true`, `no-invisible-unicode.test.ts` uses `Array.from` instead of spreading a string, and `no-undeclared-import` and its test disable `effecttsgo/node-builtin-import` (and `global-date`) with a reason, as other code that runs in Oxlint's plugin host does.
- `no-silent-fallback.test.ts` drops upstream's case for an OpenAI client whose `apiKey` falls back to a hard-coded `sk-proj-` key: secret scanners flag the fake key. The other `hardcodedSecretFallback` cases still cover the message; the rule is unchanged.

## Updating

Compare the upstream files in the table with a newer upstream revision, port relevant fixes while keeping the adaptations above, update the commit here and in each file's header, and keep `LICENSE`. Run `pnpm check` and `pnpm sync:skill-assets`.
