import { eslintCompatPlugin } from "@oxlint/plugins";

import { withModes } from "../modes/wrap.ts";
import { noAssertionlessTestRule } from "../rules/no-assertionless-test.ts";
import { noInvisibleUnicodeRule } from "../rules/no-invisible-unicode.ts";
import { noPlaceholderImplementationRule } from "../rules/no-placeholder-implementation.ts";
import { noSilentFallbackRule } from "../rules/no-silent-fallback.ts";
import { noTautologicalAssertionRule } from "../rules/no-tautological-assertion.ts";
import { noTestEnvBranchRule } from "../rules/no-test-env-branch.ts";
import { noUndeclaredImportRule } from "../rules/no-undeclared-import.ts";

/**
 * The `eslint-plugin-ai-guard` rules anti-slop uses, ported to Oxlint (see `src/vendor/ai-guard/UPSTREAM.md`),
 * under their upstream plugin name and rule ids, with a `mode` option on every rule. Register it as
 * `{ name: "ai-guard", specifier: "<this file>" }`.
 */
export default withModes(
	eslintCompatPlugin({
		meta: { name: "ai-guard" },
		rules: {
			"no-assertionless-test": noAssertionlessTestRule,
			"no-invisible-unicode": noInvisibleUnicodeRule,
			"no-placeholder-implementation": noPlaceholderImplementationRule,
			"no-silent-fallback": noSilentFallbackRule,
			"no-tautological-assertion": noTautologicalAssertionRule,
			"no-test-env-branch": noTestEnvBranchRule,
			"no-undeclared-import": noUndeclaredImportRule,
		},
	}),
);
