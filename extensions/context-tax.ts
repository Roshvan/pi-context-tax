import {
	buildSessionContext,
	calculateContextTokens,
	isReadToolResult,
	isToolCallEventType,
	SettingsManager,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";

import { CaptureState } from "../src/capture.ts";
import { resolveContextWindow } from "../src/context-window.ts";
import { createContextTax } from "../src/context-tax.ts";
import {
	buildSnapshot,
	readObservedUsage,
	summarizeActiveTools,
	toolSchemaText,
	type SnapshotInputs,
	type ToolSummary,
} from "../src/snapshot.ts";
import {
	readLoadedSkills,
	readResourceInventory,
	readSessionTotals,
	readStartupUsageKey,
	SKILL_LOADED_ENTRY,
	STARTUP_USAGE_ENTRY,
	skillForExpandedPrompt,
	skillForReadPath,
	type SkillLoadedData,
	type StartupUsageData,
} from "../src/resources.ts";
import { renderPlainReport } from "../src/report.ts";
import type { ContextSnapshot } from "../src/types.ts";

function startupKey(systemPrompt: string, tools: ToolSummary[]): string {
	return createHash("sha256").update(JSON.stringify([systemPrompt, tools.map(toolSchemaText).sort()])).digest("hex");
}

export default function contextTaxExtension(pi: ExtensionAPI): void {
	const capture = new CaptureState();
	const pendingReadPaths = new Map<string, string>();

	const activeTools = (cwd: string): ToolSummary[] => summarizeActiveTools(pi.getAllTools(), pi.getActiveTools(), cwd);

	pi.on("before_agent_start", (event, ctx) => {
		capture.noteAgentStart(event.systemPromptOptions, event.systemPrompt);
		const skill = skillForExpandedPrompt(event.prompt, event.systemPromptOptions?.skills);
		if (skill !== undefined) noteLoadedSkill(skill, ctx.sessionManager.getBranch());
	});

	pi.on("context", (event, ctx) => {
		const systemPrompt = ctx.getSystemPrompt();
		const tools = activeTools(ctx.cwd);
		capture.noteContext(
			event.messages,
			systemPrompt,
			buildSessionContext(ctx.sessionManager.getBranch()).messages,
			startupKey(systemPrompt, tools),
		);
	});

	pi.on("message_end", (event) => {
		const message = event.message;
		const key = capture.current?.startupKey;
		if (message.role === "assistant"
			&& key !== undefined
			&& message.stopReason !== "aborted"
			&& message.stopReason !== "error"
			&& calculateContextTokens(message.usage) > 0) {
			pi.appendEntry<StartupUsageData>(STARTUP_USAGE_ENTRY, {
				key,
				timestamp: message.timestamp,
				model: `${message.provider}/${message.model}`,
			});
		}
	});

	const noteLoadedSkill = (skill: SkillLoadedData, branch: readonly SessionEntry[]): void => {
		if (readLoadedSkills(branch).has(skill.name)) return;
		pi.appendEntry(`${SKILL_LOADED_ENTRY}:${skill.name}`);
	};

	pi.on("input", (event, ctx) => {
		const commandName = /^\/([^\s]+)/.exec(event.text)?.[1];
		if (commandName === undefined) return;
		const command = pi.getCommands().find((candidate) => candidate.name === commandName && candidate.source === "skill");
		if (command === undefined) return;
		const skillName = command.name.replace(/^skill:/, "");
		noteLoadedSkill({ name: skillName }, ctx.sessionManager.getBranch());
	});

	pi.on("tool_call", (event) => {
		if (!isToolCallEventType("read", event)) return;
		pendingReadPaths.set(event.toolCallId, event.input.path);
	});

	pi.on("tool_result", (event, ctx) => {
		if (!isReadToolResult(event)) return;
		const readPath = pendingReadPaths.get(event.toolCallId);
		pendingReadPaths.delete(event.toolCallId);
		if (event.isError || readPath === undefined) return;
		const match = skillForReadPath(readPath, ctx.cwd, capture.current?.systemPromptOptions?.skills);
		if (match === undefined) return;
		noteLoadedSkill(match, ctx.sessionManager.getBranch());
	});

	pi.on("session_compact", () => {
		capture.invalidate();
		pendingReadPaths.clear();
	});

	pi.on("session_start", () => {
		capture.invalidate();
		pendingReadPaths.clear();
	});

	pi.on("session_tree", () => {
		capture.invalidate();
		pendingReadPaths.clear();
	});

	const takeSnapshot = (ctx: ExtensionCommandContext): ContextSnapshot => {
		const settings = SettingsManager.create(ctx.cwd, undefined, { projectTrusted: ctx.isProjectTrusted() });
		const compaction = settings.getCompactionSettings();
		const usage = ctx.getContextUsage();
		const branch = ctx.sessionManager.getBranch();
		const systemPrompt = ctx.getSystemPrompt();
		const systemPromptOptions = ctx.getSystemPromptOptions();
		const tools = activeTools(ctx.cwd);
		const loadedSkills = readLoadedSkills(branch);
		const currentMessages = buildSessionContext(branch).messages;
		const history = capture.resolveMessages(currentMessages);
		const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "no model";
		const observed = readObservedUsage(history.messages, {
			tokens: usage?.tokens ?? null,
			model,
			startupChanged: readStartupUsageKey(branch) !== startupKey(systemPrompt, tools),
		});
		const inputs: SnapshotInputs = {
			systemPrompt,
			baselineSystemPrompt: capture.current?.systemPrompt === systemPrompt ? capture.current.baselinePrompt : undefined,
			systemPromptOptions,
			messages: history.messages,
			tools,
			source: history.source,
			capturedAt: history.capturedAt,
			...observed,
			contextWindow: resolveContextWindow(usage?.contextWindow, ctx.model?.contextWindow),
			model,
			turns: branch.filter((entry) => entry.type === "message" && entry.message.role === "user").length,
			compactionEnabled: compaction.enabled,
			reserveTokens: compaction.reserveTokens,
			resources: readResourceInventory(
				systemPromptOptions,
				pi.getCommands(),
				loadedSkills,
				tools.length,
				ctx.cwd,
			),
			sessionTotals: readSessionTotals(ctx.sessionManager.getEntries()),
		};
		return buildSnapshot(inputs);
	};

	pi.registerCommand("ctx", {
		description: "Show what's in the context window, and how much of it is startup tax",
		handler: async (_args, ctx) => {
			const snapshot = takeSnapshot(ctx);
			if (ctx.mode !== "tui") {
				const report = renderPlainReport(snapshot);
				if (ctx.hasUI) ctx.ui.notify(report, "info");
				else console.error(report);
				return;
			}

			await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
				let closed = false;
				const close = () => {
					if (closed) return;
					closed = true;
					done(undefined);
				};
				return createContextTax(
					snapshot,
					theme,
					() => tui.terminal.rows,
					{
						onClose: close,
						onRefresh: () => takeSnapshot(ctx),
						onChange: () => tui.requestRender(),
					},
				);
			}, {
				overlay: true,
				overlayOptions: {
					width: "100%",
					maxHeight: "100%",
					margin: 0,
					anchor: "top-left",
				},
			});
		},
	});
}
