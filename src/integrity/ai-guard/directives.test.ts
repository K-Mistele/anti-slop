// oxlint-disable effecttsgo/global-console -- a test runner outside any Effect runtime
// Ported from eslint-plugin-ai-guard 1.4.7 (`tests/cli/directives.test.ts`, MIT); see `src/vendor/ai-guard/UPSTREAM.md`.
// Upstream's `findCoveringDirective` cases cover the lint CLI's suppression handling, which is not ported.
import assert from "node:assert/strict";

import { disablesUntilEndOfFile, parseEslintDirectives, parseTsDirectives, rulesSuppressedBy, type CommentLike, type EslintDirective } from "./directives.ts";

const tests: Array<[string, () => void]> = [];
const test = (name: string, run: () => void): void => {
	tests.push([name, run]);
};

const line = (value: string, at = 1): CommentLike => ({ type: "Line", value, line: at, column: 0, endLine: at, endColumn: value.length + 2 });
const block = (value: string, at = 1, endAt = at): CommentLike => ({ type: "Block", value, line: at, column: 0, endLine: endAt, endColumn: 2 });

function eslintDirective(comment: CommentLike): EslintDirective | null {
	const directives = parseEslintDirectives([comment]);
	assert.ok(directives.length <= 1);
	return directives[0] ?? null;
}

const tsDirective = (comment: CommentLike): { readonly kind: string; readonly description: string } | null => {
	const [directive] = parseTsDirectives([comment]);
	return directive === undefined ? null : { kind: directive.kind, description: directive.description };
};

const shape = (directive: EslintDirective | null): Record<string, unknown> | null =>
	directive === null
		? null
		: {
				kind: directive.kind,
				rules: directive.rules,
				...(directive.settings === undefined ? {} : { settings: directive.settings }),
				...(directive.justification === undefined ? {} : { justification: directive.justification }),
			};

test("parses line directives with rule lists and justifications", () => {
	assert.deepEqual(shape(eslintDirective(line(" eslint-disable-next-line ai-guard/no-empty-catch, no-console -- legacy API"))), {
		kind: "disable-next-line",
		rules: ["ai-guard/no-empty-catch", "no-console"],
		justification: "legacy API",
	});
	assert.deepEqual(shape(eslintDirective(line(" eslint-disable-line"))), { kind: "disable-line", rules: null });
});

test("parses block disable/enable and inline rule configuration", () => {
	assert.deepEqual(shape(eslintDirective(block(" eslint-disable "))), { kind: "disable", rules: null });
	assert.deepEqual(shape(eslintDirective(block(" eslint-enable ai-guard/no-eval-dynamic "))), { kind: "enable", rules: ["ai-guard/no-eval-dynamic"] });
	assert.deepEqual(shape(eslintDirective(block(' eslint ai-guard/no-empty-catch: "off", no-console: 2 '))), {
		kind: "inline-config",
		rules: null,
		settings: { "ai-guard/no-empty-catch": "off", "no-console": "error" },
	});
});

test("ignores directives ESLint itself ignores", () => {
	// ESLint only honours eslint-disable / eslint-enable / rule config in block comments.
	assert.equal(eslintDirective(line(" eslint-disable")), null);
	assert.equal(eslintDirective(line(" eslint no-console: off")), null);
	// Line directives in a multi-line block comment are invalid.
	assert.equal(eslintDirective(block(" eslint-disable-next-line\n no-console ", 1, 2)), null);
	// Look-alikes.
	assert.equal(eslintDirective(line(" eslint-disabled-next-line foo")), null);
	assert.equal(eslintDirective(line(" see eslint-disable docs")), null);
	assert.equal(eslintDirective(block(" eslint-env node ")), null);
	assert.equal(eslintDirective(block(" eslint ")), null);
});

test("parses lenient inline config like ESLint", () => {
	assert.deepEqual(eslintDirective(block(" eslint no-alert: 0, ai-guard/no-eval-dynamic: off "))?.settings, { "no-alert": "off", "ai-guard/no-eval-dynamic": "off" });
	assert.deepEqual(eslintDirective(block(' eslint "quotes": ["error", "single"] '))?.settings, { quotes: "error" });
});

test("parses TypeScript directives and their descriptions", () => {
	assert.deepEqual(tsDirective(line(" @ts-ignore")), { kind: "ignore", description: "" });
	assert.deepEqual(tsDirective(line(" @ts-expect-error -- upstream types are wrong")), { kind: "expect-error", description: "upstream types are wrong" });
	assert.equal(tsDirective(block("* @ts-nocheck "))?.kind, "nocheck");
	assert.equal(tsDirective(line(" @ts-check"))?.kind, "check");
	assert.equal(tsDirective(line(" explain why @ts-ignore is bad")), null);
});

test("knows whether a block disable lasts until the end of the file", () => {
	const directives = parseEslintDirectives([
		block(" eslint-disable ai-guard/no-eval-dynamic ", 10),
		block(" eslint-enable ai-guard/no-eval-dynamic ", 20),
		block(" eslint-disable ", 30),
		block(" eslint-enable ai-guard/no-floating-promise ", 35),
	]);
	assert.equal(directives.length, 4);
	const [scoped, , all] = directives;
	assert.ok(scoped !== undefined && all !== undefined);
	assert.equal(disablesUntilEndOfFile(directives, scoped), false);
	assert.equal(disablesUntilEndOfFile(directives, all), true);
});

test("an inline configuration suppresses only the rules it turns off", () => {
	const directive = eslintDirective(block(' eslint ai-guard/no-empty-catch: off, no-console: "warn" ', 50));
	assert.ok(directive !== null);
	assert.deepEqual(rulesSuppressedBy(directive), ["ai-guard/no-empty-catch"]);
});

let failed = 0;
for (const [name, run] of tests) {
	try {
		run();
		console.log(`ok - ${name}`);
	} catch (error) {
		failed += 1;
		console.error(`not ok - ${name}`);
		console.error(error);
	}
}
if (failed > 0) process.exit(1);
