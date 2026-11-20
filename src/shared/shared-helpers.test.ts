// oxlint-disable effecttsgo/global-console -- a test runner outside any Effect runtime
// Ported from eslint-plugin-ai-guard 1.4.7 (`tests/utils/shared-helpers.test.ts`, MIT); see `src/vendor/ai-guard/UPSTREAM.md`.
import assert from "node:assert/strict";

import { isGenericSecretEnvName, splitEnvName } from "./env-access.ts";
import { isNonProductionFile, isTestFile } from "./file-context.ts";

const tests: Array<[string, () => void]> = [];
const test = (name: string, run: () => void): void => {
	tests.push([name, run]);
};

test("test files are test files and non-production", () => {
	for (const file of [
		"src/user.test.ts",
		"src/user.spec.tsx",
		"C:\\repo\\src\\__tests__\\user.js",
		"/repo/tests/helpers.ts",
		"/repo/e2e/login.ts",
		"src/login.cy.ts",
	]) {
		assert.equal(isTestFile(file), true, file);
		assert.equal(isNonProductionFile(file), true, file);
	}
});

test("mocks, stories, seeds, examples and fixtures are non-production but not tests", () => {
	for (const file of [
		"src/mocks/handlers.ts",
		"src/__mocks__/api.js",
		"src/Button.stories.tsx",
		"prisma/seed.ts",
		"db/seeds/users.js",
		"examples/basic.js",
		"src/api.mock.ts",
		"fixtures/data.js",
	]) {
		assert.equal(isTestFile(file), false, file);
		assert.equal(isNonProductionFile(file), true, file);
	}
});

test("names that merely contain test or spec are production code", () => {
	for (const file of ["src/api/users.ts", "src/testimonials.tsx", "src/contest.ts", "app/latest/page.tsx", "src/seeder-utils/x.ts", "src/specification.ts"]) {
		assert.equal(isTestFile(file), false, file);
		assert.equal(isNonProductionFile(file), false, file);
	}
});

test("env names split on SCREAMING_CASE and camelCase", () => {
	assert.deepEqual(splitEnvName("JWT_SECRET"), ["JWT", "SECRET"]);
	assert.deepEqual(splitEnvName("openaiApiKey"), ["OPENAI", "API", "KEY"]);
});

test("credential env names are secrets", () => {
	for (const name of [
		"JWT_SECRET", "SESSION_SECRET", "NEXTAUTH_SECRET", "DB_PASSWORD", "ENCRYPTION_KEY", "OPENAI_API_KEY",
		"STRIPE_SECRET_KEY", "GITHUB_TOKEN", "SLACK_BOT_TOKEN", "AWS_SECRET_ACCESS_KEY", "PASSWORD", "APIKEY",
	]) {
		assert.equal(isGenericSecretEnvName(name), true, name);
	}
});

test("settings of a secret and public credentials are not secrets", () => {
	for (const name of [
		"JWT_EXPIRES_IN", "SESSION_SECRET_TTL", "API_KEY_HEADER", "BCRYPT_SALT_ROUNDS", "SECRET_FILE",
		"STRIPE_PUBLISHABLE_KEY", "SUPABASE_ANON_KEY", "RECAPTCHA_SITE_KEY", "AWS_ACCESS_KEY_ID", "PORT",
		"DATABASE_URL", "TOKEN_URL", "JWT_PUBLIC_KEY", "CSRF_TOKEN_NAME",
	]) {
		assert.equal(isGenericSecretEnvName(name), false, name);
	}
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
if (failed > 0) process.exit(1);
