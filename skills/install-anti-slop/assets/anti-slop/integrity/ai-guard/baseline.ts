// Ported from eslint-plugin-ai-guard 1.4.7 (`cli/utils/baseline.ts`, MIT); see `src/vendor/ai-guard/UPSTREAM.md`.
// Reads the integrity acceptances recorded in an ai-guard baseline file. Only loading is ported: acceptances are
// added by hand (or by the ai-guard CLI) as a reviewed change to the file, which integrity reports as advisory.

// oxlint-disable effecttsgo/node-builtin-import -- a standalone CLI outside any Effect runtime, so Effect's platform services do not apply

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { errorMessage } from "./types.ts";

export const BASELINE_FILE = ".ai-guard-baseline.json";

/**
 * Baseline file format version. Files without `version` were written before versioning and are read as version 1;
 * a newer version is rejected rather than misread.
 */
const BASELINE_VERSION = 1;

/** An integrity finding a team accepted explicitly. */
export interface IntegrityAcceptance {
	readonly fingerprint: string;
	readonly ruleId: string;
	readonly file: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const PRESETS: ReadonlyArray<unknown> = ["recommended", "strict", "security", "agent"];

function validateIntegrity(integrity: unknown): string | null {
	const accepted = isRecord(integrity) ? integrity.accepted : undefined;
	if (!Array.isArray(accepted)) return '"integrity.accepted" must be an array';
	for (const acceptance of accepted) {
		if (!isRecord(acceptance) || typeof acceptance.fingerprint !== "string" || typeof acceptance.ruleId !== "string" || typeof acceptance.file !== "string") {
			return 'each "integrity.accepted" entry needs string "fingerprint", "ruleId" and "file"';
		}
	}
	return null;
}

function validateEntries(entries: ReadonlyArray<unknown>): string | null {
	for (const entry of entries) {
		const issues = isRecord(entry) ? entry.issues : undefined;
		if (!isRecord(entry) || typeof entry.filePath !== "string" || !Array.isArray(issues)) {
			return 'each entry needs a string "filePath" and an "issues" array';
		}
		for (const issue of issues) {
			if (!isRecord(issue) || typeof issue.ruleId !== "string" || typeof issue.message !== "string") {
				return `issue in ${entry.filePath} needs string "ruleId" and "message"`;
			}
		}
	}
	return null;
}

function validateBaselineShape(value: unknown): string | null {
	if (!isRecord(value)) return "expected a JSON object";
	const { entries, mode, version, preset } = value;
	if (version !== undefined && (typeof version !== "number" || !Number.isInteger(version) || version < 1)) {
		return `unknown "version" ${JSON.stringify(version)}`;
	}
	if (typeof version === "number" && version > BASELINE_VERSION) {
		return `baseline format version ${version} is newer than this ai-guard supports (${BASELINE_VERSION}); upgrade eslint-plugin-ai-guard or re-create the baseline`;
	}
	if (preset !== undefined && !PRESETS.includes(preset)) {
		return `unknown preset ${JSON.stringify(preset)} (expected recommended, strict, security or agent)`;
	}
	if (mode !== undefined && mode !== "strict" && mode !== "stable") return `unknown mode ${JSON.stringify(mode)} (expected "strict" or "stable")`;
	if (!Array.isArray(entries)) return 'missing "entries" array';
	if (value.integrity !== undefined) {
		const invalid = validateIntegrity(value.integrity);
		if (invalid !== null) return invalid;
	}
	return validateEntries(entries);
}

export function resolveBaselinePath(cwd: string, file?: string): string {
	return resolve(cwd, file ?? BASELINE_FILE);
}

export type AcceptancesResult =
	| { readonly status: "ok"; readonly accepted: ReadonlyArray<IntegrityAcceptance> }
	| { readonly status: "invalid"; readonly reason: string };

function readAcceptances(document: Record<string, unknown>): IntegrityAcceptance[] {
	const accepted = isRecord(document.integrity) ? document.integrity.accepted : undefined;
	if (!Array.isArray(accepted)) return [];
	return accepted.flatMap((acceptance: unknown) => {
		if (!isRecord(acceptance)) return [];
		const { fingerprint, ruleId, file } = acceptance;
		return typeof fingerprint === "string" && typeof ruleId === "string" && typeof file === "string" ? [{ fingerprint, ruleId, file }] : [];
	});
}

/**
 * Integrity acceptances from a baseline file. A missing file means no acceptances; an invalid file is an error so
 * acceptances are never silently dropped (which would surface accepted findings) or invented.
 */
export function loadIntegrityAcceptances(baselinePath: string): AcceptancesResult {
	if (!existsSync(baselinePath)) return { status: "ok", accepted: [] };
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(baselinePath, "utf-8"));
	} catch (error) {
		return { status: "invalid", reason: `not valid JSON (${errorMessage(error)})` };
	}
	const reason = validateBaselineShape(parsed);
	if (reason !== null || !isRecord(parsed)) return { status: "invalid", reason: reason ?? "expected a JSON object" };
	return { status: "ok", accepted: readAcceptances(parsed) };
}
