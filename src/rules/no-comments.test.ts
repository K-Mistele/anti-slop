import { RuleTester } from "oxlint/plugins-dev";

import { noCommentsRule } from "./no-comments.ts";

new RuleTester().run("no-comments", noCommentsRule, {
	valid: [
		"const answer = 42;",
		"// SAFETY: validated against the schema above.\nconst user = input;",
		"/* SAFETY: the constructor established this invariant. */\nuse(value);",
	],
	invalid: [
		{
			code: "// Compute the answer.\nconst answer = 42;",
			errors: [{ messageId: "comment" }],
		},
		{
			code: "const answer = 42; /* Keep this in sync. */",
			errors: [{ messageId: "comment" }],
		},
		{
			code: "// First.\nconst first = 1;\n// Second.\nconst second = 2;",
			errors: [{ messageId: "comment" }, { messageId: "comment" }],
		},
	],
});
