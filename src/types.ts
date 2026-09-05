import type { ResourceInventory, SessionTotals } from "./resources.ts";

export type ChunkKind =
	| "system"
	| "injection"
	| "schema"
	| "user"
	| "assistant"
	| "thinking"
	| "tool-call"
	| "tool-result"
	| "summary"
	| "bash"
	| "custom";

export type SnapshotSource = "captured" | "mixed" | "reconstructed";

export type UsageSource = "reported" | "mixed" | "estimated";

export function isChunkKind(value: string): value is ChunkKind {
	switch (value) {
		case "system":
		case "injection":
		case "schema":
		case "user":
		case "assistant":
		case "thinking":
		case "tool-call":
		case "tool-result":
		case "summary":
		case "bash":
		case "custom":
			return true;
		default:
			return false;
	}
}

export type BuiltinToolOverride = "same-definition" | "modified-definition";

export interface ToolDefinitionDetails {
	readonly description: string;
	readonly parameters: string;
	readonly source?: string;
	readonly path?: string;
	readonly builtinOverride?: BuiltinToolOverride;
}

export interface ToolCallDetails {
	readonly name: string;
	readonly arguments: string;
}

export interface ContextChunk {
	id: number;
	order: number;
	kind: ChunkKind;
	label: string;
	text: string;
	tokens: number;
	unlocated?: boolean;
	group?: string;
	toolName?: string;
	toolDefinition?: ToolDefinitionDetails;
	toolCall?: ToolCallDetails;
}

export interface ContextSnapshot {
	chunks: ContextChunk[];
	estimatedTokens: number;
	observedTokens: number | null;
	usageSource?: UsageSource;
	observedStale?: boolean;
	contextWindow: number;
	model: string;
	turns: number;
	compactionEnabled: boolean;
	reserveTokens: number;
	source: SnapshotSource;
	capturedAt?: Date;
	resources: ResourceInventory;
	sessionTotals: SessionTotals;
}

const STARTUP_KINDS: readonly ChunkKind[] = ["system", "injection", "schema"];

export function isStartupKind(kind: ChunkKind): boolean {
	return STARTUP_KINDS.includes(kind);
}
