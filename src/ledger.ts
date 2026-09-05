import {
	aggregateByKind,
	aggregateToolOutputs,
	categoryLabel,
	contextMix,
	producerLabel,
	sessionChunks,
	type ContextMix,
} from "./snapshot.ts";
import { readStartup, startupRowLabel } from "./startup.ts";
import { isChunkKind, type ContextChunk, type ContextSnapshot } from "./types.ts";

const PROMPT_KEY = "standing:prompt";
const TOOLS_KEY = "standing:tools:";
const INJECTED_KEY = "standing:injected";
const CONVERSATION_KEY = "conversation";
const KIND_KEY = "session:kind:";
const PRODUCER_KEY = "session:tool:";
const CHUNK_KEY = "chunk:";

export type LedgerGroup = "startup" | "conversation" | "other";

export interface LedgerRow {
	key: string;
	label: string;
	note: string;
	tokens: number;
	group: LedgerGroup;
}

export interface Ledger {
	snapshot: ContextSnapshot;
	mix: ContextMix;
	rows: LedgerRow[];
}

function toolLabel(provider: string): string {
	if (provider === "builtin") return "Built-in tools";
	if (provider.startsWith("builtin · ")) return `Built-in tools · ${provider.slice(10)}`;
	if (provider.startsWith("override · ")) return `Built-in overrides · ${provider.slice(11)}`;
	if (provider.startsWith("mcp · ")) return `${provider.slice(6)} tools`;
	if (provider.startsWith("ext · ")) return `${provider.slice(6)} tools`;
	return `${provider} tools`;
}

export function readLedger(snapshot: ContextSnapshot): Ledger {
	const mix = contextMix(snapshot);
	const startup = readStartup(snapshot, mix.normalization);
	const rows: LedgerRow[] = [];
	for (const section of startup.sections) {
		if (section.title === "tool definitions") {
			for (const row of section.rows) {
				rows.push({ key: TOOLS_KEY + row.label, label: toolLabel(row.label), note: "", tokens: row.tokens, group: "startup" });
			}
		} else {
			const prompt = section.title === "system prompt";
			rows.push({
				key: prompt ? PROMPT_KEY : INJECTED_KEY,
				label: prompt ? "System prompt" : "Extension additions",
				note: "",
				tokens: section.rows.reduce((sum, row) => sum + row.tokens, 0),
				group: "startup",
			});
		}
	}
	rows.sort((left, right) => right.tokens - left.tokens || left.label.localeCompare(right.label));
	rows.push({ key: CONVERSATION_KEY, label: "Conversation", note: "", tokens: mix.session, group: "conversation" });
	if (mix.gap > 0) rows.push({ key: "gap", label: "Unattributed", note: "", tokens: mix.gap, group: "other" });
	return { snapshot, mix, rows };
}

function chunkRow(chunk: ContextChunk, scale: number, group: LedgerGroup): LedgerRow {
	const label = chunk.kind === "schema"
		? (chunk.toolName ?? chunk.label)
		: chunk.label.startsWith("skill · ")
			? chunk.label.slice(8)
			: startupRowLabel(chunk.label);
	return {
		key: CHUNK_KEY + chunk.id,
		label,
		note: chunk.unlocated === true ? "not located" : "",
		tokens: chunk.tokens * scale,
		group,
	};
}

export function rowChildren(ledger: Ledger, key: string): LedgerRow[] {
	const snapshot = ledger.snapshot;
	const scale = ledger.mix.normalization;
	const chunks = (items: ContextChunk[], group: LedgerGroup): LedgerRow[] => [...items]
		.sort((left, right) => right.tokens - left.tokens || left.order - right.order)
		.map((chunk) => chunkRow(chunk, scale, group));
	if (key.startsWith(TOOLS_KEY)) {
		return chunks(snapshot.chunks.filter((chunk) => chunk.kind === "schema" && (chunk.group ?? "other") === key.slice(TOOLS_KEY.length)), "startup");
	}
	if (key === PROMPT_KEY) return chunks(snapshot.chunks.filter((chunk) => chunk.kind === "system"), "startup");
	if (key === INJECTED_KEY) return chunks(snapshot.chunks.filter((chunk) => chunk.kind === "injection"), "startup");
	if (key === CONVERSATION_KEY) {
		return aggregateByKind(sessionChunks(snapshot)).map((category) => ({
			key: KIND_KEY + category.kind,
			label: categoryLabel(category.kind),
			note: "",
			tokens: category.tokens * scale,
			group: "conversation",
		}));
	}
	if (key.startsWith(KIND_KEY)) {
		const kind = key.slice(KIND_KEY.length);
		if (!isChunkKind(kind)) return [];
		if (kind === "tool-result") {
			return aggregateToolOutputs(sessionChunks(snapshot)).map((producer) => ({
				key: PRODUCER_KEY + producer.label,
				label: producer.label,
				note: "",
				tokens: producer.tokens * scale,
				group: "conversation",
			}));
		}
		return chunks(snapshot.chunks.filter((chunk) => chunk.kind === kind), "conversation");
	}
	if (key.startsWith(PRODUCER_KEY)) {
		return chunks(snapshot.chunks.filter((chunk) => chunk.kind === "tool-result" && producerLabel(chunk.label) === key.slice(PRODUCER_KEY.length)), "conversation");
	}
	return [];
}

export function rowChunk(ledger: Ledger, key: string): ContextChunk | undefined {
	if (!key.startsWith(CHUNK_KEY)) return undefined;
	const id = Number(key.slice(CHUNK_KEY.length));
	return ledger.snapshot.chunks.find((entry) => entry.id === id);
}
