import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type ExtensionError,
	type Skill,
} from "@earendil-works/pi-coding-agent";

import { readLoadedSkills } from "../src/resources.ts";

async function createFixture(t: TestContext) {
	const cwd = await mkdtemp(join(tmpdir(), "pi-context-tax-test-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } });
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir: cwd,
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		additionalExtensionPaths: [fileURLToPath(new URL("../extensions/context-tax.ts", import.meta.url))],
	});
	await resourceLoader.reload();
	assert.deepEqual(resourceLoader.getExtensions().errors, []);
	const modelRuntime = await ModelRuntime.create({
		authPath: join(cwd, "auth.json"),
		modelsPath: null,
		modelsStorePath: join(cwd, "models-cache.json"),
		refreshOnCreate: false,
	});
	const { session } = await createAgentSession({
		cwd,
		agentDir: cwd,
		resourceLoader,
		modelRuntime,
		settingsManager,
		sessionManager: SessionManager.inMemory(cwd),
	});
	t.after(() => session.dispose());
	const errors: ExtensionError[] = [];
	const reports: string[] = [];
	await session.bindExtensions({
		mode: "rpc",
		onError: (error) => errors.push(error),
		uiContext: {
			...session.extensionRunner.getUIContext(),
			notify: (message) => { reports.push(message); },
		},
	});
	const skill: Skill = {
		name: "example",
		description: "Example skill",
		filePath: join(cwd, "example", "SKILL.md"),
		baseDir: join(cwd, "example"),
		sourceInfo: { source: "local", path: cwd, scope: "temporary", origin: "top-level" },
		disableModelInvocation: false,
	};
	return { session, skill, errors, reports };
}

test("user runs record expanded skills only once", async (t) => {
	const { session, skill, errors } = await createFixture(t);
	const trigger = {
		messageType: "user" as const,
		prompt: `<skill name="${skill.name}" location="${skill.filePath}">Instructions</skill>`,
	};
	const options = { cwd: skill.baseDir, skills: [skill] };
	await session.extensionRunner.emitBeforeAgentStart(trigger, options);
	await session.extensionRunner.emitBeforeAgentStart(trigger, options);
	assert.deepEqual([...readLoadedSkills(session.sessionManager.getBranch())], [skill.name]);
	assert.equal(session.sessionManager.getEntries().filter((entry) => entry.type === "custom").length, 1);
	assert.deepEqual(errors, []);
});

test("custom runs capture fresh options without treating their content as a user skill prompt", async (t) => {
	const { session, skill, errors } = await createFixture(t);
	const runner = session.extensionRunner;
	await runner.emitBeforeAgentStart({ messageType: "user", prompt: "Hello" }, { cwd: skill.baseDir, skills: [] });
	await runner.emitBeforeAgentStart({
		messageType: "custom",
		message: {
			role: "custom",
			customType: "test-trigger",
			content: `<skill name="${skill.name}" location="${skill.filePath}">Not a user prompt</skill>`,
			display: false,
			timestamp: Date.now(),
		},
	}, { cwd: skill.baseDir, skills: [skill] });
	assert.equal(readLoadedSkills(session.sessionManager.getBranch()).size, 0);
	await runner.emitToolCall({
		type: "tool_call", toolName: "read", toolCallId: "skill-read", input: { path: skill.filePath },
	});
	await runner.emitToolResult({
		type: "tool_result", toolName: "read", toolCallId: "skill-read", input: { path: skill.filePath },
		content: [{ type: "text", text: "Skill instructions" }], details: undefined, isError: false,
	});
	assert.deepEqual([...readLoadedSkills(session.sessionManager.getBranch())], [skill.name]);
	assert.deepEqual(errors, []);
});

test("context and session commands make no model request or transcript entries", async (t) => {
	const { session, errors, reports } = await createFixture(t);
	const before = session.sessionManager.getEntries();
	await session.prompt("/ctx");
	await session.prompt("/ctx session json");
	await session.prompt("/ctx session branch json");
	assert.equal(reports.length, 3);
	assert.match(reports[0] ?? "", /context/i);
	assert.equal(JSON.parse(reports[1] ?? "").scope, "session");
	assert.equal(JSON.parse(reports[2] ?? "").scope, "branch");
	assert.deepEqual(session.sessionManager.getEntries(), before);
	assert.deepEqual(errors, []);
});
