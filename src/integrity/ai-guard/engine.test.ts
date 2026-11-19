// oxlint-disable effecttsgo/node-builtin-import, effecttsgo/global-console, effecttsgo/process-env -- tests a standalone CLI outside any Effect runtime against real git repositories
// Ported from eslint-plugin-ai-guard 1.4.7 (`tests/integrity/engine.test.ts`, `tests/integrity/cli.test.ts` and
// `tests/integrity/mcp-and-baseline.test.ts`, MIT); see `src/vendor/ai-guard/UPSTREAM.md`. Realistic before/after
// changes in temporary Git repositories: each case asserts both the weakening that must be reported and the safe
// look-alike that must not. Upstream's staged, per-file, MCP, SARIF and `--accept` cases cover code that is not ported.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { loadIntegrityAcceptances } from "./baseline.ts";
import { analyzeIntegrity, runIntegrity, type AnalyzeOptions } from "./engine.ts";
import { isIntegrityGitError, type IntegrityFinding } from "./types.ts";

// Keep the developer's git configuration out of the scratch repositories.
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";

const tests: Array<[string, () => void]> = [];
const test = (name: string, run: () => void): void => {
	tests.push([name, run]);
};

interface TempRepo {
	readonly dir: string;
	write(file: string, content: string): void;
	remove(file: string): void;
	rename(from: string, to: string): void;
	git(...args: string[]): string;
	commit(message?: string): string;
}

const scratch: string[] = [];

function tempDir(prefix: string): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
	scratch.push(dir);
	return dir;
}

/** A local repository (no remotes) whose first commit holds `files`, unless `commit` is false. */
function createTempRepo(files: Readonly<Record<string, string>> = {}, commitFiles = true): TempRepo {
	const dir = tempDir("anti-slop-ai-guard-integrity-");
	const git = (...args: string[]): string => execFileSync("git", args, { cwd: dir, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
	git("init", "-q", "-b", "master");
	git("config", "user.email", "test@example.com");
	git("config", "user.name", "test");
	git("config", "commit.gpgsign", "false");
	git("config", "core.autocrlf", "false");
	const write = (file: string, content: string): void => {
		mkdirSync(dirname(join(dir, file)), { recursive: true });
		writeFileSync(join(dir, file), content, "utf-8");
	};
	for (const [file, content] of Object.entries(files)) write(file, content);
	const commit = (message = "commit"): string => {
		git("add", "-A");
		git("commit", "-q", "--allow-empty", "-m", message);
		return git("rev-parse", "HEAD").trim();
	};
	if (commitFiles && Object.keys(files).length > 0) commit("base");
	return {
		dir,
		write,
		remove: (file) => rmSync(join(dir, file), { force: true }),
		rename: (from, to) => {
			mkdirSync(dirname(join(dir, to)), { recursive: true });
			git("mv", from, to);
		},
		git,
		commit,
	};
}

const analyze = (repo: TempRepo, options: Partial<AnalyzeOptions> = {}): ReadonlyArray<IntegrityFinding> =>
	analyzeIntegrity({ cwd: repo.dir, ...options }).findings;

const ids = (findings: ReadonlyArray<IntegrityFinding>): string[] =>
	findings.map((finding) => `${finding.tier}:${finding.ruleId.replace("ai-guard/integrity-", "")}`).sort();

/** The fields of `actual` named in `expected`, so a partial shape can be compared exactly. */
function pick(actual: object, expected: object): Record<string, unknown> {
	return Object.fromEntries(Object.keys(expected).map((key) => [key, key in actual ? Reflect.get(actual, key) : undefined]));
}

function assertShape(actual: object | undefined, expected: object): void {
	assert.ok(actual !== undefined, `expected a value shaped like ${JSON.stringify(expected)}`);
	assert.deepEqual(pick(actual, expected), expected);
}

function only<T>(items: ReadonlyArray<T>): T {
	assert.equal(items.length, 1, JSON.stringify(items));
	const [item] = items;
	assert.ok(item !== undefined);
	return item;
}

const TESTS = `describe('cart', () => {
  it('adds items', () => { expect(add(1, 2)).toBe(3); });
  it('removes items', () => { expect(remove([1], 1)).toEqual([]); });
  it('totals', () => { expect(total([1, 2])).toBe(3); });
});
`;
const TOTALS_LINE = "  it('totals', () => { expect(total([1, 2])).toBe(3); });\n";

// Suppressions

test("reports newly added directives, not pre-existing or moved ones", () => {
	const repo = createTempRepo({ "src/a.ts": "// eslint-disable-next-line no-console\nconsole.log(1);\nexport const a = 1;\n" });
	repo.write(
		"src/a.ts",
		[
			"export const a = 1;",
			"// eslint-disable-next-line no-console",
			"console.log(1);",
			"/* eslint-disable */",
			"try { run(); } catch (e) {} // eslint-disable-line ai-guard/no-empty-catch",
			"// eslint-disable-next-line no-alert -- legacy kiosk mode",
			"alert(1);",
			"",
		].join("\n"),
	);
	const findings = analyze(repo).filter((finding) => finding.ruleId.endsWith("lint-suppression"));
	assert.deepEqual(
		findings.map((finding) => [finding.tier, finding.line]),
		[
			["high", 4],
			["high", 5],
			["advisory", 6],
		],
	);
	assert.match(findings[0]?.message ?? "", /all ESLint rules \(including AI Guard rules\) until the end of the file/);
	assert.match(findings[1]?.message ?? "", /ai-guard\/no-empty-catch/);
	assert.match(findings[2]?.message ?? "", /legacy kiosk mode/);
});

test("treats an unjustified directive for an unrelated rule as advisory", () => {
	const repo = createTempRepo({ "src/a.js": "export const a = 1;\n" });
	repo.write("src/a.js", "export const a = 1;\n// eslint-disable-next-line no-console\nconsole.log(a);\n");
	assert.deepEqual(ids(analyze(repo)), ["advisory:lint-suppression"]);
});

test("reports broadened directives", () => {
	const repo = createTempRepo({ "src/a.js": "// eslint-disable-next-line no-console\nconsole.log(1);\n" });
	repo.write("src/a.js", "// eslint-disable-next-line\nconsole.log(1);\n");
	const finding = only(analyze(repo));
	assertShape(finding, { tier: "high", line: 1 });
	assert.match(finding.message, /all ESLint rules/);
});

test("reports TypeScript suppressions by kind", () => {
	const repo = createTempRepo({ "src/t.ts": "export const n: number = 1;\n" });
	repo.write("src/t.ts", '// @ts-nocheck\n// @ts-ignore\nexport const n: number = "x" as any;\n// @ts-expect-error -- upstream typing bug #12\nconst m: string = 1;\n');
	assert.deepEqual(ids(analyze(repo)), ["advisory:ts-suppression", "advisory:unsafe-type-escape", "high:ts-suppression", "high:ts-suppression"]);
});

test("ignores directive look-alikes in strings", () => {
	const repo = createTempRepo({ "src/a.js": "export const a = 1;\n" });
	repo.write("src/a.js", 'export const a = "/* eslint-disable */ // @ts-ignore";\n');
	assert.deepEqual(analyze(repo), []);
});

// Tests

test("reports skipped, focused and conditionally skipped tests", () => {
	const repo = createTempRepo({ "src/cart.test.ts": TESTS });
	repo.write(
		"src/cart.test.ts",
		`describe('cart', () => {
  it.skip('adds items', () => { expect(add(1, 2)).toBe(3); });
  it.only('removes items', () => { expect(remove([1], 1)).toEqual([]); });
  it.skipIf(process.env.CI)('totals', () => { expect(total([1, 2])).toBe(3); });
});
`,
	);
	const findings = analyze(repo);
	assert.deepEqual(ids(findings), ["advisory:test-skipped", "high:test-focused", "high:test-skipped"]);
	const skipped = findings.find((finding) => finding.ruleId.endsWith("test-skipped") && finding.tier === "high");
	assert.match(skipped?.message ?? "", /"cart > adds items"/);
});

test("supports xit/xdescribe/fit aliases and reports a skipped suite with its test count", () => {
	const repo = createTempRepo({ "test/cart.spec.js": TESTS });
	repo.write("test/cart.spec.js", TESTS.replace("describe('cart'", "xdescribe('cart'"));
	const finding = only(analyze(repo));
	assertShape(finding, { ruleId: "ai-guard/integrity-test-skipped", tier: "high" });
	assert.match(finding.message, /suite "cart" \(3 tests\)/);
});

test("ignores test calls in comments and strings, and nested suites count once", () => {
	const repo = createTempRepo({ "src/n.test.js": `describe('outer', () => {\n  describe('inner', () => {\n    it('works', () => expect(1).toBe(1));\n  });\n});\n` });
	repo.write(
		"src/n.test.js",
		`describe('outer', () => {\n  // it.only('commented', () => {})\n  const s = "it.skip('string')";\n  describe('inner', () => {\n    it('works', () => expect(1).toBe(1));\n  });\n});\n`,
	);
	assert.deepEqual(analyze(repo), []);
});

test("reports removed tests with before/after counts", () => {
	const repo = createTempRepo({ "src/cart.test.ts": TESTS });
	repo.write("src/cart.test.ts", TESTS.replace(TOTALS_LINE, ""));
	const reduced = analyze(repo).find((finding) => finding.ruleId.endsWith("test-count-reduced"));
	assertShape(reduced, { tier: "high", before: "3", after: "2" });
	assert.match(reduced?.message ?? "", /"cart > totals"/);
});

test("does not report tests moved to another file in the same change", () => {
	const repo = createTempRepo({ "src/cart.test.ts": TESTS });
	repo.write("src/cart.test.ts", TESTS.replace(TOTALS_LINE, ""));
	repo.write("src/totals.test.ts", `describe('cart', () => {\n${TOTALS_LINE}});\n`);
	assert.deepEqual(
		analyze(repo).filter((finding) => finding.category === "tests"),
		[],
	);
});

test("reports a deleted test file, but not a renamed or relocated one", () => {
	const repo = createTempRepo({ "src/cart.test.ts": TESTS, "src/other.test.ts": TESTS.replace(/cart/g, "other") });
	repo.remove("src/cart.test.ts");
	repo.rename("src/other.test.ts", "test/other.test.ts");
	const findings = analyze(repo);
	assert.deepEqual(ids(findings), ["high:test-file-deleted"]);
	assertShape(findings[0], { file: "src/cart.test.ts", before: "3 tests", after: "deleted" });
});

test("treats consolidation into parameterized tests as advisory", () => {
	const repo = createTempRepo({ "src/cart.test.ts": TESTS });
	repo.write("src/cart.test.ts", `describe('cart', () => {\n  it.each([[1, 2, 3]])('adds %i + %i', (a, b, c) => { expect(add(a, b)).toBe(c); });\n});\n`);
	const reduced = analyze(repo).find((finding) => finding.ruleId.endsWith("test-count-reduced"));
	assertShape(reduced, { tier: "advisory" });
	assert.match(reduced?.message ?? "", /parameterized/);
});

test("a new test added in a skipped state is advisory; an existing test turned todo counts as removed", () => {
	const repo = createTempRepo({ "src/cart.test.ts": TESTS });
	repo.write(
		"src/cart.test.ts",
		TESTS.replace("  it('totals', () => { expect(total([1, 2])).toBe(3); });", "  it.todo('totals');").replace("});\n", "  it.skip('discounts', () => {});\n});\n"),
	);
	// The todo also dropped that test's assertion.
	assert.deepEqual(ids(analyze(repo)), ["advisory:assertions-reduced", "advisory:test-skipped", "high:test-count-reduced"]);
});

test("reports weaker assertions as advisory only", () => {
	const repo = createTempRepo({ "src/cart.test.ts": TESTS });
	repo.write(
		"src/cart.test.ts",
		TESTS.replace("expect(add(1, 2)).toBe(3)", "expect(add(1, 2)).toBeTruthy()")
			.replace("expect(remove([1], 1)).toEqual([])", "expect(remove([1], 1)).toEqual(expect.anything())")
			.replace(" expect(total([1, 2])).toBe(3); ", " total([1, 2]); "),
	);
	const findings = analyze(repo);
	assert.deepEqual(ids(findings), ["advisory:assertion-loosened", "advisory:assertions-reduced"]);
	assert.ok(findings.every((finding) => !finding.blocking));
});

// Configuration

test("coverage thresholds lowered or removed (package.json jest, vitest config, .nycrc)", () => {
	const repo = createTempRepo({
		"package.json": JSON.stringify({ name: "x", jest: { coverageThreshold: { global: { lines: 90, branches: 80 } } } }, null, 2),
		"vitest.config.ts": "import { defineConfig } from 'vitest/config';\nexport default defineConfig({ test: { coverage: { thresholds: { lines: 85, functions: 85 } } } });\n",
		".nycrc.json": JSON.stringify({ "check-coverage": true, lines: 80 }),
	});
	repo.write("package.json", JSON.stringify({ name: "x", jest: { coverageThreshold: { global: { lines: 70 } } } }, null, 2));
	repo.write("vitest.config.ts", "import { defineConfig } from 'vitest/config';\nexport default defineConfig({ test: { coverage: { thresholds: { lines: 90, functions: 60 } } } });\n");
	repo.write(".nycrc.json", JSON.stringify({ "check-coverage": false, lines: 80 }));
	assert.deepEqual(
		analyze(repo).map((finding) => `${finding.tier} ${finding.file}: ${finding.message}`),
		[
			"high .nycrc.json: `check-coverage` turned off; coverage thresholds are no longer enforced.",
			"high package.json: Lowered coverage threshold `coverageThreshold.global.lines` from 90 to 70.",
			"high package.json: Removed coverage threshold `coverageThreshold.global.branches` (was 80).",
			"high vitest.config.ts: Lowered coverage threshold `test.coverage.thresholds.functions` from 85 to 60.",
		],
	);
});

test("raising a threshold or reformatting the file is not reported", () => {
	const repo = createTempRepo({ "jest.config.json": JSON.stringify({ coverageThreshold: { global: { lines: 80 } } }) });
	repo.write("jest.config.json", JSON.stringify({ coverageThreshold: { global: { lines: 85 } } }, null, 4));
	assert.deepEqual(analyze(repo), []);
});

test("ESLint flat config: downgrades, AI Guard removal, explicit disables", () => {
	const repo = createTempRepo({
		"eslint.config.js":
			"import aiGuard from 'eslint-plugin-ai-guard';\nexport default [aiGuard.configs.recommended, { rules: { 'no-console': 'error', eqeqeq: ['error', 'always'] } }];\n",
	});
	repo.write("eslint.config.js", "export default [{ rules: { 'no-console': 'warn', eqeqeq: ['error', 'smart'], 'no-debugger': 'off' } }];\n");
	assert.deepEqual(
		analyze(repo).map((finding) => `${finding.tier} ${finding.message}`),
		[
			'high Lowered ESLint rule `no-console` from "error" to "warn".',
			"high Removed AI Guard (eslint-plugin-ai-guard) from this ESLint configuration.",
			"advisory Explicitly turned off ESLint rule `no-debugger`.",
		],
	);
});

test("legacy .eslintrc.json with comments: AI Guard rule turned off and new ignore patterns", () => {
	const repo = createTempRepo({ ".eslintrc.json": '{\n  // shared\n  "plugins": ["ai-guard"],\n  "extends": ["plugin:ai-guard/recommended"],\n  "rules": {}\n}\n' });
	repo.write(
		".eslintrc.json",
		'{\n  "plugins": ["ai-guard"],\n  "extends": ["plugin:ai-guard/recommended"],\n  "ignorePatterns": ["src/legacy/**"],\n  "rules": { "ai-guard/no-floating-promise": "off" },\n}\n',
	);
	assert.deepEqual(ids(analyze(repo)), ["advisory:eslint-config-weakened", "high:eslint-config-weakened"]);
});

test("tsconfig: strict disabled, inherited values are advisory, tightening is silent", () => {
	const repo = createTempRepo({
		"tsconfig.json": '{ "compilerOptions": { "strict": true, "noUncheckedIndexedAccess": true } }',
		"packages/a/tsconfig.json": '{ "extends": "../../tsconfig.json", "compilerOptions": { "strict": true } }',
		"packages/b/tsconfig.json": '{ "compilerOptions": { "strict": false } }',
	});
	repo.write("tsconfig.json", '{\n  // relaxed\n  "compilerOptions": { "strict": false, "noUncheckedIndexedAccess": true, },\n}');
	repo.write("packages/a/tsconfig.json", '{ "extends": "../../tsconfig.json", "compilerOptions": {} }');
	repo.write("packages/b/tsconfig.json", '{ "compilerOptions": { "strict": true } }');
	assert.deepEqual(
		analyze(repo).map((finding) => `${finding.tier} ${finding.file} ${finding.before}->${finding.after}`),
		["high tsconfig.json true->false", "advisory packages/a/tsconfig.json true->(inherited)"],
	);
});

test("package.json scripts: exit masking, removed checks, removed test script, hook bypass", () => {
	const repo = createTempRepo({
		"package.json": JSON.stringify(
			{ scripts: { test: "vitest run", ci: "npm run lint && npm run typecheck && npm test", lint: "eslint .", typecheck: "tsc --noEmit", build: "tsup" } },
			null,
			2,
		),
	});
	repo.write(
		"package.json",
		JSON.stringify({ scripts: { ci: "npm run lint && npm test", lint: "eslint . || true", typecheck: "tsc --noEmit", build: "tsup", release: "HUSKY=0 git push" } }, null, 2),
	);
	assert.deepEqual(
		analyze(repo).map((finding) => `${finding.ruleId.replace("ai-guard/integrity-", "")} ${finding.message}`),
		[
			"git-hook-bypass New script `release`: `HUSKY=0` disables Git hooks.",
			"verification-script-weakened Removed the `test` script (was `vitest run`).",
			"verification-script-weakened Script `ci`: removed `npm run typecheck`.",
			"verification-script-weakened Script `lint`: `|| true` makes the command succeed even when the check fails.",
		],
	);
});

test("GitHub workflow: removed step, continue-on-error, if: false, removed trigger", () => {
	const base = `on:\n  pull_request:\n  push:\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - name: Lint\n        run: npm run lint\n      - name: Test\n        run: npm test\n      - name: Types\n        run: npx tsc --noEmit\n`;
	const repo = createTempRepo({ ".github/workflows/ci.yml": base });
	repo.write(
		".github/workflows/ci.yml",
		`on:\n  push:\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - name: Test\n        run: npm test\n        continue-on-error: true\n      - name: Types\n        if: false\n        run: npx tsc --noEmit\n`,
	);
	assert.deepEqual(
		analyze(repo).map((finding) => finding.message),
		[
			"Removed the `pull_request` trigger from a workflow that runs verification steps.",
			"Step \"Lint\" in job `test` was removed (ran `npm run lint`).",
			"Step \"Test\" in job `test` now sets `continue-on-error: true`; a failing check no longer fails the job.",
			"Step \"Types\" in job `test` is disabled with `if: false`.",
		],
	);
});

test("GitHub workflow: moving a check to another job or workflow is not reported", () => {
	const repo = createTempRepo({ ".github/workflows/ci.yml": `on: [pull_request]\njobs:\n  all:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm run lint\n      - run: npm test\n` });
	repo.write(".github/workflows/ci.yml", `on: [pull_request]\njobs:\n  lint:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm run lint\n`);
	repo.write(".github/workflows/test.yml", `on: [pull_request]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n`);
	assert.deepEqual(analyze(repo), []);
});

test("husky hooks: deleted hook and early exit", () => {
	const repo = createTempRepo({ ".husky/pre-commit": "npx lint-staged\n", ".husky/pre-push": "npm test\n" });
	repo.remove(".husky/pre-push");
	repo.write(".husky/pre-commit", "exit 0\nnpx lint-staged\n");
	assert.deepEqual(
		analyze(repo).map((finding) => finding.message),
		["Git hook `.husky/pre-commit` now exits before running its checks (`exit 0`).", "Deleted Git hook `.husky/pre-push` (ran `npm test`)."],
	);
});

test("snapshot rewrites are advisory", () => {
	const snap = (value: string): string => ["a", "b", "c"].map((key) => `exports[\`${key} 1\`] = \`"${value}${key}"\`;\n`).join("\n");
	const repo = createTempRepo({ "src/__snapshots__/x.test.ts.snap": snap("old") });
	repo.write("src/__snapshots__/x.test.ts.snap", snap("new"));
	assert.deepEqual(ids(analyze(repo)), ["advisory:snapshot-update"]);
});

// Precision on real-world change shapes

test("a CI test step moved to another job with new arguments is not a removal (sindresorhus/ky d93adf8)", () => {
	const repo = createTempRepo({
		".github/workflows/main.yml": `on: [push, pull_request]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm install\n      - run: npx playwright install --with-deps\n      - run: npm test\n`,
	});
	repo.write(
		".github/workflows/main.yml",
		`on: [push, pull_request]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm install\n      - run: npx ava 'test/**' '!test/browser.ts'\n  browser:\n    runs-on: macos-latest\n    steps:\n      - run: npm install\n      - run: npx playwright install --with-deps\n      - run: npm test -- test/browser.ts\n`,
	);
	assert.deepEqual(
		analyze(repo).filter((finding) => finding.tier === "high"),
		[],
	);
});

test("changed arguments of a verification script are advisory; a removed command stays high", () => {
	const repo = createTempRepo({ "package.json": JSON.stringify({ scripts: { test: "vitest run", ci: "npm run lint && npm test" } }) });
	repo.write("package.json", JSON.stringify({ scripts: { test: "vitest run src/core", ci: "npm test" } }));
	assert.deepEqual(
		analyze(repo).map((finding) => `${finding.tier} ${finding.message}`),
		[
			"high Script `ci`: removed `npm run lint`.",
			"advisory Script `test`: arguments of `vitest run` changed; check that the same tests or files are still covered.",
		],
	);
});

test("removing a duplicate test whose title still runs is advisory (expressjs/express 9c85a25)", () => {
	const duplicate = `describe('res', () => {\n  it('keeps type', () => { expect(1).toBe(1); });\n  it('sends body', () => { expect(2).toBe(2); });\n  it('keeps type', () => { expect(1).toBe(1); });\n});\n`;
	const repo = createTempRepo({ "test/res.test.js": duplicate });
	repo.write("test/res.test.js", duplicate.replace("  it('keeps type', () => { expect(1).toBe(1); });\n});", "});"));
	const finding = only(analyze(repo).filter((item) => item.ruleId.endsWith("test-count-reduced")));
	assertShape(finding, { tier: "advisory" });
	assert.match(finding.message, /duplicate/);
});

// Base handling, acceptances and determinism

test("compares against a branch merge-base and ignores conditions already on the base", () => {
	const repo = createTempRepo({ "src/cart.test.ts": TESTS.replace("it('totals'", "it.skip('totals'") });
	repo.git("checkout", "-q", "-b", "feature");
	repo.write("src/cart.test.ts", TESTS.replace("it('totals'", "it.skip('totals'").replace("it('adds items'", "it.skip('adds items'"));
	repo.commit("feature");
	assert.deepEqual(
		analyze(repo, { base: "master", mergeBase: true }).map((finding) => finding.message),
		['Skipped the existing test "cart > adds items"; it no longer runs.'],
	);
});

test("handles paths with spaces and untracked files", () => {
	const repo = createTempRepo({ "my dir/cart.test.ts": TESTS });
	repo.write("my dir/cart.test.ts", TESTS.replace("it('totals'", "xit('totals'"));
	repo.write("new dir/extra file.test.js", "it.only('x', () => {});\n");
	assert.deepEqual(analyze(repo).map((finding) => finding.file).sort(), ["my dir/cart.test.ts", "new dir/extra file.test.js"]);
});

test("applies explicit acceptances by fingerprint and counts them", () => {
	const repo = createTempRepo({ "src/cart.test.ts": TESTS });
	repo.write("src/cart.test.ts", TESTS.replace("it('totals'", "it.skip('totals'"));
	const first = only(analyze(repo));
	// Line shifts do not change the fingerprint.
	repo.write("src/cart.test.ts", `// header\n${TESTS.replace("it('totals'", "it.skip('totals'")}`);
	const report = analyzeIntegrity({ cwd: repo.dir, acceptedFingerprints: [first.fingerprint] });
	assert.deepEqual(report.findings, []);
	assert.equal(report.accepted, 1);
});

test("reports newly added acceptances in the baseline file as advisory", () => {
	const repo = createTempRepo({ ".ai-guard-baseline.json": JSON.stringify({ createdAt: "x", preset: "recommended", mode: "stable", totalIssues: 0, entries: [] }) });
	repo.write(
		".ai-guard-baseline.json",
		JSON.stringify({
			createdAt: "x",
			preset: "recommended",
			mode: "stable",
			totalIssues: 0,
			entries: [],
			integrity: { accepted: [{ fingerprint: "abc", ruleId: "ai-guard/integrity-test-skipped", file: "a", message: "m", acceptedAt: "x" }] },
		}),
	);
	assert.deepEqual(ids(analyze(repo)), ["advisory:acceptance-added"]);
});

test("is deterministic", () => {
	const repo = createTempRepo({ "src/cart.test.ts": TESTS, "src/a.js": "export const a = 1;\n" });
	repo.write("src/cart.test.ts", TESTS.replace("it('totals'", "it.skip('totals'").replace("it('adds items'", "it.only('adds items'"));
	repo.write("src/a.js", "/* eslint-disable */\nexport const a = 1;\n");
	const first = analyzeIntegrity({ cwd: repo.dir });
	assert.ok(first.findings.length > 0);
	assert.deepEqual(analyzeIntegrity({ cwd: repo.dir }), first);
});

test("empty diff, unsupported files and a repository without commits", () => {
	const repo = createTempRepo({ "README.md": "# x\n", "src/a.js": "export const a = 1;\n" });
	assert.deepEqual(analyze(repo), []);
	repo.write("README.md", '# changed\nit.only("x")\n');
	repo.write("image.png", "not really");
	assert.deepEqual(analyze(repo), []);

	const empty = createTempRepo({ "src/a.test.js": "it.only('x', () => {});\n" }, false);
	const report = analyzeIntegrity({ cwd: empty.dir });
	assertShape(report.base, { ref: "(empty tree)", commit: null });
	assert.deepEqual(ids(report.findings), ["high:test-focused"]);
});

test("reports unparseable files as analysis errors instead of guessing", () => {
	const repo = createTempRepo({ "src/a.test.js": TESTS });
	repo.write("src/a.test.js", 'describe("x", () => { it.skip(');
	const report = analyzeIntegrity({ cwd: repo.dir });
	assert.deepEqual(report.findings, []);
	assertShape(only(report.errors), { code: "PARSE_ERROR", file: "src/a.test.js" });
});

function thrown(run: () => unknown): unknown {
	try {
		run();
	} catch (error) {
		return error;
	}
	assert.fail("expected an error");
}

test("throws actionable errors for invalid refs, missing bases and non-repositories", () => {
	const repo = createTempRepo({ "a.js": "x\n" });
	assertShape(thrown(() => analyzeIntegrity({ cwd: repo.dir, base: "--upload-pack=evil" })) ?? {}, { code: "INVALID_REF" });
	assertShape(thrown(() => analyzeIntegrity({ cwd: repo.dir, base: "no-such-branch", mergeBase: true })) ?? {}, { code: "BASE_NOT_FOUND" });
	const notRepo = tempDir("anti-slop-ai-guard-norepo-");
	const error = thrown(() => analyzeIntegrity({ cwd: notRepo }));
	assert.ok(isIntegrityGitError(error), String(error));
	assert.equal(error.code, "NOT_A_REPO");
});

// Baseline file and integrity acceptances

test("integrity acceptances load from the baseline file and an invalid section is an error, not an empty list", () => {
	const dir = tempDir("anti-slop-ai-guard-baseline-");
	const file = join(dir, "b.json");
	writeFileSync(file, JSON.stringify({ entries: [], integrity: { accepted: [{ fingerprint: "f1", ruleId: "r", file: "a", message: "m" }] } }));
	assert.deepEqual(loadIntegrityAcceptances(file), { status: "ok", accepted: [{ fingerprint: "f1", ruleId: "r", file: "a" }] });
	writeFileSync(file, JSON.stringify({ entries: [], integrity: { accepted: [{ ruleId: "r" }] } }));
	assert.equal(loadIntegrityAcceptances(file).status, "invalid");
	writeFileSync(file, "{ broken");
	assert.equal(loadIntegrityAcceptances(file).status, "invalid");
	assert.deepEqual(loadIntegrityAcceptances(join(dir, "missing.json")), { status: "ok", accepted: [] });
});

test("runIntegrity applies the baseline file's acceptances and reports an invalid baseline as an error", () => {
	const repo = createTempRepo({ "src/cart.test.ts": TESTS });
	repo.write("src/cart.test.ts", TESTS.replace("it('totals'", "it.skip('totals'"));
	const finding = only(runIntegrity({ cwd: repo.dir, mode: "enforce" }).report?.findings ?? []);
	repo.write(".ai-guard-baseline.json", JSON.stringify({ entries: [], integrity: { accepted: [{ fingerprint: finding.fingerprint, ruleId: finding.ruleId, file: finding.file }] } }));
	const accepted = runIntegrity({ cwd: repo.dir, mode: "enforce" }).report;
	// The skip is accepted; the new acceptance itself is reported for reviewers (advisory).
	assert.deepEqual(ids(accepted?.findings ?? []), ["advisory:acceptance-added"]);
	assert.equal(accepted?.accepted, 1);
	repo.write(".ai-guard-baseline.json", "{ broken");
	assertShape(runIntegrity({ cwd: repo.dir, mode: "enforce" }).error, { code: "BASELINE_INVALID" });
});

// @effect/vitest

const EFFECT_TESTS = `import { assert, it, layer } from "@effect/vitest";
import { Effect } from "effect";

layer(Cart.layer)("cart", (it) => {
  it.effect("adds items", () => Effect.gen(function* () { assert.strictEqual(yield* add(1, 2), 3); }));
  it.live("removes items", () => Effect.gen(function* () { assert.deepStrictEqual(yield* remove([1], 1), []); }));
  it.effect("totals", () => Effect.gen(function* () { assert.strictEqual(yield* total([1, 2]), 3); }));
});
`;
const EFFECT_TOTALS_LINE = '  it.effect("totals", () => Effect.gen(function* () { assert.strictEqual(yield* total([1, 2]), 3); }));\n';

test("rewriting tests with it.effect keeps them counted", () => {
	const repo = createTempRepo({ "src/cart.test.ts": TESTS });
	repo.write(
		"src/cart.test.ts",
		`import { assert, it } from "@effect/vitest";\nimport { Effect } from "effect";\n\ndescribe('cart', () => {\n  it.effect('adds items', () => Effect.sync(() => assert.strictEqual(add(1, 2), 3)));\n  it.effect('removes items', () => Effect.sync(() => assert.deepStrictEqual(remove([1], 1), [])));\n  it.scoped('totals', () => Effect.sync(() => assert.strictEqual(total([1, 2]), 3)));\n});\n`,
	);
	assert.deepEqual(analyze(repo), []);
});

test("reports a removed it.effect test under its layer suite", () => {
	const repo = createTempRepo({ "src/cart.test.ts": EFFECT_TESTS });
	repo.write("src/cart.test.ts", EFFECT_TESTS.replace(EFFECT_TOTALS_LINE, ""));
	const findings = analyze(repo);
	assert.deepEqual(ids(findings), ["advisory:assertions-reduced", "high:test-count-reduced"]);
	const reduced = findings.find((finding) => finding.ruleId.endsWith("test-count-reduced"));
	assertShape(reduced, { before: "3", after: "2" });
	assert.match(reduced?.message ?? "", /"cart > totals"/);
});

test("reports skipped and focused Effect tests", () => {
	const repo = createTempRepo({ "src/cart.test.ts": EFFECT_TESTS });
	repo.write("src/cart.test.ts", EFFECT_TESTS.replace('it.effect("adds items"', 'it.effect.skip("adds items"').replace('it.live("removes items"', 'it.live.only("removes items"'));
	const findings = analyze(repo);
	assert.deepEqual(ids(findings), ["high:test-focused", "high:test-skipped"]);
	assert.match(findings.find((finding) => finding.ruleId.endsWith("test-skipped"))?.message ?? "", /"cart > adds items"/);
});

test("reports a deleted file of Effect tests with its test count", () => {
	const repo = createTempRepo({ "src/cart.test.ts": EFFECT_TESTS });
	repo.remove("src/cart.test.ts");
	assertShape(only(analyze(repo)), { ruleId: "ai-guard/integrity-test-file-deleted", before: "3 tests", after: "deleted" });
});
// The command line (run.ts)

const CLI_TESTS = `describe('cart', () => {\n  it('adds', () => { expect(cart(1)).toBe(1); });\n  it('totals', () => { expect(cart(2)).toBe(2); });\n});\n`;

interface Run {
	readonly status: number | null;
	readonly stdout: string;
	readonly stderr: string;
	readonly summary: string;
	readonly outputs: string;
}

function runCli(repo: TempRepo, args: ReadonlyArray<string>, githubActions = false): Run {
	const summary = join(repo.dir, ".git", "summary.md");
	const outputs = join(repo.dir, ".git", "outputs.txt");
	writeFileSync(summary, "");
	writeFileSync(outputs, "");
	const result = spawnSync(process.execPath, [join(import.meta.dirname, "..", "run.ts"), ...args], {
		cwd: repo.dir,
		encoding: "utf8",
		env: {
			...process.env,
			NO_COLOR: "1",
			ANTI_SLOP_BASE: "",
			CI: "",
			GITHUB_ACTIONS: githubActions ? "true" : "",
			GITHUB_STEP_SUMMARY: githubActions ? summary : "",
			GITHUB_OUTPUT: githubActions ? outputs : "",
		},
	});
	return {
		status: result.status,
		stdout: result.stdout,
		stderr: result.stderr,
		summary: readFileSync(summary, "utf-8"),
		outputs: readFileSync(outputs, "utf-8"),
	};
}

function weakened(): TempRepo {
	const repo = createTempRepo({ "src/cart.test.ts": CLI_TESTS, "src/util.js": "export const a = 1;\n" });
	repo.write("src/cart.test.ts", CLI_TESTS.replace("it('adds'", "it.skip('adds'"));
	repo.write("src/util.js", "export const a = 1;\n// eslint-disable-next-line no-console -- debug\nconsole.log(a);\n");
	return repo;
}

test("run.ts lists the findings and exits 1 on a high-confidence finding, 0 when only advisories remain", () => {
	const repo = weakened();
	const failing = runCli(repo, []);
	assert.equal(failing.status, 1, failing.stderr);
	assert.match(failing.stdout, /1 high-confidence, 1 advisory finding\(s\) — high-confidence findings fail this check/);
	assert.match(failing.stdout, /Skipped the existing test "cart > adds"/);
	repo.write("src/cart.test.ts", CLI_TESTS);
	const passing = runCli(repo, []);
	assert.equal(passing.status, 0, passing.stdout + passing.stderr);
	assert.match(passing.stdout, /0 high-confidence, 1 advisory finding\(s\)/);
});

test("run.ts writes the same findings to annotations, the step summary and outputs on GitHub Actions", () => {
	const result = runCli(weakened(), [], true);
	assert.equal(result.status, 1, result.stderr);
	assert.deepEqual(result.stdout.match(/^::(?:error|notice) /gm), ["::error ", "::notice "]);
	assert.match(result.stdout, /^::error file=src\/cart\.test\.ts,line=2,title=ai-guard\/integrity-test-skipped::/m);
	assert.match(result.summary, /### Check integrity/);
	assert.match(result.summary, /Skipped the existing test/);
	assert.match(result.outputs, /integrity-high-count=1/);
	assert.match(result.outputs, /integrity-advisory-count=1/);
});

test("run.ts exits 2 with an actionable message when the base is missing", () => {
	const missing = runCli(weakened(), ["--base", "does-not-exist"]);
	assert.equal(missing.status, 2, missing.stdout + missing.stderr);
	assert.match(missing.stdout + missing.stderr, /does-not-exist/);
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
for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
if (failed > 0) process.exit(1);
