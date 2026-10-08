import type { Usage } from "@earendil-works/pi-ai";
import type { SessionEntry, ToolInfo } from "@earendil-works/pi-coding-agent";

import { terminalText } from "./terminal-text.ts";

export type SummaryScope = "session" | "branch";

type UsageTotals = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	reasoning: number;
	total: number;
	cost: number;
};

type CallCounts = {
	calls: number;
	direct: number;
	nested: number;
	failed: number;
	unfinished: number;
};

type NamedCallCounts = CallCounts & { readonly name: string };
type UsageSource = { readonly name: string; records: number; tokens: number; cost: number };

export type SessionSummary = {
	readonly userMessages: number;
	readonly responses: { readonly total: number; readonly failed: number; readonly aborted: number };
	readonly compactions: number;
	readonly branchSummaries: number;
	readonly usage: Readonly<UsageTotals>;
	readonly usageSources: readonly Readonly<UsageSource>[];
	readonly toolCalls: Readonly<CallCounts>;
	readonly tools: readonly Readonly<NamedCallCounts>[];
	readonly mcpCalls: Readonly<CallCounts>;
	readonly mcpServers: readonly Readonly<NamedCallCounts>[];
	readonly incompleteNestedRecords: number;
};

function emptyCallCounts(): CallCounts {
	return { calls: 0, direct: 0, nested: 0, failed: 0, unfinished: 0 };
}

function addCallCounts(total: CallCounts, counts: Readonly<CallCounts>): void {
	total.calls += counts.calls;
	total.direct += counts.direct;
	total.nested += counts.nested;
	total.failed += counts.failed;
	total.unfinished += counts.unfinished;
}

function byCalls(left: Readonly<NamedCallCounts>, right: Readonly<NamedCallCounts>): number {
	return right.calls - left.calls || left.name.localeCompare(right.name);
}

export function summarizeUsage(entries: readonly SessionEntry[]): Pick<SessionSummary, "usage" | "usageSources"> {
	const usage: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0, cost: 0 };
	const sources = new Map<string, UsageSource>();
	const addUsage = (value: Usage, name: string): void => {
		const tokens = value.input + value.output + value.cacheRead + value.cacheWrite;
		usage.input += value.input;
		usage.output += value.output;
		usage.cacheRead += value.cacheRead;
		usage.cacheWrite += value.cacheWrite;
		usage.reasoning += value.reasoning ?? 0;
		usage.total += tokens;
		usage.cost += value.cost.total;
		const source = sources.get(name) ?? { name, records: 0, tokens: 0, cost: 0 };
		source.records++;
		source.tokens += tokens;
		source.cost += value.cost.total;
		sources.set(name, source);
	};
	for (const entry of entries) {
		if (entry.type === "usage") addUsage(entry.usage, `usage:${entry.kind}`);
		else if (entry.type === "compaction" || entry.type === "branch_summary") {
			if (entry.usage) addUsage(entry.usage, entry.type);
		} else if (entry.type === "message") {
			const message = entry.message;
			if (message.role === "assistant") addUsage(message.usage, "assistant");
			else if (message.role === "toolResult" && message.usage) addUsage(message.usage, "tool");
		}
	}
	return { usage, usageSources: [...sources.values()].sort((left, right) => right.tokens - left.tokens || left.name.localeCompare(right.name)) };
}

function entryAncestry(entries: readonly SessionEntry[]): Map<string, { start: number; end: number }> {
	const ids = new Set(entries.map((entry) => entry.id));
	const children = new Map<string, string[]>();
	const roots: string[] = [];
	for (const entry of entries) {
		if (entry.parentId === null || !ids.has(entry.parentId)) roots.push(entry.id);
		else {
			const siblings = children.get(entry.parentId) ?? [];
			siblings.push(entry.id);
			children.set(entry.parentId, siblings);
		}
	}
	const ranges = new Map<string, { start: number; end: number }>();
	const stack: Array<{ id: string; phase: "enter" | "leave" }> = roots.reverse().map((id) => ({ id, phase: "enter" }));
	let position = 0;
	while (stack.length > 0) {
		const next = stack.pop();
		if (next === undefined) break;
		if (next.phase === "leave") {
			const range = ranges.get(next.id);
			if (range !== undefined) range.end = position;
		} else if (!ranges.has(next.id)) {
			ranges.set(next.id, { start: position++, end: position });
			stack.push({ id: next.id, phase: "leave" });
			for (const child of [...(children.get(next.id) ?? [])].reverse()) stack.push({ id: child, phase: "enter" });
		}
	}
	return ranges;
}

export function summarizeSession(
	entries: readonly SessionEntry[],
	toolInfo: readonly Pick<ToolInfo, "name" | "namespace">[] = [],
): SessionSummary {
	const { usage, usageSources } = summarizeUsage(entries);
	const tools = new Map<string, NamedCallCounts>();
	const attempts = new Map<string, Array<{ entryId: string; counts: NamedCallCounts; settled: boolean }>>();
	const ancestry = entryAncestry(entries);
	const serversByTool = new Map<string, string>();
	let userMessages = 0;
	const responses = { total: 0, failed: 0, aborted: 0 };
	let compactions = 0;
	let branchSummaries = 0;
	let incompleteNestedRecords = 0;

	for (const tool of toolInfo) {
		if (tool.namespace?.name.startsWith("mcp__")) serversByTool.set(tool.name, tool.namespace.name.slice(5));
	}

	const addCall = (name: string, origin: "direct" | "nested", status: "ok" | "error" | "unfinished"): NamedCallCounts => {
		const counts = tools.get(name) ?? { name, ...emptyCallCounts() };
		counts.calls++;
		counts[origin]++;
		if (status === "error") counts.failed++;
		if (status === "unfinished") counts.unfinished++;
		tools.set(name, counts);
		return counts;
	};

	for (const entry of entries) {
		if (entry.type === "compaction" || entry.type === "branch_summary") {
			if (entry.type === "compaction") compactions++;
			else branchSummaries++;
		} else if (entry.type === "message") {
			const message = entry.message;
			if (message.role === "user") userMessages++;
			else if (message.role === "assistant") {
				responses.total++;
				if (message.stopReason === "error") responses.failed++;
				if (message.stopReason === "aborted") responses.aborted++;
				for (const block of message.content) {
					if (block.type !== "toolCall") continue;
					const candidates = attempts.get(block.id) ?? [];
					candidates.push({ entryId: entry.id, counts: addCall(block.name, "direct", "unfinished"), settled: false });
					attempts.set(block.id, candidates);
				}
			} else if (message.role === "toolResult") {
				const resultRange = ancestry.get(entry.id);
				const candidates = attempts.get(message.toolCallId) ?? [];
				let attempt: { counts: NamedCallCounts; settled: boolean } | undefined;
				for (let index = candidates.length - 1; index >= 0; index--) {
					const candidate = candidates[index];
					if (candidate === undefined || resultRange === undefined) continue;
					const owner = ancestry.get(candidate.entryId);
					if (owner !== undefined && owner.start <= resultRange.start && resultRange.start < owner.end) {
						attempt = candidate;
						break;
					}
				}
				if (attempt !== undefined) {
					if (!attempt.settled) {
						attempt.counts.unfinished--;
						if (message.isError) attempt.counts.failed++;
						attempt.settled = true;
					}
				} else addCall(message.toolName, "direct", message.isError ? "error" : "ok");
				if (message.nestedCalls) {
					if (!message.nestedCalls.complete) incompleteNestedRecords++;
					for (const call of message.nestedCalls.calls) addCall(call.name, "nested", call.status);
				}
			}
		}
	}

	const toolCalls = emptyCallCounts();
	const mcpCalls = emptyCallCounts();
	const mcpServers = new Map<string, NamedCallCounts>();
	for (const counts of tools.values()) {
		addCallCounts(toolCalls, counts);
		const server = serversByTool.get(counts.name) ?? /^mcp__(.+?)__/.exec(counts.name)?.[1];
		if (server) {
			addCallCounts(mcpCalls, counts);
			const serverCounts = mcpServers.get(server) ?? { name: server, ...emptyCallCounts() };
			addCallCounts(serverCounts, counts);
			mcpServers.set(server, serverCounts);
		}
	}

	return {
		userMessages, responses, compactions, branchSummaries, usage, usageSources,
		toolCalls, tools: [...tools.values()].sort(byCalls), mcpCalls,
		mcpServers: [...mcpServers.values()].sort(byCalls), incompleteNestedRecords,
	};
}

const numberFormat = new Intl.NumberFormat("en-US");

export function formatCount(value: number): string {
	return numberFormat.format(value);
}

function callLine(value: Readonly<CallCounts>): string {
	return `${formatCount(value.calls)} calls · ${formatCount(value.failed)} failed · ${formatCount(value.unfinished)} unfinished`;
}

export function formatSessionSummary(summary: SessionSummary, scope: SummaryScope): string {
	const { usage, responses, toolCalls, mcpCalls } = summary;
	const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
	const hitRate = prompt > 0 ? `${((usage.cacheRead / prompt) * 100).toFixed(1)}%` : "—";
	const lines = [
		`Session activity · ${scope === "session" ? "all branches" : "current branch"}`,
		"Cumulative recorded usage, not current context size.",
		`Model responses: ${formatCount(responses.total)} · ${formatCount(responses.failed)} failed · ${formatCount(responses.aborted)} aborted`,
		`User messages: ${formatCount(summary.userMessages)} · Compactions: ${formatCount(summary.compactions)} · Branch summaries: ${formatCount(summary.branchSummaries)}`,
		"",
		`Tokens: ${formatCount(usage.total)} total · ${formatCount(prompt)} prompt · ${formatCount(usage.output)} output`,
		`  Uncached input: ${formatCount(usage.input)} · Cache read: ${formatCount(usage.cacheRead)} · Cache write: ${formatCount(usage.cacheWrite)}`,
		`  Cache hit rate: ${hitRate} · Recorded model cost: $${usage.cost.toFixed(4)}`,
	];
	if (usage.reasoning > 0) lines.push(`  Reasoning: ${formatCount(usage.reasoning)} (included in output)`);
	for (const source of summary.usageSources) {
		if (source.name !== "assistant") lines.push(`  ${source.name}: ${formatCount(source.records)} usage records · ${formatCount(source.tokens)} tokens · $${source.cost.toFixed(4)}`);
	}
	lines.push("", `Tools: ${callLine(toolCalls)} (${formatCount(toolCalls.direct)} direct + ${formatCount(toolCalls.nested)} nested)`);
	for (const tool of summary.tools) lines.push(`  ${tool.name}: ${callLine(tool)}`);
	lines.push("", `MCP: ${callLine(mcpCalls)} · ${formatCount(summary.mcpServers.length)} servers called`);
	for (const server of summary.mcpServers) lines.push(`  ${server.name}: ${callLine(server)}`);
	if (summary.incompleteNestedRecords > 0) lines.push("", `Warning: ${formatCount(summary.incompleteNestedRecords)} incomplete nested-call records; nested/MCP counts may be lower bounds.`);
	lines.push("", "Recorded history only; in-flight/unrecorded nested calls and unrecorded API retries are excluded.");
	return terminalText(lines.join("\n"));
}
