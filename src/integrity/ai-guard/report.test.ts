// oxlint-disable effecttsgo/global-console -- a test runner outside any Effect runtime
// Ported from eslint-plugin-ai-guard 1.4.7 (`tests/integrity/outputs.test.ts`, MIT); see `src/vendor/ai-guard/UPSTREAM.md`.
// One finding set drives every output. Upstream's SARIF and JSON outputs and the `changed` command are not ported.
import assert from "node:assert/strict";

import { integrityAnnotations, integrityMarkdown, integrityText } from "./report.ts";
import { finalizeFinding, integrityExitCode, type IntegrityEnvelope, type IntegrityFinding } from "./types.ts";

const tests: Array<[string, () => void]> = [];
const test = (name: string, run: () => void): void => {
	tests.push([name, run]);
};

const findings = [
	finalizeFinding({
		ruleId: "ai-guard/integrity-test-skipped",
		tier: "high",
		file: "src/a.test.ts",
		line: 4,
		message: 'Skipped the existing test "a > b"; it no longer runs.',
		before: "runs",
		after: "skipped",
		key: "a",
	}),
	finalizeFinding({
		ruleId: "ai-guard/integrity-coverage-weakened",
		tier: "high",
		file: "jest.config.js",
		message: "Lowered coverage threshold `coverageThreshold.global.lines` from 80 to 60.",
		before: "80",
		after: "60",
		key: "b",
	}),
	finalizeFinding({ ruleId: "ai-guard/integrity-assertions-reduced", tier: "advisory", file: "src/a.test.ts", message: "Assertions in this file went from 3 to 2 | fewer.", key: "c" }),
];

function envelope(mode: "report" | "enforce", list: ReadonlyArray<IntegrityFinding> = findings): IntegrityEnvelope {
	return { mode, report: { base: { ref: "main", commit: "abc123", head: "working-tree" }, filesAnalyzed: 2, findings: list, accepted: 0, errors: [] } };
}

const levels = (annotations: string): string[] => annotations.split("\n").filter((line) => line !== "").map((line) => line.split(" ")[0] ?? "");

test("annotations, Markdown and text list the same findings", () => {
	const env = envelope("enforce");
	const annotations = integrityAnnotations(env);
	assert.deepEqual(levels(annotations), ["::error", "::error", "::notice"]);
	assert.match(annotations, /^::error file=src\/a\.test\.ts,line=4,title=ai-guard\/integrity-test-skipped::/);

	const markdown = integrityMarkdown(env);
	for (const finding of findings) assert.ok(markdown.includes(finding.message.replace(/\|/g, "\\|")), finding.message);
	assert.match(markdown, /high-confidence findings fail this check/);

	const text = integrityText(env);
	assert.equal(text.split("\n").filter((line) => /^\s+(?:HIGH|advisory)/.test(line)).length, 3);
	for (const finding of findings) assert.ok(text.includes(`#${finding.fingerprint.slice(0, 12)}`), finding.ruleId);
	assert.match(text, /2 high-confidence, 1 advisory finding\(s\) — high-confidence findings fail this check/);
});

test("report mode annotates high findings as warnings and never fails", () => {
	const env = envelope("report");
	assert.deepEqual(levels(integrityAnnotations(env)), ["::warning", "::warning", "::notice"]);
	assert.equal(integrityExitCode(env), 0);
	assert.doesNotMatch(integrityText(env), /fail this check/);
});

test("exit codes: integrity fails only in enforce mode, and only on high-confidence findings", () => {
	assert.equal(integrityExitCode(envelope("enforce")), 1);
	assert.equal(integrityExitCode(envelope("enforce", findings.filter((finding) => finding.tier === "advisory"))), 0);
	assert.equal(integrityExitCode({ mode: "enforce", error: { code: "BASE_NOT_FOUND", message: "x" } }), 2);
	assert.equal(integrityExitCode({ mode: "report", error: { code: "BASE_NOT_FOUND", message: "x" } }), 0);
});

test("an error envelope is reported, never presented as clean", () => {
	const env: IntegrityEnvelope = { mode: "report", error: { code: "NO_MERGE_BASE", message: "No merge base; use fetch-depth: 0" } };
	assert.match(integrityMarkdown(env), /Could not run: No merge base/);
	assert.doesNotMatch(integrityMarkdown(env), /No weakened checks/);
	assert.match(integrityText(env), /✖ {2}No merge base; use fetch-depth: 0/);
	assert.equal(integrityAnnotations(env), "");
});

test("a clean report says so", () => {
	const env = envelope("enforce", []);
	assert.match(integrityText(env), /No weakened checks found\./);
	assert.match(integrityMarkdown(env), /✅ No weakened checks found\./);
	assert.equal(integrityAnnotations(env), "");
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
