import { RuleTester } from "oxlint/plugins-dev";

import { noReflectApplyRule } from "./no-reflect-apply.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
const error = { messageId: "reflectApply" };

tester.run("anti-slop/no-reflect-apply", noReflectApplyRule, {
  valid: [
    "const value = operation.apply(owner, args);",
    "Reflect.get(owner, key);",
    "const Reflect = { apply() { return 1; } }; Reflect.apply();",
    "function invoke(Reflect: { apply(): number }) { return Reflect.apply(); }",
  ],
  invalid: [
    { code: "const value = Reflect.apply(operation, owner, args);", errors: [{ ...error, line: 1, column: 14, endLine: 1, endColumn: 27 }] },
    { code: "const value = Reflect['apply'](operation, owner, args);", errors: [error] },
  ],
});
