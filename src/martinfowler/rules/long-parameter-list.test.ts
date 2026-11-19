import { RuleTester } from "oxlint/plugins-dev";

import { longParameterListRule } from "./long-parameter-list.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
const message = (subject: string, count: number, max = 4) =>
	`Long parameter list${subject}: ${count} positional parameters (limit ${max}). Pass one parameter object.`;

tester.run("anti-slop-martinfowler/long-parameter-list", longParameterListRule, {
	valid: [
		"function send(to, subject, body, options) {}",
		// Rest parameters and destructured objects are not extra positions.
		"function log(level, message, context, tags, ...rest) {}",
		"function create({ a, b, c, d, e, f }) {}",
		// TypeScript `this` parameters are not positional.
		"function bind(this: Window, a: A, b: B, c: C, d: D) {}",
		// Overload signatures and declarations have no body.
		"declare function external(a, b, c, d, e): void;",
		"interface Api { call(a: A, b: B, c: C, d: D, e: E): void }",
		{ code: "function pair(a, b) {}", options: [{ max: 2 }] },
	],
	invalid: [
		{
			code: "function send(to, cc, subject, body, attachments) {}",
			errors: [{ message: message(" `send`", 5), line: 1, column: 9, endLine: 1, endColumn: 13 }],
		},
		{
			code: "const build = (a, b = 1, [c], d, e) => a;",
			errors: [{ message: message(" `build`", 5), line: 1, column: 6, endLine: 1, endColumn: 11 }],
		},
		{
			code: "class Store { constructor(a, b, c, d, e) {} }",
			errors: [{ message: message(" `constructor`", 5), line: 1, column: 14, endLine: 1, endColumn: 25 }],
		},
		{
			code: "items.map(function (a, b, c) {\n  return a;\n});",
			options: [{ max: 2 }],
			errors: [{ message: message("", 3, 2), line: 1, column: 10, endLine: 1, endColumn: 30 }],
		},
	],
});
