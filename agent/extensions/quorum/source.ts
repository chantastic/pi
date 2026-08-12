import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { buildSessionContext, type SessionEntry } from "@earendil-works/pi-coding-agent";

export interface QuorumSource {
	kind: "session" | "document";
	label: string;
	text: string;
	path?: string;
	truncated: boolean;
	originalChars?: number;
	originalBytes?: number;
}

const SESSION_TOOL_RESULT_CHARS = 4_000;
const SESSION_TOOL_CALL_CHARS = 8_000;

function truncateMiddle(text: string, maxChars: number, headRatio: number): { text: string; truncated: boolean } {
	if (text.length <= maxChars) return { text, truncated: false };

	const omitted = text.length - maxChars;
	const marker = `\n\n[... ${omitted.toLocaleString()} characters omitted by quorum ...]\n\n`;
	if (marker.length >= maxChars) return { text: text.slice(0, maxChars), truncated: true };
	const available = maxChars - marker.length;
	const headChars = Math.floor(available * headRatio);
	const tailChars = available - headChars;
	return {
		text: `${text.slice(0, headChars)}${marker}${text.slice(text.length - tailChars)}`,
		truncated: true,
	};
}

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block: any) => {
			if (block?.type === "text" && typeof block.text === "string") return block.text;
			if (block?.type === "image") return `[image: ${block.mimeType ?? "unknown type"}]`;
			return "";
		})
		.filter(Boolean)
		.join("\n");
}

function boundedJson(value: unknown, maxChars: number): string {
	let serialized: string;
	try {
		serialized = JSON.stringify(value);
	} catch {
		serialized = "[unserializable arguments]";
	}
	if (serialized.length <= maxChars) return serialized;
	return `${serialized.slice(0, maxChars)}… [arguments truncated]`;
}

function serializeSession(messages: AgentMessage[]): string {
	const sections: string[] = [];

	for (const message of messages as any[]) {
		switch (message.role) {
			case "user": {
				const text = contentText(message.content).trim();
				if (text) sections.push(`[User]\n${text}`);
				break;
			}
			case "assistant": {
				const text = contentText(message.content).trim();
				if (text) sections.push(`[Assistant]\n${text}`);

				const calls = Array.isArray(message.content)
					? message.content
						.filter((block: any) => block?.type === "toolCall" && typeof block.name === "string")
						.map(
							(block: any) => `${block.name}(${boundedJson(block.arguments ?? {}, SESSION_TOOL_CALL_CHARS)})`,
						)
					: [];
				if (calls.length > 0) sections.push(`[Assistant tool calls]\n${calls.join("\n")}`);
				break;
			}
			case "toolResult": {
				const text = contentText(message.content).trim();
				if (text) {
					const bounded = text.length <= SESSION_TOOL_RESULT_CHARS
						? text
						: `${text.slice(0, SESSION_TOOL_RESULT_CHARS)}\n[tool result truncated]`;
					sections.push(
						`[Tool result: ${message.toolName ?? "unknown"}${message.isError ? ", error" : ""}]\n${bounded}`,
					);
				}
				break;
			}
			case "compactionSummary":
				if (typeof message.summary === "string") sections.push(`[Earlier conversation summary]\n${message.summary}`);
				break;
			case "branchSummary":
				if (typeof message.summary === "string") sections.push(`[Prior branch summary]\n${message.summary}`);
				break;
			case "bashExecution":
				if (!message.excludeFromContext) {
					sections.push(`[User shell command]\n$ ${message.command}\n${message.output ?? ""}`);
				}
				break;
			case "custom":
				// Avoid recursively reviewing previous quorum reports.
				if (message.customType !== "quorum") {
					const text = contentText(message.content).trim();
					if (text) sections.push(`[Extension: ${message.customType ?? "custom"}]\n${text}`);
				}
				break;
		}
	}

	return sections.join("\n\n---\n\n");
}

export function buildSessionSource(entries: SessionEntry[], leafId: string | null, maxChars: number): QuorumSource {
	const context = buildSessionContext(entries, leafId);
	const serialized = serializeSession(context.messages);
	if (!serialized.trim()) throw new Error("The current session has no reviewable content");
	const bounded = truncateMiddle(serialized, maxChars, 0.3);
	return {
		kind: "session",
		label: "current session",
		text: bounded.text,
		truncated: bounded.truncated,
		originalChars: serialized.length,
	};
}

function normalizePath(input: string, cwd: string): string {
	let value = input.trim();
	if (value.startsWith("@")) value = value.slice(1);
	if (value === "~") value = homedir();
	else if (value.startsWith("~/")) value = resolve(homedir(), value.slice(2));
	return isAbsolute(value) ? resolve(value) : resolve(cwd, value);
}

export function resolveExistingFile(input: string, cwd: string): string | undefined {
	if (!input.trim()) return undefined;
	const path = normalizePath(input, cwd);
	try {
		return statSync(path).isFile() ? path : undefined;
	} catch {
		return undefined;
	}
}

export function displayPath(path: string, cwd: string): string {
	const local = relative(cwd, path);
	if (local && !local.startsWith("..") && !isAbsolute(local)) return local;
	const home = homedir();
	return path.startsWith(`${home}/`) ? `~/${relative(home, path)}` : path;
}

export function findLatestProducedDocument(branch: SessionEntry[], cwd: string): string | undefined {
	const toolResults = new Map<string, boolean>();
	for (const entry of branch) {
		if (entry.type !== "message" || entry.message.role !== "toolResult") continue;
		toolResults.set(entry.message.toolCallId, !entry.message.isError);
	}

	for (let entryIndex = branch.length - 1; entryIndex >= 0; entryIndex--) {
		const entry = branch[entryIndex];
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;

		for (let blockIndex = entry.message.content.length - 1; blockIndex >= 0; blockIndex--) {
			const block = entry.message.content[blockIndex];
			if (block.type !== "toolCall" || (block.name !== "write" && block.name !== "edit")) continue;
			if (toolResults.get(block.id) === false) continue;

			const args = block.arguments as { path?: unknown; file_path?: unknown };
			const rawPath = typeof args.path === "string"
				? args.path
				: typeof args.file_path === "string"
				? args.file_path
				: undefined;
			if (!rawPath) continue;

			const path = normalizePath(rawPath, cwd);
			try {
				if (existsSync(path) && statSync(path).isFile()) return path;
			} catch {
				// Keep looking for an earlier successful file operation.
			}
		}
	}

	return undefined;
}

function readLargeFileSample(path: string, size: number, maxChars: number): string {
	const byteBudget = Math.max(16_384, maxChars * 2);
	const headBytes = Math.min(size, Math.floor(byteBudget * 0.45));
	const tailBytes = Math.min(size - headBytes, byteBudget - headBytes);
	const head = Buffer.alloc(headBytes);
	const tail = Buffer.alloc(tailBytes);
	const fd = openSync(path, "r");
	try {
		readSync(fd, head, 0, headBytes, 0);
		if (tailBytes > 0) readSync(fd, tail, 0, tailBytes, size - tailBytes);
		const currentSize = fstatSync(fd).size;
		if (currentSize !== size) throw new Error("File changed while quorum was reading it; run quorum again");
	} finally {
		closeSync(fd);
	}
	return `${head.toString("utf8")}\n\n[... middle of large file omitted by quorum ...]\n\n${tail.toString("utf8")}`;
}

export function loadDocumentSource(inputPath: string, cwd: string, maxChars: number): QuorumSource {
	const path = normalizePath(inputPath, cwd);
	let stats: ReturnType<typeof statSync>;
	try {
		stats = statSync(path);
	} catch (error) {
		throw new Error(
			`Could not read ${displayPath(path, cwd)}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (!stats.isFile()) throw new Error(`${displayPath(path, cwd)} is not a file`);

	const probe = Buffer.alloc(Math.min(stats.size, 8_192));
	if (probe.length > 0) {
		const fd = openSync(path, "r");
		try {
			readSync(fd, probe, 0, probe.length, 0);
		} finally {
			closeSync(fd);
		}
		if (probe.includes(0)) throw new Error(`${displayPath(path, cwd)} appears to be binary`);
	}

	const sampled = stats.size > maxChars * 4;
	const content = sampled ? readLargeFileSample(path, stats.size, maxChars) : readFileSync(path, "utf8");
	const bounded = truncateMiddle(content, maxChars, 0.5);
	return {
		kind: "document",
		label: displayPath(path, cwd),
		path,
		text: bounded.text,
		truncated: sampled || bounded.truncated,
		originalChars: sampled ? undefined : content.length,
		originalBytes: stats.size,
	};
}
