import { rowChunk, type Ledger, type LedgerRow } from "./ledger.ts";
import { renderSessionDetails } from "./report.ts";
import type { ContextSnapshot } from "./types.ts";

export type SourceBlock =
	| { kind: "markdown" | "text" | "note" | "heading"; text: string }
	| { kind: "code"; text: string; language: string };

export interface SourceDocument {
	title: string;
	breadcrumb: string;
	tokens?: number;
	blocks: SourceBlock[];
}

export function sourceDocument(ledger: Ledger, row: LedgerRow, breadcrumb: string): SourceDocument | undefined {
	const document: SourceDocument = { title: row.label, breadcrumb, tokens: row.tokens, blocks: [] };
	if (row.key === "gap") {
		document.blocks.push({ kind: "markdown", text: "The difference between reported usage and the estimated sources. Provider formatting and tokenizer differences cannot be attributed reliably." });
		return document;
	}
	const chunk = rowChunk(ledger, row.key);
	if (chunk === undefined) return undefined;
	if (chunk.unlocated === true) {
		delete document.tokens;
		document.blocks.push({ kind: "note", text: chunk.label.startsWith("extension rewrote")
			? "The prompt was rewritten; the change could not be isolated to a separate span. Its tokens are included in the assembled prompt."
			: "Declared by Pi but not found in the assembled prompt. Its text may be included in an unattributed prompt span." });
		return document;
	}
	const definition = chunk.toolDefinition;
	if (definition !== undefined) {
		if (definition.builtinOverride === "same-definition") {
			document.blocks.push({ kind: "note", text: "Same schema and description as Pi’s built-in tool. Counted once." });
		} else if (definition.builtinOverride === "modified-definition") {
			document.blocks.push({ kind: "note", text: "Replaces Pi’s built-in definition. Only the active definition is counted." });
		}
		document.blocks.push(
			{ kind: "heading", text: "Description" },
			{ kind: "markdown", text: definition.description || "No description supplied." },
			{ kind: "heading", text: "Parameters" },
			{ kind: "code", text: definition.parameters, language: "json" },
		);
		const source = definition.source ?? chunk.group;
		if (source !== undefined || definition.path !== undefined) {
			document.blocks.push({ kind: "heading", text: "Source" });
			if (source !== undefined) document.blocks.push({ kind: "text", text: source });
			if (definition.path !== undefined) document.blocks.push({ kind: "note", text: definition.path });
		}
		return document;
	}
	if (chunk.toolCall !== undefined) {
		document.title = chunk.toolCall.name;
		document.blocks.push({ kind: "heading", text: "Arguments" }, { kind: "code", text: chunk.toolCall.arguments, language: "json" });
		return document;
	}
	if (chunk.label.startsWith("project context · ")) {
		document.blocks.push({ kind: "note", text: chunk.label.slice(18) });
	}
	const prose = ["system", "injection", "user", "assistant", "thinking", "summary"].includes(chunk.kind);
	document.blocks.push({ kind: prose ? "markdown" : "text", text: chunk.text || "(non-text content)" });
	return document;
}

export function sessionDocument(snapshot: ContextSnapshot): SourceDocument {
	return {
		title: "Session details",
		breadcrumb: "Current context",
		blocks: [{ kind: "text", text: renderSessionDetails(snapshot).join("\n") }],
	};
}
