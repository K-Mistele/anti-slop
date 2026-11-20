// Ported from eslint-plugin-ai-guard 1.4.7 (`src/rules/security/no-invisible-unicode.ts`, MIT); see
// `src/vendor/ai-guard/UPSTREAM.md`.
import { defineRule } from "@oxlint/plugins";

import type { ESTree, FixFn, SourceCode } from "@oxlint/plugins";

import { decodeTags, decodeVariationSelectors, describeChars, findRuns, hasInvisibleCandidates } from "../shared/invisible-unicode.ts";

type Location = "comment" | "string" | "template" | "regex" | "jsx" | "code" | "whitespace";

const LOCATION_TEXT: Readonly<Record<Location, string>> = {
	comment: "a comment",
	string: "a string literal",
	template: "a template literal",
	regex: "a regular expression",
	jsx: "JSX text",
	code: "code (an identifier or keyword)",
	whitespace: "whitespace between tokens",
};

interface TokenSpan {
	readonly start: number;
	readonly end: number;
	readonly type: string;
}

function buildSpans(sourceCode: SourceCode): TokenSpan[] {
	const spans: TokenSpan[] = [
		...sourceCode.ast.tokens.map((token) => ({ start: token.start, end: token.end, type: token.type })),
		...sourceCode.ast.comments.map((comment) => ({ start: comment.start, end: comment.end, type: "Comment" })),
	];
	spans.sort((a, b) => a.start - b.start);
	return spans;
}

function findSpan(spans: ReadonlyArray<TokenSpan>, index: number): TokenSpan | null {
	let lo = 0;
	let hi = spans.length - 1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		const span = spans[mid];
		if (span === undefined) return null;
		if (index < span.start) hi = mid - 1;
		else if (index >= span.end) lo = mid + 1;
		else return span;
	}
	return null;
}

function locate(sourceCode: SourceCode, spans: ReadonlyArray<TokenSpan>, index: number): { readonly location: Location; readonly node: ESTree.Node | null } {
	const span = findSpan(spans, index);
	const node = sourceCode.getNodeByRangeIndex(index);
	if (span === null) return { location: "whitespace", node };
	if (span.type === "Comment") return { location: "comment", node };
	if (span.type === "JSXText") return { location: "jsx", node };
	if (node?.type === "Literal" && node.parent?.type === "JSXAttribute") return { location: "jsx", node };
	if (span.type === "String") return { location: "string", node };
	if (span.type === "Template") return { location: "template", node };
	if (span.type === "RegularExpression") return { location: "regex", node };
	return { location: "code", node };
}

function escapeForString(cp: number): string {
	return cp > 0xffff ? `\\u{${cp.toString(16).toUpperCase()}}` : `\\u${cp.toString(16).toUpperCase().padStart(4, "0")}`;
}

function escapeForRegex(cp: number): string {
	if (cp <= 0xffff) return escapeForString(cp);
	const units = String.fromCodePoint(cp);
	return [...Array(units.length).keys()].map((k) => `\\u${units.charCodeAt(k).toString(16).toUpperCase()}`).join("");
}

function isInTaggedTemplate(node: ESTree.Node | null): boolean {
	for (let current = node; current !== null && current !== undefined; current = current.parent ?? null) {
		if (current.type === "TemplateLiteral") return current.parent?.type === "TaggedTemplateExpression";
	}
	return false;
}

/** Reject Trojan Source bidi controls, zero-width characters, fillers and tag characters that hide text. */
export const noInvisibleUnicodeRule = defineRule({
	meta: {
		type: "problem",
		docs: {
			description:
				"Disallow invisible and bidirectional Unicode characters in source code: Trojan Source bidi overrides, zero-width characters, Hangul-filler identifiers, and Unicode tag characters that hide text. Pasted AI output and poisoned agent rule files carry these characters, which change what code does or what an AI reads without being visible in review.",
		},
		fixable: "code",
		schema: [],
		messages: {
			bidiControl:
				"Bidirectional control character {{chars}} in {{location}}. It reorders how code is displayed, so reviewers can see different logic from what runs (Trojan Source, CVE-2021-42574). Remove it, or write it as an escape sequence if the text needs it.",
			invisibleCharacter:
				"Invisible character {{chars}} in {{location}}. Zero-width and filler characters make different identifiers or strings look identical. Remove it, or write it as an escape sequence if it is intentional.",
			hiddenText:
				'Invisible Unicode characters in {{location}} encode hidden text: "{{decoded}}". This technique smuggles instructions into code and agent rule files that AI tools read but humans cannot see. Remove them.',
		},
	},
	create(context) {
		const { sourceCode } = context;
		const text = sourceCode.text;
		if (!hasInvisibleCandidates(text)) return {};

		return {
			Program() {
				const runs = findRuns(text);
				if (runs.length === 0) return;
				const spans = buildSpans(sourceCode);

				for (const run of runs) {
					const { location, node } = locate(sourceCode, spans, run.start);
					const loc = { start: sourceCode.getLocFromIndex(run.start), end: sourceCode.getLocFromIndex(run.end) };
					const range: [number, number] = [run.start, run.end];

					let fix: FixFn | undefined;
					if (location === "comment") {
						fix = (fixer) => fixer.removeRange(range);
					} else if (location === "string" || (location === "template" && !isInTaggedTemplate(node))) {
						fix = (fixer) => fixer.replaceTextRange(range, run.codePoints.map(escapeForString).join(""));
					} else if (location === "regex") {
						fix = (fixer) => fixer.replaceTextRange(range, run.codePoints.map(escapeForRegex).join(""));
					}

					const locationText = LOCATION_TEXT[location];

					if (run.kind === "tag" || (run.kind === "variation" && run.codePoints.length > 1)) {
						const decoded = run.kind === "tag" ? decodeTags(run.codePoints) : decodeVariationSelectors(run.codePoints);
						context.report({
							loc,
							messageId: "hiddenText",
							data: { location: locationText, decoded: decoded === "" ? describeChars(run.codePoints) : decoded },
							...(fix === undefined ? {} : { fix }),
						});
						continue;
					}

					context.report({
						loc,
						messageId: run.kind === "bidi" ? "bidiControl" : "invisibleCharacter",
						data: { chars: describeChars(run.codePoints), location: locationText },
						...(fix === undefined ? {} : { fix }),
					});
				}
			},
		};
	},
});
