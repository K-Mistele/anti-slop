# anti-slop

[![skills.sh](https://skills.sh/b/dmmulroy/anti-slop)](https://skills.sh/dmmulroy/anti-slop)

Opinionated Oxlint rules that reject low-evidence and low-signal TypeScript and JavaScript patterns.

This project is meant to be vendored, not treated as a fixed npm dependency. Copy the rules into your repository, read them, and change them to match your team's standards. The bundled agent skill handles the initial copy and configuration; after that, the vendored files are yours to maintain and make your own.

## Install with an agent skill

```bash
npx skills add dmmulroy/anti-slop --skill install-anti-slop
```

Then ask your coding agent to install or configure anti-slop in the current repository. The skill copies the plugin, installs current Oxlint dependencies, merges the plugin into the existing lint configuration, enables every generic rule, and validates the result. In repositories that depend on Effect, it also enables the opt-in Effect rule group.

To inspect available skills first:

```bash
npx skills add dmmulroy/anti-slop --list
```

## Manual local installation

Copy `src/` into the target repository, for example at `tools/oxlint/anti-slop/`, and install matching current versions of `oxlint` and `@oxlint/plugins`.

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
    "anti-slop/no-comments": "error",
    "anti-slop/no-conditional-empty-object-spread": "error",
    "anti-slop/no-known-value-widening": "error",
    "anti-slop/no-module-mocking": "error",
    "anti-slop/no-object-parameters": "error",
    "anti-slop/no-reflect-apply": "error",
    "anti-slop/no-reflect-get": "error",
    "anti-slop/no-reprovide-ambient-service": "error",
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
    "anti-slop-effect/no-manual-effect-error-tag": "error",
    "anti-slop-effect/no-manual-tag-comparison": "error",
    "anti-slop-effect/no-manual-tagged-construction": "error",
    "anti-slop-effect/no-service-constructor-imports": "error",
    "anti-slop-effect/prefer-effect-match": "error"
  }
});
```

## Rules

### Generic rules

- `no-chained-type-assertions` — rejects nested type assertions that fabricate evidence.
- `no-comments` — rejects implementation comments so code must communicate intent directly. `SAFETY:` comments required by assertion policy remain allowed.
- `no-conditional-empty-object-spread` — rejects conditional spreads that use `{}` to omit fields.
- `no-known-value-widening` — rejects explicit broad target types that discard known value evidence.
- `no-module-mocking` — rejects Vitest and Jest module mocks in favor of real dependency seams.
- `no-object-parameters` — rejects the broad `object` type on function inputs.
- `no-reflect-apply` — rejects `Reflect.apply` in favor of typed function calls.
- `no-reflect-get` — rejects `Reflect.get` in favor of typed property access or boundary parsing.
- `no-reprovide-ambient-service` — rejects yielding an Effect service only to provide that same value back into a nested operation.
- `no-runtime-typeof` — requires boundary parsing instead of ad hoc `typeof` narrowing.
- `no-shape-in-symbol-names` — rejects `shape` in symbol names.
- `no-unknown-parameters` — rejects `unknown` inputs except the explicit `cause` convention.
- `no-unknown-returns` — rejects function contracts that return `unknown` or `Promise<unknown>`.
- `no-unknown-type-aliases` — rejects aliases that merely conceal `unknown`.
- `no-unsafe-dictionary-type` — rejects dictionary value contracts based on `unknown`, `any`, `object`, `{}`, and semantic equivalents.
- `no-widen-then-assert` — rejects local flows that widen known values and later assert them back.
- `require-safety-comment-for-type-assertion` — requires each non-const assertion to document its checked invariant.

### Effect rules

- `no-manual-effect-error-tag` — rejects manual `_tag` comparisons and switches inside broad `Effect.catch`, `Effect.catchAll`, and `Effect.catchIf` handlers in favor of tagged error handlers.
- `no-manual-tag-comparison` — rejects direct `_tag` comparisons and `_tag` switches in favor of `Match`, `Predicate.isTagged`, or tagged-enum matching.
- `no-manual-tagged-construction` — rejects literal `_tag` object construction in favor of Schema, tagged class/error, or `Data.taggedEnum` constructors. `Match.when` and `Match.not` patterns remain allowed.
- `no-service-constructor-imports` — rejects relative project imports of exported `make<CapabilityName>` constructors outside `*.test.*` and `*.spec.*` files. Runtime callers should import the owning Layer and yield the contextual service instead. Package imports and static constructors such as `WorkspaceName.make` are outside the rule.
- `prefer-effect-match` — rejects chained literal ternaries over the same value in favor of Effect's `Match` API.

## Violation examples

Each snippet below is rejected by the named rule.

### `no-chained-type-assertions`

```ts
const user = input as object as User;
```

### `no-comments`

```ts
// Convert the input before saving it.
const saved = save(convert(input));
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

The option defaults to `false`.

### `no-shape-in-symbol-names`

```ts
interface UserShape {
  id: string;
}
```

### Effect: `no-service-constructor-imports`

```ts
import { makeIssueService } from "./issue-service.ts";
```

Import the owning Layer and yield `IssueService` instead. Focused `*.test.*` and `*.spec.*` files may import the constructor directly.

### Effect: tagged values and matching

```ts
if (result._tag === "Ready") useReady(result);

const result = { _tag: "Ready", value };

Effect.catch((error) =>
  error._tag === "NotFound" ? recover : Effect.fail(error)
);

const label = kind === "a" ? "A" : kind === "b" ? "B" : "Other";
```

Use `Predicate.isTagged` for reusable predicates, `Match` or tagged-enum matching for branching, tagged constructors for values, and `Effect.catchTag`/`Effect.catchTags` for tagged errors.

### `no-unknown-parameters`

```ts
function handle(input: unknown) {}
```

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

## Development

```bash
pnpm install
pnpm check
```

`src/` is canonical. After changing production source, run `pnpm sync:skill-assets`; CI checks that the skill's bundled copy remains identical.

## License

MIT
