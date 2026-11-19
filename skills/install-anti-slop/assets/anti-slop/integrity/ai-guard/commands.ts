// Ported from eslint-plugin-ai-guard 1.4.7 (`cli/utils/integrity/commands.ts`, MIT); see `src/vendor/ai-guard/UPSTREAM.md`.
// Shell-command analysis shared by package.json scripts, CI `run:` steps and Git hook files. This is pattern matching
// on command text, not shell evaluation. Quoted strings are blanked first so a commit message such as
// `-m "mention -n"` is not mistaken for a flag.

type WeakenerKind = "exit-masking" | "no-verify" | "hooks-disabled" | "pass-with-no-tests" | "tests-excluded" | "coverage-disabled";

export interface Weakener {
	readonly kind: WeakenerKind;
	/** The matched text, for display. */
	readonly token: string;
	/** Precise enough to block when enforced. */
	readonly high: boolean;
}

/** Commands that run a test, lint or type check. */
const VERIFY_TOOL = new RegExp(
	[
		String.raw`\b(?:jest|vitest|mocha|ava|tap|c8|nyc|karma|jasmine)\b`,
		String.raw`\bplaywright\s+test\b`,
		String.raw`\bcypress\s+run\b`,
		String.raw`\b(?:eslint|oxlint|tsc|vue-tsc|ai-guard|stylelint)\b`,
		String.raw`\bbiome\s+(?:check|lint|ci)\b`,
		String.raw`\bprettier\b[^;&|]*--check\b`,
		String.raw`\bnode\s+--test\b`,
		String.raw`\b(?:bun|deno)\s+test\b`,
		String.raw`\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|tests|lint|typecheck|type-check|types|check|verify|validate|ci|e2e|coverage)(?::[\w:-]+)?\b`,
		String.raw`\bnpm\s+t\b`,
		String.raw`\bnpx\s+(?:--yes\s+)?(?:jest|vitest|mocha|eslint|tsc|playwright|ai-guard|lint-staged)\b`,
		String.raw`\blint-staged\b`,
	].join("|"),
);

function blankQuotes(command: string): string {
	return command.replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, (quoted) => `${quoted[0] ?? ""}${" ".repeat(Math.max(0, quoted.length - 2))}${quoted.at(-1) ?? ""}`);
}

export function isVerificationCommand(command: string): boolean {
	return VERIFY_TOOL.test(blankQuotes(command));
}

/** Split a command line into `&&`, `||`, `;` and newline separated segments, normalized. */
function commandSegments(command: string): string[] {
	return command
		.split(/&&|\|\||;|\r?\n/)
		.map((segment) => segment.trim().replace(/\s+/g, " "))
		.filter((segment) => segment !== "" && !segment.startsWith("#"));
}

export function verificationSegments(command: string): string[] {
	return commandSegments(command).filter(isVerificationCommand);
}

const PACKAGE_MANAGERS: ReadonlySet<string> = new Set(["npm", "pnpm", "yarn", "bun"]);
const SUBCOMMAND_TOOLS: ReadonlySet<string> = new Set(["playwright", "cypress", "biome", "node"]);

/**
 * The tool invocation a verification command runs, without its arguments: `npm test -- test/browser.ts` and
 * `pnpm run test` give `npm test`; `npx --yes vitest run --coverage` gives `vitest`; `tsc --noEmit` gives `tsc`. A
 * command whose key is still present was changed, not removed: whether new arguments cover the same checks cannot be
 * decided statically.
 */
export function verificationKey(segment: string): string {
	const tokens = blankQuotes(segment)
		.trim()
		.split(/\s+/)
		.filter((token) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(token));
	const [first = "", second] = tokens;
	if (first === "npx" || first === "pnpx" || (first === "pnpm" && second === "exec") || (first === "yarn" && second === "dlx")) {
		let i = first === "npx" || first === "pnpx" ? 1 : 2;
		for (let token = tokens[i]; token?.startsWith("-") === true; token = tokens[i]) i += token === "-p" || token === "--package" ? 2 : 1;
		const tool = tokens[i] ?? "";
		const subcommand = tokens[i + 1];
		return SUBCOMMAND_TOOLS.has(tool) && subcommand !== undefined && subcommand !== "" ? `${tool} ${subcommand}` : tool;
	}
	if (PACKAGE_MANAGERS.has(first)) {
		const sub = second === "run" || second === "run-script" ? tokens[2] : second;
		const script = sub === "t" || sub === "tst" ? "test" : sub;
		return script === "test" ? "npm test" : `npm run ${script ?? ""}`.trim();
	}
	return SUBCOMMAND_TOOLS.has(first) && second !== undefined && second !== "" ? `${first} ${second}` : first;
}

const PATTERNS: ReadonlyArray<{ readonly kind: WeakenerKind; readonly re: RegExp; readonly high: boolean }> = [
	{ kind: "exit-masking", re: /\|\|\s*(?:true|:|exit\s+0)\b/, high: true },
	{ kind: "exit-masking", re: /;\s*(?:exit\s+0|true)\s*$/m, high: true },
	{ kind: "exit-masking", re: /^\s*(?:exit\s+0|true)\s*(?:$|;|&&)/m, high: true },
	{ kind: "exit-masking", re: /\bset\s+\+e\b/, high: true },
	{ kind: "no-verify", re: /\bgit\b[^\n;&|]*\bcommit\b[^\n;&|]*(?:--no-verify\b|\s-[a-zA-Z]*n[a-zA-Z]*\b)/, high: true },
	{ kind: "no-verify", re: /\bgit\b[^\n;&|]*\b(?:push|merge|am|rebase|cherry-pick|revert)\b[^\n;&|]*--no-verify\b/, high: true },
	{ kind: "hooks-disabled", re: /\b(?:HUSKY=0|HUSKY_SKIP_HOOKS=1|SKIP_SIMPLE_GIT_HOOKS=1|LEFTHOOK=0)\b/, high: true },
	{ kind: "hooks-disabled", re: /core\.hooksPath[=\s]+(?:\/dev\/null|NUL|''|"")(?:\s|$)/, high: true },
	{ kind: "pass-with-no-tests", re: /--pass(?:WithNoTests|-with-no-tests)\b/, high: false },
	{ kind: "tests-excluded", re: /--(?:testPathIgnorePatterns|testPathIgnore|exclude)\b/, high: false },
	{ kind: "coverage-disabled", re: /--no-coverage\b|--coverage(?:\.enabled)?=false\b/, high: false },
];

/** Every weakening construct present in a command. */
function detectWeakeners(command: string): Weakener[] {
	const text = blankQuotes(command);
	return PATTERNS.flatMap((pattern) => {
		const match = pattern.re.exec(text);
		return match === null ? [] : [{ kind: pattern.kind, token: match[0].trim(), high: pattern.high }];
	});
}

/** Weakeners present in `after` but not in `before`, by kind. */
export function addedWeakeners(before: string | null, after: string): Weakener[] {
	const had = new Set((before === null ? [] : detectWeakeners(before)).map((weakener) => weakener.kind));
	return detectWeakeners(after).filter((weakener) => !had.has(weakener.kind));
}

export function describeWeakener(weakener: Weakener): string {
	switch (weakener.kind) {
		case "exit-masking":
			return `\`${weakener.token}\` makes the command succeed even when the check fails`;
		case "no-verify":
			return `\`${weakener.token}\` skips Git hooks`;
		case "hooks-disabled":
			return `\`${weakener.token}\` disables Git hooks`;
		case "pass-with-no-tests":
			return `\`${weakener.token}\` lets the run pass when no tests are found`;
		case "tests-excluded":
			return `\`${weakener.token}\` excludes tests from the run`;
		case "coverage-disabled":
			return `\`${weakener.token}\` disables coverage collection`;
	}
}
