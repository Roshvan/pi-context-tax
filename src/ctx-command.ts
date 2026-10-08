import type { SummaryScope } from "./session-summary.ts";

export type ContextCommand =
	| { readonly view: "context" }
	| { readonly view: "session"; readonly scope: SummaryScope; readonly format: "panel" | "json" };

export class InvalidContextCommand extends Error {
	readonly _tag = "InvalidContextCommand" as const;
	constructor() { super("Usage: /ctx [context|session] [branch] [json] · branch and json apply to session activity"); }
}

export function parseContextCommand(args: string):
	| { readonly _tag: "ok"; readonly value: ContextCommand }
	| { readonly _tag: "err"; readonly error: InvalidContextCommand } {
	const options = args.trim().split(/\s+/).filter(Boolean).map((option) => option === "summary" ? "session" : option);
	const flags = new Set(options);
	if (flags.size !== options.length || options.some((option) => !["context", "session", "branch", "json"].includes(option))
		|| (flags.has("context") && flags.size > 1)) return { _tag: "err", error: new InvalidContextCommand() };
	return { _tag: "ok", value: flags.size === 0 || flags.has("context") ? { view: "context" }
		: { view: "session", scope: flags.has("branch") ? "branch" : "session", format: flags.has("json") ? "json" : "panel" } };
}
