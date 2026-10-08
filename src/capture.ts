import type { BuildSystemPromptOptions, ContextWithSystemEvent } from "@earendil-works/pi-coding-agent";
import type { ToolSummary } from "./tool-loadout.ts";
import type { SnapshotSource } from "./types.ts";

export type CapturedMessages = ContextWithSystemEvent["messages"];

interface Capture {
	systemPrompt: string;
	baselinePrompt: string | undefined;
	systemPromptOptions: BuildSystemPromptOptions | undefined;
	messages: CapturedMessages;
	sessionMessages: CapturedMessages;
	startupKey: string;
	tools: ToolSummary[];
	capturedAt: Date;
}

export interface ResolvedMessages {
	readonly messages: CapturedMessages;
	readonly source: SnapshotSource;
	readonly capturedAt?: Date;
}

export class CaptureState {
	private latest: Capture | undefined;
	private pendingOptions: BuildSystemPromptOptions | undefined;
	private pendingBaseline: string | undefined;

	noteAgentStart(options: BuildSystemPromptOptions | undefined, systemPrompt?: string): void {
		this.pendingOptions = options;
		this.pendingBaseline = systemPrompt;
	}

	noteContext(
		messages: CapturedMessages,
		systemPrompt: string,
		sessionMessages: CapturedMessages,
		startupKey: string,
		tools: ToolSummary[],
	): void {
		this.latest = {
			systemPrompt,
			baselinePrompt: this.pendingBaseline,
			systemPromptOptions: this.pendingOptions === undefined ? undefined : structuredClone(this.pendingOptions),
			messages: structuredClone(messages),
			sessionMessages: structuredClone(sessionMessages),
			startupKey,
			tools: structuredClone(tools),
			capturedAt: new Date(),
		};
	}

	resolveMessages(currentMessages: CapturedMessages): ResolvedMessages {
		const captured = this.latest;
		if (captured === undefined
			|| captured.sessionMessages.length > currentMessages.length
			|| JSON.stringify(captured.sessionMessages) !== JSON.stringify(currentMessages.slice(0, captured.sessionMessages.length))) {
			return { messages: currentMessages, source: "reconstructed" };
		}
		const trailing = currentMessages.slice(captured.sessionMessages.length);
		return {
			messages: [...captured.messages, ...trailing],
			source: trailing.length === 0 ? "captured" : "mixed",
			capturedAt: captured.capturedAt,
		};
	}

	invalidate(): void {
		this.latest = undefined;
		this.pendingOptions = undefined;
		this.pendingBaseline = undefined;
	}

	get systemPromptOptions(): BuildSystemPromptOptions | undefined {
		return this.pendingOptions;
	}

	get current(): Capture | undefined {
		return this.latest;
	}
}
