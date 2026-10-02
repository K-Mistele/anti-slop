import { presets } from "@effect/tsgo/oxlint-presets";
import { defineConfig } from "oxlint";

const effectTsgoRules = Object.values(presets).flatMap((preset) =>
	Object.keys(preset.rules ?? {}),
);

export default defineConfig({
	extends: Object.values(presets),
	rules: {
		...Object.fromEntries(effectTsgoRules.map((rule) => [rule, "error"])),
		"effecttsgo/missing-pipeable-signature": "off",
	},
});
