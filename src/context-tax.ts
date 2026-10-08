import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, KeybindingsManager, TUI_KEYBINDINGS, matchesKey, truncateToWidth, visibleWidth, type Component, type Keybinding } from "@earendil-works/pi-tui";

import { readLedger, rowChildren, type Ledger, type LedgerRow } from "./ledger.ts";
import { renderLedgerRow, renderOverview, valueLine, windowShare } from "./panel.ts";
import { sessionDocument, sourceDocument } from "./source-document.ts";
import { createSourceReader } from "./source-reader.ts";
import { createSessionView } from "./session-view.ts";
import type { SessionSummary, SummaryScope } from "./session-summary.ts";
import { formatTokens } from "./tokens.ts";
import type { ContextSnapshot } from "./types.ts";

interface ContextTaxCallbacks {
	onClose: () => void;
	onRefresh: () => ContextSnapshot;
	onSummary: (scope: SummaryScope) => SessionSummary;
	onChange: () => void;
}

interface ContextTaxInitial {
	readonly tab: "context" | "session";
	readonly scope: SummaryScope;
}

interface VisibleRow {
	row: LedgerRow;
	depth: number;
	parent: string | undefined;
}

type SourceView = { kind: "source"; reader: ReturnType<typeof createSourceReader> };
type PrimaryView = { kind: "context" } | SourceView;
type View = PrimaryView | { kind: "details"; reader: ReturnType<typeof createSourceReader>; back: PrimaryView };

export function createContextTax(
	snapshot: ContextSnapshot,
	theme: Theme,
	terminalRows: () => number,
	callbacks: ContextTaxCallbacks,
	initial: ContextTaxInitial = { tab: "context", scope: "session" },
	keybindings: KeybindingsManager = new KeybindingsManager(TUI_KEYBINDINGS),
): ContextTax {
	return new ContextTax(snapshot, theme, terminalRows, callbacks, initial, keybindings);
}

class ContextTax implements Component {
	private selected = 0;
	private offset = 0;
	private expanded = new Set<string>();
	private cached: Ledger | undefined;
	private children = new Map<string, LedgerRow[]>();
	private view: View = { kind: "context" };
	private tab: "context" | "session";
	private scope: SummaryScope;
	private session: ReturnType<typeof createSessionView> | undefined;

	constructor(
		private snapshot: ContextSnapshot,
		private readonly theme: Theme,
		private readonly terminalRows: () => number,
		private readonly callbacks: ContextTaxCallbacks,
		initial: ContextTaxInitial,
		private readonly keybindings: KeybindingsManager,
	) { this.tab = initial.tab; this.scope = initial.scope; }

	invalidate(): void {
		this.session?.invalidate();
		if (this.view.kind !== "context") this.view.reader.invalidate();
		if (this.view.kind === "details" && this.view.back.kind === "source") this.view.back.reader.invalidate();
	}

	private sessionView(): ReturnType<typeof createSessionView> {
		if (this.session === undefined) this.session = createSessionView(this.callbacks.onSummary(this.scope), this.scope, this.theme);
		return this.session;
	}

	private ledger(): Ledger {
		if (this.cached !== undefined) return this.cached;
		this.cached = readLedger(this.snapshot);
		return this.cached;
	}

	private descendants(key: string): LedgerRow[] {
		const existing = this.children.get(key);
		if (existing !== undefined) return existing;
		const children = rowChildren(this.ledger(), key);
		this.children.set(key, children);
		return children;
	}

	private visibleRows(): VisibleRow[] {
		const rows: VisibleRow[] = [];
		const append = (sources: LedgerRow[], depth: number, parent: string | undefined): void => {
			for (const row of sources) {
				rows.push({ row, depth, parent });
				if (this.expanded.has(row.key)) append(this.descendants(row.key), depth + 1, row.key);
			}
		};
		append(this.ledger().rows, 0, undefined);
		return rows;
	}

	private refresh(): void {
		if (this.tab === "session") {
			this.session = undefined;
			return;
		}
		const selected = this.visibleRows()[this.selected];
		this.snapshot = this.callbacks.onRefresh();
		this.session = undefined;
		this.cached = undefined;
		this.children.clear();
		const key = selected?.row.key.startsWith("chunk:") ? selected.parent : selected?.row.key;
		const rows = this.visibleRows();
		const index = rows.findIndex((entry) => entry.row.key === key);
		this.selected = index < 0 ? 0 : index;
		const valid = new Set(rows.map((entry) => entry.row.key));
		for (const expanded of this.expanded) if (!valid.has(expanded)) this.expanded.delete(expanded);
		this.offset = 0;
		this.view = this.view.kind === "details"
			? { kind: "details", reader: createSourceReader(sessionDocument(this.snapshot), this.theme), back: { kind: "context" } }
			: { kind: "context" };
	}

	private open(): void {
		const current = this.visibleRows()[this.selected];
		if (current === undefined) return;
		const key = current.row.key;
		if (this.descendants(key).length > 0) {
			if (this.expanded.has(key)) this.expanded.delete(key);
			else this.expanded.add(key);
		} else {
			const rows = this.visibleRows();
			const ancestors: string[] = [];
			let parent = current.parent;
			while (parent !== undefined) {
				const ancestor = rows.find((entry) => entry.row.key === parent);
				if (ancestor === undefined) break;
				ancestors.unshift(ancestor.row.label);
				parent = ancestor.parent;
			}
			if (current.row.group === "startup") ancestors.unshift("Startup tax");
			const document = sourceDocument(this.ledger(), current.row, ancestors.join(" › ") || "Current context");
			if (document !== undefined) this.view = { kind: "source", reader: createSourceReader(document, this.theme) };
		}
	}

	private back(): boolean {
		if (this.view.kind !== "context") {
			this.view = this.view.kind === "details" ? this.view.back : { kind: "context" };
			return true;
		}
		const current = this.visibleRows()[this.selected];
		if (current === undefined) return false;
		const key = this.expanded.has(current.row.key) ? current.row.key : current.parent;
		if (key === undefined) return false;
		this.expanded.delete(key);
		this.selected = Math.max(0, this.visibleRows().findIndex((entry) => entry.row.key === key));
		return true;
	}

	handleInput(data: string): void {
		if (data === "q") { this.callbacks.onClose(); return; }
		if (matchesKey(data, Key.tab) || matchesKey(data, Key.shift("tab"))) {
			this.tab = this.tab === "context" ? "session" : "context";
		} else if (this.keybindings.matches(data, "tui.select.cancel")) {
			if (this.tab === "session" || !this.back()) this.callbacks.onClose();
		} else if (data === "r") this.refresh();
		else if (this.tab === "session" && data === "b") {
			this.scope = this.scope === "session" ? "branch" : "session";
			this.session = undefined;
		} else if (this.tab === "session") {
			const page = Math.max(1, this.terminalRows() - 6);
			const delta = this.keybindings.matches(data, "tui.select.up") ? -1 : this.keybindings.matches(data, "tui.select.down") ? 1
				: this.keybindings.matches(data, "tui.select.pageUp") ? -page : this.keybindings.matches(data, "tui.select.pageDown") ? page : 0;
			this.sessionView().move(delta, matchesKey(data, Key.home) ? "start" : matchesKey(data, Key.end) ? "end" : undefined);
		} else if (data === "d") {
			this.view = this.view.kind === "details" ? this.view.back
				: { kind: "details", reader: createSourceReader(sessionDocument(this.snapshot), this.theme), back: this.view };
		} else if (matchesKey(data, Key.left) || matchesKey(data, Key.backspace)) this.back();
		else if (this.view.kind === "context" && (this.keybindings.matches(data, "tui.select.confirm") || matchesKey(data, Key.right) || data === " ")) this.open();
		else {
			const page = Math.max(1, this.terminalRows() - 8);
			const delta = this.keybindings.matches(data, "tui.select.up") ? -1
				: this.keybindings.matches(data, "tui.select.down") ? 1
					: this.keybindings.matches(data, "tui.select.pageUp") ? -page
						: this.keybindings.matches(data, "tui.select.pageDown") ? page : 0;
			if (this.view.kind === "context") {
				const last = Math.max(0, this.visibleRows().length - 1);
				this.selected = matchesKey(data, Key.home) ? 0 : matchesKey(data, Key.end) ? last : Math.max(0, Math.min(last, this.selected + delta));
			} else {
				this.view.reader.move(delta, matchesKey(data, Key.home) ? "start" : matchesKey(data, Key.end) ? "end" : undefined);
			}
		}
		this.callbacks.onChange();
	}

	private keyName(action: Keybinding): string | undefined {
		const key = this.keybindings.getKeys(action)[0];
		return key?.split("+").map((part) => part === "up" ? "↑" : part === "down" ? "↓" : part === "escape" ? "Esc"
			: part === "enter" ? "Enter" : part === "ctrl" ? "Ctrl" : part === "alt" ? "Alt" : part === "shift" ? "Shift" : part).join("+");
	}

	private help(width: number): string {
		const up = this.keyName("tui.select.up");
		const down = this.keyName("tui.select.down");
		const move = up === "↑" && down === "↓" ? "↑↓" : [up, down].filter((key) => key !== undefined).join("/") || "Home/End";
		const open = this.keyName("tui.select.confirm") ?? "→";
		const cancel = this.keyName("tui.select.cancel");
		const back = cancel ?? "←";
		const close = cancel ?? "q";
		const options = this.tab === "session"
			? [`${move} scroll · b branch/all · r refresh · ${close} close`, `${move} · b branch/all · r · ${close} close`, `${move} · b scope · ${close}`, `b · ${close}`, "q"]
			: this.view.kind === "context"
				? [`${move} move · ${open} open · ${back} back · r refresh · d details · q close`, `${move} · ${open} open · ${back} back · r · d details · q close`, `${move} · ${open} · ${back} · r · d · q`, `${move} ${open} ${back} q`, "q close"]
				: [`${move} scroll · ${back} back · d details · q close`, `${move} scroll · ${back} back · q close`, `${move} · ${back} · q`, "q close"];
		return this.theme.fg("muted", options.find((option) => visibleWidth(option) <= width) ?? "q");
	}

	private renderContext(width: number, height: number): string[] {
		const theme = this.theme;
		const ledger = this.ledger();
		const overview = renderOverview(this.snapshot, ledger.mix, width, theme);
		const tax = valueLine(
			theme.fg("accent", theme.bold("Startup tax")),
			theme.fg("accent", `~${formatTokens(ledger.mix.startup)}`) + (width >= 44 ? theme.fg("muted", ` · ${windowShare(ledger.mix.startup, this.snapshot.contextWindow)} of window`) : ""),
			width,
		);
		const fullHeader = height >= 18 ? [...overview, "", tax, ""]
			: height >= 12 ? [...overview, tax, ""]
				: height >= 10 ? [overview[0] ?? "", overview[2] ?? "", overview[3] ?? "", tax, ""]
				: [overview[0] ?? "", tax];
		const header = fullHeader.slice(0, Math.max(0, height - 2));
		const rows = this.visibleRows();
		const body: Array<{ text: string; selected: boolean }> = [];
		if (!ledger.rows.some((row) => row.group === "startup")) body.push({ text: theme.fg("muted", "No startup sources available."), selected: false });
		for (const [index, entry] of rows.entries()) {
			if (entry.row.key === "conversation" && body.length > 0) body.push({ text: "", selected: false });
			const state = this.descendants(entry.row.key).length === 0 ? "leaf" : this.expanded.has(entry.row.key) ? "open" : "closed";
			body.push({ text: renderLedgerRow(entry.row, entry.depth, state, index === this.selected, width, theme), selected: index === this.selected });
		}
		const budget = Math.max(0, height - header.length - 1);
		const selectedPosition = Math.max(0, body.findIndex((row) => row.selected));
		const needsScroll = body.length > budget;
		const showPosition = needsScroll && budget >= 3;
		const available = Math.max(0, budget - (showPosition ? 1 : 0));
		if (selectedPosition < this.offset) this.offset = selectedPosition;
		if (selectedPosition >= this.offset + available) this.offset = selectedPosition - available + 1;
		this.offset = Math.max(0, Math.min(this.offset, Math.max(0, body.length - available)));
		const output = [...header, ...body.slice(this.offset, this.offset + available).map((row) => row.text)];
		if (showPosition) output.push(theme.fg("muted", `${this.selected + 1} / ${rows.length} sources · ↑↓ scroll`));
		while (output.length < height - 1) output.push("");
		output.push(this.help(width));
		return output;
	}

	render(width: number): string[] {
		const cols = Math.max(1, Math.floor(width));
		const height = Math.max(1, Math.floor(this.terminalRows()));
		const inset = cols >= 48 ? "  " : "";
		const inner = Math.max(1, Math.min(cols - inset.length * 2, 100));
		const context = this.tab === "context" ? this.theme.fg("accent", this.theme.bold("Context")) : this.theme.fg("muted", "Context");
		const session = this.tab === "session" ? this.theme.fg("accent", this.theme.bold("Session")) : this.theme.fg("muted", "Session");
		const tabs = inner >= 20 ? `${context}  ${session}` : this.theme.fg("accent", this.theme.bold(this.tab === "context" ? "Context" : "Session"));
		const navigation = valueLine(tabs, this.theme.fg("muted", inner >= 32 ? "Tab switch view" : "Tab"), inner);
		const header = height >= 8 ? [navigation, ""] : height >= 2 ? [navigation] : [];
		const bodyHeight = Math.max(1, height - header.length);
		const help = this.help(inner >= 48 || (this.tab === "session" && inner >= 40) ? inner - 18 : inner);
		const body = this.tab === "session" ? this.sessionView().render(inner, bodyHeight, help)
			: this.view.kind === "context" ? this.renderContext(inner, bodyHeight) : this.view.reader.render(inner, bodyHeight, help);
		return [...header, ...body].slice(0, height).map((text) => {
			const line = inset + truncateToWidth(text, inner, "");
			return line + " ".repeat(Math.max(0, cols - visibleWidth(line)));
		});
	}
}
