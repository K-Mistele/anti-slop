// Ported from eslint-plugin-ai-guard 1.4.7 (`src/utils/invisible-unicode.ts`, MIT); see `src/vendor/ai-guard/UPSTREAM.md`.
// Detection of invisible and bidirectional Unicode characters for `no-invisible-unicode`. Reports runs of
// zero-width, bidi-control, filler, tag and variation-selector characters while skipping their legitimate uses
// (emoji ZWJ sequences, joiners in non-Latin words, subdivision flags, CJK ideographic variation selectors).

export type InvisibleKind = "bidi" | "invisible" | "tag" | "variation";

const CHAR_NAMES: Readonly<Record<number, string>> = {
	0x115f: "HANGUL CHOSEONG FILLER",
	0x1160: "HANGUL JUNGSEONG FILLER",
	0x180e: "MONGOLIAN VOWEL SEPARATOR",
	0x200b: "ZERO WIDTH SPACE",
	0x200c: "ZERO WIDTH NON-JOINER",
	0x200d: "ZERO WIDTH JOINER",
	0x202a: "LEFT-TO-RIGHT EMBEDDING",
	0x202b: "RIGHT-TO-LEFT EMBEDDING",
	0x202c: "POP DIRECTIONAL FORMATTING",
	0x202d: "LEFT-TO-RIGHT OVERRIDE",
	0x202e: "RIGHT-TO-LEFT OVERRIDE",
	0x2060: "WORD JOINER",
	0x2061: "FUNCTION APPLICATION",
	0x2062: "INVISIBLE TIMES",
	0x2063: "INVISIBLE SEPARATOR",
	0x2064: "INVISIBLE PLUS",
	0x2066: "LEFT-TO-RIGHT ISOLATE",
	0x2067: "RIGHT-TO-LEFT ISOLATE",
	0x2068: "FIRST STRONG ISOLATE",
	0x2069: "POP DIRECTIONAL ISOLATE",
	0x3164: "HANGUL FILLER",
	0xfeff: "ZERO WIDTH NO-BREAK SPACE",
	0xffa0: "HALFWIDTH HANGUL FILLER",
};

/** Cheap pre-check so files without any candidate characters cost one regex scan. */
const CANDIDATE_PATTERN = /[\u115F\u1160\u180E\u200B-\u200D\u202A-\u202E\u2060-\u2064\u2066-\u2069\u3164\uFEFF\uFFA0]|\uDB40[\uDC00-\uDDEF]/;

function classify(cp: number): InvisibleKind | null {
	if ((cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069)) return "bidi";
	if (
		cp === 0x200b ||
		cp === 0x200c ||
		cp === 0x200d ||
		cp === 0xfeff ||
		cp === 0x180e ||
		(cp >= 0x2060 && cp <= 0x2064) ||
		cp === 0x115f ||
		cp === 0x1160 ||
		cp === 0x3164 ||
		cp === 0xffa0
	) {
		return "invisible";
	}
	if (cp >= 0xe0000 && cp <= 0xe007f) return "tag";
	if (cp >= 0xe0100 && cp <= 0xe01ef) return "variation";
	return null;
}

/** Visible characters that legitimately sit on both sides of a ZWJ / ZWNJ. */
const JOINABLE = /[\p{L}\p{M}\p{Extended_Pictographic}\p{Emoji_Modifier}\u20E3]/u;

function isJoinable(cp: number | undefined): boolean {
	return cp !== undefined && cp > 0x7f && JOINABLE.test(String.fromCodePoint(cp));
}

const WAVING_BLACK_FLAG = 0x1f3f4;
const CANCEL_TAG = 0xe007f;
const IDEOGRAPHIC = /\p{Ideographic}/u;

interface CodePoint {
	readonly cp: number;
	readonly index: number;
	readonly length: number;
}

export interface InvisibleRun {
	readonly kind: InvisibleKind;
	readonly start: number;
	end: number;
	readonly codePoints: number[];
}

function toCodePoints(text: string): CodePoint[] {
	const out: CodePoint[] = [];
	let index = 0;
	for (const char of text) {
		out.push({ cp: char.codePointAt(0) ?? 0, index, length: char.length });
		index += char.length;
	}
	return out;
}

/**
 * Runs of suspicious characters, skipping the legitimate uses: emoji ZWJ sequences, joiners inside non-Latin
 * words, subdivision flag tag sequences (black flag + tags + CANCEL TAG) and single CJK ideographic variation
 * selectors.
 */
export function findRuns(text: string): InvisibleRun[] {
	const points = toCodePoints(text);
	const runs: InvisibleRun[] = [];
	let current: InvisibleRun | null = null;

	const push = (kind: InvisibleKind, point: CodePoint): void => {
		if (current !== null && current.kind === kind && current.end === point.index) {
			current.end = point.index + point.length;
			current.codePoints.push(point.cp);
			return;
		}
		current = { kind, start: point.index, end: point.index + point.length, codePoints: [point.cp] };
		runs.push(current);
	};

	for (let i = 0; i < points.length; i += 1) {
		const point = points[i];
		if (point === undefined) continue;
		const kind = classify(point.cp);
		if (kind === null) continue;

		// byte order mark
		if (point.cp === 0xfeff && point.index === 0) continue;

		if ((point.cp === 0x200c || point.cp === 0x200d) && isJoinable(points[i - 1]?.cp) && isJoinable(points[i + 1]?.cp)) continue;

		if (kind === "tag" && points[i - 1]?.cp === WAVING_BLACK_FLAG) {
			// Skip a complete emoji tag sequence: black flag + tag letters/digits + CANCEL TAG
			let j = i;
			for (let cp = points[j]?.cp; cp !== undefined && cp >= 0xe0030 && cp <= 0xe007a; cp = points[j]?.cp) j += 1;
			if (j > i && points[j]?.cp === CANCEL_TAG) {
				i = j;
				continue;
			}
		}

		if (kind === "variation") {
			// One ideographic variation selector after a CJK character is standard text.
			const previous = points[i - 1]?.cp;
			const next = points[i + 1]?.cp;
			const nextIsVariation = next !== undefined && classify(next) === "variation";
			const previousIsVariation = previous !== undefined && classify(previous) === "variation";
			if (!nextIsVariation && !previousIsVariation && previous !== undefined && IDEOGRAPHIC.test(String.fromCodePoint(previous))) continue;
		}

		push(kind, point);
	}

	return runs;
}

function hex(cp: number): string {
	return `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`;
}

export function describeChars(codePoints: ReadonlyArray<number>): string {
	const unique = [...new Set(codePoints)];
	const shown = unique.slice(0, 3).map((cp) => {
		const name = CHAR_NAMES[cp];
		return name === undefined ? hex(cp) : `${hex(cp)} (${name})`;
	});
	const more = unique.length > 3 ? ` and ${unique.length - 3} more` : "";
	const count = codePoints.length > 1 ? `${codePoints.length}x ` : "";
	return `${count}${shown.join(", ")}${more}`;
}

const NON_PRINTABLE = /[^\x20-\x7E]/g;

function truncate(text: string): string {
	const clean = text.replace(NON_PRINTABLE, "?");
	return clean.length > 80 ? `${clean.slice(0, 77)}...` : clean;
}

export function decodeTags(codePoints: ReadonlyArray<number>): string {
	const text = codePoints
		.filter((cp) => cp >= 0xe0020 && cp <= 0xe007e)
		.map((cp) => String.fromCharCode(cp - 0xe0000))
		.join("");
	return truncate(text);
}

export function decodeVariationSelectors(codePoints: ReadonlyArray<number>): string {
	const bytes = Uint8Array.from(codePoints.map((cp) => cp - 0xe0100 + 16));
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		// Not UTF-8: the selectors still hide data, which the message describes by size.
		return `${bytes.length} bytes of binary data`;
	}
	return truncate(text);
}

/** Cheap pre-check: true when the text contains any candidate character. */
export function hasInvisibleCandidates(text: string): boolean {
	return CANDIDATE_PATTERN.test(text);
}
