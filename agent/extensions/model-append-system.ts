import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { getAgentDir } from "@mariozechner/pi-coding-agent";

function readIfExists(path: string): string | undefined {
	if (!existsSync(path)) return undefined;
	const content = readFileSync(path, "utf8").trim();
	return content.length > 0 ? content : undefined;
}

export default function modelAppendSystem(pi: ExtensionAPI) {
	pi.on("before_agent_start", async (event, ctx) => {
		if (!ctx.model) return;

		const agentDir = getAgentDir();
		const projectDir = join(ctx.cwd, ".pi", "APPEND_SYSTEM.d");
		const globalDir = join(agentDir, "APPEND_SYSTEM.d");
		const provider = ctx.model.provider;
		const modelId = ctx.model.id;

		const candidates = [
			join(globalDir, `${provider}.md`),
			join(globalDir, `${modelId}.md`),
			join(globalDir, `${provider}__${modelId}.md`),
			join(projectDir, `${provider}.md`),
			join(projectDir, `${modelId}.md`),
			join(projectDir, `${provider}__${modelId}.md`),
		];

		const additions = candidates
			.map(readIfExists)
			.filter((content): content is string => Boolean(content));

		if (additions.length === 0) return;

		return {
			systemPrompt: `${event.systemPrompt}\n\n${additions.join("\n\n")}`,
		};
	});
}
