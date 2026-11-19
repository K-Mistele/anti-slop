import { RuleTester } from "oxlint/plugins-dev";

import { longFunctionRule } from "./long-function.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });

const statements = (count: number) =>
	Array.from({ length: count }, (_, index) => `step${index}();`).join("\n");

const hint = "Extract named steps.";

tester.run("anti-slop-martinfowler/long-function", longFunctionRule, {
	valid: [
		`function short() {\n${statements(30)}\n}`,
		// Nested function bodies count toward the nested function, not the outer one.
		`function outer() {\n  const inner = () => {\n${statements(25)}\n  };\n  const other = () => {\n${statements(25)}\n  };\n  return [inner, other];\n}`,
		// Expression-bodied arrows have no statements.
		"const pick = (value) => value.a + value.b;",
		{ code: `function short() {\n${statements(10)}\n}`, options: [{ maxStatements: 10 }] },
	],
	invalid: [
		{
			code: `function long() {\n${statements(31)}\n}`,
			errors: [
				{
					message: `Long function \`long\`: 31 statements (limit 30). ${hint}`,
					line: 1,
					column: 9,
					endLine: 1,
					endColumn: 13,
				},
			],
		},
		{
			// The `Effect.fn` label names the function and is where the report points.
			code: `export const make = Effect.fn("users.make")(function* () {\n${statements(12)}\n});`,
			options: [{ maxStatements: 10 }],
			errors: [
				{
					message: `Long function \`users.make\`: 12 statements (limit 10). ${hint}`,
					line: 1,
					column: 30,
					endLine: 1,
					endColumn: 42,
				},
			],
		},
		{
			// Blank lines count toward the line limit.
			code: `const spread = () => {\n  a();\n${"\n".repeat(10)}  b();\n};`,
			options: [{ maxLines: 8 }],
			errors: [
				{
					message: `Long function \`spread\`: 14 lines (limit 8). ${hint}`,
					line: 1,
					column: 6,
					endLine: 1,
					endColumn: 12,
				},
			],
		},
		{
			code: `function both() {\n${statements(5)}\n}`,
			options: [{ maxStatements: 3, maxLines: 4 }],
			errors: [
				{
					message: `Long function \`both\`: 7 lines (limit 4), 5 statements (limit 3). ${hint}`,
					line: 1,
					column: 9,
					endLine: 1,
					endColumn: 13,
				},
			],
		},
		{
			// A service's `make` is named by its property key, not by the generator inside `Effect.gen`.
			code: `class Users extends Context.Service<Users>()("Users", {\n  make: Effect.gen(function* () {\n${statements(4)}\n  }),\n}) {}`,
			options: [{ maxStatements: 3 }],
			errors: [
				{
					message: `Long function \`make\`: 4 statements (limit 3). ${hint}`,
					line: 2,
					column: 2,
					endLine: 2,
					endColumn: 6,
				},
			],
		},
		{
			code: `class Store {\n  load() {\n${statements(4)}\n  }\n}`,
			options: [{ maxStatements: 3 }],
			errors: [
				{
					message: `Long function \`load\`: 4 statements (limit 3). ${hint}`,
					line: 2,
					column: 2,
					endLine: 2,
					endColumn: 6,
				},
			],
		},
		{
			// Anonymous functions are reported on their first line only, never their whole body.
			code: `items.forEach(function () {\n${statements(4)}\n});`,
			options: [{ maxStatements: 3 }],
			errors: [
				{
					message: `Long function: 4 statements (limit 3). ${hint}`,
					line: 1,
					column: 14,
					endLine: 1,
					endColumn: 27,
				},
			],
		},
		{
			code: `run(Effect.gen(function* () {\n${statements(4)}\n}));`,
			options: [{ maxStatements: 3 }],
			errors: [
				{
					message: `Long function: 4 statements (limit 3). ${hint}`,
					line: 1,
					column: 15,
					endLine: 1,
					endColumn: 29,
				},
			],
		},
	],
});
