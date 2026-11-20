// Ported from eslint-plugin-ai-guard 1.4.7 (`cli/utils/integrity/analyze-js.ts`, MIT); see `src/vendor/ai-guard/UPSTREAM.md`.
// Integrity analyzers for JavaScript/TypeScript sources: suppression comments, `as any` casts, skipped/focused/removed
// tests and assertion signals. Comparisons are multiset-based (per signature, base count vs head count), so a
// suppression or skip that was merely moved or reformatted is not reported as new. When a signature gained
// occurrences, the occurrences on lines the change added are reported first.

import { affectsAiGuard, disablesUntilEndOfFile, rulesSuppressedBy, type EslintDirective } from "./directives.ts";
import type { ChangeStatus } from "./git.ts";
import { activeTests, type JsFacts, type TestDecl } from "./js-facts.ts";
import type { FindingDraft } from "./types.ts";

export interface JsFilePair {
	/** Head path (or the deleted path). */
	readonly path: string;
	readonly status: ChangeStatus;
	readonly base: JsFacts | null;
	readonly head: JsFacts | null;
	/** Head lines added by the change; null means "treat every line as added". */
	readonly added: ReadonlySet<number> | null;
}

function countBy<T>(items: ReadonlyArray<T>, key: (item: T) => string): Map<string, number> {
	const counts = new Map<string, number>();
	for (const item of items) counts.set(key(item), (counts.get(key(item)) ?? 0) + 1);
	return counts;
}

/** Head items whose signature occurs more often than in the base, preferring added lines. */
function surplus<T extends { readonly line: number }>(
	base: ReadonlyArray<T>,
	head: ReadonlyArray<T>,
	signature: (item: T) => string,
	added: ReadonlySet<number> | null,
): Array<{ readonly item: T; readonly ordinal: number }> {
	const baseCounts = countBy(base, signature);
	const groups = new Map<string, T[]>();
	for (const item of head) {
		const key = signature(item);
		groups.set(key, [...(groups.get(key) ?? []), item]);
	}
	const out: Array<{ readonly item: T; readonly ordinal: number }> = [];
	for (const [key, list] of groups) {
		const extra = list.length - (baseCounts.get(key) ?? 0);
		if (extra <= 0) continue;
		const onAdded = added === null ? list : list.filter((item) => added.has(item.line));
		const rest = list.filter((item) => !onAdded.includes(item)).reverse();
		const picked = [...onAdded, ...rest].slice(0, extra).sort((a, b) => a.line - b.line);
		picked.forEach((item, ordinal) => out.push({ item, ordinal }));
	}
	return out;
}

// ─── Suppressions ─────────────────────────────────────────────────────────────

function directiveSignature(directive: EslintDirective): string {
	const rules = rulesSuppressedBy(directive);
	return `${directive.kind}|${rules === null ? "*" : [...rules].sort().join(",")}`;
}

function describeScope(directive: EslintDirective, all: ReadonlyArray<EslintDirective>): string {
	const rules = rulesSuppressedBy(directive);
	const what = rules === null ? "all ESLint rules (including AI Guard rules)" : rules.join(", ");
	switch (directive.kind) {
		case "disable-line":
			return `${what} on line ${directive.line}`;
		case "disable-next-line":
			return `${what} on line ${directive.endLine + 1}`;
		case "inline-config":
			return `${what} for the whole file`;
		default:
			return disablesUntilEndOfFile(all, directive) ? `${what} until the end of the file` : `${what} for a block of code`;
	}
}

function isSuppressing(directive: EslintDirective): boolean {
	if (directive.kind === "enable") return false;
	const rules = rulesSuppressedBy(directive);
	return rules === null || rules.length > 0;
}

function describeTsDirective(kind: string, line: number): string {
	if (kind === "nocheck") return "turns off type checking for the whole file";
	if (kind === "ignore") return `hides any type error on line ${line + 1}`;
	return `expects and hides a type error on line ${line + 1}`;
}

export function analyzeSuppressions(pair: JsFilePair): FindingDraft[] {
	const head = pair.head;
	if (head === null) return [];
	const drafts: FindingDraft[] = [];
	const baseEslint = (pair.base?.eslintDirectives ?? []).filter(isSuppressing);
	const headAll = head.eslintDirectives;
	const headEslint = headAll.filter(isSuppressing);

	for (const { item: directive, ordinal } of surplus(baseEslint, headEslint, directiveSignature, pair.added)) {
		const rules = rulesSuppressedBy(directive);
		const broad = rules === null || directive.kind === "inline-config" || (directive.kind === "disable" && disablesUntilEndOfFile(headAll, directive));
		const high = directive.justification === undefined && (broad || affectsAiGuard(rules));
		const reason = directive.justification === undefined ? " without a reason" : ` with reason "${directive.justification}"`;
		drafts.push({
			ruleId: "ai-guard/integrity-lint-suppression",
			tier: high ? "high" : "advisory",
			file: pair.path,
			line: directive.line,
			message: `Added \`${directive.text}\`, which disables ${describeScope(directive, headAll)},${reason}.`,
			after: directive.text,
			key: `${directiveSignature(directive)}#${directive.justification ?? ""}#${ordinal}`,
		});
	}

	const baseTs = (pair.base?.tsDirectives ?? []).filter((directive) => directive.kind !== "check");
	const headTs = head.tsDirectives.filter((directive) => directive.kind !== "check");
	for (const { item: directive, ordinal } of surplus(baseTs, headTs, (item) => item.kind, pair.added)) {
		const high = directive.kind === "nocheck" || (directive.kind === "ignore" && directive.description.length < 3);
		const reason = directive.description === "" ? ", without a reason" : ` (reason: "${directive.description}")`;
		drafts.push({
			ruleId: "ai-guard/integrity-ts-suppression",
			tier: high ? "high" : "advisory",
			file: pair.path,
			line: directive.line,
			message: `Added \`${directive.text}\`, which ${describeTsDirective(directive.kind, directive.line)}${reason}.`,
			after: directive.text,
			key: `${directive.kind}#${directive.description}#${ordinal}`,
		});
	}

	const baseChecks = (pair.base?.tsDirectives ?? []).filter((directive) => directive.kind === "check").length;
	const headChecks = head.tsDirectives.filter((directive) => directive.kind === "check").length;
	if (pair.base !== null && headChecks < baseChecks) {
		drafts.push({
			ruleId: "ai-guard/integrity-ts-suppression",
			tier: "advisory",
			file: pair.path,
			message: "Removed `// @ts-check`; this JavaScript file is no longer type-checked.",
			before: "// @ts-check",
			key: "ts-check-removed",
		});
	}

	const baseCasts = pair.base?.anyCasts.length ?? 0;
	const headCasts = head.anyCasts.length;
	if (headCasts > baseCasts) {
		const added = pair.added;
		const newLine = head.anyCasts.find((line) => added === null || added.has(line)) ?? head.anyCasts[0];
		drafts.push({
			ruleId: "ai-guard/integrity-unsafe-type-escape",
			tier: "advisory",
			file: pair.path,
			line: newLine,
			message: `\`as any\` casts went from ${baseCasts} to ${headCasts} in this file.`,
			before: String(baseCasts),
			after: String(headCasts),
			key: "any-casts",
		});
	}
	return drafts;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

const declSig = (test: TestDecl): string => `${test.kind}|${test.path}`;

function plural(count: number, word: string): string {
	return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function listTitles(titles: ReadonlyArray<string>): string {
	const shown = titles
		.slice(0, 5)
		.map((title) => `"${title}"`)
		.join(", ");
	return titles.length > 5 ? `${shown} and ${titles.length - 5} more` : shown;
}

/** Skipped, conditionally run, and focused declarations the head added. */
function newlyDisabled(pair: JsFilePair, head: JsFacts): FindingDraft[] {
	const drafts: FindingDraft[] = [];
	const base = pair.base;
	// Newly skipped tests and suites.
	const baseSkipped = (base?.tests ?? []).filter((test) => test.skipped);
	const headSkipped = head.tests.filter((test) => test.skipped);
	for (const { item: test, ordinal } of surplus(baseSkipped, headSkipped, declSig, pair.added)) {
		const existed = base?.tests.some((before) => before.kind === test.kind && before.path === test.path && !before.skipped) ?? false;
		const affected =
			test.kind === "suite" && base !== null ? activeTests(base).filter((before) => before.path.startsWith(`${test.path} > `)).length : 0;
		const subject = test.kind === "suite" ? `suite "${test.path}"${affected > 0 ? ` (${plural(affected, "test")})` : ""}` : `test "${test.path}"`;
		drafts.push({
			ruleId: "ai-guard/integrity-test-skipped",
			tier: existed ? "high" : "advisory",
			file: pair.path,
			line: test.line,
			message: existed ? `Skipped the existing ${subject}; it no longer runs.` : `Added the ${subject} in a skipped state.`,
			before: existed ? "runs" : undefined,
			after: "skipped",
			key: `${declSig(test)}#${ordinal}`,
		});
	}

	// Conditionally skipped (skipIf/runIf): advisory.
	const baseConditional = (base?.tests ?? []).filter((test) => test.conditional);
	const headConditional = head.tests.filter((test) => test.conditional);
	for (const { item: test, ordinal } of surplus(baseConditional, headConditional, declSig, pair.added)) {
		drafts.push({
			ruleId: "ai-guard/integrity-test-skipped",
			tier: "advisory",
			file: pair.path,
			line: test.line,
			message: `"${test.path}" now runs only under a condition (skipIf/runIf).`,
			key: `conditional#${declSig(test)}#${ordinal}`,
		});
	}

	// Focused tests stop every other test in the file.
	const baseFocused = (base?.tests ?? []).filter((test) => test.focused);
	const headFocused = head.tests.filter((test) => test.focused);
	for (const { item: test, ordinal } of surplus(baseFocused, headFocused, declSig, pair.added)) {
		drafts.push({
			ruleId: "ai-guard/integrity-test-focused",
			tier: "high",
			file: pair.path,
			line: test.line,
			message: `Focused ${test.kind} "${test.path}" (.only/fit/fdescribe): other tests in this file stop running.`,
			after: "focused",
			key: `${declSig(test)}#${ordinal}`,
		});
	}
	return drafts;
}

function assertionChanges(path: string, base: JsFacts, head: JsFacts): FindingDraft[] {
	const drafts: FindingDraft[] = [];
	if (head.assertions.total < base.assertions.total) {
		drafts.push({
			ruleId: "ai-guard/integrity-assertions-reduced",
			tier: "advisory",
			file: path,
			message: `Assertions in this file went from ${base.assertions.total} to ${head.assertions.total}.`,
			before: String(base.assertions.total),
			after: String(head.assertions.total),
			key: "assertions",
		});
	}
	if (head.assertions.loose > base.assertions.loose && head.assertions.strict < base.assertions.strict) {
		drafts.push({
			ruleId: "ai-guard/integrity-assertion-loosened",
			tier: "advisory",
			file: path,
			message: `Specific assertions went from ${base.assertions.strict} to ${head.assertions.strict} while generic ones (toBeTruthy, toBeDefined, expect.anything, …) went from ${base.assertions.loose} to ${head.assertions.loose}.`,
			before: `${base.assertions.strict} specific / ${base.assertions.loose} generic`,
			after: `${head.assertions.strict} specific / ${head.assertions.loose} generic`,
			key: "loosened",
		});
	}
	return drafts;
}

/**
 * Analyze test files of one change together.
 * @param changeWide true when `pairs` covers every changed test file, so moves between files can be recognized.
 */
export function analyzeTests(pairs: ReadonlyArray<JsFilePair>, changeWide: boolean): FindingDraft[] {
	const drafts: FindingDraft[] = [];
	let totalBase = 0;
	let totalHead = 0;
	// Tests that are new in their own file can be the moved copy of a removed test. Tests that already existed there
	// cannot, so they never "absorb" one.
	const pool = new Map<string, number>();
	const take = (key: string): boolean => {
		const count = pool.get(key) ?? 0;
		if (count === 0) return false;
		pool.set(key, count - 1);
		return true;
	};
	const innerPath = (test: TestDecl): string => test.path.split(" > ").slice(1).join(" > ") || test.title;
	for (const pair of pairs) {
		const baseActive = pair.base === null ? [] : activeTests(pair.base);
		const headActive = pair.head === null ? [] : activeTests(pair.head);
		totalBase += baseActive.length;
		totalHead += headActive.length;
		const existing = countBy(baseActive, (test) => test.path);
		for (const test of headActive) {
			const count = existing.get(test.path) ?? 0;
			if (count > 0) {
				existing.set(test.path, count - 1);
				continue;
			}
			pool.set(`path:${test.path}`, (pool.get(`path:${test.path}`) ?? 0) + 1);
			pool.set(`inner:${innerPath(test)}`, (pool.get(`inner:${innerPath(test)}`) ?? 0) + 1);
		}
	}
	const suiteShrank = changeWide && totalHead < totalBase;
	// Same full path, or same path below a renamed top-level suite.
	const foundElsewhere = (test: TestDecl): boolean => take(`path:${test.path}`) || take(`inner:${innerPath(test)}`);

	for (const pair of pairs) {
		const { base, head } = pair;
		if (head !== null) drafts.push(...newlyDisabled(pair, head));

		if (base === null) continue;
		const baseActive = activeTests(base);
		if (baseActive.length === 0) continue;

		if (head === null) {
			const missing = baseActive.filter((test) => !foundElsewhere(test));
			// Every test moved to other files in this change.
			if (missing.length === 0) continue;
			drafts.push({
				ruleId: "ai-guard/integrity-test-file-deleted",
				tier: suiteShrank ? "high" : "advisory",
				file: pair.path,
				message: `Deleted a test file with ${plural(baseActive.length, "active test")}; ${plural(missing.length, "test")} are not found elsewhere in this change (${listTitles(missing.map((test) => test.path))}).`,
				before: plural(baseActive.length, "test"),
				after: "deleted",
				key: "deleted",
			});
			continue;
		}

		const headActive = activeTests(head);
		if (headActive.length < baseActive.length) {
			const headPaths = countBy(headActive, (test) => test.path);
			const skippedNow = new Set(head.tests.filter((test) => test.effectiveSkipped).map((test) => test.path));
			const missing: TestDecl[] = [];
			for (const test of baseActive) {
				const count = headPaths.get(test.path) ?? 0;
				if (count > 0) {
					headPaths.set(test.path, count - 1);
					continue;
				}
				// Reported as a skip.
				if (skippedNow.has(test.path)) continue;
				if (foundElsewhere(test)) continue;
				missing.push(test);
			}
			if (missing.length > 0) {
				const consolidated = head.tests.some((test) => test.parameterized && !base.tests.some((before) => before.parameterized && before.path === test.path));
				// A removed copy of a test whose exact title still runs is a duplicate removal.
				const stillRuns = new Set(headActive.map((test) => test.path));
				const onlyDuplicates = missing.every((test) => stillRuns.has(test.path));
				const gone = listTitles(missing.filter((test) => !stillRuns.has(test.path)).map((test) => test.path));
				drafts.push({
					ruleId: "ai-guard/integrity-test-count-reduced",
					tier: suiteShrank && !consolidated && !onlyDuplicates ? "high" : "advisory",
					file: pair.path,
					message: onlyDuplicates
						? `Active tests in this file went from ${baseActive.length} to ${headActive.length}; removed duplicate(s) of ${listTitles(missing.map((test) => test.path))}, which still run.`
						: `Active tests in this file went from ${baseActive.length} to ${headActive.length}; no longer found: ${gone}.${consolidated ? " New parameterized tests (.each) may cover them." : ""}`,
					before: String(baseActive.length),
					after: String(headActive.length),
					key: `count#${missing
						.map((test) => test.path)
						.sort()
						.join("|")}`,
				});
			}
		}

		drafts.push(...assertionChanges(pair.path, base, head));
	}
	return drafts;
}
