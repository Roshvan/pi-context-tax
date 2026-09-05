import { readLedger } from "./ledger.ts";
import { terminalText } from "./terminal-text.ts";
import { formatTokens } from "./tokens.ts";
import type { ContextSnapshot } from "./types.ts";

export function renderPlainReport(snapshot: ContextSnapshot): string {
	const ledger = readLedger(snapshot);
	const mix = ledger.mix;
	const estimated = snapshot.usageSource === "estimated" || snapshot.observedTokens === null || mix.observedStale;
	const mixed = !estimated && snapshot.usageSource === "mixed";
	const lines = [
		`Current context: ${estimated || mixed ? "~" : ""}${formatTokens(mix.used)} / ${formatTokens(snapshot.contextWindow)} (${(mix.used / Math.max(1, snapshot.contextWindow) * 100).toFixed(1)}% full)`,
		`Available: ${formatTokens(mix.free)}`,
		`Startup tax: ~${formatTokens(mix.startup)} (${(mix.startup / Math.max(1, snapshot.contextWindow) * 100).toFixed(1)}% of window)`,
	];
	for (const row of ledger.rows) {
		lines.push(`${row.group === "startup" ? "  " : ""}${row.label}: ~${formatTokens(row.tokens)}`);
	}
	lines.push(estimated ? "Total and source counts are estimated." : mixed ? "Total combines Pi-reported usage with newer message estimates; source counts are estimated." : "Total reported by Pi; source counts are estimated.");
	return terminalText(lines.join("\n"));
}

export function renderSessionDetails(snapshot: ContextSnapshot): string[] {
	const resources = snapshot.resources;
	return [
		`Model: ${snapshot.model}`,
		`Turn: ${snapshot.turns}`,
		`Context source: ${snapshot.source}`,
		`Total: ${snapshot.observedTokens === null || snapshot.usageSource === "estimated" || snapshot.observedStale === true ? "estimated" : snapshot.usageSource === "mixed" ? "Pi usage + newer estimates" : "Pi-reported usage"}`,
		"Source counts: estimated; reconciled to the total",
		...(snapshot.capturedAt === undefined ? [] : [`Captured: ${snapshot.capturedAt.toLocaleTimeString()}`]),
		"",
		`Active tools: ${resources.activeTools}`,
		`Skills: ${resources.availableSkillCount} available · ${resources.loadedSkills.length} used`,
		...resources.loadedSkills.map((skill) => `  ${skill}`),
		`Context files: ${resources.contextFiles.length}`,
		...resources.contextFiles.map((file) => `  ${file}`),
		`Command sources: ${resources.commandExtensions.length}`,
		...resources.commandExtensions.map((source) => `  ${source}`),
		"",
		`Session traffic: ${formatTokens(snapshot.sessionTotals.tokens)} tokens`,
		`Session cost: $${snapshot.sessionTotals.cost.toFixed(4)}`,
		"Cumulative session usage includes earlier requests and cached tokens.",
	];
}
