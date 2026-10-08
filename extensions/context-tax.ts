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

import { CaptureState } from "../src/capture.ts";
import { parseContextCommand } from "../src/ctx-command.ts";
import { resolveContextWindow } from "../src/context-window.ts";
import { createContextTax } from "../src/context-tax.ts";
import {
	buildSnapshot,
	readObservedUsage,
	type SnapshotInputs,
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
import { formatSessionSummary, summarizeSession, type SummaryScope } from "../src/session-summary.ts";
import { startupKey, summarizeActiveTools, summarizeDeclaredTools } from "../src/tool-loadout.ts";
import type { ContextSnapshot } from "../src/types.ts";

function report(ctx: ExtensionCommandContext, text: string, level: "info" | "warning" = "info"): void {
	if (ctx.hasUI) ctx.ui.notify(text, level);
	else console.error(text);
}

export default function contextTaxExtension(pi: ExtensionAPI): void {
	const capture = new CaptureState();
	const pendingReadPaths = new Map<string, string>();

	pi.on("before_agent_start", (event, ctx) => {
		capture.noteAgentStart(event.systemPromptOptions, event.systemPrompt);
		const skill = skillForExpandedPrompt(event.prompt, event.systemPromptOptions?.skills);
		if (skill !== undefined) noteLoadedSkill(skill, ctx.sessionManager.getBranch());
	});

	pi.on("context_with_system", (event, ctx) => {
		const systemPrompt = ctx.getSystemPrompt();
		const tools = pi.getAllTools();
		const hidden = capture.systemPromptOptions?.hiddenTools ?? [];
		const activeNames = pi.getActiveTools();
		capture.noteContext(
			event.messages,
			systemPrompt,
			buildSessionContext(ctx.sessionManager.getBranch()).messages,
			startupKey({ systemPrompt, tools, activeNames, hiddenNames: hidden, codemode: pi.getSettings().codemode }),
			summarizeDeclaredTools(event.messages, tools, ctx.cwd, hidden),
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
		const match = skillForReadPath(readPath, ctx.cwd, capture.systemPromptOptions?.skills);
		if (match === undefined) return;
		noteLoadedSkill(match, ctx.sessionManager.getBranch());
	});

	const reset = (): void => { capture.invalidate(); pendingReadPaths.clear(); };
	pi.on("session_compact", reset);
	pi.on("session_start", reset);
	pi.on("session_tree", reset);
	pi.on("session_shutdown", reset);
	pi.on("agent_end", () => { pendingReadPaths.clear(); });

	const takeSnapshot = (ctx: ExtensionCommandContext): ContextSnapshot => {
		const compaction = SettingsManager.inMemory(pi.getSettings()).getCompactionSettings(ctx.model);
		const usage = ctx.getContextUsage();
		const branch = ctx.sessionManager.getBranch();
		const systemPrompt = ctx.getSystemPrompt();
		const systemPromptOptions = ctx.getSystemPromptOptions();
		const configured = pi.getAllTools();
		const hidden = systemPromptOptions.hiddenTools ?? [];
		const activeNames = pi.getActiveTools();
		const registered = summarizeActiveTools(configured, activeNames, ctx.cwd, hidden);
		const key = startupKey({ systemPrompt, tools: configured, activeNames, hiddenNames: hidden, codemode: pi.getSettings().codemode });
		const loadedSkills = readLoadedSkills(branch);
		const currentMessages = buildSessionContext(branch).messages;
		const history = capture.resolveMessages(currentMessages);
		const tools = capture.current?.startupKey === key ? capture.current.tools
			: readStartupUsageKey(branch) === key ? summarizeDeclaredTools(currentMessages, configured, ctx.cwd, hidden)
				: registered;
		const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "no model";
		const observed = readObservedUsage(history.messages, {
			tokens: usage?.tokens ?? null,
			model,
			startupChanged: readStartupUsageKey(branch) !== key,
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
		description: "Inspect current context and recorded session usage, cost, tools, and MCP activity (no model call)",
		getArgumentCompletions: (prefix) => {
			const values = ["context", "session", "session branch", "session json", "session branch json"].filter((value) => value.startsWith(prefix));
			return values.length > 0 ? values.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args, ctx) => {
			const parsed = parseContextCommand(args);
			if (parsed._tag === "err") {
				report(ctx, parsed.error.message, "warning");
				return;
			}
			const command = parsed.value;
			const takeSummary = (scope: SummaryScope) => summarizeSession(
				scope === "branch" ? ctx.sessionManager.getBranch() : ctx.sessionManager.getEntries(),
				pi.getAllTools(),
			);
			if (command.view === "session" && (command.format === "json" || ctx.mode !== "tui")) {
				const summary = takeSummary(command.scope);
				const output = command.format === "json" ? JSON.stringify({ scope: command.scope, ...summary }, null, 2) : formatSessionSummary(summary, command.scope);
				report(ctx, output);
				return;
			}
			const snapshot = takeSnapshot(ctx);
			if (ctx.mode !== "tui") {
				report(ctx, renderPlainReport(snapshot) + "\n\n/ctx session · recorded usage, cost, tools, and MCP calls");
				return;
			}

			await ctx.ui.custom<void>((tui, theme, keybindings, done) => {
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
						onSummary: takeSummary,
						onChange: () => tui.requestRender(),
					},
					{ tab: command.view, scope: command.view === "session" ? command.scope : "session" },
					keybindings,
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
