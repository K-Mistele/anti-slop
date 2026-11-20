// Ported from eslint-plugin-ai-guard 1.4.7 (`cli/utils/directives.ts`, MIT); see `src/vendor/ai-guard/UPSTREAM.md`.
// Parses ESLint and TypeScript suppression comments so integrity analysis can detect directives a change added.
// The grammar follows ESLint's own directive handling:
//  - `eslint-disable`, `eslint-enable` and inline rule configuration (`/* eslint rule: "off" */`) are only recognized
//    in block comments;
//  - `eslint-disable-line` / `eslint-disable-next-line` work in line comments and in single-line block comments;
//  - a description after ` -- ` is the justification.
// TypeScript directives (`@ts-ignore`, `@ts-expect-error`, `@ts-nocheck`, `@ts-check`) are parsed so newly added ones
// can be reported.

export type EslintDirectiveKind = "disable" | "enable" | "disable-line" | "disable-next-line" | "inline-config";

type RuleSeverity = "off" | "warn" | "error" | "unknown";

export interface CommentLike {
	readonly type: string;
	readonly value: string;
	readonly line: number;
	readonly column: number;
	readonly endLine: number;
	readonly endColumn: number;
}

export interface EslintDirective {
	readonly kind: EslintDirectiveKind;
	/** Rule IDs the directive names; null means "all rules". Always null for inline-config. */
	readonly rules: ReadonlyArray<string> | null;
	/** Rule settings of an inline-config comment (`/* eslint rule: "off" *\/`). */
	readonly settings?: Readonly<Record<string, RuleSeverity>>;
	/** Text after ` -- `, if any. */
	readonly justification?: string;
	/** Comment text as written, trimmed and capped for display. */
	readonly text: string;
	readonly line: number;
	readonly column: number;
	readonly endLine: number;
	readonly endColumn: number;
}

export type TsDirectiveKind = "ignore" | "expect-error" | "nocheck" | "check";

export interface TsDirective {
	readonly kind: TsDirectiveKind;
	readonly description: string;
	readonly text: string;
	readonly line: number;
}

const DIRECTIVE_RE = /^(eslint(?:-enable|-disable(?:(?:-next)?-line)?)?)(?:\s|$)/u;
const JUSTIFICATION_SPLIT = /\s-{2,}\s/u;
const MAX_TEXT = 160;

function displayText(type: string, value: string): string {
	const inner = value.replace(/\s+/g, " ").trim();
	const text = type === "Line" ? `// ${inner}` : `/* ${inner} */`;
	return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text;
}

function normalizeSeverity(raw: unknown): RuleSeverity {
	const value: unknown = Array.isArray(raw) ? raw[0] : raw;
	if (value === 0 || value === "0" || value === "off") return "off";
	if (value === 1 || value === "1" || value === "warn") return "warn";
	if (value === 2 || value === "2" || value === "error") return "error";
	return "unknown";
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The JSON object `{<body>}` denotes, or null when the body is not JSON, which ESLint then reads leniently. */
function parseJsonObject(body: string): Record<string, unknown> | null {
	try {
		const parsed: unknown = JSON.parse(`{${body}}`);
		return isRecord(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

/**
 * Parse the body of an inline-config comment (`rule-a: off, rule-b: [2, {...}]`). Mirrors ESLint: try JSON first,
 * then fall back to a lenient `name: value` scan.
 */
function parseInlineConfigSettings(body: string): Record<string, RuleSeverity> {
	const settings: Record<string, RuleSeverity> = {};
	const parsed = parseJsonObject(body);
	if (parsed !== null) {
		for (const [rule, value] of Object.entries(parsed)) settings[rule] = normalizeSeverity(value);
		return settings;
	}
	for (const match of body.matchAll(/(?:^|,)\s*["']?([@\w][\w@/.-]*)["']?\s*:\s*(\[\s*)?["']?([\w]+)["']?/g)) {
		const [, rule, , value] = match;
		if (rule === undefined || value === undefined) continue;
		settings[rule] = normalizeSeverity(/^\d$/.test(value) ? Number(value) : value);
	}
	return settings;
}

const LINE_DIRECTIVES: ReadonlySet<string> = new Set(["eslint-disable-line", "eslint-disable-next-line"]);

const DIRECTIVE_KINDS: Readonly<Record<string, EslintDirectiveKind>> = {
	"eslint-disable": "disable",
	"eslint-enable": "enable",
	"eslint-disable-line": "disable-line",
	"eslint-disable-next-line": "disable-next-line",
};

/** Parse one comment as an ESLint directive, or return null when it is not one. */
function parseEslintDirective(comment: CommentLike): EslintDirective | null {
	const { type } = comment;
	if (type !== "Line" && type !== "Block") return null;
	const trimmed = comment.value.trim();
	const name = DIRECTIVE_RE.exec(trimmed)?.[1];
	if (name === undefined) return null;

	const lineDirective = LINE_DIRECTIVES.has(name);
	// ESLint ignores `// eslint-disable`, `// eslint-enable` and `// eslint rule: off`.
	if (type === "Line" && !lineDirective) return null;
	// Line directives in block comments must fit on one line.
	if (lineDirective && type === "Block" && comment.endLine !== comment.line) return null;

	const [directivePart = "", ...rest] = trimmed.slice(name.length).split(JUSTIFICATION_SPLIT);
	const justification = rest.length > 0 ? rest.join(" -- ").trim() : undefined;
	const body = directivePart.trim();
	const base = {
		text: displayText(type, comment.value),
		line: comment.line,
		column: comment.column,
		endLine: comment.endLine,
		endColumn: comment.endColumn,
		...(justification === undefined || justification === "" ? {} : { justification }),
	};

	if (name === "eslint") {
		if (body === "") return null;
		return { kind: "inline-config", rules: null, settings: parseInlineConfigSettings(body), ...base };
	}

	const rules = body
		.split(",")
		.map((rule) => rule.trim())
		.filter((rule) => rule !== "");
	return { kind: DIRECTIVE_KINDS[name] ?? "disable-next-line", rules: rules.length > 0 ? rules : null, ...base };
}

const TS_DIRECTIVE_RE = /^\s*(?:\*\s*)?@ts-(ignore|expect-error|nocheck|check)\b(.*)$/;

const isTsDirectiveKind = (value: string | undefined): value is TsDirectiveKind =>
	value === "ignore" || value === "expect-error" || value === "nocheck" || value === "check";

/** Parse one comment as a TypeScript directive, or return null. */
function parseTsDirective(comment: CommentLike): TsDirective | null {
	if (comment.type !== "Line" && comment.type !== "Block") return null;
	const firstLine = comment.value.split(/\r?\n/).find((line) => line.trim() !== "") ?? "";
	const match = TS_DIRECTIVE_RE.exec(firstLine);
	const kind = match?.[1];
	if (match === null || !isTsDirectiveKind(kind)) return null;
	const description = (match[2] ?? "")
		.replace(/^[\s:\-–—]+/, "")
		.replace(/\*\/?$/, "")
		.trim();
	return { kind, description, text: displayText(comment.type, comment.value), line: comment.line };
}

export function parseEslintDirectives(comments: ReadonlyArray<CommentLike>): EslintDirective[] {
	return comments.flatMap((comment) => parseEslintDirective(comment) ?? []);
}

export function parseTsDirectives(comments: ReadonlyArray<CommentLike>): TsDirective[] {
	return comments.flatMap((comment) => parseTsDirective(comment) ?? []);
}

function namesRule(rules: ReadonlyArray<string> | null, ruleId: string): boolean {
	return rules === null || rules.includes(ruleId);
}

/** True when a block `eslint-disable` is never re-enabled for all of its rules. */
export function disablesUntilEndOfFile(directives: ReadonlyArray<EslintDirective>, directive: EslintDirective): boolean {
	if (directive.kind !== "disable") return false;
	const later = directives.filter(
		(other) => other.kind === "enable" && (other.line > directive.line || (other.line === directive.line && other.column > directive.column)),
	);
	const rules = directive.rules;
	if (rules === null) return !later.some((other) => other.rules === null);
	return rules.some((rule) => !later.some((other) => namesRule(other.rules, rule)));
}

/** Rules a directive switches off; null means all rules. */
export function rulesSuppressedBy(directive: EslintDirective): ReadonlyArray<string> | null {
	if (directive.kind === "inline-config") {
		return Object.entries(directive.settings ?? {})
			.filter(([, severity]) => severity === "off")
			.map(([rule]) => rule);
	}
	return directive.rules;
}

export function affectsAiGuard(rules: ReadonlyArray<string> | null): boolean {
	return rules === null || rules.some((rule) => rule.startsWith("ai-guard/"));
}
