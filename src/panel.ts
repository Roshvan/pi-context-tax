import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import type { LedgerRow } from "./ledger.ts";
import type { ContextMix } from "./snapshot.ts";
import { terminalText } from "./terminal-text.ts";
import { formatTokens } from "./tokens.ts";
import type { ContextSnapshot } from "./types.ts";

export function windowShare(tokens: number, window: number): string {
	const share = window > 0 ? tokens / window * 100 : 0;
	if (share === 0) return "0%";
	if (share < 0.1) return "<0.1%";
	return `${share.toFixed(share < 10 ? 1 : 0)}%`;
}

export function valueLine(label: string, value: string, width: number): string {
	const room = Math.max(0, width);
	if (visibleWidth(value) >= room) return truncateToWidth(value, room, "");
	const left = truncateToWidth(label, Math.max(0, room - visibleWidth(value) - 1), "…");
	return left + " ".repeat(Math.max(1, room - visibleWidth(left) - visibleWidth(value))) + value;
}

export function renderOverview(snapshot: ContextSnapshot, mix: ContextMix, width: number, theme: Theme): string[] {
	const estimated = snapshot.usageSource === "estimated" || snapshot.observedTokens === null || mix.observedStale;
	const mixed = !estimated && snapshot.usageSource === "mixed";
	const total = `${estimated || mixed ? "~" : ""}${formatTokens(mix.used)} / ${formatTokens(snapshot.contextWindow)}`;
	const heading = width < 40 ? "Context" : "Current context";
	const cells = Math.max(1, width);
	const denominator = Math.max(1, snapshot.contextWindow, mix.used);
	const startupCells = Math.round(mix.startup / denominator * cells);
	const usedCells = Math.round(mix.used / denominator * cells);
	const bar = theme.fg("accent", "━".repeat(startupCells))
		+ theme.fg("text", "━".repeat(Math.max(0, usedCells - startupCells)))
		+ theme.fg("borderMuted", "─".repeat(Math.max(0, cells - usedCells)));
	const availability = mix.used > snapshot.contextWindow
		? `${formatTokens(mix.used - snapshot.contextWindow)} over capacity`
		: `${formatTokens(mix.free)} available`;
	const status = `${windowShare(mix.used, snapshot.contextWindow)} full · ${availability}`;
	return [
		valueLine(theme.bold(heading), theme.bold(total), width),
		bar,
		theme.fg("muted", truncateToWidth(status, width, "")),
		theme.fg("muted", estimated ? "Estimated context · ~ estimated sources" : mixed ? "Pi usage + newer estimates · ~ estimated sources" : "Pi-reported total · ~ estimated sources"),
	];
}

export function renderLedgerRow(
	row: LedgerRow,
	depth: number,
	state: "leaf" | "closed" | "open",
	selected: boolean,
	width: number,
	theme: Theme,
): string {
	const inset = " ".repeat(Math.min(depth * 2, Math.max(0, Math.floor(width / 4))));
	const marker = state === "open" ? "▾" : state === "closed" ? "▸" : " ";
	const cursor = selected ? theme.fg("accent", "›") : " ";
	const name = terminalText(row.label).replace(/\s+/g, " ");
	const title = selected ? theme.fg("accent", theme.bold(name)) : theme.fg(row.group === "other" ? "muted" : "text", name);
	const label = `${inset}${cursor} ${marker} ${title}`;
	const value = row.note === "not located" ? "—" : `~${formatTokens(row.tokens)}`;
	return valueLine(label, theme.fg(row.group === "other" ? "muted" : "text", value), width);
}
