import { highlightCode, type Theme } from "@earendil-works/pi-coding-agent";
import { Markdown, wrapTextWithAnsi, type MarkdownTheme } from "@earendil-works/pi-tui";
import { valueLine } from "./panel.ts";
import type { SourceBlock, SourceDocument } from "./source-document.ts";
import { terminalText } from "./terminal-text.ts";
import { formatTokens } from "./tokens.ts";

interface ReaderLine {
	text: string;
	anchor: string;
	progress: number;
}

function anchoredLines(lines: string[], anchor: string): ReaderLine[] {
	let progress = 0;
	return lines.map((text) => {
		const line = { text, anchor, progress };
		progress += terminalText(text).replace(/\s/g, "").length;
		return line;
	});
}

function markdownTheme(theme: Theme): MarkdownTheme {
	return {
		heading: (text) => theme.fg("mdHeading", text),
		link: (text) => theme.fg("mdLink", text),
		linkUrl: (text) => theme.fg("mdLinkUrl", text),
		code: (text) => theme.fg("mdCode", text),
		codeBlock: (text) => theme.fg("mdCodeBlock", text),
		codeBlockBorder: (text) => theme.fg("mdCodeBlockBorder", text),
		quote: (text) => theme.fg("mdQuote", text),
		quoteBorder: (text) => theme.fg("mdQuoteBorder", text),
		hr: (text) => theme.fg("mdHr", text),
		listBullet: (text) => theme.fg("mdListBullet", text),
		bold: (text) => theme.bold(text),
		italic: (text) => theme.italic(text),
		strikethrough: (text) => theme.strikethrough(text),
		underline: (text) => theme.underline(text),
		highlightCode,
	};
}

function blockLines(block: SourceBlock, width: number, theme: Theme, index: number): ReaderLine[] {
	const text = terminalText(block.text).replace(/\t/g, "  ");
	if (block.kind === "markdown") {
		return anchoredLines(new Markdown(text, 0, 0, markdownTheme(theme), { color: (value) => theme.fg("text", value) }, { renderLatex: false }).render(width), `${index}:prose`);
	}
	const source = block.kind === "code" ? highlightCode(text, block.language) : text.split("\n");
	return source.flatMap((line, lineIndex) => {
		const styled = block.kind === "heading" ? theme.fg("accent", theme.bold(line))
			: block.kind === "note" ? theme.fg("muted", line) : theme.fg("text", line);
		return anchoredLines(wrapTextWithAnsi(styled, width), `${index}:${lineIndex}`);
	});
}

export function createSourceReader(document: SourceDocument, theme: Theme): SourceReader {
	return new SourceReader(document, theme);
}

class SourceReader {
	private offset = 0;
	private width = 0;
	private lines: ReaderLine[] = [];

	constructor(private readonly document: SourceDocument, private readonly theme: Theme) {}

	move(delta: number, edge?: "start" | "end"): void {
		this.offset = edge === "start" ? 0 : edge === "end" ? Number.MAX_SAFE_INTEGER : Math.max(0, this.offset + delta);
	}

	private content(width: number): ReaderLine[] {
		if (width === this.width) return this.lines;
		const current = this.lines[this.offset];
		this.lines = this.document.blocks.flatMap((block, index) => [
			...(index === 0 ? [] : [{ text: "", anchor: `${index}:space`, progress: 0 }]),
			...blockLines(block, width, this.theme, index),
		]);
		this.width = width;
		if (current !== undefined) {
			for (const [index, line] of this.lines.entries()) {
				if (line.anchor === current.anchor && line.progress <= current.progress) this.offset = index;
			}
		}
		return this.lines;
	}

	render(width: number, height: number, help: string): string[] {
		const theme = this.theme;
		const lines = this.content(width);
		const tokens = this.document.tokens === undefined ? "" : `~${formatTokens(this.document.tokens)} tokens`;
		const title = valueLine(theme.bold(terminalText(this.document.title).replace(/\s+/g, " ")), theme.fg("muted", tokens), width);
		const breadcrumb = theme.fg("muted", terminalText(this.document.breadcrumb).replace(/\s+/g, " "));
		const header = height >= 8 ? [breadcrumb, title, ""] : height >= 3 ? [title] : [];
		const budget = Math.max(0, height - header.length - 1);
		this.offset = Math.max(0, Math.min(this.offset, Math.max(0, lines.length - budget)));
		const output = [...header, ...lines.slice(this.offset, this.offset + budget).map((line) => line.text)];
		while (output.length < height - 1) output.push("");
		const position = lines.length > budget && budget > 0 ? `${this.offset + 1}–${Math.min(lines.length, this.offset + budget)} / ${lines.length}` : "";
		output.push(width >= 48 ? valueLine(help, theme.fg("muted", position), width) : help);
		return output;
	}
}
