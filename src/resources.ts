import {
	calculateContextTokens,
	type BuildSystemPromptOptions,
	type SessionEntry,
	type SlashCommandInfo,
} from "@earendil-works/pi-coding-agent";
import os from "node:os";
import path from "node:path";

export const SKILL_LOADED_ENTRY = "context-tax:skill-loaded";

export const STARTUP_USAGE_ENTRY = "context-tax:startup-usage:v1";

export interface StartupUsageData {
	readonly key: string;
	readonly timestamp: number;
	readonly model: string;
}

function parseStartupUsage(data: unknown): StartupUsageData | undefined {
	if (typeof data !== "object" || data === null
		|| !("key" in data) || typeof data.key !== "string" || !/^[a-f0-9]{64}$/.test(data.key)
		|| !("timestamp" in data) || typeof data.timestamp !== "number" || !Number.isFinite(data.timestamp)
		|| !("model" in data) || typeof data.model !== "string") return undefined;
	return { key: data.key, timestamp: data.timestamp, model: data.model };
}

export function readStartupUsageKey(entries: readonly SessionEntry[]): string | undefined {
	let pending: StartupUsageData | undefined;
	let key: string | undefined;
	for (const entry of entries) {
		if (entry.type === "compaction") {
			pending = undefined;
			key = undefined;
			continue;
		}
		if (entry.type === "custom" && entry.customType === STARTUP_USAGE_ENTRY) {
			pending = parseStartupUsage(entry.data);
			continue;
		}
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const message = entry.message;
		const tokens = calculateContextTokens(message.usage);
		if (message.stopReason !== "aborted" && message.stopReason !== "error" && Number.isFinite(tokens) && tokens > 0) {
			key = pending?.timestamp === message.timestamp && pending.model === `${message.provider}/${message.model}`
				? pending.key
				: undefined;
		}
		pending = undefined;
	}
	return key;
}

export interface SkillLoadedData {
	readonly name: string;
}

export interface SessionTotals {
	readonly tokens: number;
	readonly cost: number;
}

export interface ResourceInventory {
	readonly contextFiles: readonly string[];
	readonly availableSkillCount: number;
	readonly loadedSkills: readonly string[];
	readonly commandExtensions: readonly string[];
	readonly activeTools: number;
}

interface UsageReading {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly cost: { readonly total: number };
}

function addUsage(total: { tokens: number; cost: number }, usage: UsageReading | undefined): void {
	if (usage === undefined) return;
	total.tokens += usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
	total.cost += usage.cost.total;
}

export function readSessionTotals(entries: readonly SessionEntry[]): SessionTotals {
	const total = { tokens: 0, cost: 0 };
	for (const entry of entries) {
		if (entry.type === "message") {
			const message = entry.message;
			if ("usage" in message) addUsage(total, message.usage);
			continue;
		}
		if (entry.type === "compaction" || entry.type === "branch_summary") addUsage(total, entry.usage);
	}
	return total;
}

export function readLoadedSkills(entries: readonly SessionEntry[]): ReadonlySet<string> {
	const loaded = new Set<string>();
	const prefix = `${SKILL_LOADED_ENTRY}:`;
	for (const entry of entries) {
		if (entry.type !== "custom" || !entry.customType.startsWith(prefix)) continue;
		const name = entry.customType.slice(prefix.length);
		if (name.length > 0) loaded.add(name);
	}
	return loaded;
}

function resolveReadPath(input: string, cwd: string): string {
	let candidate = input.startsWith("@") ? input.slice(1) : input;
	if (candidate === "~") candidate = os.homedir();
	else if (candidate.startsWith("~/")) candidate = path.join(os.homedir(), candidate.slice(2));
	return path.resolve(cwd, candidate);
}

export function skillForExpandedPrompt(
	prompt: string,
	skills: BuildSystemPromptOptions["skills"],
): SkillLoadedData | undefined {
	const wrapper = /^<skill name="([^"]+)" location="([^"]+)">/.exec(prompt);
	const frontmatterName = /^---\r?\nname:\s*["']?([^\r\n"']+)["']?\s*\r?\n/.exec(prompt)?.[1]?.trim();
	const name = wrapper?.[1] ?? frontmatterName;
	if (name === undefined) return undefined;
	const skill = (skills ?? []).find((candidate) => candidate.name === name);
	if (skill === undefined) return undefined;
	return { name: skill.name };
}

export function skillForReadPath(
	inputPath: string,
	cwd: string,
	skills: BuildSystemPromptOptions["skills"],
): SkillLoadedData | undefined {
	const readPath = resolveReadPath(inputPath, cwd);
	let match: { readonly name: string; readonly baseDir: string } | undefined;
	for (const skill of skills ?? []) {
		const filePath = path.resolve(skill.filePath);
		const baseDir = path.resolve(skill.baseDir);
		if (readPath !== filePath && !readPath.startsWith(`${baseDir}${path.sep}`)) continue;
		if (match === undefined || baseDir.length > match.baseDir.length) {
			match = { name: skill.name, baseDir };
		}
	}
	return match === undefined ? undefined : { name: match.name };
}

function compactPath(filePath: string, cwd: string): string {
	const absolute = path.resolve(filePath);
	const project = path.resolve(cwd);
	if (absolute === project) return ".";
	if (absolute.startsWith(`${project}${path.sep}`)) return `./${absolute.slice(project.length + 1)}`;
	if (absolute.startsWith(`${os.homedir()}${path.sep}`)) return `~/${absolute.slice(os.homedir().length + 1)}`;
	return absolute;
}

function extensionFileLabel(filePath: string): string {
	const inline = /^<inline:(.+)>$/.exec(filePath);
	if (inline?.[1] !== undefined) return inline[1];

	const normalized = filePath.replaceAll("\\", "/");
	const marker = "/node_modules/";
	const moduleAt = normalized.lastIndexOf(marker);
	const leaf = path.basename(filePath).replace(/\.[cm]?[jt]sx?$/, "");
	if (moduleAt < 0) return leaf;

	const moduleParts = normalized.slice(moduleAt + marker.length).split("/");
	const packageName = moduleParts[0]?.startsWith("@")
		? moduleParts.slice(0, 2).join("/")
		: moduleParts[0];
	if (packageName === undefined || packageName.length === 0) return leaf;
	return leaf.length === 0 || leaf === "index" ? packageName : `${packageName}/${leaf}`;
}

function extensionLabels(commands: readonly SlashCommandInfo[]): string[] {
	const sources = new Map<string, string>();
	for (const command of commands) {
		if (command.source !== "extension") continue;
		sources.set(command.sourceInfo.path, extensionFileLabel(command.sourceInfo.path));
	}
	return [...sources.values()].sort((left, right) => left.localeCompare(right));
}

export function readResourceInventory(
	options: BuildSystemPromptOptions,
	commands: readonly SlashCommandInfo[],
	loadedSkills: ReadonlySet<string>,
	activeTools: number,
	cwd: string,
): ResourceInventory {
	return {
		contextFiles: (options.contextFiles ?? []).map((file) => compactPath(file.path, cwd)),
		availableSkillCount: options.skills?.length ?? 0,
		loadedSkills: [...loadedSkills].sort((left, right) => left.localeCompare(right)),
		commandExtensions: extensionLabels(commands),
		activeTools,
	};
}
