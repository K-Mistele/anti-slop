# anti-slop

[![skills.sh](https://skills.sh/b/dmmulroy/anti-slop)](https://skills.sh/dmmulroy/anti-slop)

Opinionated Oxlint rules that reject low-evidence and low-signal TypeScript and JavaScript patterns.

Anti-slop is first and foremost the ruleset I use with my team. It reflects my preferences and taste rather than attempting to be a universal coding standard.

This project is meant to be vendored, not treated as a fixed npm dependency. There is no official npm package. Copy the rules into your repository, read them, and change them to match your team's standards. The bundled agent skill handles the initial copy and configuration; after that, the vendored files are yours to maintain and make your own. Community-maintained forks and packages are welcome, but their compatibility and release lifecycle belong to their maintainers.

## Install with an agent skill

```bash
npx skills add dmmulroy/anti-slop --skill install-anti-slop
```

Then ask your coding agent to install or configure anti-slop in the current repository. The skill copies the plugin, installs compatible Oxlint dependencies—matching an existing Oxlint version when present—merges the plugin into the existing lint configuration, enables every generic rule, and validates the result. In repositories that depend directly on Effect, it also enables the opt-in Effect rule group.

To inspect available skills first:

```bash
npx skills add dmmulroy/anti-slop --list
```

## Manual local installation

Copy `src/` into the target repository, for example at `tools/oxlint/anti-slop/`. If the repository already uses `oxlint`, install `@oxlint/plugins` at exactly the resolved Oxlint version. Otherwise, install the same current version of both packages. Keep both versions exact so upgrades move them together.

Register the copied entry point in `oxlint.config.ts`:

```ts
import { defineConfig } from "oxlint";

export default defineConfig({
  ignorePatterns: [
    ".agent/**",
    ".agents/**",
    ".claude/**",
    ".codex/**",
    ".continue/**",
    ".cursor/**",
    ".gemini/**",
    ".opencode/**",
    ".pi/**",
    ".roo/**",
    ".windsurf/**",
    "tools/oxlint/anti-slop/**",
  ],
  jsPlugins: [
    { name: "anti-slop", specifier: "./tools/oxlint/anti-slop/index.ts" },
  ],
  rules: {
    "anti-slop/no-chained-type-assertions": "error",
    "anti-slop/no-conditional-empty-object-spread": "error",
    "anti-slop/no-known-value-widening": "error",
    "anti-slop/no-module-mocking": "error",
    "anti-slop/no-object-parameters": "error",
    "anti-slop/no-reflect-apply": "error",
    "anti-slop/no-reflect-get": "error",
    "anti-slop/no-runtime-typeof": "error",
    "anti-slop/no-shape-in-symbol-names": "error",
    "anti-slop/no-unknown-parameters": "error",
    "anti-slop/no-unknown-returns": "error",
    "anti-slop/no-unknown-type-aliases": "error",
    "anti-slop/no-unsafe-dictionary-type": "error",
    "anti-slop/no-widen-then-assert": "error",
    "anti-slop/require-safety-comment-for-type-assertion": "error"
  }
});
```

The same `ignorePatterns`, `jsPlugins`, and rules work under `lint` in a Vite+ config. Merge the ignore patterns into Vite+'s `fmt.ignorePatterns` as well so `vp check` does not reformat installed agent assets or the vendored plugin. Preserve existing ignores and add any other project-local agent tooling directories detected in the repository; do not broadly ignore every dot-directory.

### Optional Effect rules

Effect-specific rules live in a separate plugin so projects that do not use Effect do not inherit Effect architecture policy. Register the Effect entry point only in repositories that use Effect:

```ts
export default defineConfig({
  jsPlugins: [
    { name: "anti-slop", specifier: "./tools/oxlint/anti-slop/index.ts" },
    {
      name: "anti-slop-effect",
      specifier: "./tools/oxlint/anti-slop/effect/index.ts"
    }
  ],
  rules: {
    "anti-slop-effect/no-service-constructor-imports": "error"
  }
});
```

## Rules

### Generic rules

- `no-chained-type-assertions` — rejects nested `as` and angle-bracket assertions that fabricate evidence; chains made only of `as const` remain valid.
- `no-conditional-empty-object-spread` — reports object spreads that use a conditional `{}` branch to omit fields. It intentionally has no autofix because omission is not equivalent to assigning `undefined`.
- `no-known-value-widening` — rejects known expressions flowing into explicit `unknown`, `object`, anonymous-object, or open-dictionary targets, including known arguments passed to local `unknown` type predicates. Empty dictionary accumulators and finite-key `Record` targets remain valid.
- `no-module-mocking` — rejects Vitest and Jest `mock`, `doMock`, and `unstable_mockModule` calls in favor of real dependency seams.
- `no-object-parameters` — rejects `object`, unions containing it, and scoped or transparent generic aliases that resolve to it on function inputs.
- `no-reflect-apply` — rejects global `Reflect.apply` in favor of typed function calls.
- `no-reflect-get` — rejects global `Reflect.get` in favor of typed property access or boundary parsing.
- `no-runtime-typeof` — requires boundary parsing instead of ad hoc `typeof` narrowing. Existence probes against the string `"undefined"` are allowed, and type predicates can be enabled explicitly.
- `no-shape-in-symbol-names` — rejects the case-insensitive substring `shape` in locally owned symbol names while allowing static member names such as Zod's `schema.shape` that cannot be renamed locally.
- `no-unknown-parameters` — rejects `unknown` and unions containing it on function inputs except the explicit `cause` convention and the exact subject of a type predicate.
- `no-unknown-returns` — rejects explicit function contracts that resolve to `unknown`, `Promise<unknown>`, or `PromiseLike<unknown>`, including scoped and transparent generic aliases.
- `no-unknown-type-aliases` — rejects scoped and transparent generic aliases whose resolved type is `unknown`.
- `no-unsafe-dictionary-type` — rejects dictionary value contracts based on `unknown`, `any`, `object`, `{}`, and semantic equivalents. Generic constraints such as `T extends Record<string, unknown>` are allowed.
- `no-widen-then-assert` — rejects immutable local flows that widen known evidence to `unknown`, `any`, `object`, or a broad record and later assert it back to a narrower type.
- `require-safety-comment-for-type-assertion` — requires each non-const assertion to have a nearby, non-empty invariant justification. Marker prefixes are configurable and default to `SAFETY`.

### Effect rules

- `no-service-constructor-imports` — rejects named `make<CapabilityName>` imports from relative project modules outside `*.test.*` and `*.spec.*` files. Runtime callers should import the owning Layer and yield the contextual service instead. Package and path-alias imports, default imports, and static constructors such as `WorkspaceName.make` are outside the rule.

### Analysis boundaries

The rules use Oxlint's ESTree and lexical-scope APIs rather than a TypeScript type checker. They resolve same-file aliases—including block-scoped aliases, forward references, and transparent generic aliases—but do not infer imported type definitions or cross-file call signatures. Rules that inspect calls therefore document when enforcement is intentionally local.

## Violation examples

Each snippet below is rejected by the named rule.

### `no-chained-type-assertions`

```ts
const user = input as object as User;
```

### `no-conditional-empty-object-spread`

```ts
const options = {
  ...(timeout !== undefined ? { timeout } : {}),
};
```

### `no-known-value-widening`

```ts
const handlers: Record<string, Handler> = {
  start: startHandler,
};
```

This discards the known `start` key. Preserve inference or use `satisfies Record<string, Handler>` instead.

Known values must not be widened back to `unknown` through a local type predicate:

```ts
function isUser(value: unknown): value is User {
  return UserSchema.safeParse(value).success;
}

declare const user: User;
isUser(user);
```

Call the predicate at the unparsed boundary, while the argument is still `unknown`.

### `no-module-mocking`

```ts
vi.mock("./user-store");
```

### `no-object-parameters`

```ts
function save(value: object) {}
```

### `no-reflect-apply`

```ts
const value = Reflect.apply(operation, owner, args);
```

### `no-reflect-get`

```ts
const value = Reflect.get(owner, key);
```

### `no-runtime-typeof`

```ts
if (typeof input === "string") {
  useName(input);
}
```

Schema-free projects can permit `typeof` checks directly inside type predicate and
assertion functions while continuing to reject ad hoc checks elsewhere:

```json
{
  "anti-slop/no-runtime-typeof": [
    "error",
    { "allowInTypeGuards": true }
  ]
}
```

The option defaults to `false`. Existence probes such as `typeof document === "undefined"` are always allowed because they establish whether a binding exists rather than narrow its representation.

### `no-shape-in-symbol-names`

```ts
interface UserShape {
  id: string;
}
```

Static member reads such as `schema.shape` are allowed because the member name belongs to the value's owner and cannot be renamed locally.

### Effect: `no-service-constructor-imports`

```ts
import { makeIssueService } from "./issue-service.ts";
```

Import the owning Layer and yield `IssueService` instead. Focused `*.test.*` and `*.spec.*` files may import the constructor directly.

### `no-unknown-parameters`

```ts
function handle(input: unknown) {}
```

A type predicate may accept `unknown` for the parameter it narrows; other `unknown`
parameters on the same function remain rejected.

### `no-unknown-returns`

```ts
function loadUser(): unknown {
  return input;
}
```

### `no-unknown-type-aliases`

```ts
type ExternalValue = unknown;
```

### `no-unsafe-dictionary-type`

```ts
type Metadata = Record<string, unknown>;
type OtherMetadata = { [key: string]: object };
```

### `no-widen-then-assert`

```ts
const loaded: User = loadUser();
const stored: unknown = loaded;
const user = stored as User;
```

### `require-safety-comment-for-type-assertion`

```ts
const userId = value as UserId;
```

Add a specific justification immediately before a necessary assertion:

```ts
// SAFETY: parseUserId validated the identifier before branding it.
const userId = value as UserId;
```

`SAFETY` remains the default marker. Comments immediately above exported declarations are recognized. Repositories with an established convention can configure one or more alternatives; every marker must still be followed by a colon and a non-empty justification:

```json
{
  "anti-slop/require-safety-comment-for-type-assertion": [
    "error",
    { "markers": ["INVARIANT", "SAFETY"] }
  ]
}
```

## Development

```bash
pnpm install
pnpm check
```

`src/` is canonical. After changing production source, run `pnpm sync:skill-assets`; CI checks that the skill's bundled copy remains identical. `pnpm check` runs Oxlint, every RuleTester suite, TypeScript typechecking, and the skill-asset drift check.

## License

MIT
