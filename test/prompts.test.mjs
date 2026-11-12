import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { captureNudge, fill, guidanceText, manageSkillDescription } from "../scripts/lib/prompts.mjs";

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
