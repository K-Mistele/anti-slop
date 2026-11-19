// Ported from eslint-plugin-ai-guard 1.4.7 (`cli/utils/integrity/analyze-config.ts`, MIT); see `src/vendor/ai-guard/UPSTREAM.md`.
// Integrity analyzers for configuration: ESLint, TypeScript, coverage and test runners, package.json scripts and
// hooks, GitHub Actions workflows, husky hook files, Jest snapshots and integrity acceptances. Only values that can be
// read statically are compared. When the effective value cannot be established (computed values, `extends`, shared
// presets), the finding is advisory rather than a confirmed weakening.

// oxlint-disable effecttsgo/node-builtin-import -- a standalone CLI outside any Effect runtime, so Effect's platform services do not apply

import { posix } from "node:path";

import { addedWeakeners, describeWeakener, isVerificationCommand, verificationKey, verificationSegments } from "./commands.ts";
import { displayPath, entriesFromValue, formatScalar, pathKey, type PathEntry, type Scalar } from "./config-values.ts";
import type { ChangeStatus } from "./git.ts";
import type { FindingDraft, IntegrityTier } from "./types.ts";

export interface TextPair {
	readonly path: string;
	readonly status: ChangeStatus;
	readonly baseText: string | null;
	readonly headText: string | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const asRecord = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {});

// ─── File classification ──────────────────────────────────────────────────────

export type ConfigKind =
	| "eslint-js"
	| "eslint-data"
	| "eslintignore"
	| "tsconfig"
	| "jest-js"
	| "jest-json"
	| "vitest-js"
	| "coverage-data"
	| "package-json"
	| "workflow"
	| "husky"
	| "snapshot"
	| "baseline";

export function classifyConfig(repoPath: string, baselineName = ".ai-guard-baseline.json"): ConfigKind | null {
	const path = repoPath.replace(/\\/g, "/");
	if (path.split("/").includes("node_modules")) return null;
	const base = posix.basename(path);
	if (/^eslint\.config\.[cm]?[jt]s$/.test(base) || /^\.eslintrc\.c?js$/.test(base)) return "eslint-js";
	if (/^\.eslintrc(\.json|\.ya?ml)?$/.test(base)) return "eslint-data";
	if (base === ".eslintignore") return "eslintignore";
	if (/^[tj]sconfig(\..+)?\.json$/.test(base)) return "tsconfig";
	if (/^jest\.config\.[cm]?[jt]s$/.test(base)) return "jest-js";
	if (base === "jest.config.json") return "jest-json";
	if (/^(vitest|vite)\.config\.[cm]?[jt]s$/.test(base) || /^vitest\.workspace\.[cm]?[jt]s$/.test(base)) return "vitest-js";
	if (/^\.(nycrc|c8rc)(\.json|\.ya?ml)?$/.test(base)) return "coverage-data";
	if (base === "package.json") return "package-json";
	if (/^\.github\/workflows\/[^/]+\.ya?ml$/.test(path)) return "workflow";
	if (/^(.*\/)?\.husky\/[^/_.][^/]*$/.test(path)) return "husky";
	if (/\/__snapshots__\/[^/]+\.snap$/.test(path) || /^__snapshots__\/[^/]+\.snap$/.test(path)) return "snapshot";
	if (base === baselineName) return "baseline";
	return null;
}

// ─── ESLint configuration ─────────────────────────────────────────────────────

type Severity = 0 | 1 | 2;
const SEVERITY_NAME = ["off", "warn", "error"] as const;

function severityOf(value: Scalar): Severity | null {
	if (value === 0 || value === "off" || value === "0") return 0;
	if (value === 1 || value === "warn" || value === "1") return 1;
	if (value === 2 || value === "error" || value === "2") return 2;
	return null;
}

/** Rule to severities of each explicit rule entry (one per config block). */
function ruleSeverities(entries: ReadonlyArray<PathEntry>): Map<string, Severity[]> {
	const out = new Map<string, Severity[]>();
	for (const entry of entries) {
		const k = entry.path.lastIndexOf("rules");
		if (k < 0 || k + 1 >= entry.path.length) continue;
		const isScalar = entry.path.length === k + 2;
		const isArrayHead = entry.path.length === k + 3 && entry.path[k + 2] === "[0]";
		if (!isScalar && !isArrayHead) continue;
		const severity = severityOf(entry.value);
		const rule = entry.path[k + 1];
		if (severity === null || rule === undefined) continue;
		out.set(rule, [...(out.get(rule) ?? []), severity]);
	}
	return out;
}

const AI_GUARD_REF = /eslint-plugin-ai-guard|plugin:ai-guard\/|["']ai-guard["']/;

function stringsUnder(entries: ReadonlyArray<PathEntry>, keys: ReadonlyArray<string>): Set<string> {
	const out = new Set<string>();
	for (const entry of entries) {
		const index = entry.path.findIndex((segment) => keys.includes(segment));
		if (index >= 0 && entry.path.length === index + 2 && /^\[\d+\]$/.test(entry.path[index + 1] ?? "") && typeof entry.value === "string") {
			out.add(entry.value);
		}
	}
	return out;
}

const severityName = (severity: Severity): string => SEVERITY_NAME[severity];
const highest = (severities: ReadonlyArray<Severity>): Severity => severities.reduce<Severity>((max, severity) => (severity > max ? severity : max), 0);
const lowest = (severities: ReadonlyArray<Severity>): Severity => severities.reduce<Severity>((min, severity) => (severity < min ? severity : min), 2);

function ruleChange(file: string, rule: string, before: ReadonlyArray<Severity>, after: ReadonlyArray<Severity>, headUsesAiGuard: boolean): FindingDraft | null {
	const maxBefore = before.length > 0 ? highest(before) : null;
	const maxAfter = after.length > 0 ? highest(after) : null;
	const ruleId = "ai-guard/integrity-eslint-config-weakened";
	if (maxBefore !== null && maxAfter !== null) {
		if (maxAfter < maxBefore) {
			return {
				ruleId,
				tier: "high",
				file,
				message: `Lowered ESLint rule \`${rule}\` from "${severityName(maxBefore)}" to "${severityName(maxAfter)}".`,
				before: severityName(maxBefore),
				after: severityName(maxAfter),
				key: `rule:${rule}`,
			};
		}
		const weakerBefore = before.filter((severity) => severity < maxBefore).length;
		const weakerAfter = after.filter((severity) => severity < maxBefore).length;
		if (weakerAfter <= weakerBefore) return null;
		const weakest = lowest(after);
		return {
			ruleId,
			tier: "advisory",
			file,
			message: `Added a config block that sets \`${rule}\` to "${severityName(weakest)}" for some files (still "${severityName(maxBefore)}" elsewhere).`,
			after: severityName(weakest),
			key: `rule-scoped:${rule}`,
		};
	}
	if (maxBefore !== null && maxBefore > 0 && maxAfter === null) {
		return {
			ruleId,
			tier: "advisory",
			file,
			message: `\`${rule}\` (was "${severityName(maxBefore)}") is no longer configured in this file; its severity now comes from shared configs.`,
			before: severityName(maxBefore),
			after: "(not set)",
			key: `rule-removed:${rule}`,
		};
	}
	if (maxBefore === null && after.includes(0)) {
		const knownOn = rule.startsWith("ai-guard/") && headUsesAiGuard;
		return {
			ruleId,
			tier: knownOn ? "high" : "advisory",
			file,
			message: knownOn ? `Turned off AI Guard rule \`${rule}\`.` : `Explicitly turned off ESLint rule \`${rule}\`.`,
			after: "off",
			key: `rule-off:${rule}`,
		};
	}
	return null;
}

export function analyzeEslintConfig(
	file: string,
	base: ReadonlyArray<PathEntry> | null,
	head: ReadonlyArray<PathEntry> | null,
	baseText: string,
	headText: string | null,
): FindingDraft[] {
	const drafts: FindingDraft[] = [];
	if (headText === null) {
		if (AI_GUARD_REF.test(baseText)) {
			drafts.push({
				ruleId: "ai-guard/integrity-eslint-config-weakened",
				tier: "advisory",
				file,
				message: "Deleted an ESLint config that enabled AI Guard; confirm the configuration moved elsewhere.",
				before: "present",
				after: "deleted",
				key: "deleted",
			});
		}
		return drafts;
	}
	if (AI_GUARD_REF.test(baseText) && !AI_GUARD_REF.test(headText)) {
		drafts.push({
			ruleId: "ai-guard/integrity-eslint-config-weakened",
			tier: "high",
			file,
			message: "Removed AI Guard (eslint-plugin-ai-guard) from this ESLint configuration.",
			before: "enabled",
			after: "removed",
			key: "ai-guard-removed",
		});
	}
	if (base === null || head === null) return drafts;

	const before = ruleSeverities(base);
	const after = ruleSeverities(head);
	const headUsesAiGuard = AI_GUARD_REF.test(headText);
	for (const rule of [...new Set([...before.keys(), ...after.keys()])].sort()) {
		const change = ruleChange(file, rule, before.get(rule) ?? [], after.get(rule) ?? [], headUsesAiGuard);
		if (change !== null) drafts.push(change);
	}

	const ignoresBefore = stringsUnder(base, ["ignores", "ignorePatterns"]);
	const newIgnores = [...stringsUnder(head, ["ignores", "ignorePatterns"])].filter((pattern) => !ignoresBefore.has(pattern)).sort();
	if (newIgnores.length > 0) {
		drafts.push({
			ruleId: "ai-guard/integrity-eslint-config-weakened",
			tier: "advisory",
			file,
			message: `Added ESLint ignore patterns: ${newIgnores.map((pattern) => `\`${pattern}\``).join(", ")}.`,
			after: newIgnores.join(", "),
			key: `ignores:${newIgnores.join("|")}`,
		});
	}
	return drafts;
}

export function analyzeIgnoreFile(pair: TextPair): FindingDraft[] {
	if (pair.headText === null) return [];
	const lines = (text: string | null): Set<string> =>
		new Set(
			(text ?? "")
				.split("\n")
				.map((line) => line.trim())
				.filter((line) => line !== "" && !line.startsWith("#")),
		);
	const before = lines(pair.baseText);
	const added = [...lines(pair.headText)].filter((line) => !before.has(line)).sort();
	if (added.length === 0) return [];
	return [
		{
			ruleId: "ai-guard/integrity-eslint-config-weakened",
			tier: "advisory",
			file: pair.path,
			message: `Added ${added.length} pattern(s) excluded from linting: ${added
				.slice(0, 5)
				.map((pattern) => `\`${pattern}\``)
				.join(", ")}.`,
			after: added.join(", "),
			key: `eslintignore:${added.join("|")}`,
		},
	];
}

// ─── TypeScript configuration ─────────────────────────────────────────────────

const STRICT_FAMILY: ReadonlyArray<string> = [
	"noImplicitAny",
	"strictNullChecks",
	"strictFunctionTypes",
	"strictBindCallApply",
	"strictPropertyInitialization",
	"noImplicitThis",
	"alwaysStrict",
	"useUnknownInCatchVariables",
	"strictBuiltinIteratorReturn",
];
const STRICT_WHEN_TRUE: ReadonlyArray<string> = [
	"noUncheckedIndexedAccess",
	"exactOptionalPropertyTypes",
	"noImplicitReturns",
	"noFallthroughCasesInSwitch",
	"noImplicitOverride",
	"checkJs",
	"noEmitOnError",
];

type TriState = boolean | "unknown";

function effectiveOption(options: Record<string, unknown>, hasExtends: boolean, key: string): TriState {
	const value = options[key];
	if (typeof value === "boolean") return value;
	if (STRICT_FAMILY.includes(key) && typeof options.strict === "boolean") return options.strict;
	return hasExtends ? "unknown" : false;
}

const stringList = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);

export function analyzeTsconfig(file: string, base: unknown, head: unknown): FindingDraft[] {
	const drafts: FindingDraft[] = [];
	const b = asRecord(base);
	const h = asRecord(head);
	const baseOptions = asRecord(b.compilerOptions);
	const headOptions = asRecord(h.compilerOptions);
	const baseExtends = b.extends !== undefined;
	const headExtends = h.extends !== undefined;

	for (const key of ["strict", ...STRICT_FAMILY, ...STRICT_WHEN_TRUE]) {
		// Family members that only follow `strict` are reported once, via `strict`.
		if (STRICT_FAMILY.includes(key) && !(key in baseOptions) && !(key in headOptions)) continue;
		const before = effectiveOption(baseOptions, baseExtends, key);
		const after = effectiveOption(headOptions, headExtends, key);
		if (before !== true) continue;
		if (after === false) {
			drafts.push({
				ruleId: "ai-guard/integrity-tsconfig-weakened",
				tier: "high",
				file,
				message: `\`compilerOptions.${key}\` changed from true to ${key in headOptions ? "false" : "unset (defaults to false)"}.`,
				before: "true",
				after: key in headOptions ? "false" : "(unset)",
				key: `opt:${key}`,
			});
		} else if (after === "unknown") {
			drafts.push({
				ruleId: "ai-guard/integrity-tsconfig-weakened",
				tier: "advisory",
				file,
				message: `\`compilerOptions.${key}\` is no longer set to true here; its value now comes from \`extends\`.`,
				before: "true",
				after: "(inherited)",
				key: `opt-inherited:${key}`,
			});
		}
	}
	if (baseOptions.skipLibCheck !== true && headOptions.skipLibCheck === true) {
		drafts.push({
			ruleId: "ai-guard/integrity-tsconfig-weakened",
			tier: "advisory",
			file,
			message: "`compilerOptions.skipLibCheck` turned on; declaration files are no longer type-checked.",
			before: String(baseOptions.skipLibCheck ?? "(unset)"),
			after: "true",
			key: "opt:skipLibCheck",
		});
	}
	const newExcludes = stringList(h.exclude).filter((pattern) => !stringList(b.exclude).includes(pattern));
	if (newExcludes.length > 0 && Array.isArray(b.exclude)) {
		drafts.push({
			ruleId: "ai-guard/integrity-tsconfig-weakened",
			tier: "advisory",
			file,
			message: `Added files excluded from type checking: ${newExcludes.map((pattern) => `\`${pattern}\``).join(", ")}.`,
			after: newExcludes.join(", "),
			key: `exclude:${newExcludes.join("|")}`,
		});
	}
	const removedIncludes = [...stringList(b.include), ...stringList(b.files)].filter(
		(pattern) => !stringList(h.include).includes(pattern) && !stringList(h.files).includes(pattern),
	);
	if (removedIncludes.length > 0 && (Array.isArray(h.include) || Array.isArray(h.files))) {
		drafts.push({
			ruleId: "ai-guard/integrity-tsconfig-weakened",
			tier: "advisory",
			file,
			message: `Removed paths from type checking: ${removedIncludes.map((pattern) => `\`${pattern}\``).join(", ")}.`,
			before: removedIncludes.join(", "),
			key: `include:${removedIncludes.join("|")}`,
		});
	}
	return drafts;
}

// ─── Coverage and test-runner configuration ───────────────────────────────────

const METRICS: ReadonlySet<string> = new Set(["lines", "branches", "functions", "statements"]);
const THRESHOLD_PARENTS: ReadonlySet<string> = new Set(["coverageThreshold", "thresholds", "check-coverage", "checkCoverage"]);

function thresholdEntries(entries: ReadonlyArray<PathEntry>, rootIsCoverageTool: boolean): Map<string, { readonly path: ReadonlyArray<string>; readonly value: number }> {
	const out = new Map<string, { readonly path: ReadonlyArray<string>; readonly value: number }>();
	for (const entry of entries) {
		const { path, value } = entry;
		if (typeof value !== "number" || !METRICS.has(path.at(-1) ?? "")) continue;
		const underThreshold =
			path.some((segment) => THRESHOLD_PARENTS.has(segment)) ||
			(path.includes("coverage") && !path.includes("thresholds") && path.length >= 2 && path.at(-2) === "coverage") ||
			(rootIsCoverageTool && path.length === 1) ||
			(path.length === 2 && (path[0] === "nyc" || path[0] === "c8"));
		if (underThreshold) out.set(pathKey(path), { path, value });
	}
	return out;
}

function scalarAt(entries: ReadonlyArray<PathEntry>, suffix: ReadonlyArray<string>): Scalar | undefined {
	for (const entry of entries) {
		const offset = entry.path.length - suffix.length;
		if (offset >= 0 && suffix.every((segment, i) => entry.path[offset + i] === segment)) return entry.value;
	}
	return undefined;
}

interface CoverageFlag {
	readonly suffix: ReadonlyArray<string>;
	readonly disabled: (head: Scalar | undefined) => boolean;
	readonly tier: IntegrityTier;
	readonly message: string;
}

const COVERAGE_FLAGS: ReadonlyArray<CoverageFlag> = [
	{
		suffix: ["check-coverage"],
		disabled: (head) => head !== true,
		tier: "high",
		message: "`check-coverage` turned off; coverage thresholds are no longer enforced.",
	},
	{
		suffix: ["checkCoverage"],
		disabled: (head) => head !== true,
		tier: "high",
		message: "`checkCoverage` turned off; coverage thresholds are no longer enforced.",
	},
	{
		suffix: ["collectCoverage"],
		disabled: (head) => head === false,
		tier: "advisory",
		message: "`collectCoverage` turned off; Jest thresholds only apply when coverage is collected.",
	},
	{ suffix: ["coverage", "enabled"], disabled: (head) => head === false, tier: "advisory", message: "`coverage.enabled` turned off." },
];

const EXCLUDE_KEYS: ReadonlyArray<string> = ["testPathIgnorePatterns", "modulePathIgnorePatterns", "exclude"];

function testExcludes(entries: ReadonlyArray<PathEntry>): Set<string> {
	const out = new Set<string>();
	for (const entry of entries) {
		const index = entry.path.findIndex((segment) => EXCLUDE_KEYS.includes(segment));
		if (index < 0 || typeof entry.value !== "string") continue;
		// vitest `test.exclude`/`coverage.exclude`: only test-file excludes matter here.
		if (entry.path[index] === "exclude" && !(index > 0 && entry.path[index - 1] === "test")) continue;
		out.add(entry.value);
	}
	return out;
}

function thresholdChanges(file: string, base: ReadonlyArray<PathEntry>, head: ReadonlyArray<PathEntry>, rootIsCoverageTool: boolean): FindingDraft[] {
	const drafts: FindingDraft[] = [];
	const after = thresholdEntries(head, rootIsCoverageTool);
	for (const [key, before] of thresholdEntries(base, rootIsCoverageTool)) {
		const label = displayPath(before.path);
		const current = after.get(key);
		if (current === undefined) {
			drafts.push({
				ruleId: "ai-guard/integrity-coverage-weakened",
				tier: "high",
				file,
				message: `Removed coverage threshold \`${label}\` (was ${before.value}).`,
				before: String(before.value),
				after: "(removed)",
				key: `threshold:${key}`,
			});
		} else if (Math.sign(current.value) !== Math.sign(before.value) && before.value !== 0 && current.value !== 0) {
			drafts.push({
				ruleId: "ai-guard/integrity-coverage-weakened",
				tier: "advisory",
				file,
				message: `Coverage threshold \`${label}\` changed meaning (${before.value} → ${current.value}); negative values count uncovered items.`,
				before: String(before.value),
				after: String(current.value),
				key: `threshold:${key}`,
			});
		} else if (current.value < before.value) {
			drafts.push({
				ruleId: "ai-guard/integrity-coverage-weakened",
				tier: "high",
				file,
				message: `Lowered coverage threshold \`${label}\` from ${before.value} to ${current.value}.`,
				before: String(before.value),
				after: String(current.value),
				key: `threshold:${key}`,
			});
		}
	}
	return drafts;
}

export function analyzeCoverageAndTestConfig(
	file: string,
	base: ReadonlyArray<PathEntry> | null,
	head: ReadonlyArray<PathEntry> | null,
	options: { readonly rootIsCoverageTool: boolean; readonly fileDeleted: boolean },
): FindingDraft[] {
	if (base === null) return [];
	if (options.fileDeleted || head === null) {
		const thresholds = thresholdEntries(base, options.rootIsCoverageTool).size;
		if (thresholds === 0) return [];
		return [
			{
				ruleId: "ai-guard/integrity-coverage-weakened",
				tier: "advisory",
				file,
				message: `Deleted a config file that enforced ${thresholds} coverage threshold(s); confirm they moved elsewhere.`,
				before: `${thresholds} threshold(s)`,
				after: "deleted",
				key: "deleted",
			},
		];
	}
	const drafts = thresholdChanges(file, base, head, options.rootIsCoverageTool);

	for (const flag of COVERAGE_FLAGS) {
		const before = scalarAt(base, flag.suffix);
		const after = scalarAt(head, flag.suffix);
		if (before === true && flag.disabled(after)) {
			drafts.push({
				ruleId: "ai-guard/integrity-coverage-weakened",
				tier: flag.tier,
				file,
				message: flag.message,
				before: formatScalar(before),
				after: formatScalar(after),
				key: `flag:${flag.suffix.join(".")}`,
			});
		}
	}
	const passBefore = scalarAt(base, ["passWithNoTests"]);
	const passAfter = scalarAt(head, ["passWithNoTests"]);
	if (passBefore !== true && passAfter === true) {
		drafts.push({
			ruleId: "ai-guard/integrity-test-config-weakened",
			tier: "advisory",
			file,
			message: "`passWithNoTests` turned on; the test run now passes when no tests are found.",
			before: formatScalar(passBefore),
			after: "true",
			key: "passWithNoTests",
		});
	}
	const excludedBefore = testExcludes(base);
	const newExcludes = [...testExcludes(head)].filter((pattern) => !excludedBefore.has(pattern)).sort();
	if (newExcludes.length > 0) {
		drafts.push({
			ruleId: "ai-guard/integrity-test-config-weakened",
			tier: "advisory",
			file,
			message: `Added test exclusions: ${newExcludes.map((pattern) => `\`${pattern}\``).join(", ")}.`,
			after: newExcludes.join(", "),
			key: `exclude:${newExcludes.join("|")}`,
		});
	}
	return drafts;
}

// ─── package.json scripts and hooks ───────────────────────────────────────────

const VERIFY_SCRIPT_NAME = /^(test|tests|lint|typecheck|type-check|types|tsc|check|verify|validate|ci|pre-?commit|pre-?push|e2e|coverage)(:.*)?$/i;

function stringRecord(value: unknown): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, item] of Object.entries(asRecord(value))) if (typeof item === "string") out[key] = item;
	return out;
}

function compareCommands(file: string, label: string, keyPrefix: string, before: string, after: string, ruleId: string): FindingDraft[] {
	const drafts: FindingDraft[] = [];
	for (const weakener of addedWeakeners(before, after)) {
		const isHookBypass = weakener.kind === "no-verify" || weakener.kind === "hooks-disabled";
		drafts.push({
			ruleId: isHookBypass ? "ai-guard/integrity-git-hook-bypass" : ruleId,
			tier: weakener.high ? "high" : "advisory",
			file,
			message: `${label}: ${describeWeakener(weakener)}.`,
			before,
			after,
			key: `${keyPrefix}:${weakener.kind}`,
		});
	}
	const afterSegments = verificationSegments(after);
	const afterKeys = new Set(afterSegments.map(verificationKey));
	const beforeSegments = verificationSegments(before);
	const removed = beforeSegments.filter((segment) => !afterKeys.has(verificationKey(segment)));
	const changed = beforeSegments.filter((segment) => afterKeys.has(verificationKey(segment)) && !afterSegments.includes(segment));
	if (removed.length > 0) {
		drafts.push({
			ruleId,
			tier: "high",
			file,
			message:
				afterSegments.length === 0
					? `${label} no longer runs a verification command (was \`${before}\`).`
					: `${label}: removed ${removed.map((segment) => `\`${segment}\``).join(", ")}.`,
			before,
			after,
			key: `${keyPrefix}:removed:${removed.map(verificationKey).join("|")}`,
		});
	}
	if (changed.length > 0) {
		drafts.push({
			ruleId,
			tier: "advisory",
			file,
			message: `${label}: arguments of ${changed.map((segment) => `\`${segment}\``).join(", ")} changed; check that the same tests or files are still covered.`,
			before,
			after,
			key: `${keyPrefix}:args:${changed.map(verificationKey).join("|")}`,
		});
	}
	return drafts;
}

function scriptChanges(file: string, baseScripts: Record<string, string>, headScripts: Record<string, string>): FindingDraft[] {
	const drafts: FindingDraft[] = [];
	const headValues = new Set(Object.values(headScripts));
	for (const [name, before] of Object.entries(baseScripts)) {
		const after = headScripts[name];
		const isVerify = VERIFY_SCRIPT_NAME.test(name) || isVerificationCommand(before);
		if (after === undefined) {
			if (isVerify && !headValues.has(before)) {
				drafts.push({
					ruleId: "ai-guard/integrity-verification-script-weakened",
					tier: "high",
					file,
					message: `Removed the \`${name}\` script (was \`${before}\`).`,
					before,
					after: "(removed)",
					key: `script-removed:${name}`,
				});
			}
			continue;
		}
		if (after === before) continue;
		const compared = compareCommands(file, `Script \`${name}\``, `script:${name}`, before, after, "ai-guard/integrity-verification-script-weakened");
		// Non-verification scripts: only hook bypasses matter.
		drafts.push(...(isVerify ? compared : compared.filter((draft) => draft.ruleId === "ai-guard/integrity-git-hook-bypass")));
	}
	for (const [name, after] of Object.entries(headScripts)) {
		if (name in baseScripts) continue;
		for (const weakener of addedWeakeners(null, after).filter((item) => item.kind === "no-verify" || item.kind === "hooks-disabled")) {
			drafts.push({
				ruleId: "ai-guard/integrity-git-hook-bypass",
				tier: "high",
				file,
				message: `New script \`${name}\`: ${describeWeakener(weakener)}.`,
				after,
				key: `script-new:${name}:${weakener.kind}`,
			});
		}
	}
	return drafts;
}

export function analyzePackageJson(file: string, base: Record<string, unknown>, head: Record<string, unknown>): FindingDraft[] {
	const baseScripts = stringRecord(base.scripts);
	const headScripts = stringRecord(head.scripts);
	const drafts = scriptChanges(file, baseScripts, headScripts);

	// husky v4 (`husky.hooks`) and simple-git-hooks.
	const hookMaps: ReadonlyArray<readonly [string, Record<string, string>, Record<string, string>]> = [
		["husky.hooks", stringRecord(asRecord(base.husky).hooks), stringRecord(asRecord(head.husky).hooks)],
		["simple-git-hooks", stringRecord(base["simple-git-hooks"]), stringRecord(head["simple-git-hooks"])],
	];
	for (const [label, baseHooks, headHooks] of hookMaps) {
		for (const [hook, before] of Object.entries(baseHooks)) {
			const after = headHooks[hook];
			if (after === undefined) {
				drafts.push({
					ruleId: "ai-guard/integrity-git-hook-bypass",
					tier: "high",
					file,
					message: `Removed the \`${hook}\` Git hook from \`${label}\` (was \`${before}\`).`,
					before,
					after: "(removed)",
					key: `hook-removed:${label}:${hook}`,
				});
			} else if (after !== before) {
				drafts.push(...compareCommands(file, `Git hook \`${label}.${hook}\``, `hook:${label}:${hook}`, before, after, "ai-guard/integrity-git-hook-bypass"));
			}
		}
	}
	if (base["lint-staged"] !== undefined && head["lint-staged"] === undefined) {
		drafts.push({
			ruleId: "ai-guard/integrity-git-hook-bypass",
			tier: "advisory",
			file,
			message: "Removed the `lint-staged` configuration; pre-commit checks may no longer run.",
			before: "present",
			after: "(removed)",
			key: "lint-staged-removed",
		});
	}
	const prepareBefore = baseScripts.prepare ?? "";
	const prepareAfter = headScripts.prepare ?? "";
	if (/\bhusky\b/.test(prepareBefore) && !/\bhusky\b/.test(prepareAfter)) {
		drafts.push({
			ruleId: "ai-guard/integrity-git-hook-bypass",
			tier: "advisory",
			file,
			message: "The `prepare` script no longer installs husky Git hooks.",
			before: prepareBefore,
			after: prepareAfter === "" ? "(removed)" : prepareAfter,
			key: "prepare-husky",
		});
	}
	return drafts;
}

/** Entries for a nested config key inside package.json (jest, eslintConfig, nyc, c8). */
export function packageJsonSection(pkg: Record<string, unknown>, key: string): PathEntry[] | null {
	if (pkg[key] === undefined) return null;
	return entriesFromValue(pkg[key], key === "nyc" || key === "c8" ? [key] : []);
}

// ─── GitHub Actions workflows ─────────────────────────────────────────────────

interface Step {
	readonly identity: string;
	readonly run?: string | undefined;
	readonly uses?: string | undefined;
	readonly if?: unknown;
	readonly coe?: unknown;
}
interface Job {
	readonly if?: unknown;
	readonly coe?: unknown;
	readonly steps: ReadonlyArray<Step>;
}
interface Workflow {
	readonly triggers: ReadonlySet<string>;
	readonly jobs: ReadonlyMap<string, Job>;
	readonly on: Record<string, unknown>;
}

function stepIdentity(step: Record<string, unknown>, index: number): string {
	if (typeof step.id === "string") return `id:${step.id}`;
	if (typeof step.name === "string") return `name:${step.name}`;
	if (typeof step.run === "string" && step.run !== "") return `run:${(step.run.split("\n")[0] ?? "").trim()}`;
	if (typeof step.uses === "string" && step.uses !== "") return `uses:${step.uses}`;
	return `#${index}`;
}

function normalizeWorkflow(document: unknown): Workflow {
	const workflow = asRecord(document);
	// YAML 1.1 parsers may read `on` as true.
	const on = workflow.on ?? workflow.true;
	const triggers = new Set<string>();
	let onRecord: Record<string, unknown> = {};
	if (typeof on === "string") triggers.add(on);
	else if (Array.isArray(on)) for (const trigger of on) if (typeof trigger === "string") triggers.add(trigger);
	if (isRecord(on)) {
		onRecord = on;
		for (const trigger of Object.keys(onRecord)) triggers.add(trigger);
	}
	const jobs = new Map<string, Job>();
	for (const [id, raw] of Object.entries(asRecord(workflow.jobs))) {
		const job = asRecord(raw);
		const rawSteps: unknown[] = Array.isArray(job.steps) ? job.steps : [];
		const steps = rawSteps.map((rawStep, index): Step => {
			const step = asRecord(rawStep);
			return {
				identity: stepIdentity(step, index),
				run: typeof step.run === "string" ? step.run : undefined,
				uses: typeof step.uses === "string" ? step.uses : undefined,
				if: step.if,
				coe: step["continue-on-error"],
			};
		});
		jobs.set(id, { if: job.if, coe: job["continue-on-error"], steps });
	}
	return { triggers, jobs, on: onRecord };
}

function isVerificationStep(step: Step): boolean {
	return (step.run !== undefined && isVerificationCommand(step.run)) || (step.uses !== undefined && /ai-guard|eslint|codeql-action\/analyze/i.test(step.uses));
}

/** Verification commands a step runs, as tool keys (arguments ignored; see verificationKey). */
function stepCommands(step: Step): string[] {
	if (step.run !== undefined && step.run !== "") return [...new Set(verificationSegments(step.run).map(verificationKey))];
	if (step.uses !== undefined && step.uses !== "") return [`uses:${step.uses.replace(/@.*$/, "")}`];
	return [];
}

function isDisabledCondition(value: unknown): boolean {
	return value === false || (typeof value === "string" && /^\s*(\$\{\{\s*)?false(\s*\}\})?\s*$/.test(value));
}

/** Verification commands per workflow head, so steps moved between jobs or files are not reported. */
export function workflowVerificationCommands(text: string | null, parse: (text: string) => unknown): Set<string> {
	const out = new Set<string>();
	if (text === null) return out;
	let document: unknown;
	try {
		document = parse(text);
	} catch {
		// An unparseable head has nothing to match against; the workflow analysis reports the parse error.
		return out;
	}
	for (const job of normalizeWorkflow(document).jobs.values()) for (const step of job.steps) for (const command of stepCommands(step)) out.add(command);
	return out;
}

const backticked = (items: Iterable<string>): string => [...items].map((item) => `\`${item}\``).join(", ");

function triggerChanges(file: string, base: Workflow, head: Workflow): FindingDraft[] {
	const drafts: FindingDraft[] = [];
	for (const trigger of ["pull_request", "pull_request_target", "push", "merge_group"]) {
		if (base.triggers.has(trigger) && !head.triggers.has(trigger)) {
			drafts.push({
				ruleId: "ai-guard/integrity-ci-check-weakened",
				tier: "high",
				file,
				message: `Removed the \`${trigger}\` trigger from a workflow that runs verification steps.`,
				before: trigger,
				after: "(removed)",
				key: `trigger:${trigger}`,
			});
		}
	}
	for (const trigger of ["pull_request", "push"]) {
		const before = asRecord(base.on[trigger]);
		const headTrigger = head.on[trigger] ?? {};
		if (typeof headTrigger !== "object" || headTrigger === null) continue;
		const after = asRecord(headTrigger);
		for (const filter of ["paths-ignore", "branches-ignore", "paths"]) {
			const beforeList: unknown = before[filter];
			const afterList: unknown = after[filter];
			const had = Array.isArray(beforeList) ? beforeList.map(String) : [];
			const now = Array.isArray(afterList) ? afterList.map(String) : [];
			const added = now.filter((item) => !had.includes(item));
			// Adding to an existing `paths` allow-list broadens runs; only a newly introduced `paths` filter narrows
			// them. Ignore lists narrow on every addition.
			if (added.length > 0 && (filter !== "paths" || had.length === 0)) {
				drafts.push({
					ruleId: "ai-guard/integrity-ci-check-weakened",
					tier: "advisory",
					file,
					message: `\`on.${trigger}.${filter}\` now ${filter === "paths" ? "limits runs to" : "skips"} ${backticked(added)}.`,
					after: added.join(", "),
					key: `filter:${trigger}:${filter}:${added.join("|")}`,
				});
			}
		}
	}
	return drafts;
}

interface Conditions {
	readonly if?: unknown;
	readonly coe?: unknown;
}

/** `continue-on-error` and `if:` changes of a job or step; `id` is the job id, plus the step identity for steps. */
function conditionChanges(file: string, label: string, scope: "job" | "step", id: string, before: Conditions, after: Conditions, failsWhat: string): FindingDraft[] {
	const drafts: FindingDraft[] = [];
	if (before.coe !== true && after.coe !== undefined && after.coe !== false && JSON.stringify(after.coe) !== JSON.stringify(before.coe)) {
		drafts.push({
			ruleId: "ai-guard/integrity-ci-check-weakened",
			tier: after.coe === true ? "high" : "advisory",
			file,
			message: `${label} now sets \`continue-on-error: ${String(after.coe)}\`; ${failsWhat}.`,
			before: String(before.coe ?? false),
			after: String(after.coe),
			key: `${scope}-coe:${id}`,
		});
	}
	if (JSON.stringify(after.if) !== JSON.stringify(before.if) && after.if !== undefined) {
		const disabled = isDisabledCondition(after.if);
		drafts.push({
			ruleId: "ai-guard/integrity-ci-check-weakened",
			tier: disabled ? "high" : "advisory",
			file,
			message: disabled ? `${label} is disabled with \`if: ${String(after.if)}\`.` : `${label} now runs only when \`${String(after.if)}\`.`,
			before: before.if === undefined ? "(always)" : String(before.if),
			after: String(after.if),
			key: `${scope}-if:${id}`,
		});
	}
	return drafts;
}

function stepChanges(file: string, id: string, baseJob: Job, headJob: Job, headCommands: ReadonlySet<string>): FindingDraft[] {
	const drafts: FindingDraft[] = [];
	for (const baseStep of baseJob.steps.filter(isVerificationStep)) {
		const commands = stepCommands(baseStep);
		const headStep =
			headJob.steps.find((step) => step.identity === baseStep.identity) ??
			headJob.steps.find((step) => stepCommands(step).some((command) => commands.includes(command)));
		const label = `Step "${baseStep.identity.replace(/^(id|name|run|uses):/, "")}" in job \`${id}\``;
		if (headStep === undefined) {
			const missing = commands.filter((command) => !headCommands.has(command));
			if (missing.length > 0) {
				drafts.push({
					ruleId: "ai-guard/integrity-ci-check-weakened",
					tier: "high",
					file,
					message: `${label} was removed (ran ${backticked(missing)}).`,
					before: commands.join("; "),
					after: "(removed)",
					key: `step-removed:${id}:${baseStep.identity}`,
				});
			}
			continue;
		}
		drafts.push(...conditionChanges(file, label, "step", `${id}:${baseStep.identity}`, baseStep, headStep, "a failing check no longer fails the job"));
		const baseRun = baseStep.run;
		const headRun = headStep.run;
		if (baseRun !== undefined && headRun !== undefined && baseRun !== headRun) {
			const stillRunsElsewhere = !verificationSegments(baseRun).some((command) => !headCommands.has(verificationKey(command)));
			drafts.push(
				...compareCommands(file, label, `step-run:${id}:${baseStep.identity}`, baseRun, headRun, "ai-guard/integrity-ci-check-weakened").filter(
					(draft) => !draft.key.includes(":removed:") || !stillRunsElsewhere,
				),
			);
		}
	}
	return drafts;
}

export function analyzeWorkflow(file: string, baseDocument: unknown, headDocument: unknown, elsewhere: ReadonlySet<string>): FindingDraft[] {
	const base = normalizeWorkflow(baseDocument);
	const verifyJobs = [...base.jobs.entries()].filter(([, job]) => job.steps.some(isVerificationStep));
	if (verifyJobs.length === 0) return [];

	if (headDocument === null) {
		const missing = verifyJobs.flatMap(([, job]) => job.steps.filter(isVerificationStep).flatMap(stepCommands)).filter((command) => !elsewhere.has(command));
		if (missing.length === 0) return [];
		return [
			{
				ruleId: "ai-guard/integrity-ci-check-weakened",
				tier: "high",
				file,
				message: `Deleted a workflow that ran ${backticked(new Set(missing))}.`,
				before: "present",
				after: "deleted",
				key: "deleted",
			},
		];
	}

	const head = normalizeWorkflow(headDocument);
	const headCommands = new Set<string>(elsewhere);
	for (const job of head.jobs.values()) for (const step of job.steps) for (const command of stepCommands(step)) headCommands.add(command);

	const drafts = triggerChanges(file, base, head);
	for (const [id, baseJob] of verifyJobs) {
		const headJob = head.jobs.get(id);
		if (headJob === undefined) {
			const missing = [...new Set(baseJob.steps.filter(isVerificationStep).flatMap(stepCommands).filter((command) => !headCommands.has(command)))];
			if (missing.length > 0) {
				drafts.push({
					ruleId: "ai-guard/integrity-ci-check-weakened",
					tier: "high",
					file,
					message: `Removed job \`${id}\`, which ran ${backticked(missing)}.`,
					before: id,
					after: "(removed)",
					key: `job-removed:${id}`,
				});
			}
			continue;
		}
		drafts.push(...conditionChanges(file, `Job \`${id}\``, "job", id, baseJob, headJob, "its verification failures no longer fail the workflow"));
		drafts.push(...stepChanges(file, id, baseJob, headJob, headCommands));
	}
	return drafts;
}

// ─── husky hook files ─────────────────────────────────────────────────────────

function effectiveHookLines(text: string): string[] {
	return text
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "" && !line.startsWith("#") && !/husky\.sh/.test(line));
}

const EARLY_EXIT = /^(exit\s+0|true)\b/;

export function analyzeHuskyHook(pair: TextPair): FindingDraft[] {
	if (pair.baseText === null) return [];
	const before = effectiveHookLines(pair.baseText);
	const [firstBefore = ""] = before;
	if (before.length === 0) return [];
	if (pair.headText === null) {
		return [
			{
				ruleId: "ai-guard/integrity-git-hook-bypass",
				tier: "high",
				file: pair.path,
				message: `Deleted Git hook \`${pair.path}\` (ran ${backticked(before)}).`,
				before: before.join("; "),
				after: "deleted",
				key: "deleted",
			},
		];
	}
	const after = effectiveHookLines(pair.headText);
	const [firstAfter] = after;
	const drafts: FindingDraft[] = [];
	const earlyExit = firstAfter !== undefined && EARLY_EXIT.test(firstAfter) && !EARLY_EXIT.test(firstBefore);
	if (earlyExit) {
		drafts.push({
			ruleId: "ai-guard/integrity-git-hook-bypass",
			tier: "high",
			file: pair.path,
			message: `Git hook \`${pair.path}\` now exits before running its checks (\`${firstAfter}\`).`,
			after: firstAfter,
			key: "early-exit",
		});
	}
	const compared = compareCommands(pair.path, `Git hook \`${pair.path}\``, "hook", before.join("\n"), after.join("\n"), "ai-guard/integrity-git-hook-bypass");
	// The early exit is the same weakening as its exit-masking match; report it once.
	drafts.push(...(earlyExit ? compared.filter((draft) => !draft.key.endsWith(":exit-masking")) : compared));
	return drafts;
}

// ─── Jest snapshots ───────────────────────────────────────────────────────────

const SNAPSHOT_CHANGE_THRESHOLD = 3;

function snapshotEntries(text: string | null): Map<string, string> {
	const out = new Map<string, string>();
	if (text === null || text === "") return out;
	const marks = [...text.matchAll(/^exports\[`((?:\\`|[^`])*)`\] = /gm)].map((match) => ({
		name: match[1] ?? "",
		start: match.index,
		bodyStart: match.index + match[0].length,
	}));
	marks.forEach((mark, i) => out.set(mark.name, text.slice(mark.bodyStart, marks[i + 1]?.start ?? text.length).trim()));
	return out;
}

export function analyzeSnapshot(pair: TextPair): FindingDraft[] {
	const before = snapshotEntries(pair.baseText);
	if (before.size === 0) return [];
	const after = snapshotEntries(pair.headText);
	const removed = [...before.keys()].filter((name) => !after.has(name));
	const changed = [...before.keys()].filter((name) => after.has(name) && after.get(name) !== before.get(name));
	if (removed.length === 0 && changed.length < SNAPSHOT_CHANGE_THRESHOLD) return [];
	return [
		{
			ruleId: "ai-guard/integrity-snapshot-update",
			tier: "advisory",
			file: pair.path,
			message: `${changed.length} snapshot(s) rewritten and ${removed.length} removed (of ${before.size}).`,
			before: `${before.size} snapshots`,
			after: `${changed.length} changed, ${removed.length} removed`,
			key: "snapshots",
		},
	];
}

// ─── Integrity acceptances in the baseline file ───────────────────────────────

function acceptedFingerprints(document: unknown): Set<string> {
	const accepted: unknown = asRecord(asRecord(document).integrity).accepted;
	const out = new Set<string>();
	if (!Array.isArray(accepted)) return out;
	for (const acceptance of accepted) {
		const fingerprint = asRecord(acceptance).fingerprint;
		if (typeof fingerprint === "string") out.add(fingerprint);
	}
	return out;
}

export function analyzeAcceptances(file: string, baseDocument: unknown, headDocument: unknown): FindingDraft[] {
	const before = acceptedFingerprints(baseDocument);
	const added = [...acceptedFingerprints(headDocument)].filter((fingerprint) => !before.has(fingerprint)).sort();
	if (added.length === 0) return [];
	return [
		{
			ruleId: "ai-guard/integrity-acceptance-added",
			tier: "advisory",
			file,
			message: `This change accepts ${added.length} integrity finding(s) in the baseline file; accepted findings are no longer reported.`,
			after: `${added.length} accepted`,
			key: `accepted:${added.join("|")}`,
		},
	];
}
