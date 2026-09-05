import {
	calculateContextTokens,
	convertToLlm,
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createPowerShellToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	estimateTokens,
	type BuildSystemPromptOptions,
	type ToolInfo,
} from "@earendil-works/pi-coding-agent";

import type { CapturedMessages } from "./capture.ts";
import type { ResourceInventory, SessionTotals } from "./resources.ts";
import { toolProvider } from "./startup.ts";
import { attributeSystemPrompt } from "./system-prompt.ts";
import { contentText, distribute, estimateText, oneLine } from "./tokens.ts";
import { isStartupKind, type BuiltinToolOverride, type ChunkKind, type ContextChunk, type ContextSnapshot, type SnapshotSource, type ToolCallDetails, type ToolDefinitionDetails, type UsageSource } from "./types.ts";

const KIND_LABEL = {
	system: "system",
	injection: "injection",
	schema: "definition",
	user: "user",
	assistant: "assistant",
	thinking: "thinking",
	"tool-call": "tool call",
	"tool-result": "tool output",
	summary: "summary",
	bash: "bash",
	custom: "custom",
} as const satisfies Record<ChunkKind, string>;

const CATEGORY_LABEL = {
	schema: "Tool definitions",
	system: "System prompt",
	injection: "Injected",
} as const satisfies Partial<Record<ChunkKind, string>>;

export function categoryLabel(kind: ChunkKind): string {
	if (kind === "schema") return CATEGORY_LABEL.schema;
	if (kind === "system") return CATEGORY_LABEL.system;
	if (kind === "injection") return CATEGORY_LABEL.injection;
	return KIND_LABEL[kind].replace(/^./, (letter) => letter.toUpperCase());
}

export interface ToolSummary {
	name: string;
	description: string;
	parameters: unknown;
	source?: string;
	path?: string;
	builtinOverride?: BuiltinToolOverride;
}

export function toolSchemaText(tool: ToolSummary): string {
	return `${tool.name}\n${tool.description}\n${JSON.stringify(tool.parameters ?? {})}`;
}

const BUILTIN_FACTORIES = new Map<string, (cwd: string) => ToolSummary>([
	["read", createReadToolDefinition],
	["bash", createBashToolDefinition],
	["edit", createEditToolDefinition],
	["write", createWriteToolDefinition],
	["grep", createGrepToolDefinition],
	["find", createFindToolDefinition],
	["ls", createLsToolDefinition],
	["powershell", createPowerShellToolDefinition],
]);

export function summarizeActiveTools(tools: readonly ToolInfo[], activeNames: readonly string[], cwd: string): ToolSummary[] {
	const active = new Set(activeNames);
	const definitions = new Map(tools.filter((tool) => active.has(tool.name)).map((tool) => [tool.name, tool]));
	return [...definitions.values()].map((tool) => {
		const builtin = tool.sourceInfo?.source === "builtin" ? undefined : BUILTIN_FACTORIES.get(tool.name)?.(cwd);
		const builtinOverride = builtin === undefined ? undefined
			: toolSchemaText(tool) === toolSchemaText(builtin) ? "same-definition" : "modified-definition";
		return {
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
			source: tool.sourceInfo?.source,
			path: tool.sourceInfo?.path,
			builtinOverride,
		};
	});
}

export interface SnapshotInputs {
	systemPrompt: string;
	baselineSystemPrompt?: string;
	systemPromptOptions: BuildSystemPromptOptions | undefined;
	messages: CapturedMessages;
	tools: ToolSummary[];
	source: SnapshotSource;
	capturedAt?: Date;
	observedTokens: number | null;
	usageSource?: UsageSource;
	observedStale?: boolean;
	contextWindow: number;
	model: string;
	turns: number;
	compactionEnabled: boolean;
	reserveTokens: number;
	resources: ResourceInventory;
	sessionTotals: SessionTotals;
}

interface AddOptions {
	tokens?: number;
	unlocated?: boolean;
	group?: string;
	toolName?: string;
	toolDefinition?: ToolDefinitionDetails;
	toolCall?: ToolCallDetails;
}

type AddChunk = (kind: ChunkKind, label: string, text: string, options?: AddOptions) => void;

function addSystemChunks(
	systemPrompt: string,
	options: BuildSystemPromptOptions | undefined,
	baseline: string | undefined,
	add: AddChunk,
): void {
	const segments = attributeSystemPrompt(systemPrompt, options, baseline);
	const shares = distribute(segments.map((segment) => segment.chars), estimateText(systemPrompt));
	for (let index = 0; index < segments.length; index++) {
		const segment = segments[index];
		if (segment === undefined) continue;
		add(segment.kind, segment.label, segment.text, {
			tokens: shares[index] ?? 0,
			unlocated: segment.unlocated,
		});
	}
}

type UserChunkMeta = {
	readonly kind: ChunkKind;
	readonly label: string;
};

function userChunkMeta(original: CapturedMessages[number]): UserChunkMeta {
	switch (original.role) {
		case "compactionSummary":
			return { kind: "summary", label: "compaction summary" };
		case "branchSummary":
			return { kind: "summary", label: "branch summary" };
		case "bashExecution":
			return { kind: "bash", label: `bash · ${oneLine(original.command)}` };
		case "custom":
			return { kind: "custom", label: `custom · ${original.customType}` };
		default:
			return { kind: "user", label: "user message" };
	}
}

function addMessageChunks(messages: CapturedMessages, add: AddChunk): void {
	for (const original of messages) {
		const message = convertToLlm([original])[0];
		if (!message) continue;
		const messageTokens = estimateTokens(message);

		if (message.role === "user") {
			const meta = userChunkMeta(original);
			add(meta.kind, meta.label, contentText(message.content), { tokens: messageTokens });
			continue;
		}

		if (message.role === "toolResult") {
			const error = message.isError ? " · error" : "";
			add(
				"tool-result",
				`tool output · ${message.toolName || "unknown"}${error}`,
				contentText(message.content),
				{ tokens: messageTokens },
			);
			continue;
		}

		const blocks: Array<{ kind: ChunkKind; label: string; text: string; estimate: number; toolCall?: ToolCallDetails }> = [];
		let blockNumber = 0;
		for (const block of Array.isArray(message.content) ? message.content : []) {
			blockNumber++;
			if (block.type === "text") {
				blocks.push({ kind: "assistant", label: `assistant text · block ${blockNumber}`, text: block.text, estimate: estimateText(block.text) });
			} else if (block.type === "thinking") {
				blocks.push({ kind: "thinking", label: `assistant thinking · block ${blockNumber}`, text: block.thinking, estimate: estimateText(block.thinking) });
			} else if (block.type === "toolCall") {
				const text = `${block.name} ${JSON.stringify(block.arguments ?? {})}`;
				blocks.push({
					kind: "tool-call", label: `tool call · ${block.name}`, text, estimate: estimateText(text),
					toolCall: { name: block.name, arguments: JSON.stringify(block.arguments ?? {}, null, 2) },
				});
			}
		}
		if (blocks.length === 0) {
			if (messageTokens > 0) {
				add("assistant", "assistant message", contentText(message.content), {
					tokens: messageTokens,
				});
			}
			continue;
		}
		const shares = distribute(blocks.map((block) => block.estimate), messageTokens);
		for (let index = 0; index < blocks.length; index++) {
			const block = blocks[index];
			if (block === undefined) continue;
			add(block.kind, block.label, block.text, { tokens: shares[index] ?? block.estimate, toolCall: block.toolCall });
		}
	}
}

export function contextMessageTokens(messages: CapturedMessages): number {
	let total = 0;
	for (const message of convertToLlm(messages)) {
		total += estimateTokens(message);
	}
	return total;
}

export interface ObservedUsage {
	readonly observedTokens: number | null;
	readonly usageSource: UsageSource;
	readonly observedStale: boolean;
}

export function readObservedUsage(
	messages: CapturedMessages,
	reading: { readonly tokens: number | null; readonly model: string; readonly startupChanged: boolean },
): ObservedUsage {
	const estimated: ObservedUsage = { observedTokens: null, usageSource: "estimated", observedStale: false };
	if (reading.tokens === null || !Number.isFinite(reading.tokens) || reading.tokens <= 0) return estimated;
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message?.role !== "assistant" || message.stopReason === "aborted" || message.stopReason === "error") continue;
		const tokens = calculateContextTokens(message.usage);
		if (!Number.isFinite(tokens) || tokens <= 0) continue;
		if (reading.startupChanged || `${message.provider}/${message.model}` !== reading.model) {
			return { ...estimated, observedStale: true };
		}
		const trailingTokens = contextMessageTokens(messages.slice(index + 1));
		return {
			observedTokens: tokens + trailingTokens,
			usageSource: trailingTokens > 0 ? "mixed" : "reported",
			observedStale: false,
		};
	}
	return estimated;
}

export function buildSnapshot(inputs: SnapshotInputs): ContextSnapshot {
	const chunks: ContextChunk[] = [];
	let nextId = 0;
	const add: AddChunk = (kind, label, text, options = {}) => {
		const tokens = options.tokens ?? estimateText(text);
		if (tokens <= 0 && !options.unlocated) return;
		chunks.push({
			id: nextId,
			order: nextId++,
			kind,
			label,
			text,
			tokens,
			unlocated: options.unlocated,
			group: options.group,
			toolName: options.toolName,
			toolDefinition: options.toolDefinition,
			toolCall: options.toolCall,
		});
	};

	addSystemChunks(inputs.systemPrompt, inputs.systemPromptOptions, inputs.baselineSystemPrompt, add);
	for (const tool of inputs.tools) {
		add("schema", `tool definition · ${tool.name}`, toolSchemaText(tool), {
			group: toolProvider(tool.name, tool.source, tool.path, tool.builtinOverride),
			toolName: tool.name,
			toolDefinition: {
				description: tool.description,
				parameters: JSON.stringify(tool.parameters ?? {}, null, 2),
				source: tool.source,
				path: tool.path,
				builtinOverride: tool.builtinOverride,
			},
		});
	}

	addMessageChunks(inputs.messages, add);

	return {
		chunks,
		estimatedTokens: chunks.reduce((sum, chunk) => sum + chunk.tokens, 0),
		observedTokens: inputs.observedTokens !== null && Number.isFinite(inputs.observedTokens) && inputs.observedTokens > 0 ? inputs.observedTokens : null,
		usageSource: inputs.usageSource,
		observedStale: inputs.observedStale,
		contextWindow: inputs.contextWindow,
		model: inputs.model,
		turns: inputs.turns,
		compactionEnabled: inputs.compactionEnabled,
		reserveTokens: Math.max(0, Math.min(inputs.contextWindow, inputs.reserveTokens)),
		source: inputs.source,
		capturedAt: inputs.capturedAt,
		resources: inputs.resources,
		sessionTotals: inputs.sessionTotals,
	};
}

export function aggregateByKind(chunks: ContextChunk[]): Array<{ kind: ChunkKind; tokens: number }> {
	const totals = new Map<ChunkKind, number>();
	for (const chunk of chunks) totals.set(chunk.kind, (totals.get(chunk.kind) ?? 0) + chunk.tokens);
	return Array.from(totals, ([kind, tokens]) => ({ kind, tokens })).sort((a, b) => b.tokens - a.tokens);
}

export function producerLabel(label: string): string {
	return label.replace(/^tool output · /, "").replace(/ · error$/, "");
}

export function aggregateToolOutputs(chunks: ContextChunk[]): Array<{ label: string; tokens: number }> {
	const totals = new Map<string, number>();
	for (const chunk of chunks) {
		if (chunk.kind !== "tool-result") continue;
		const label = producerLabel(chunk.label);
		totals.set(label, (totals.get(label) ?? 0) + chunk.tokens);
	}
	return Array.from(totals, ([label, tokens]) => ({ label, tokens })).sort((a, b) => b.tokens - a.tokens);
}

function sumTokens(chunks: ContextChunk[]): number {
	return chunks.reduce((sum, chunk) => sum + chunk.tokens, 0);
}

export function startupChunks(snapshot: ContextSnapshot): ContextChunk[] {
	return snapshot.chunks.filter((chunk) => isStartupKind(chunk.kind));
}

export function sessionChunks(snapshot: ContextSnapshot): ContextChunk[] {
	return snapshot.chunks.filter((chunk) => !isStartupKind(chunk.kind));
}

export interface ContextMix {
	used: number;
	normalization: number;
	startup: number;
	session: number;
	gap: number;
	free: number;
	compactAt: number;
	observedStale: boolean;
}

export function contextMix(snapshot: ContextSnapshot): ContextMix {
	const observedStale = snapshot.observedStale ?? false;
	const used = observedStale || snapshot.observedTokens === null
		? snapshot.estimatedTokens
		: snapshot.observedTokens;
	const startupRaw = sumTokens(startupChunks(snapshot));
	const sessionRaw = Math.max(0, snapshot.estimatedTokens - startupRaw);
	const normalization = snapshot.estimatedTokens > used && snapshot.estimatedTokens > 0 ? used / snapshot.estimatedTokens : 1;
	const startup = startupRaw * normalization;
	const session = sessionRaw * normalization;
	const rawGap = Math.max(0, used - startup - session);
	const gap = rawGap < 0.5 ? 0 : rawGap;
	const compactAt = snapshot.compactionEnabled
		? Math.max(0, snapshot.contextWindow - snapshot.reserveTokens)
		: snapshot.contextWindow;
	return {
		used,
		normalization,
		startup,
		session,
		gap,
		free: Math.max(0, snapshot.contextWindow - used),
		compactAt,
		observedStale,
	};
}
