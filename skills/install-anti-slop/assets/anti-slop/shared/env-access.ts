// Ported from eslint-plugin-ai-guard 1.4.7 (`src/utils/env-access.ts`, MIT); see `src/vendor/ai-guard/UPSTREAM.md`.
// Recognises environment-variable reads, for rules that reason about the test environment and configuration secrets.
import type { ESTree } from "@oxlint/plugins";

export interface EnvAccess {
	readonly name: string;
	readonly source: "process.env" | "import.meta.env";
}

/** True for `process.env` itself. */
export function isProcessEnv(node: ESTree.Node): boolean {
	return (
		node.type === "MemberExpression" &&
		!node.computed &&
		node.object.type === "Identifier" &&
		node.object.name === "process" &&
		node.property.type === "Identifier" &&
		node.property.name === "env"
	);
}

/** True for `import.meta.env` itself. */
export function isImportMetaEnv(node: ESTree.Node): boolean {
	return (
		node.type === "MemberExpression" &&
		!node.computed &&
		node.object.type === "MetaProperty" &&
		node.object.meta.name === "import" &&
		node.object.property.name === "meta" &&
		node.property.type === "Identifier" &&
		node.property.name === "env"
	);
}

/** Name of a member property when it is statically known (`a.b`, `a['b']` or ``a[`b`]``). */
export function getStaticPropertyName(node: ESTree.MemberExpression): string | null {
	const property = node.property;
	if (!node.computed && property.type === "Identifier") return property.name;
	if (node.computed && property.type === "Literal" && typeof property.value === "string") return property.value;
	if (node.computed && property.type === "TemplateLiteral" && property.expressions.length === 0) {
		return property.quasis[0]?.value.cooked ?? null;
	}
	return null;
}

/**
 * The env var read by `node`, for `process.env.X`, `process.env['X']` and `import.meta.env.X`. TypeScript non-null
 * assertions (`process.env.X!`) are unwrapped.
 */
export function getEnvAccess(node: ESTree.Node): EnvAccess | null {
	let current = node;
	while (current.type === "TSNonNullExpression") current = current.expression;
	if (current.type !== "MemberExpression") return null;
	const name = getStaticPropertyName(current);
	if (name === null) return null;
	if (isProcessEnv(current.object)) return { name, source: "process.env" };
	if (isImportMetaEnv(current.object)) return { name, source: "import.meta.env" };
	return null;
}

/** Env-var name segments that describe a property of a secret rather than the secret itself: `JWT_SECRET_EXPIRES_IN`, `API_KEY_HEADER`. */
const NON_SECRET_TRAILING_SEGMENTS: ReadonlySet<string> = new Set([
	"EXPIRY", "EXPIRES", "EXPIRE", "EXPIRATION", "IN", "TTL", "TIMEOUT", "LIFETIME",
	"DURATION", "AGE", "LENGTH", "LEN", "SIZE", "ALGORITHM", "ALGO", "ALG", "ISSUER",
	"AUDIENCE", "HEADER", "NAME", "URL", "URI", "ENDPOINT", "HOST", "PORT", "PATH",
	"FILE", "DIR", "ROUNDS", "PREFIX", "TYPE", "ID", "REGION", "VERSION", "ENABLED",
	"MODE", "FIELD", "PARAM", "COOKIE", "COUNT", "LIMIT", "STRATEGY", "PROVIDER",
]);

/** Words that mark a credential as public: a Stripe publishable key, a Supabase anon key, a reCAPTCHA site key. */
const PUBLIC_CREDENTIAL_SEGMENTS: ReadonlySet<string> = new Set(["PUBLISHABLE", "PUBLIC", "ANON"]);

export function splitEnvName(name: string): string[] {
	return name
		.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
		.toUpperCase()
		.split(/[^A-Z0-9]+/)
		.filter((segment) => segment.length > 0);
}

/** Whether an env var name holds a credential, for checks where any credential is in scope (hard-coded fallbacks). */
export function isGenericSecretEnvName(name: string): boolean {
	const segments = splitEnvName(name);
	const last = segments.at(-1);
	if (last === undefined || NON_SECRET_TRAILING_SEGMENTS.has(last)) return false;
	if (segments.some((segment) => PUBLIC_CREDENTIAL_SEGMENTS.has(segment)) || segments.join("_").includes("SITE_KEY")) return false;
	const joined = `_${segments.join("_")}_`;
	return (
		/_(SECRET|SECRETS|PASSWORD|PASSWD|PASSPHRASE|PWD|CREDENTIALS?|SALT|PEPPER)_/.test(joined) ||
		/_(PRIVATE|SIGNING|ENCRYPTION|SESSION|MASTER|ADMIN|SERVICE|API|ACCESS|SECRET)_KEY_/.test(joined) ||
		/_APIKEY_/.test(joined) ||
		/_(AUTH|ACCESS|REFRESH|BEARER|BOT|ADMIN|API|SERVICE|PERSONAL)_TOKEN_/.test(joined) ||
		/^_(TOKEN|SECRET|PASSWORD|APIKEY)_$/.test(joined) ||
		/_(GITHUB|GH|GITLAB|NPM|SLACK|DISCORD|TELEGRAM|SENTRY|VERCEL|NETLIFY|CLOUDFLARE|HF|HUGGINGFACE)_TOKEN_/.test(joined)
	);
}
