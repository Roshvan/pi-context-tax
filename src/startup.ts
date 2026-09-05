import { isStartupKind, type BuiltinToolOverride, type ContextSnapshot } from "./types.ts";

const MCP_TOOL = /^mcp__(.+?)__/;

const SOURCE_LABEL = new Map<string, string>([["builtin", "builtin"], ["sdk", "sdk"]]);

const GENERIC_ENTRY = /^(index|main|entry|extension|extensions)$/;
const CONTAINER_DIR = /^(extensions?|src|dist|lib|build|out|\.pi)$/;

function extensionLabel(path: string): string | undefined {
	const inline = /^<inline:(.+)>$/.exec(path)?.[1];
	if (inline !== undefined) return inline;
	const packagePath = path.replaceAll("\\", "/").split("/node_modules/").pop();
	if (packagePath !== undefined && packagePath !== path.replaceAll("\\", "/")) {
		const parts = packagePath.split("/");
		return parts[0]?.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
	}
	const parts = path.split(/[\\/]/).filter((part) => part.length > 0);
	const file = parts.pop();
	if (file === undefined) return undefined;
	const name = file.replace(/^<|>$/g, "").replace(/\.[cm]?[jt]sx?$/, "");
	if (name.length > 0 && !GENERIC_ENTRY.test(name)) return name;
	while (parts.length > 0) {
		const directory = parts.pop();
		if (directory === undefined) break;
		if (!CONTAINER_DIR.test(directory)) return directory;
	}
	return name.length > 0 ? name : undefined;
}

export function toolProvider(name: string, source?: string, path?: string, builtinOverride?: BuiltinToolOverride): string {
	const mcp = MCP_TOOL.exec(name);
	if (mcp) return `mcp · ${mcp[1]}`;
	const npmPackage = /^npm:((?:@[^/]+\/)?[^@/]+)/.exec(source ?? "")?.[1];
	const label = npmPackage ?? (path === undefined ? undefined : extensionLabel(path));
	if (builtinOverride !== undefined) {
		return `${builtinOverride === "same-definition" ? "builtin" : "override"} · ${label ?? source ?? "extension"}`;
	}
	const known = source === undefined ? undefined : SOURCE_LABEL.get(source);
	if (known) return known;
	if (label !== undefined) return `ext · ${label}`;
	return source && source.length > 0 ? source : "other";
}

export interface StartupRow {
	label: string;
	tokens: number;
	tools: number;
}

interface StartupSection {
	title: string;
	rows: StartupRow[];
}

export interface StartupReading {
	sections: StartupSection[];
}

export function startupRowLabel(label: string): string {
	if (label.startsWith("project context · ")) {
		const path = label.slice("project context · ".length);
		return path.split(/[\\/]/).pop() || path;
	}
	if (label.startsWith("prompt scaffolding")) return "scaffolding";
	if (label.startsWith("skill index · ")) {
		return `skill index · ${label.slice("skill index · ".length).replace(/ skills?\b.*$/, "")}`;
	}
	if (label === "custom system prompt") return "custom prompt";
	if (label === "appended system prompt") return "appended prompt";
	if (label.startsWith("extension injection")) return label.slice("extension ".length);
	if (label.startsWith("unattributed span ")) return `unattributed ${label.slice("unattributed span ".length)}`;
	if (label.startsWith("extension rewrote")) return "prompt rewritten";
	return label;
}

function bySize(left: StartupRow, right: StartupRow): number {
	return right.tokens - left.tokens || left.label.localeCompare(right.label);
}

interface Group {
	label: string;
	tokens: number;
	tools: number;
}

export function readStartup(snapshot: ContextSnapshot, normalization = 1): StartupReading {
	const groups = new Map<string, Group>();
	const promptRows: StartupRow[] = [];
	const injectedRows: StartupRow[] = [];
	for (const chunk of snapshot.chunks) {
		if (!isStartupKind(chunk.kind)) continue;
		if (chunk.kind === "schema") {
			const label = chunk.group ?? "other";
			const group = groups.get(label) ?? { label, tokens: 0, tools: 0 };
			group.tokens += chunk.tokens;
			group.tools++;
			groups.set(label, group);
			continue;
		}

		const row: StartupRow = {
			label: chunk.label,
			tokens: chunk.tokens * normalization,
			tools: 0,
		};
		if (chunk.kind === "injection") injectedRows.push(row);
		else promptRows.push(row);
	}

	const toolRows: StartupRow[] = [...groups.values()]
		.map((group) => ({
			label: group.label,
			tokens: group.tokens * normalization,
			tools: group.tools,
		}))
		.sort(bySize);
	promptRows.sort(bySize);
	injectedRows.sort(bySize);
	const sections: StartupSection[] = [];
	const addSection = (title: string, rows: StartupRow[]) => {
		if (rows.length > 0) sections.push({ title, rows });
	};
	addSection("tool definitions", toolRows);
	addSection("system prompt", promptRows);
	addSection("injected", injectedRows);
	return { sections };
}
