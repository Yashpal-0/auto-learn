import assert from "node:assert/strict";
import { test } from "node:test";
import { setupOpenCode } from "../opencode/index.mjs";
import { nativeHost, proposal } from "./opencode-helpers.mjs";

const call = { sessionID: "ses_native", agent: "build", messageID: "msg_tool", id: "call_save" };

test("session guidance stays identical until a compaction, so saving a skill mid-session does not bust the cached prefix", async (t) => {
	const host = await nativeHost(t);
	host.ctx.options = { autoCapture: false };
	t.after(await setupOpenCode(host.ctx, { env: host.env }));
	const guidance = async (hook, sessionID = "ses_native") => {
		const request = { sessionID, agent: "build", system: [] };
		await host.hooks.session.get(hook)(request);
		return request.system.at(-1).text;
	};
	const before = await guidance("context");
	assert.doesNotMatch(before, /native-build:/);
	await host.tools.get("manage_skill").execute(proposal, call);
	assert.equal(await guidance("context"), before, "the block sits in the cached system prefix");
	assert.equal(await guidance("generate"), before);
	assert.match(await guidance("context", "ses_new"), /native-build: Use when building this project/, "a new session lists the skill");
	assert.match(await guidance("compaction"), /native-build:/, "a compaction re-baselines the prefix, so it refreshes the list");
	assert.match(await guidance("context"), /native-build:/, "later requests keep the refreshed list");
});
