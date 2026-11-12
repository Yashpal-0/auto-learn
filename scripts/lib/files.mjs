// File helpers shared by the skill store and the plugin state.
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

/** Replaces `file` through a temporary sibling, so readers never see a partial file. */
export async function writeFileAtomic(file, content, mode = 0o644) {
	const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
	try {
		const handle = await fs.open(temp, "wx", mode);
		try {
			await handle.writeFile(content, "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
		await fs.rename(temp, file);
	} catch (error) {
		await fs.rm(temp, { force: true });
		throw error;
	}
}
