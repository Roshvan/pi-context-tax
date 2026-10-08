import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

import { valueLine } from "./panel.ts";
import { formatCount, type SessionSummary, type SummaryScope } from "./session-summary.ts";
import { terminalText } from "./terminal-text.ts";

type CallRow = SessionSummary["tools"][number];

function renderSummary(summary: SessionSummary, width: number, theme: Theme): string[] {
	const lines: string[] = [];
	const text = (value: string, token: ThemeColor = "text"): string => theme.fg(token, terminalText(value).replace(/\s+/g, " "));
	const add = (value: string): void => { lines.push(...wrapTextWithAnsi(value, width)); };
	const pair = (label: string, value: string): void => {
		const gap = width - visibleWidth(label) - visibleWidth(value);
		if (gap >= 2) lines.push(label + " ".repeat(gap) + value);
		else { add(label); add(value); }
	};
	const metric = (label: string, value: string, token: ThemeColor = "text"): void => pair(text(label, "muted"), text(value, token));
	const heading = (label: string, value = ""): void => {
		lines.push("");
		pair(theme.bold(text(label, "accent")), text(value, "muted"));
	};
	const status = (value: number, label: string, token: "error" | "warning"): string => text(`${formatCount(value)} ${label}`, value > 0 ? token : "dim");
	const pad = (value: string, cells: number, alignment: "left" | "right"): string => {
		const clipped = truncateToWidth(value, cells, "…");
		const spaces = " ".repeat(Math.max(0, cells - visibleWidth(clipped)));
		return alignment === "left" ? clipped + spaces : spaces + clipped;
	};
	const table = (rows: readonly CallRow[], label: string): void => {
		if (rows.length === 0) { add(text("No recorded calls yet.", "muted")); return; }
		const showOpen = rows.some((row) => row.unfinished > 0);
		const callsWidth = Math.max(5, ...rows.map((row) => formatCount(row.calls).length));
		const failedWidth = Math.max(6, ...rows.map((row) => formatCount(row.failed).length));
		const openWidth = showOpen ? Math.max(4, ...rows.map((row) => formatCount(row.unfinished).length)) : 0;
		const nameWidth = width - callsWidth - failedWidth - 4 - (showOpen ? openWidth + 2 : 0);
		if (nameWidth < 8) {
			for (const row of rows) {
				pair(text(row.name), text(`${formatCount(row.calls)} calls`, "accent"));
				add(`${status(row.failed, "failed", "error")} · ${status(row.unfinished, "open", "warning")}`);
			}
			return;
		}
		const rowLine = (name: string, calls: string, failed: string, open: string): string => [
			pad(name, nameWidth, "left"), pad(calls, callsWidth, "right"), pad(failed, failedWidth, "right"),
			...(showOpen ? [pad(open, openWidth, "right")] : []),
		].join("  ");
		lines.push(rowLine(text(label, "muted"), text("Calls", "muted"), text("Failed", "muted"), text("Open", "muted")));
		for (const row of rows) lines.push(rowLine(
			text(row.name), text(formatCount(row.calls), "accent"),
			text(formatCount(row.failed), row.failed > 0 ? "error" : "dim"),
			text(formatCount(row.unfinished), row.unfinished > 0 ? "warning" : "dim"),
		));
	};

	const { usage, responses, toolCalls, mcpCalls } = summary;
	const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
	metric("Total tokens", formatCount(usage.total), "accent");
	metric("Recorded model cost", `$${usage.cost.toFixed(4)}`, "accent");
	metric("Prompt", formatCount(prompt));
	metric("Output", formatCount(usage.output));
	metric("Cache hit", prompt > 0 ? `${(usage.cacheRead / prompt * 100).toFixed(1)}%` : "—", usage.cacheRead > 0 ? "success" : "dim");

	heading("Activity");
	metric("Model responses", formatCount(responses.total));
	if (responses.failed > 0 || responses.aborted > 0) pair(text("Response status", "muted"), `${status(responses.failed, "failed", "error")} · ${status(responses.aborted, "aborted", "warning")}`);
	metric("User messages", formatCount(summary.userMessages));
	pair(text("Tool calls", "muted"), `${text(formatCount(toolCalls.calls))} · ${status(toolCalls.failed, "failed", "error")} · ${status(toolCalls.unfinished, "open", "warning")}`);
	metric("MCP calls", `${formatCount(mcpCalls.calls)} · ${formatCount(summary.mcpServers.length)} servers`);
	if (summary.compactions > 0) metric("Compactions", formatCount(summary.compactions));
	if (summary.branchSummaries > 0) metric("Branch summaries", formatCount(summary.branchSummaries));
	if (summary.incompleteNestedRecords > 0) {
		add(text(`Warning: ${formatCount(summary.incompleteNestedRecords)} incomplete nested-call record${summary.incompleteNestedRecords === 1 ? "" : "s"}. Nested / MCP counts may be lower bounds.`, "warning"));
	}

	heading("Tools", `${formatCount(toolCalls.calls)} calls`);
	add(text(`${formatCount(toolCalls.direct)} direct · ${formatCount(toolCalls.nested)} nested`, "muted"));
	table(summary.tools, "Tool");
	heading("MCP", `${formatCount(mcpCalls.calls)} calls`);
	table(summary.mcpServers, "Server");

	heading("Token breakdown");
	metric("Uncached input", formatCount(usage.input));
	metric("Cache read", formatCount(usage.cacheRead));
	metric("Cache write", formatCount(usage.cacheWrite));
	if (usage.reasoning > 0) metric("Reasoning (in output)", formatCount(usage.reasoning));
	for (const source of summary.usageSources) {
		if (source.name !== "assistant") metric(`${source.name} (${formatCount(source.records)})`, `${formatCount(source.tokens)} tok · $${source.cost.toFixed(4)}`);
	}
	lines.push("");
	add(text("Recorded history only. Unrecorded calls and API retries are excluded.", "muted"));
	return lines;
}

export function createSessionView(summary: SessionSummary, scope: SummaryScope, theme: Theme): SessionView {
	return new SessionView(summary, scope, theme);
}

class SessionView {
	private offset = 0;
	private width = 0;
	private lines: string[] = [];

	constructor(private readonly summary: SessionSummary, private readonly scope: SummaryScope, private readonly theme: Theme) {}

	invalidate(): void { this.width = 0; }

	move(delta: number, edge?: "start" | "end"): void {
		this.offset = edge === "start" ? 0 : edge === "end" ? Number.MAX_SAFE_INTEGER : Math.max(0, this.offset + delta);
	}

	render(width: number, height: number, help: string): string[] {
		if (this.width !== width) { this.lines = renderSummary(this.summary, width, this.theme); this.width = width; }
		const scope = this.scope === "session" ? "all branches" : "current branch";
		const title = valueLine(this.theme.bold("Session activity"), this.theme.fg("muted", scope), width);
		const header = height >= 7 ? [title, this.theme.fg("muted", truncateToWidth("Cumulative usage · not current context size", width, "")), ""] : height >= 3 ? [title] : [];
		const budget = Math.max(0, height - header.length - 1);
		this.offset = Math.max(0, Math.min(this.offset, Math.max(0, this.lines.length - budget)));
		const output = [...header, ...this.lines.slice(this.offset, this.offset + budget)];
		while (output.length < height - 1) output.push("");
		const position = this.lines.length > budget && budget > 0 ? `${this.offset + 1}–${Math.min(this.lines.length, this.offset + budget)} / ${this.lines.length}` : "";
		output.push(width >= 40 ? valueLine(help, this.theme.fg("muted", position), width) : help);
		return output;
	}
}
