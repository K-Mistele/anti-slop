// Ported from eslint-plugin-ai-guard 1.4.7 (`cli/utils/integrity/report.ts` and the printing in
// `cli/commands/integrity.ts`, MIT); see `src/vendor/ai-guard/UPSTREAM.md`. Renderings of one IntegrityEnvelope:
// terminal text, a Markdown step summary and GitHub annotations. Every output reads the same findings array, so they
// cannot disagree.

import type { IntegrityEnvelope, IntegrityFinding, IntegrityReport } from "./types.ts";

function baseLabel(report: IntegrityReport): string {
	const commit = report.base.commit === null ? "" : ` (${report.base.commit.slice(0, 12)})`;
	return `${report.base.ref}${commit} → working tree`;
}

function location(finding: IntegrityFinding): string {
	return finding.line === undefined || finding.line === 0 ? finding.file : `${finding.file}:${finding.line}`;
}

function change(finding: IntegrityFinding): string {
	return finding.before !== undefined && finding.after !== undefined ? `${finding.before} → ${finding.after}` : "";
}

export function counts(report: IntegrityReport): { readonly high: number; readonly advisory: number } {
	const high = report.findings.filter((finding) => finding.tier === "high").length;
	return { high, advisory: report.findings.length - high };
}

const failsNote = (envelope: IntegrityEnvelope, high: number): string =>
	envelope.mode === "enforce" && high > 0 ? " — high-confidence findings fail this check" : "";

/** Plain lines, as `ai-guard integrity` prints them under its banner. */
function textLines(envelope: IntegrityEnvelope, report: IntegrityReport): string[] {
	const { high, advisory } = counts(report);
	const lines = [`Compared ${baseLabel(report)} · ${report.filesAnalyzed} relevant file(s) · mode: ${envelope.mode}`];
	if (report.findings.length === 0) {
		lines.push("No weakened checks found.");
	} else {
		lines.push(`${high} high-confidence, ${advisory} advisory finding(s)${failsNote(envelope, high)}`);
		for (const finding of report.findings) {
			const tag = finding.tier === "high" ? "HIGH    " : "advisory";
			lines.push(`  ${tag}  ${location(finding)}  ${finding.ruleId.replace("ai-guard/", "")}  #${finding.fingerprint.slice(0, 12)}`);
			lines.push(`            ${finding.message}`);
		}
	}
	if (report.accepted > 0) lines.push(`${report.accepted} finding(s) accepted in the baseline file are not shown.`);
	for (const error of report.errors) lines.push(`  note: ${error.file === undefined ? "" : `${error.file}: `}${error.message}`);
	return lines;
}

/** The terminal output: a banner, the findings, and what to do about them. */
export function integrityText(envelope: IntegrityEnvelope): string {
	const out = ["", "  AI GUARD — CHECK INTEGRITY  ", "", ""];
	const report = envelope.report;
	if (report === undefined) {
		out.push(`  ✖  ${envelope.error?.message ?? "Check integrity could not run"}`, "");
		return out.join("\n");
	}
	const asIs = /^(?: {2}HIGH| {2}advisory| {12})/;
	for (const line of textLines(envelope, report)) out.push(asIs.test(line) ? line : `  ${line}`);
	out.push("");
	if (report.findings.length > 0) {
		out.push(`  ℹ  Fix the weakened checks, or accept an intended one explicitly by adding its fingerprint to the \`integrity.accepted\` list in .ai-guard-baseline.json.`, "");
	}
	return out.join("\n");
}

function markdown(text: string): string {
	return text.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

/** A GitHub step summary of the run. */
export function integrityMarkdown(envelope: IntegrityEnvelope): string {
	const lines = ["### Check integrity", ""];
	const report = envelope.report;
	if (report === undefined) {
		lines.push(`> ⚠️ Could not run: ${markdown(envelope.error?.message ?? "unknown error")}`, "");
		return lines.join("\n");
	}
	const { high, advisory } = counts(report);
	lines.push(`> Compared \`${markdown(baseLabel(report))}\` · mode **${envelope.mode}**`);
	if (report.accepted > 0) lines.push(`> ${report.accepted} accepted finding(s) not shown`);
	lines.push("");
	if (report.findings.length === 0) {
		lines.push("✅ No weakened checks found.", "");
		return lines.join("\n");
	}
	lines.push(`**${high} high-confidence**, ${advisory} advisory${failsNote(envelope, high)}`, "");
	lines.push("| Tier | Location | Finding | Change |", "|------|----------|---------|--------|");
	for (const finding of report.findings.slice(0, 50)) {
		lines.push(`| ${finding.tier === "high" ? "🔴 high" : "⚪ advisory"} | \`${markdown(location(finding))}\` | ${markdown(finding.message)} | ${markdown(change(finding))} |`);
	}
	if (report.findings.length > 50) lines.push("", `…and ${report.findings.length - 50} more.`);
	lines.push("");
	return lines.join("\n");
}

function escapeData(text: string): string {
	return text.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

function escapeProperty(text: string): string {
	return escapeData(text).replace(/:/g, "%3A").replace(/,/g, "%2C");
}

/** GitHub Actions workflow commands that annotate each finding on its file and line. */
export function integrityAnnotations(envelope: IntegrityEnvelope): string {
	const report = envelope.report;
	if (report === undefined) return "";
	return report.findings
		.map((finding) => {
			const level = finding.tier === "advisory" ? "notice" : envelope.mode === "enforce" ? "error" : "warning";
			const parts = [`file=${escapeProperty(finding.file)}`];
			if (finding.line !== undefined && finding.line !== 0) parts.push(`line=${finding.line}`);
			parts.push(`title=${escapeProperty(finding.ruleId)}`);
			return `::${level} ${parts.join(",")}::${escapeData(finding.message)}\n`;
		})
		.join("");
}
