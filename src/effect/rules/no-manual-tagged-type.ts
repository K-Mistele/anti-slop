import { defineRule } from "@oxlint/plugins";

export const noManualTaggedTypeRule = defineRule({
	meta: {
		type: "problem",
		docs: {
			description:
				"Derive tagged types from Data or Schema tagged constructors instead of declaring `_tag` in a type or interface.",
		},
		messages: {
			manualTaggedType:
				"Do not declare `_tag` in a type or interface. Define the value with Schema.TaggedStruct, Schema.TaggedClass, Schema.TaggedError, Schema.TaggedUnion, Data.TaggedClass, Data.TaggedError, or Data.taggedEnum, then infer its type from the schema with `export type X = typeof X.Type`.",
		},
	},
	createOnce(context) {
		return {
			TSPropertySignature(node) {
				if (
					(node.key.type === "Identifier" && node.key.name === "_tag") ||
					(node.key.type === "Literal" && node.key.value === "_tag")
				) {
					context.report({ node, messageId: "manualTaggedType" });
				}
			},
		};
	},
});
