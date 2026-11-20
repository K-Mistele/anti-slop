#!/usr/bin/env node
// Fails a branch that weakens its own checks. Runs the integrity analysis vendored from eslint-plugin-ai-guard
// (`./ai-guard/`: skipped, focused, or deleted tests, suppressions, downgraded ESLint, TypeScript, coverage, and CI
// settings) and anti-slop's checks for what ai-guard does not read: oxlint and eslint disable comments without a
// reason, and oxlint config changes that lower or remove rules, add ignore patterns, or drop JS plugins. Both compare
// the working tree, untracked files included, with the merge base of HEAD and the default branch. Neither uses the
// network.
//
// Usage: node integrity/run.ts [--base <ref>]   (or ANTI_SLOP_BASE=<ref>)
//
// Exit codes: 0 nothing weakened, 1 a check was weakened, 2 the comparison could not run.

// oxlint-disable effecttsgo/node-builtin-import, effecttsgo/global-console, effecttsgo/process-env -- a standalone CLI outside any Effect runtime, so Effect's platform services and logger do not apply

import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";

import { runIntegrity } from "./ai-guard/engine.ts";
import { counts, integrityAnnotations, integrityMarkdown, integrityText } from "./ai-guard/report.ts";
import { errorMessage, integrityExitCode, type IntegrityEnvelope } from "./ai-guard/types.ts";
import { checkIntegrity, type IntegrityFinding } from "./checks.ts";

const USAGE = "usage: node integrity/run.ts [--base <ref>]";

function format(finding: IntegrityFinding): string {
	const location = finding.line === undefined ? finding.file : `${finding.file}:${finding.line}`;
	return `  ${location}  ${finding.check}\n      ${finding.message}`;
}

function parseBase(args: ReadonlyArray<string>): string | undefined {
	if (args.length === 0) return process.env.ANTI_SLOP_BASE || undefined;
	if (args.length === 2 && args[0] === "--base" && args[1] !== undefined) return args[1];
	throw new Error(USAGE);
}

/** Appends to a file GitHub Actions reads after the step; a failure to write is reported, not fatal. */
function appendForGitHub(variable: "GITHUB_STEP_SUMMARY" | "GITHUB_OUTPUT", text: string): void {
	const path = process.env[variable];
	if (path === undefined || path === "") return;
	try {
		appendFileSync(path, text, "utf-8");
	} catch (error) {
		console.error(`anti-slop integrity: could not write ${variable}: ${errorMessage(error)}`);
	}
}

/** The step summary, `integrity-high-count`/`integrity-advisory-count` outputs and annotations ai-guard's CLI writes in CI. */
function reportToGitHub(envelope: IntegrityEnvelope): void {
	if (process.env.GITHUB_ACTIONS !== "true") return;
	appendForGitHub("GITHUB_STEP_SUMMARY", `## AI Guard — Check Integrity\n\n${integrityMarkdown(envelope)}\n`);
	if (envelope.report !== undefined) {
		const { high, advisory } = counts(envelope.report);
		appendForGitHub("GITHUB_OUTPUT", `integrity-high-count=${high}\nintegrity-advisory-count=${advisory}\n`);
	}
	process.stdout.write(integrityAnnotations(envelope));
}

function run(args: ReadonlyArray<string>): number {
	const base = parseBase(args);
	const result = checkIntegrity({ cwd: process.cwd(), ...(base === undefined ? {} : { base }) });
	const root = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).stdout.trim();

	// Without a base branch, ai-guard's own default (HEAD) matches what the anti-slop checks compare against.
	const aiGuardBase = result.baseCommit === undefined || result.baseLabel === "HEAD" ? undefined : result.baseCommit;
	const envelope = runIntegrity({ cwd: root, mode: "enforce", base: aiGuardBase });
	reportToGitHub(envelope);
	console.log(integrityText(envelope));
	const aiGuardStatus = integrityExitCode(envelope);

	const commit = result.baseCommit === undefined ? "" : ` (${result.baseCommit.slice(0, 12)})`;
	console.log(`anti-slop integrity: compared with ${result.baseLabel}${commit}`);
	if (result.findings.length === 0) console.log("  No weakened lint settings found.");
	else console.log([`  ${result.findings.length} finding(s):`, ...result.findings.map(format)].join("\n"));

	if (aiGuardStatus >= 2) return 2;
	return aiGuardStatus === 1 || result.findings.length > 0 ? 1 : 0;
}

try {
	process.exit(run(process.argv.slice(2)));
} catch (error) {
	console.error(`anti-slop integrity: ${errorMessage(error)}`);
	process.exit(2);
}
