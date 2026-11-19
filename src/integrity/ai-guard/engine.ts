// Ported from eslint-plugin-ai-guard 1.4.7 (`cli/utils/integrity/engine.ts` and `cli/utils/integrity/run.ts`, MIT);
// see `src/vendor/ai-guard/UPSTREAM.md`. Compares a base revision with the working tree and reports only weakenings
// the change introduced; conditions that already exist at the base are never reported. No network access and no
// model calls. Upstream's per-file (`paths`), workspace-scoped and `--staged` modes are not ported.

// oxlint-disable effecttsgo/node-builtin-import -- a standalone CLI outside any Effect runtime, so Effect's platform services do not apply

import { posix } from "node:path";

import { analyzeSuppressions, analyzeTests, type JsFilePair } from "./analyze-js.ts";
import {
	analyzeAcceptances,
	analyzeCoverageAndTestConfig,
	analyzeEslintConfig,
	analyzeHuskyHook,
	analyzeIgnoreFile,
	analyzePackageJson,
	analyzeSnapshot,
	analyzeTsconfig,
	analyzeWorkflow,
	classifyConfig,
	packageJsonSection,
	workflowVerificationCommands,
	type ConfigKind,
} from "./analyze-config.ts";
import { loadIntegrityAcceptances, resolveBaselinePath } from "./baseline.ts";
import { entriesFromAst, entriesFromValue, parseJsonc, parseYaml, type PathEntry } from "./config-values.ts";
import { addedLinesForAll, listChanges, readBlobs, readHeadFile, resolveBase, type ChangedEntry, type ResolvedBase } from "./git.ts";
import { analyzeJs, isTestPath, JS_TS_EXTENSIONS, parseSource, type AstNode, type JsFacts } from "./js-facts.ts";
import {
	compareFindings,
	errorMessage,
	finalizeFinding,
	isIntegrityGitError,
	type FindingDraft,
	type IntegrityEnvelope,
	type IntegrityError,
	type IntegrityFinding,
	type IntegrityMode,
	type IntegrityReport,
} from "./types.ts";

export interface AnalyzeOptions {
	readonly cwd: string;
	/** Base ref; omit for HEAD (uncommitted changes, plus untracked files). */
	readonly base?: string | undefined;
	/** Compare with merge-base(HEAD, base): pull request semantics. */
	readonly mergeBase?: boolean;
	/** Try `origin/<base>` before `<base>`. */
	readonly preferRemote?: boolean;
	/** Fingerprints accepted explicitly in the baseline file. */
	readonly acceptedFingerprints?: Iterable<string>;
	/** Maximum number of relevant files to analyze. */
	readonly maxFiles?: number;
}

const DEFAULT_MAX_FILES = 1000;

/** Text every suppression directive or `any` cast contains (see analyzeSuppressions). */
const SUPPRESSION_TEXT = /eslint-disable|eslint-enable|\/\*\s*eslint\s|@ts-(?:ignore|expect-error|nocheck|check)|\bas\s+any\b|<any>/;

interface Loaded {
	readonly entry: ChangedEntry;
	readonly js: boolean;
	readonly config: ConfigKind | null;
	readonly baseText: string | null;
	readonly headText: string | null;
}

function normalizeEol(text: string | null): string | null {
	return text === null ? null : text.replace(/\r\n/g, "\n");
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function parseAst(text: string, file: string): AstNode | null {
	const parsed = parseSource(text, file);
	return "ast" in parsed ? parsed.ast : null;
}

/** JSON first, then YAML, the way ESLint and coverage tools read their data configs. */
function parseData(text: string): PathEntry[] {
	let value: unknown;
	try {
		value = parseJsonc(text);
	} catch {
		value = parseYaml(text);
	}
	return entriesFromValue(value);
}

function firstLine(error: unknown): string {
	return errorMessage(error).split("\n")[0] ?? "";
}

/** Read the base and head text of each selected file, recording files that cannot be read. */
function loadFiles(base: ResolvedBase, selected: ReadonlyArray<Omit<Loaded, "baseText" | "headText">>, errors: IntegrityError[]): Loaded[] {
	const basePathOf = (entry: ChangedEntry): string | null => (entry.status === "A" ? null : (entry.oldPath ?? entry.path));
	const commit = base.commit;
	// Base contents in two Git processes total.
	const specs = commit === null ? [] : selected.flatMap(({ entry }) => {
		const path = basePathOf(entry);
		return path === null ? [] : [`${commit}:${path}`];
	});
	const blobs = specs.length > 0 ? readBlobs(base.repoRoot, specs) : new Map();
	const blobText = (spec: string): string | null => {
		const blob = blobs.get(spec);
		if (blob === undefined || "missing" in blob) return null;
		if ("error" in blob) throw blob.error;
		return blob.content;
	};

	const loaded: Loaded[] = [];
	for (const file of selected) {
		const basePath = basePathOf(file.entry);
		try {
			const baseText = basePath !== null && commit !== null ? normalizeEol(blobText(`${commit}:${basePath}`)) : null;
			const headText = file.entry.status === "D" ? null : normalizeEol(readHeadFile(base, file.entry.path));
			if (baseText !== null || headText !== null) loaded.push({ ...file, baseText, headText });
		} catch (error) {
			errors.push({ code: isIntegrityGitError(error) ? error.code : "READ_FAILED", message: errorMessage(error), file: file.entry.path });
		}
	}
	return loaded;
}

function analyzeSources(loaded: ReadonlyArray<Loaded>, addedByPath: ReadonlyMap<string, Set<number>>, errors: IntegrityError[]): FindingDraft[] {
	const drafts: FindingDraft[] = [];
	const testPairs: JsFilePair[] = [];
	for (const file of loaded.filter((item) => item.js)) {
		const { entry } = file;
		const isTest = isTestPath(entry.path) || (entry.oldPath !== undefined && isTestPath(entry.oldPath));
		// Non-test sources can only yield suppression / `as any` findings, which need this text on one side; skipping
		// the parse is exact, not a heuristic.
		if (!isTest && !SUPPRESSION_TEXT.test(file.baseText ?? "") && !SUPPRESSION_TEXT.test(file.headText ?? "")) continue;
		const facts = (text: string | null, side: string): JsFacts | null => {
			if (text === null) return null;
			const outcome = analyzeJs(text, entry.path);
			if (outcome.ok) return outcome.facts;
			errors.push({ code: outcome.error.split(":")[0] ?? "PARSE_ERROR", message: `${side}: ${outcome.error}`, file: entry.path });
			return null;
		};
		const baseFacts = facts(file.baseText, "base");
		const headFacts = facts(file.headText, "head");
		// An unparseable head cannot be compared; skip rather than guess.
		if (file.headText !== null && headFacts === null) continue;
		if (file.baseText !== null && baseFacts === null && entry.status !== "A") continue;
		const pair: JsFilePair = {
			path: entry.path,
			status: entry.status,
			base: baseFacts,
			head: headFacts,
			added: entry.status === "A" ? null : (addedByPath.get(entry.path) ?? null),
		};
		drafts.push(...analyzeSuppressions(pair));
		if (isTest) testPairs.push(pair);
	}
	drafts.push(...analyzeTests(testPairs, true));
	return drafts;
}

/** Findings for one configuration file; `parseFailed` records a side that could not be read. */
function analyzeConfigFile(
	file: Loaded,
	kind: ConfigKind,
	workflowHeads: ReadonlyMap<string, Set<string>>,
	parseFailed: (side: string, error: unknown) => void,
): FindingDraft[] {
	const path = file.entry.path;
	const { baseText, headText } = file;
	const pair = { path, status: file.entry.status, baseText, headText };
	switch (kind) {
		case "eslint-js": {
			if (baseText === null) return [];
			const baseAst = parseAst(baseText, path);
			const headAst = headText === null ? null : parseAst(headText, path);
			return analyzeEslintConfig(path, baseAst === null ? null : entriesFromAst(baseAst), headAst === null ? null : entriesFromAst(headAst), baseText, headText);
		}
		case "eslint-data": {
			if (baseText === null) return [];
			let baseEntries: PathEntry[] | null = null;
			let headEntries: PathEntry[] | null = null;
			try {
				baseEntries = parseData(baseText);
			} catch (error) {
				parseFailed("base", error);
			}
			try {
				headEntries = headText === null ? null : parseData(headText);
			} catch (error) {
				parseFailed("head", error);
			}
			return analyzeEslintConfig(path, baseEntries, headEntries, baseText, headText);
		}
		case "eslintignore":
			return analyzeIgnoreFile(pair);
		case "tsconfig": {
			if (baseText === null || headText === null) return [];
			let before: unknown;
			let after: unknown;
			try {
				before = parseJsonc(baseText);
			} catch (error) {
				parseFailed("base", error);
				return [];
			}
			try {
				after = parseJsonc(headText);
			} catch (error) {
				parseFailed("head", error);
				return [];
			}
			return analyzeTsconfig(path, before, after);
		}
		case "jest-js":
		case "vitest-js": {
			if (baseText === null) return [];
			const baseAst = parseAst(baseText, path);
			const headAst = headText === null ? null : parseAst(headText, path);
			return analyzeCoverageAndTestConfig(path, baseAst === null ? null : entriesFromAst(baseAst), headAst === null ? null : entriesFromAst(headAst), {
				rootIsCoverageTool: false,
				fileDeleted: headText === null,
			});
		}
		case "jest-json":
		case "coverage-data": {
			if (baseText === null) return [];
			let before: PathEntry[];
			let after: PathEntry[] | null = null;
			try {
				before = parseData(baseText);
			} catch (error) {
				parseFailed("base", error);
				return [];
			}
			try {
				after = headText === null ? null : parseData(headText);
			} catch (error) {
				parseFailed("head", error);
				return [];
			}
			return analyzeCoverageAndTestConfig(path, before, after, { rootIsCoverageTool: kind === "coverage-data", fileDeleted: headText === null });
		}
		case "package-json":
			return analyzePackageJsonFile(path, baseText, headText, parseFailed);
		case "workflow": {
			if (baseText === null) return [];
			let before: unknown;
			let after: unknown = null;
			try {
				before = parseYaml(baseText);
			} catch (error) {
				parseFailed("base", error);
				return [];
			}
			if (headText !== null) {
				try {
					after = parseYaml(headText);
				} catch (error) {
					parseFailed("head", error);
					return [];
				}
			}
			const elsewhere = new Set<string>();
			for (const [other, commands] of workflowHeads) if (other !== path) for (const command of commands) elsewhere.add(command);
			return analyzeWorkflow(path, before, after, elsewhere);
		}
		case "husky":
			return analyzeHuskyHook(pair);
		case "snapshot":
			return analyzeSnapshot(pair);
		case "baseline": {
			if (headText === null) return [];
			let before: unknown = null;
			let after: unknown;
			try {
				before = baseText === null ? null : JSON.parse(baseText);
			} catch {
				// An unreadable base baseline accepted nothing, so every head acceptance is new.
				before = null;
			}
			try {
				after = JSON.parse(headText);
			} catch (error) {
				parseFailed("head", error);
				return [];
			}
			return analyzeAcceptances(path, before, after);
		}
	}
}

function analyzePackageJsonFile(path: string, baseText: string | null, headText: string | null, parseFailed: (side: string, error: unknown) => void): FindingDraft[] {
	if (baseText === null || headText === null) return [];
	let before: unknown;
	let after: unknown;
	try {
		before = JSON.parse(baseText);
	} catch (error) {
		parseFailed("base", error);
		return [];
	}
	try {
		after = JSON.parse(headText);
	} catch (error) {
		parseFailed("head", error);
		return [];
	}
	if (!isRecord(before) || !isRecord(after)) return [];
	const drafts = analyzePackageJson(path, before, after);
	for (const section of ["jest", "nyc", "c8"]) {
		const baseSection = packageJsonSection(before, section);
		if (baseSection !== null) {
			drafts.push(...analyzeCoverageAndTestConfig(path, baseSection, packageJsonSection(after, section) ?? [], { rootIsCoverageTool: false, fileDeleted: false }));
		}
	}
	const baseEslint = packageJsonSection(before, "eslintConfig");
	if (baseEslint !== null) {
		const headEslint = after.eslintConfig === undefined ? "" : JSON.stringify(after.eslintConfig);
		drafts.push(...analyzeEslintConfig(path, baseEslint, packageJsonSection(after, "eslintConfig") ?? [], JSON.stringify(before.eslintConfig), headEslint));
	}
	return drafts;
}

function analyzeConfigs(loaded: ReadonlyArray<Loaded>, errors: IntegrityError[]): FindingDraft[] {
	const workflowHeads = new Map<string, Set<string>>();
	for (const file of loaded) if (file.config === "workflow") workflowHeads.set(file.entry.path, workflowVerificationCommands(file.headText, parseYaml));

	const drafts: FindingDraft[] = [];
	for (const file of loaded) {
		const kind = file.config;
		if (kind === null) continue;
		const path = file.entry.path;
		const parseFailed = (side: string, error: unknown): void => {
			errors.push({ code: "CONFIG_PARSE_ERROR", message: `${side}: ${firstLine(error)}`, file: path });
		};
		try {
			drafts.push(...analyzeConfigFile(file, kind, workflowHeads, parseFailed));
		} catch (error) {
			errors.push({ code: "ANALYSIS_FAILED", message: errorMessage(error), file: path });
		}
	}
	return drafts;
}

export function analyzeWithBase(base: ResolvedBase, options: AnalyzeOptions): IntegrityReport {
	const errors: IntegrityError[] = [];
	const relevant = listChanges(base)
		.map((entry) => ({
			entry,
			js: JS_TS_EXTENSIONS.has(posix.extname(entry.path).toLowerCase()) && !entry.path.split("/").includes("node_modules"),
			config: classifyConfig(entry.path) ?? (entry.oldPath === undefined ? null : classifyConfig(entry.oldPath)),
		}))
		.filter((file) => file.js || file.config !== null);

	const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
	if (relevant.length > maxFiles) errors.push({ code: "RESOURCE_LIMIT", message: `Analyzed the first ${maxFiles} of ${relevant.length} relevant changed files` });
	const selected = relevant.slice(0, maxFiles);
	const addedByPath = addedLinesForAll(
		base,
		selected.map((file) => file.entry),
	);
	const loaded = loadFiles(base, selected, errors);
	const drafts = [...analyzeSources(loaded, addedByPath, errors), ...analyzeConfigs(loaded, errors)];

	const seen = new Set<string>();
	const findings: IntegrityFinding[] = [];
	for (const draft of drafts) {
		const finding = finalizeFinding(draft);
		if (seen.has(finding.fingerprint)) continue;
		seen.add(finding.fingerprint);
		findings.push(finding);
	}
	const accepted = new Set(options.acceptedFingerprints ?? []);
	const kept = findings.filter((finding) => !accepted.has(finding.fingerprint)).sort(compareFindings);
	return {
		base: { ref: base.ref, commit: base.commit, head: base.head },
		filesAnalyzed: loaded.length,
		findings: kept,
		accepted: findings.length - kept.length,
		errors: errors.sort((a, b) => (a.file ?? "").localeCompare(b.file ?? "") || a.code.localeCompare(b.code)),
	};
}

export function analyzeIntegrity(options: AnalyzeOptions): IntegrityReport {
	return analyzeWithBase(resolveBase(options), options);
}

export interface IntegrityRunOptions {
	readonly cwd: string;
	readonly mode: IntegrityMode;
	/** Branch, ref or commit to compare with: merge-base(HEAD, ref), `origin/<ref>` preferred. Omit for HEAD. */
	readonly base?: string | undefined;
	/** Baseline file holding explicit acceptances; defaults to .ai-guard-baseline.json in `cwd`. */
	readonly baselinePath?: string;
}

/**
 * `ai-guard integrity [--enforce] [--base <ref>]`: every failure becomes an envelope error instead of a crash or a
 * silently empty (falsely clean) report.
 */
export function runIntegrity(options: IntegrityRunOptions): IntegrityEnvelope {
	const baselinePath = resolveBaselinePath(options.cwd, options.baselinePath);
	const acceptances = loadIntegrityAcceptances(baselinePath);
	if (acceptances.status === "invalid") {
		return { mode: options.mode, error: { code: "BASELINE_INVALID", message: `Baseline file ${baselinePath} is invalid: ${acceptances.reason}` } };
	}
	try {
		const report = analyzeIntegrity({
			cwd: options.cwd,
			base: options.base,
			mergeBase: options.base !== undefined,
			preferRemote: options.base !== undefined,
			acceptedFingerprints: acceptances.accepted.map((acceptance) => acceptance.fingerprint),
		});
		return { mode: options.mode, report };
	} catch (error) {
		return { mode: options.mode, error: { code: isIntegrityGitError(error) ? error.code : "ANALYSIS_FAILED", message: errorMessage(error) } };
	}
}
