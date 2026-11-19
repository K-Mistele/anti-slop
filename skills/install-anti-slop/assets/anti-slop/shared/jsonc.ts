// Ported from eslint-plugin-ai-guard 1.4.7 (`src/utils/jsonc.ts`, MIT); see `src/vendor/ai-guard/UPSTREAM.md`.

/**
 * Parses JSON with comments and trailing commas, as tsconfig allows. Comments and trailing commas are removed only
 * outside string literals, so string values are never altered. Throws on invalid JSON.
 */
export function parseJsonc(text: string): unknown {
	const out: string[] = [];
	let inString = false;
	// Index in `out` of a comma that may turn out to be trailing.
	let pendingComma = -1;
	const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
	for (let index = 0; index < source.length; index += 1) {
		const char = source[index] ?? "";
		const next = source[index + 1];
		if (inString) {
			out.push(char);
			if (char === "\\") {
				out.push(next ?? "");
				index += 1;
			} else if (char === '"') {
				inString = false;
			}
			continue;
		}
		if (char === "/" && next === "/") {
			while (index < source.length && source[index] !== "\n") index += 1;
			out.push("\n");
			continue;
		}
		if (char === "/" && next === "*") {
			index += 2;
			while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) index += 1;
			index += 1;
			out.push(" ");
			continue;
		}
		if (char === "}" || char === "]") {
			if (pendingComma >= 0) out[pendingComma] = " ";
			pendingComma = -1;
			out.push(char);
			continue;
		}
		if (char === ",") {
			pendingComma = out.length;
			out.push(char);
			continue;
		}
		if (!/\s/.test(char)) pendingComma = -1;
		if (char === '"') inString = true;
		out.push(char);
	}
	return JSON.parse(out.join(""));
}
