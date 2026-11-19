// Ported from eslint-plugin-ai-guard 1.4.7 (`src/rules/security/no-undeclared-import.ts`, MIT); see
// `src/vendor/ai-guard/UPSTREAM.md`.

// oxlint-disable effecttsgo/node-builtin-import, effecttsgo/global-date -- runs inside oxlint's plugin host, outside any Effect runtime

import fs from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";

import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

import { isFunctionNode } from "../shared/ast-walk.ts";
import { parseJsonc } from "../shared/jsonc.ts";

const BUILTINS: ReadonlySet<string> = new Set(builtinModules);

const DEPENDENCY_FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const;
const SOURCE_EXTENSIONS = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".json", ".d.ts", ".vue", ".svelte"];
const TSCONFIG_FILE = /^[tj]sconfig(?:\.[\w-]+)?\.json$/;

interface PackageInfo {
	readonly dir: string;
	readonly names: ReadonlySet<string>;
}

interface AliasInfo {
	/** Exact `paths` keys and wildcard prefixes (key before the `*`). */
	readonly exact: Set<string>;
	readonly prefixes: string[];
	/** Absolute `baseUrl` directories. */
	readonly baseUrls: string[];
}

interface ProjectContext {
	readonly declared: ReadonlySet<string>;
	readonly packageDirs: ReadonlyArray<string>;
	readonly aliases: AliasInfo;
}

// ─── Filesystem caches ───────────────────────────────────────────────────────
// package.json and tsconfig contents are re-read when their mtime changes, so a long-running process (editor,
// language server) sees dependencies an agent just added.

const fileCache = new Map<string, { readonly mtimeMs: number; readonly value: unknown }>();

/** The parsed file, or null when it is missing or does not parse: either way it declares nothing. */
function readJsonCached(file: string, parse: (text: string) => unknown): unknown {
	let stat: fs.Stats;
	try {
		stat = fs.statSync(file);
	} catch {
		fileCache.delete(file);
		return null;
	}
	const cached = fileCache.get(file);
	if (cached !== undefined && cached.mtimeMs === stat.mtimeMs) return cached.value;
	let value: unknown = null;
	try {
		value = parse(fs.readFileSync(file, "utf8"));
	} catch {
		value = null;
	}
	fileCache.set(file, { mtimeMs: stat.mtimeMs, value });
	return value;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function readPackage(file: string): PackageInfo | null {
	const pkg = readJsonCached(file, JSON.parse);
	if (!isRecord(pkg)) return null;
	const names = new Set<string>();
	if (typeof pkg.name === "string") names.add(pkg.name);
	for (const field of DEPENDENCY_FIELDS) {
		const deps = pkg[field];
		if (isRecord(deps)) for (const name of Object.keys(deps)) names.add(name);
	}
	for (const field of ["bundleDependencies", "bundledDependencies"]) {
		const deps = pkg[field];
		if (Array.isArray(deps)) for (const name of deps) if (typeof name === "string") names.add(name);
	}
	return { dir: path.dirname(file), names };
}

function collectAliases(dir: string, aliases: AliasInfo): void {
	let entries: string[];
	try {
		entries = fs.readdirSync(dir);
	} catch {
		return;
	}
	for (const entry of entries) {
		if (TSCONFIG_FILE.test(entry)) readTsconfig(path.join(dir, entry), aliases, 0);
	}
}

function readTsconfig(file: string, aliases: AliasInfo, depth: number): void {
	if (depth > 3) return;
	const config = readJsonCached(file, parseJsonc);
	if (!isRecord(config)) return;
	const dir = path.dirname(file);

	if (typeof config.extends === "string" && config.extends.startsWith(".")) {
		const target = path.resolve(dir, config.extends);
		readTsconfig(target.endsWith(".json") ? target : `${target}.json`, aliases, depth + 1);
	}

	const options = config.compilerOptions;
	if (!isRecord(options)) return;
	if (typeof options.baseUrl === "string") aliases.baseUrls.push(path.resolve(dir, options.baseUrl));
	if (isRecord(options.paths)) {
		for (const key of Object.keys(options.paths)) {
			const star = key.indexOf("*");
			if (star === -1) aliases.exact.add(key);
			else aliases.prefixes.push(key.slice(0, star));
		}
	}
}

/** Short-lived so a long-running process notices a dependency an agent just added. */
const PROJECT_CACHE_TTL_MS = 2000;
const projectCache = new Map<string, { readonly at: number; readonly project: ProjectContext | null }>();

/** Forget cached project lookups, for tests that change package.json between runs. */
export function clearUndeclaredImportCache(): void {
	projectCache.clear();
	fileCache.clear();
}

/**
 * Walks up from the file collecting every package.json until the repository root (a directory with `.git`).
 * Dependencies are unioned so a workspace package can rely on tooling declared once at the monorepo root.
 */
function getProjectContext(fileDir: string): ProjectContext | null {
	const now = Date.now();
	const cached = projectCache.get(fileDir);
	if (cached !== undefined && now - cached.at < PROJECT_CACHE_TTL_MS) return cached.project;
	const project = buildProjectContext(fileDir);
	projectCache.set(fileDir, { at: now, project });
	return project;
}

function buildProjectContext(fileDir: string): ProjectContext | null {
	const declared = new Set<string>();
	const packageDirs: string[] = [];
	const aliases: AliasInfo = { exact: new Set(), prefixes: [], baseUrls: [] };

	let dir = fileDir;
	for (let i = 0; i < 50; i += 1) {
		const pkg = readPackage(path.join(dir, "package.json"));
		if (pkg !== null) {
			for (const name of pkg.names) declared.add(name);
			packageDirs.push(dir);
			collectAliases(dir, aliases);
		}
		if (fs.existsSync(path.join(dir, ".git"))) break;
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return packageDirs.length > 0 ? { declared, packageDirs, aliases } : null;
}

// ─── Specifier analysis ──────────────────────────────────────────────────────

/** The npm package name a specifier refers to, or null for non-package specifiers. */
export function getPackageName(specifier: string): string | null {
	const spec = specifier.split("?")[0] ?? "";
	// webpack loader syntax
	if (spec === "" || spec.includes("!")) return null;
	if (/^[./]/.test(spec) || path.isAbsolute(spec)) return null;
	// subpath imports, ~/ and $lib aliases
	if (/^[#~$]/.test(spec)) return null;
	if (spec.startsWith("@/") || spec.startsWith("@@/") || spec === "@") return null;
	// node:, bun:, virtual:, astro:, npm:, https:
	if (/^[\w.-]+:/.test(spec)) return null;

	const [first = "", second = ""] = spec.split("/");
	if (spec.startsWith("@")) {
		if (first.slice(1) === "" || second === "") return null;
		return `${first}/${second}`;
	}
	return first;
}

function typesPackageName(name: string): string {
	return name.startsWith("@") ? `@types/${name.slice(1).replace("/", "__")}` : `@types/${name}`;
}

function existsAsSource(base: string): boolean {
	return SOURCE_EXTENSIONS.some((extension) => fs.existsSync(base + extension));
}

/** True when the specifier resolves through a tsconfig alias or a local directory. */
function isLocalAlias(specifier: string, packageName: string, project: ProjectContext): boolean {
	const { aliases } = project;
	if (aliases.exact.has(specifier) || aliases.exact.has(packageName)) return true;
	if (aliases.prefixes.some((prefix) => prefix.length > 0 && specifier.startsWith(prefix))) return true;

	const firstSegment = specifier.split("/")[0] ?? "";
	// baseUrl imports (`components/Button`) and bundler aliases that mirror a directory name (`utils/format` -> src/utils).
	const roots = [...aliases.baseUrls, ...project.packageDirs.flatMap((dir) => [dir, path.join(dir, "src")])];
	return roots.some((root) => existsAsSource(path.join(root, firstSegment)));
}

function isInstalled(packageName: string, project: ProjectContext): boolean {
	return project.packageDirs.some((dir) => fs.existsSync(path.join(dir, "node_modules", packageName)));
}

/**
 * `try { require('fsevents') } catch {}` and `await import('open').catch(...)` load an optional dependency on
 * purpose; a missing package is handled.
 */
function isGuardedOptionalLoad(node: ESTree.Node): boolean {
	const parent = node.parent;
	if (
		parent?.type === "MemberExpression" &&
		parent.object === node &&
		parent.property.type === "Identifier" &&
		parent.parent?.type === "CallExpression" &&
		(parent.property.name === "catch" || (parent.property.name === "then" && parent.parent.arguments.length >= 2))
	) {
		return true;
	}
	let child: ESTree.Node = node;
	for (let current = node.parent; current !== null && current !== undefined; current = current.parent) {
		if (current.type === "TryStatement" && current.block === child && current.handler !== null) return true;
		if (isFunctionNode(current)) return false;
		child = current;
	}
	return false;
}

function matchesAllowList(name: string, allow: ReadonlyArray<string>): boolean {
	return allow.some((pattern) => (pattern.endsWith("/*") ? name.startsWith(pattern.slice(0, -1)) : pattern === name));
}

function allowOption(option: unknown): ReadonlyArray<string> {
	if (!isRecord(option) || !Array.isArray(option.allow)) return [];
	return option.allow.filter((entry): entry is string => typeof entry === "string");
}

/** Reject imports of packages that no package.json between the file and the repository root declares. */
export const noUndeclaredImportRule = defineRule({
	meta: {
		type: "problem",
		docs: {
			description:
				'Disallow imports of packages that are not declared in package.json. AI models invent plausible package names (5-22% of suggested packages do not exist), and attackers register those names on npm ("slopsquatting"). Catching the import before `npm install` runs stops the attack; it also catches phantom dependencies that only work through hoisting.',
		},
		schema: [
			{
				type: "object",
				properties: {
					allow: {
						type: "array",
						items: { type: "string" },
						description: 'Module names provided by the runtime or host (exact names, or a scope such as "@acme/*").',
					},
				},
				additionalProperties: false,
			},
		],
		messages: {
			notInstalled:
				'"{{name}}" is not declared in package.json and is not installed. AI tools invent plausible package names, and attackers publish malware under them (slopsquatting). Confirm on npmjs.com that "{{name}}" is the package you meant before installing it, or fix the import if it should be a local module.',
			phantomDependency:
				'"{{name}}" is installed but not declared in package.json, so it is only present as a dependency of another package. A clean install, pnpm, or an upgrade of that package can remove it. Add "{{name}}" to dependencies.',
		},
	},
	create(context) {
		const filename = context.physicalFilename || context.filename;
		if (filename === "" || filename.startsWith("<") || !path.isAbsolute(filename)) return {};
		if (/[\\/]node_modules[\\/]/.test(filename)) return {};

		const project = getProjectContext(path.dirname(filename));
		if (project === null) return {};
		const allow = allowOption(context.options[0]);

		function check(source: ESTree.Node | null | undefined, loadExpression?: ESTree.Node): void {
			if (source === null || source === undefined || source.type !== "Literal" || typeof source.value !== "string") return;
			if (loadExpression !== undefined && isGuardedOptionalLoad(loadExpression)) return;
			const specifier = source.value;
			const name = getPackageName(specifier);
			if (name === null || project === null) return;
			if (BUILTINS.has(name) || BUILTINS.has(specifier)) return;
			if (project.declared.has(name) || project.declared.has(typesPackageName(name))) return;
			if (matchesAllowList(name, allow)) return;
			if (isLocalAlias(specifier, name, project)) return;

			context.report({ node: source, messageId: isInstalled(name, project) ? "phantomDependency" : "notInstalled", data: { name } });
		}

		return {
			ImportDeclaration: (node) => check(node.source),
			ExportNamedDeclaration: (node) => check(node.source),
			ExportAllDeclaration: (node) => check(node.source),
			ImportExpression: (node) => check(node.source, node),
			TSImportEqualsDeclaration(node) {
				if (node.moduleReference.type === "TSExternalModuleReference") check(node.moduleReference.expression);
			},
			CallExpression(node) {
				if (node.arguments.length !== 1) return;
				const callee = node.callee;
				const isRequire = callee.type === "Identifier" && callee.name === "require";
				const isRequireResolve =
					callee.type === "MemberExpression" &&
					callee.object.type === "Identifier" &&
					callee.object.name === "require" &&
					callee.property.type === "Identifier" &&
					callee.property.name === "resolve";
				if (isRequire || isRequireResolve) check(node.arguments[0], node);
			},
		};
	},
});
