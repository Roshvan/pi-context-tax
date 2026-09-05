import { formatSkillsForPrompt, type BuildSystemPromptOptions } from "@earendil-works/pi-coding-agent";

const PI_BASE_MARKER = "You are an expert coding assistant operating inside pi";

const MIN_REPORTED_GAP = 160;

const SKILL_PREAMBLE = `The following skills provide specialized instructions for specific tasks.
Use the read tool to load a skill's file when the task matches its description.
When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.`;

function isKnownScaffolding(text: string): boolean {
	const remainder = text
		.replaceAll("<project_context>", "")
		.replaceAll("</project_context>", "")
		.replaceAll("Project-specific instructions and guidelines:", "")
		.replaceAll(SKILL_PREAMBLE, "")
		.replaceAll("<available_skills>", "")
		.replaceAll("</available_skills>", "");
	return remainder.trim().length === 0;
}

interface PromptSegment {
	kind: "system" | "injection";
	label: string;
	text: string;
	chars: number;
	unlocated?: boolean;
}

interface Claim {
	start: number;
	end: number;
	label: string;
	injected?: boolean;
}

interface Candidate {
	label: string;
	literal: string;
}

function findFreeSpan(prompt: string, literal: string, claims: Claim[]): { start: number; end: number } | undefined {
	if (literal.length === 0) return undefined;
	let from = 0;
	for (;;) {
		const start = prompt.indexOf(literal, from);
		if (start < 0) return undefined;
		const end = start + literal.length;
		const overlaps = claims.some((claim) => start < claim.end && end > claim.start);
		if (!overlaps) return { start, end };
		from = start + 1;
	}
}

function freeSubSpans(start: number, end: number, claims: Claim[]): Array<{ start: number; end: number }> {
	const blocking = claims
		.filter((claim) => claim.start >= 0 && claim.start < end && claim.end > start)
		.sort((a, b) => a.start - b.start);
	const spans: Array<{ start: number; end: number }> = [];
	let cursor = start;
	for (const claim of blocking) {
		if (claim.start > cursor) spans.push({ start: cursor, end: claim.start });
		cursor = Math.max(cursor, claim.end);
	}
	if (cursor < end) spans.push({ start: cursor, end });
	return spans;
}

function declaredCandidates(options: BuildSystemPromptOptions): Candidate[] {
	const candidates: Candidate[] = [];
	if (options.customPrompt) candidates.push({ label: "custom system prompt", literal: options.customPrompt });
	if (options.appendSystemPrompt) {
		candidates.push({ label: "appended system prompt", literal: options.appendSystemPrompt });
	}
	for (const file of options.contextFiles ?? []) {
		candidates.push({
			label: `project context · ${file.path}`,
			literal: `<project_instructions path="${file.path}">\n${file.content}\n</project_instructions>`,
		});
	}
	return candidates;
}

const SKILL_OPEN = "  <skill>";
const SKILL_CLOSE = "  </skill>";

function claimSkills(prompt: string, options: BuildSystemPromptOptions, claims: Claim[]): void {
	if (options.selectedTools !== undefined && !options.selectedTools.includes("read")) return;
	const skills = (options.skills ?? []).filter((skill) => !skill.disableModelInvocation);
	if (skills.length === 0) return;
	let section: string;
	try {
		section = formatSkillsForPrompt(skills);
	} catch {
		return;
	}
	if (section.length === 0) return;
	const span = findFreeSpan(prompt, section, claims);
	if (!span) {
		claims.push({ start: -1, end: -1, label: `skill index · ${skills.length} skills · not found in prompt` });
		return;
	}

	const entries: Array<{ start: number; end: number }> = [];
	let cursor = 0;
	for (;;) {
		const open = section.indexOf(SKILL_OPEN, cursor);
		if (open < 0) break;
		const close = section.indexOf(SKILL_CLOSE, open);
		if (close < 0) break;
		entries.push({ start: open, end: close + SKILL_CLOSE.length });
		cursor = close + SKILL_CLOSE.length;
	}

	if (entries.length !== skills.length) {
		claims.push({ start: span.start, end: span.end, label: `skill index · ${skills.length} skills` });
		return;
	}
	for (let index = 0; index < entries.length; index++) {
		const entry = entries[index];
		const skill = skills[index];
		if (entry === undefined || skill === undefined) continue;
		claims.push({
			start: span.start + entry.start,
			end: span.start + entry.end,
			label: `skill · ${skill.name}`,
		});
	}
}

function diffInsertion(baseline: string, actual: string): { start: number; end: number } | undefined {
	if (baseline === actual || actual.length <= baseline.length) return undefined;
	const limit = baseline.length;
	let prefix = 0;
	while (prefix < limit && baseline[prefix] === actual[prefix]) prefix++;
	let suffix = 0;
	while (
		suffix < limit - prefix
		&& baseline[baseline.length - 1 - suffix] === actual[actual.length - 1 - suffix]
	) {
		suffix++;
	}

	const start = prefix;
	const end = actual.length - suffix;
	if (end <= start) return undefined;
	const stranded = baseline.slice(prefix, baseline.length - suffix);
	if (!actual.slice(start, end).includes(stranded)) return undefined;
	return { start, end };
}

export function attributeSystemPrompt(
	prompt: string,
	options: BuildSystemPromptOptions | undefined,
	baseline?: string,
): PromptSegment[] {
	if (prompt.length === 0) return [];
	if (!options) {
		return [{ kind: "system", label: "system prompt", text: prompt, chars: prompt.length }];
	}

	const claims: Claim[] = [];
	const unlocated: PromptSegment[] = [];
	for (const candidate of declaredCandidates(options)) {
		const span = findFreeSpan(prompt, candidate.literal, claims);
		if (span) claims.push({ start: span.start, end: span.end, label: candidate.label });
		else unlocated.push({ kind: "system", label: candidate.label, text: candidate.literal, chars: 0, unlocated: true });
	}
	claimSkills(prompt, options, claims);
	if (baseline !== undefined && baseline !== prompt) {
		const inserted = diffInsertion(baseline, prompt);
		if (inserted) {
			const parts = freeSubSpans(inserted.start, inserted.end, claims);
			for (let index = 0; index < parts.length; index++) {
				const part = parts[index];
				if (part === undefined) continue;
				claims.push({
					...part,
					label: parts.length > 1 ? `extension injection ${index + 1}` : "extension injection",
					injected: true,
				});
			}
		} else {
			unlocated.push({
				kind: "injection",
				label: "extension rewrote the system prompt",
				text: "",
				chars: 0,
				unlocated: true,
			});
		}
	}

	const located = claims.filter((claim) => claim.start >= 0).sort((a, b) => a.start - b.start);
	for (const claim of claims) {
		if (claim.start < 0) unlocated.push({ kind: "system", label: claim.label, text: "", chars: 0, unlocated: true });
	}

	const segments: PromptSegment[] = [];
	let scaffolding = 0;
	let cursor = 0;
	let unattributedIndex = 0;
	const flushGap = (start: number, end: number): void => {
		if (end <= start) return;
		const text = prompt.slice(start, end);
		if (text.trim().length < MIN_REPORTED_GAP || isKnownScaffolding(text)) {
			scaffolding += text.length;
			return;
		}
		const markerAt = text.indexOf(PI_BASE_MARKER);
		if (markerAt >= 0) {
			if (markerAt > 0) flushGap(start, start + markerAt);
			const base = text.slice(markerAt);
			segments.push({ kind: "system", label: "Pi base prompt", text: base, chars: base.length });
			return;
		}
		unattributedIndex++;
		segments.push({
			kind: "injection",
			label: `unattributed span ${unattributedIndex}`,
			text,
			chars: text.length,
		});
	};

	for (const claim of located) {
		flushGap(cursor, claim.start);
		const text = prompt.slice(claim.start, claim.end);
		segments.push({ kind: claim.injected ? "injection" : "system", label: claim.label, text, chars: text.length });
		cursor = claim.end;
	}
	flushGap(cursor, prompt.length);
	if (scaffolding > 0) {
		segments.push({
			kind: "system",
			label: "prompt scaffolding · tags, headers, cwd",
			text: "",
			chars: scaffolding,
		});
	}
	return [...segments, ...unlocated];
}
