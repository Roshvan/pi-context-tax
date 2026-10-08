import { createHash } from "node:crypto";
import { getCurrentTools, type Tool } from "@earendil-works/pi-ai";
import {
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createPowerShellToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	type ExtensionAPI,
	type ToolInfo,
} from "@earendil-works/pi-coding-agent";

import type { CapturedMessages } from "./capture.ts";
import type { BuiltinToolOverride } from "./types.ts";

export interface ToolSummary {
	name: string;
	description: string;
	parameters: unknown;
	source?: string;
	path?: string;
	namespace?: string;
	builtinOverride?: BuiltinToolOverride;
}

export function toolSchemaText(tool: Pick<ToolSummary, "name" | "description" | "parameters">): string {
	return `${tool.name}\n${tool.description}\n${JSON.stringify(tool.parameters ?? {})}`;
}

interface LoadoutState {
	readonly systemPrompt: string;
	readonly tools: readonly ToolInfo[];
	readonly activeNames: readonly string[];
	readonly hiddenNames: readonly string[];
	readonly codemode: ReturnType<ExtensionAPI["getSettings"]>["codemode"];
}

export function startupKey(loadout: LoadoutState): string {
	const tools = loadout.tools.map((tool) => ({
		name: tool.name, description: tool.description, parameters: tool.parameters,
		exposure: tool.exposure, namespace: tool.namespace, promptGuidelines: tool.promptGuidelines,
	}));
	return createHash("sha256").update(JSON.stringify([loadout.systemPrompt, tools, loadout.activeNames, loadout.hiddenNames, loadout.codemode])).digest("hex");
}

const BUILTIN_FACTORIES = new Map<string, (cwd: string) => Pick<ToolSummary, "name" | "description" | "parameters">>([
	["read", createReadToolDefinition], ["bash", createBashToolDefinition],
	["edit", createEditToolDefinition], ["write", createWriteToolDefinition],
	["grep", createGrepToolDefinition], ["find", createFindToolDefinition],
	["ls", createLsToolDefinition], ["powershell", createPowerShellToolDefinition],
]);

function summarizeTool(declaration: Tool, registered: ToolInfo | undefined, cwd: string): ToolSummary {
	const builtin = registered?.sourceInfo?.source === "builtin" ? undefined : BUILTIN_FACTORIES.get(declaration.name)?.(cwd);
	const builtinOverride = builtin === undefined || registered === undefined ? undefined
		: toolSchemaText(registered) === toolSchemaText(builtin) ? "same-definition" : "modified-definition";
	return {
		name: declaration.name, description: declaration.description, parameters: declaration.parameters,
		source: registered?.sourceInfo?.source, path: registered?.sourceInfo?.path,
		namespace: registered?.namespace?.name, builtinOverride,
	};
}

export function summarizeActiveTools(
	tools: readonly ToolInfo[], activeNames: readonly string[], cwd: string, hiddenNames: readonly string[] = [],
): ToolSummary[] {
	const active = new Set(activeNames);
	const hidden = new Set(hiddenNames);
	return tools.filter((tool) => active.has(tool.name) && !hidden.has(tool.name))
		.map((tool) => summarizeTool(tool, tool, cwd));
}

export function summarizeDeclaredTools(
	messages: CapturedMessages, tools: readonly ToolInfo[], cwd: string, hiddenNames: readonly string[] = [],
): ToolSummary[] {
	const registered = new Map(tools.map((tool) => [tool.name, tool]));
	const hidden = new Set(hiddenNames);
	return getCurrentTools(messages).filter((tool) => !hidden.has(tool.name))
		.map((tool) => summarizeTool(tool, registered.get(tool.name), cwd));
}
