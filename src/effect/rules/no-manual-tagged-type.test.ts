import { RuleTester } from "oxlint/plugins-dev";

import { noManualTaggedTypeRule } from "./no-manual-tagged-type.ts";

new RuleTester().run("no-manual-tagged-type", noManualTaggedTypeRule, {
	valid: [
		{
			filename: "value.ts",
			code: 'const Ready = Schema.TaggedStruct("Ready", { payload: Schema.String });\nexport type Ready = typeof Ready.Type;',
		},
		{
			filename: "value.ts",
			code: "interface Value { readonly tag: string; readonly payload: string; }",
		},
		{
			filename: "value.ts",
			code: 'type ValueTag = Value["_tag"];',
		},
	],
	invalid: [
		{
			filename: "value.ts",
			code: "export interface AuthoredEvent { readonly _tag: string; readonly actor: Participant; }",
			errors: [{ messageId: "manualTaggedType" }],
		},
		{
			filename: "value.ts",
			code: 'interface Value { readonly "_tag": "Ready"; }',
			errors: [{ messageId: "manualTaggedType" }],
		},
		{
			filename: "value.ts",
			code: 'type Value = { readonly _tag: "Ready"; readonly payload: string };',
			errors: [{ messageId: "manualTaggedType" }],
		},
		{
			filename: "value.ts",
			code: 'type Value = { readonly _tag: "Ready" } | { readonly _tag: "Failed" };',
			errors: [
				{ messageId: "manualTaggedType" },
				{ messageId: "manualTaggedType" },
			],
		},
		{
			filename: "value.ts",
			code: "const handle = <A extends { readonly _tag: string }>(value: A) => value;",
			errors: [{ messageId: "manualTaggedType" }],
		},
	],
});
