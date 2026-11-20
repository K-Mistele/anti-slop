// Ported from eslint-plugin-ai-guard 1.4.7 (`cli/utils/integrity/git.ts`, MIT); see `src/vendor/ai-guard/UPSTREAM.md`.
// Git access for integrity analysis. Every call uses execFileSync with an argument array (no shell), validated refs,
// NUL-delimited path lists and bounded output, so file names with spaces or shell metacharacters are safe and nothing
// is interpolated.

// oxlint-disable effecttsgo/node-builtin-import -- a standalone CLI outside any Effect runtime, so Effect's platform services do not apply

import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, type Stats } from "node:fs";
import { join } from "node:path";

import { IntegrityGitError, errorMessage, isIntegrityGitError, type IntegrityBaseInfo } from "./types.ts";

/** Files larger than this are skipped (reported as an analysis error). */
const MAX_FILE_BYTES = 2 * 1024 * 1024;

const REF_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._/~^@{}-]*$/;

function isSafeRef(ref: string): boolean {
	return ref.length <= 256 && REF_PATTERN.test(ref) && !ref.includes("..") && !ref.startsWith("-");
}

function field(error: unknown, key: "code" | "stderr"): unknown {
	if (typeof error !== "object" || error === null) return undefined;
	if (key === "code") return "code" in error ? error.code : undefined;
	return "stderr" in error ? error.stderr : undefined;
}

function git(args: ReadonlyArray<string>, cwd: string, input?: string): string {
	try {
		return execFileSync("git", ["-c", "core.fsmonitor=false", "-c", "core.quotepath=false", ...args], {
			cwd,
			encoding: "utf-8",
			stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
			...(input === undefined ? {} : { input }),
			timeout: 30000,
			maxBuffer: 64 * 1024 * 1024,
			shell: false,
			windowsHide: true,
		});
	} catch (error) {
		if (field(error, "code") === "ENOENT") throw new IntegrityGitError("GIT_UNAVAILABLE", "Git is not installed or not on PATH");
		const stderr = field(error, "stderr");
		const firstLine = typeof stderr === "string" ? (stderr.trim().split("\n")[0] ?? "") : "";
		throw new IntegrityGitError("GIT_FAILED", firstLine === "" ? errorMessage(error) : firstLine);
	}
}

/** The output of a Git command, or null when it fails: callers that probe (does this ref exist?) treat failure as "no". */
function tryGit(args: ReadonlyArray<string>, cwd: string): string | null {
	try {
		return git(args, cwd);
	} catch {
		return null;
	}
}

export interface ResolvedBase extends IntegrityBaseInfo {
	readonly repoRoot: string;
	/** Tree-ish to diff against (commit SHA or the empty tree). */
	readonly treeish: string;
}

export interface ResolveBaseOptions {
	readonly cwd: string;
	/** Ref to compare with. Omit for HEAD (uncommitted changes). */
	readonly base?: string | undefined;
	/** Compare with merge-base(HEAD, base) instead of base itself (PR semantics). */
	readonly mergeBase?: boolean;
	/** Also try `origin/<base>` first, the way branch names resolve on a CI checkout. */
	readonly preferRemote?: boolean;
}

function repoRootOf(cwd: string): string {
	try {
		return git(["rev-parse", "--show-toplevel"], cwd).trim();
	} catch (error) {
		if (isIntegrityGitError(error) && error.code === "GIT_UNAVAILABLE") throw error;
		throw new IntegrityGitError("NOT_A_REPO", "Not inside a Git repository");
	}
}

function emptyTree(root: string): string {
	return git(["hash-object", "-t", "tree", "--stdin"], root, "").trim();
}

function verifyCommit(ref: string, root: string): string | null {
	const out = tryGit(["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`], root);
	return out === null || out === "" ? null : out.trim();
}

/** Resolve the base revision to compare against. Throws IntegrityGitError with an actionable message. */
export function resolveBase(options: ResolveBaseOptions): ResolvedBase {
	const repoRoot = repoRootOf(options.cwd);
	const head = "working-tree";

	if (options.base === undefined || options.base === "HEAD") {
		const commit = verifyCommit("HEAD", repoRoot);
		if (commit === null) {
			if (options.base === "HEAD") {
				throw new IntegrityGitError("BASE_NOT_FOUND", "HEAD does not exist yet (no commits); omit --base to compare with the empty tree");
			}
			return { ref: "(empty tree)", commit: null, head, repoRoot, treeish: emptyTree(repoRoot) };
		}
		return { ref: "HEAD", commit, head, repoRoot, treeish: commit };
	}

	const base = options.base;
	if (!isSafeRef(base)) {
		throw new IntegrityGitError("INVALID_REF", `Invalid Git ref: ${JSON.stringify(base)} (expected a single ref, without options or ranges)`);
	}
	const candidates = options.preferRemote === true && !base.startsWith("origin/") ? [`origin/${base}`, base] : [base];
	let resolvedRef: string | null = null;
	let commit: string | null = null;
	for (const candidate of candidates) {
		commit = verifyCommit(candidate, repoRoot);
		if (commit !== null) {
			resolvedRef = candidate;
			break;
		}
	}
	if (commit === null || resolvedRef === null) {
		throw new IntegrityGitError(
			"BASE_NOT_FOUND",
			`Base revision ${JSON.stringify(base)} was not found. Fetch it first (e.g. \`git fetch origin ${base}\`; in GitHub Actions use actions/checkout with fetch-depth: 0).`,
		);
	}
	if (options.mergeBase === true) {
		const mergeBase = tryGit(["merge-base", "HEAD", commit], repoRoot);
		if (mergeBase === null) {
			throw new IntegrityGitError(
				"NO_MERGE_BASE",
				`No merge base between HEAD and ${resolvedRef}. The clone may be shallow — use actions/checkout with fetch-depth: 0.`,
			);
		}
		commit = mergeBase.trim();
	}
	return { ref: resolvedRef, commit, head, repoRoot, treeish: commit };
}

export type ChangeStatus = "A" | "M" | "D" | "R" | "T";

export interface ChangedEntry {
	readonly status: ChangeStatus;
	/** Repo-relative POSIX path in the head (old path for deletions). */
	readonly path: string;
	/** Previous path for renames. */
	readonly oldPath?: string;
}

/** Literal pathspecs (no glob interpretation) for repo-relative paths. */
function literalPathspecs(paths: ReadonlyArray<string>): string[] {
	return paths.map((path) => `:(literal)${path}`);
}

/** Files changed between the base and the working tree, including untracked files. */
export function listChanges(base: ResolvedBase): ChangedEntry[] {
	const out = git(["diff", "--name-status", "-z", "-M", "--no-color", "--no-ext-diff", base.treeish, "--"], base.repoRoot);
	const tokens = out.split("\0");
	const entries: ChangedEntry[] = [];
	for (let i = 0; i < tokens.length; ) {
		const status = tokens[i++];
		if (status === undefined || status === "") continue;
		const code = status[0];
		if (code === "R" || code === "C") {
			const oldPath = tokens[i++] ?? "";
			const newPath = tokens[i++] ?? "";
			entries.push(code === "R" ? { status: "R", path: newPath, oldPath } : { status: "A", path: newPath });
			continue;
		}
		const path = tokens[i++];
		if (path === undefined || path === "") continue;
		if (code === "A" || code === "M" || code === "D" || code === "T") entries.push({ status: code, path });
		else if (code === "U") entries.push({ status: "M", path });
	}
	const untracked = git(["ls-files", "--others", "--exclude-standard", "--full-name", "-z"], base.repoRoot);
	const known = new Set(entries.map((entry) => entry.path));
	for (const path of untracked.split("\0")) {
		if (path !== "" && !known.has(path)) entries.push({ status: "A", path });
	}
	return entries.sort((a, b) => a.path.localeCompare(b.path));
}

export type BlobRead = { readonly content: string } | { readonly missing: true } | { readonly error: IntegrityGitError };

/**
 * Read many `<rev>:<path>` blobs with two Git processes (`cat-file --batch-check`, then `--batch` for the ones within
 * the size limit) instead of two processes per file.
 */
export function readBlobs(repoRoot: string, specs: ReadonlyArray<string>): Map<string, BlobRead> {
	const out = new Map<string, BlobRead>();
	const batchable = specs.filter((spec) => !spec.includes("\n") && !spec.includes("\r"));
	for (const spec of specs) if (!batchable.includes(spec)) out.set(spec, { missing: true });
	if (batchable.length === 0) return out;
	const check = git(["cat-file", "--batch-check"], repoRoot, `${batchable.join("\n")}\n`).split("\n");
	const wanted: Array<{ readonly spec: string; readonly sha: string; readonly size: number }> = [];
	batchable.forEach((spec, i) => {
		const match = /^([0-9a-f]{40,64}) (\w+) (\d+)$/.exec(check[i] ?? "");
		const sha = match?.[1];
		if (match === null || sha === undefined || match[2] !== "blob") {
			out.set(spec, { missing: true });
			return;
		}
		const size = Number(match[3]);
		if (size > MAX_FILE_BYTES) {
			out.set(spec, { error: new IntegrityGitError("FILE_TOO_LARGE", `${spec.replace(/^[^:]*:/, "")} exceeds ${MAX_FILE_BYTES} bytes`) });
			return;
		}
		wanted.push({ spec, sha, size });
	});
	if (wanted.length === 0) return out;
	let raw: Buffer;
	try {
		raw = execFileSync("git", ["-c", "core.fsmonitor=false", "cat-file", "--batch"], {
			cwd: repoRoot,
			input: `${wanted.map((blob) => blob.sha).join("\n")}\n`,
			stdio: ["pipe", "pipe", "pipe"],
			timeout: 60000,
			maxBuffer: wanted.reduce((total, blob) => total + blob.size + 128, 1024),
			shell: false,
			windowsHide: true,
		});
	} catch (error) {
		throw new IntegrityGitError("GIT_FAILED", errorMessage(error));
	}
	let offset = 0;
	for (const blob of wanted) {
		offset = raw.indexOf(0x0a, offset) + 1;
		out.set(blob.spec, { content: raw.subarray(offset, offset + blob.size).toString("utf-8") });
		// The content is followed by a newline.
		offset += blob.size + 1;
	}
	return out;
}

/** Git C-style quoted path ("b/a\tb") to a plain path. */
function unquotePath(path: string): string {
	if (!path.startsWith('"') || !path.endsWith('"')) return path;
	const body = path.slice(1, -1);
	const escapes: Readonly<Record<string, string>> = { n: "\n", t: "\t", r: "\r", '"': '"', "\\": "\\", a: "\x07", b: "\b", f: "\f", v: "\v" };
	const bytes: number[] = [];
	for (let i = 0; i < body.length; i += 1) {
		const char = body[i] ?? "";
		if (char !== "\\") {
			bytes.push(...Buffer.from(char, "utf-8"));
			continue;
		}
		i += 1;
		const next = body[i] ?? "";
		if (/[0-7]/.test(next)) {
			bytes.push(Number.parseInt(body.slice(i, i + 3), 8));
			i += 2;
			continue;
		}
		bytes.push(...Buffer.from(escapes[next] ?? next, "utf-8"));
	}
	return Buffer.from(bytes).toString("utf-8");
}

/**
 * Head-side line numbers added by the change for many files, from one `git diff -U0` (chunked to stay under
 * command-line limits). Files missing from the map could not be diffed; callers treat every line as added.
 */
export function addedLinesForAll(base: ResolvedBase, entries: ReadonlyArray<ChangedEntry>): Map<string, Set<number>> {
	const result = new Map<string, Set<number>>();
	const targets = entries.filter((entry) => entry.status !== "A" && entry.status !== "D");
	for (const entry of targets) result.set(entry.path, new Set());
	const chunks: ChangedEntry[][] = [];
	let current: ChangedEntry[] = [];
	let length = 0;
	for (const entry of targets) {
		const size = entry.path.length + (entry.oldPath?.length ?? 0) + 24;
		if (current.length > 0 && length + size > 16000) {
			chunks.push(current);
			current = [];
			length = 0;
		}
		current.push(entry);
		length += size;
	}
	if (current.length > 0) chunks.push(current);
	for (const chunk of chunks) {
		const paths = chunk.flatMap((entry) => (entry.oldPath === undefined ? [entry.path] : [entry.oldPath, entry.path]));
		const out = tryGit(["diff", "-U0", "--no-color", "--no-ext-diff", "-M", base.treeish, "--", ...literalPathspecs(paths)], base.repoRoot);
		if (out === null) {
			for (const entry of chunk) result.delete(entry.path);
			continue;
		}
		let file: string | null = null;
		for (const line of out.split("\n")) {
			if (line.startsWith("+++ ")) {
				const target = line.slice(4).replace(/\t$/, "");
				file = target === "/dev/null" ? null : unquotePath(target).replace(/^b\//, "");
				continue;
			}
			const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
			if (match === null || file === null) continue;
			const set = result.get(file) ?? new Set<number>();
			const start = Number(match[1]);
			const count = match[2] === undefined ? 1 : Number(match[2]);
			for (let i = 0; i < count; i += 1) set.add(start + i);
			result.set(file, set);
		}
	}
	return result;
}

/** Read a file in the working tree; null if it does not exist or is not a regular file. */
export function readHeadFile(base: ResolvedBase, repoPath: string): string | null {
	const absolute = join(base.repoRoot, repoPath);
	let stat: Stats;
	try {
		stat = lstatSync(absolute);
	} catch {
		return null;
	}
	if (!stat.isFile()) return null;
	if (stat.size > MAX_FILE_BYTES) throw new IntegrityGitError("FILE_TOO_LARGE", `${repoPath} exceeds ${MAX_FILE_BYTES} bytes`);
	return readFileSync(absolute, "utf-8");
}
