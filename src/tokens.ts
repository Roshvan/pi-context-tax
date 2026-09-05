export function estimateText(text: string): number {
	return Math.ceil(text.length / 4);
}

export function formatTokens(value: number): string {
	if (Math.round(value) < 1_000) return String(Math.round(value));
	if (value < 10_000) return `${(value / 1_000).toFixed(1)}k`;
	if (value < 100_000) return `${Number((value / 1_000).toFixed(1))}k`;
	if (value < 1_000_000) return `${Math.round(value / 1_000)}k`;
	return `${(value / 1_000_000).toFixed(1)}M`;
}

export function oneLine(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

type ContentBlock = {
	readonly type: string;
	readonly text?: string;
	readonly mimeType?: string;
};

type MessageContent = string | readonly ContentBlock[];

export function contentText(content: MessageContent): string {
	if (!Array.isArray(content)) return String(content);
	const parts: string[] = [];
	for (const block of content) {
		if (block.type === "text" && block.text !== undefined) parts.push(block.text);
		else if (block.type === "image") parts.push(`[image ${block.mimeType ?? "unknown"}]`);
	}
	return parts.join("\n");
}

export function distribute(parts: number[], total: number): number[] {
	const subtotal = parts.reduce((sum, part) => sum + part, 0);
	if (parts.length === 0) return [];
	if (subtotal === total) return [...parts];
	if (subtotal <= 0) {
		const even = parts.map(() => 0);
		even[0] = total;
		return even;
	}

	const exact = parts.map((part) => (part / subtotal) * total);
	const floored = exact.map((value) => Math.floor(value));
	let remainder = total - floored.reduce((sum, value) => sum + value, 0);
	const order = exact
		.map((value, index) => ({ index, fraction: value - Math.floor(value) }))
		.sort((a, b) => b.fraction - a.fraction);
	for (const entry of order) {
		if (remainder <= 0) break;
		floored[entry.index] = (floored[entry.index] ?? 0) + 1;
		remainder--;
	}
	return floored;
}
