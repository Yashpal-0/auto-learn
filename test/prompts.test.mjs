import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { captureNudge, fill, guidanceText, learnedSkillsText, manageSkillDescription } from "../scripts/lib/prompts.mjs";

test("fill substitutes each placeholder once and refuses a missing value", () => {
	assert.equal(fill("{{a}} and {{b}}", { a: "{{b}}", b: "x" }), "{{b}} and x");
	assert.throws(() => fill("{{missing}}", {}), /\{\{missing\}\}/);
});

test("the prompts name the skill library with the home directory shown as ~", () => {
	const library = path.join(os.homedir(), ".claude", "skills");
	for (const text of [guidanceText(library), manageSkillDescription(library)]) {
		assert.ok(text.includes(path.join("~", ".claude", "skills")), text);
		assert.doesNotMatch(text, /\{\{/);
	}
	assert.match(guidanceText(library), /manage_skill/);
});

test("the capture request says it is automatic and how to load manage_skill", () => {
	const tool = "mcp__plugin_auto-learn_auto-learn__manage_skill";
	const nudge = captureNudge(tool);
	assert.match(nudge, /^Automatic skill review/);
	assert.ok(nudge.includes(`select:${tool}`), nudge);
	assert.doesNotMatch(nudge, /\{\{/);
});

test("Codex gets its own wording: its skill library, its name, and tool_search to load manage_skill", () => {
	const library = path.join(os.homedir(), ".agents", "skills");
	const texts = [guidanceText(library, "codex"), manageSkillDescription(library, "codex"), learnedSkillsText([{ name: "a", description: "b" }], "codex")];
	for (const text of texts) {
		assert.doesNotMatch(text, /Claude|\{\{/, text);
	}
	for (const text of texts.slice(0, 2)) assert.ok(text.includes(path.join("~", ".agents", "skills")), text);
	assert.match(texts[0], /Codex offers/);
	const nudge = captureNudge("manage_skill", "codex");
	assert.match(nudge, /^Automatic skill review/);
	assert.match(nudge, /`tool_search`, query `manage_skill`/);
	assert.doesNotMatch(nudge, /Claude|select:|\{\{/);
});

test("OpenCode guidance names the native tool and its own skill library", () => {
	const library = path.join(os.homedir(), ".config", "opencode", "skills");
	const guidance = guidanceText(library, "opencode");
	const description = manageSkillDescription(library, "opencode");
	assert.match(guidance, /OpenCode/);
	assert.match(guidance, /auto_learn/);
	assert.ok(guidance.includes(path.join("~", ".config", "opencode", "skills")));
	assert.match(description, /OpenCode/);
	assert.doesNotMatch(`${guidance}\n${description}`, /Claude|Codex|\{\{/);
});

test("the learned-skill listing gives each skill a short description", () => {
	assert.equal(learnedSkillsText([]), "");
	const sentence = "Use when the docs build fails on a missing theme package.";
	const text = learnedSkillsText([
		{ name: "short-skill", description: "Use when testing" },
		{ name: "sentence-skill", description: `${sentence} ${"More detail follows here. ".repeat(10)}` },
		{ name: "long-skill", description: "words ".repeat(80).trim() },
		{ name: "bare-skill", description: "" },
	]);
	assert.match(text, /^## Learned skills\n/);
	assert.doesNotMatch(text, /\{\{/);
	const lines = text.split("\n").filter((line) => line.startsWith("- "));
	assert.equal(lines[0], "- short-skill: Use when testing");
	assert.equal(lines[1], `- sentence-skill: ${sentence}`);
	assert.match(lines[2], /^- long-skill: (words ){20,}words…$/);
	assert.ok(lines[2].length <= "- long-skill: ".length + 160, lines[2]);
	assert.equal(lines[3], "- bare-skill");
	assert.equal(lines.length, 4);
});

test("the learned-skill listing stops at its size limit and says how many older skills it left out", () => {
	const skills = Array.from({ length: 100 }, (_, i) => ({ name: `skill-${i}`, description: "x".repeat(100) }));
	const text = learnedSkillsText(skills);
	const listed = text.split("\n").filter((line) => line.startsWith("- skill-"));
	assert.ok(listed.length > 10 && listed.length < 100, `${listed.length} listed`);
	assert.equal(listed[0], `- skill-0: ${"x".repeat(100)}`);
	assert.ok(listed.join("\n").length <= 4000, `${listed.join("\n").length} characters`);
	assert.ok(text.endsWith(`\n- ${100 - listed.length} older learned skills are not listed here.`), text.slice(-80));
});
