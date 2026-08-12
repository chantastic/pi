import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { BorderedLoader, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Box, Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { loadConfig, QUORUM_CONFIG_PATH, type QuorumConfig } from "./config.ts";
import { type QuorumDetails, type QuorumRun, resolvePanelModels, runQuorum } from "./quorum.ts";
import {
	buildSessionSource,
	displayPath,
	findLatestProducedDocument,
	loadDocumentSource,
	type QuorumSource,
	resolveExistingFile,
} from "./source.ts";

const DEFAULT_FOCUS =
	"Infer the artifact's primary objective. Evaluate correctness, coherence, quality, material risks, blind spots, and the highest-leverage next actions.";

interface ParsedCommand {
	action: "run" | "status" | "help";
	sourceMode: "auto" | "session" | "latest" | "document";
	path?: string;
	focus?: string;
}

function splitFocus(args: string): { sourcePart: string; focus?: string } {
	const match = args.match(/^(.*?)\s+--\s+([\s\S]+)$/);
	if (!match) return { sourcePart: args.trim() };
	return { sourcePart: match[1].trim(), focus: match[2].trim() || undefined };
}

function parseCommand(args: string, cwd: string): ParsedCommand {
	const trimmed = args.trim();
	if (!trimmed) return { action: "run", sourceMode: "auto" };
	if (trimmed === "status") return { action: "status", sourceMode: "auto" };
	if (trimmed === "help" || trimmed === "--help" || trimmed === "-h") {
		return { action: "help", sourceMode: "auto" };
	}

	const { sourcePart, focus: explicitFocus } = splitFocus(trimmed);
	const firstSpace = sourcePart.search(/\s/);
	const first = (firstSpace === -1 ? sourcePart : sourcePart.slice(0, firstSpace)).toLowerCase();
	const rest = firstSpace === -1 ? "" : sourcePart.slice(firstSpace).trim();

	if (first === "session" || first === "current") {
		return { action: "run", sourceMode: "session", focus: (explicitFocus ?? rest) || undefined };
	}
	if (first === "latest") {
		return { action: "run", sourceMode: "latest", focus: (explicitFocus ?? rest) || undefined };
	}
	if (first === "document" || first === "doc" || first === "file") {
		return { action: "run", sourceMode: "document", path: rest || undefined, focus: explicitFocus };
	}

	const existingPath = resolveExistingFile(sourcePart, cwd);
	if (existingPath) {
		return { action: "run", sourceMode: "document", path: existingPath, focus: explicitFocus };
	}

	return { action: "run", sourceMode: "auto", focus: explicitFocus ?? trimmed };
}

function helpText(): string {
	return `# Quorum

Run independent frontier-model reviews, one cross-review round, then a single synthesis.

- \`/quorum\` — choose latest edited file or current session
- \`/quorum session [focus]\`
- \`/quorum latest [-- focus]\`
- \`/quorum document <path> [-- focus]\`
- \`/quorum <path> [-- focus]\`
- \`/quorum <focus>\` — choose a source, then apply the focus
- \`/quorum status\` — show model resolution and inferred latest file

Configuration: \`${QUORUM_CONFIG_PATH}\``;
}

function sendPlainMessage(pi: ExtensionAPI, customType: string, content: string, details?: unknown): void {
	pi.sendMessage({ customType, content, display: true, details });
}

async function selectSourceMode(
	ctx: ExtensionCommandContext,
	latestPath: string | undefined,
): Promise<"session" | "latest" | undefined> {
	if (!latestPath || ctx.mode !== "tui") return "session";
	const latestLabel = `Latest edited file: ${displayPath(latestPath, ctx.cwd)}`;
	const currentLabel = "Current session";
	const selected = await ctx.ui.select("What should quorum review?", [latestLabel, currentLabel]);
	if (selected === latestLabel) return "latest";
	if (selected === currentLabel) return "session";
	return undefined;
}

async function resolveSource(
	parsed: ParsedCommand,
	ctx: ExtensionCommandContext,
	config: QuorumConfig,
): Promise<QuorumSource | undefined> {
	const branch = ctx.sessionManager.getBranch();
	const latestPath = findLatestProducedDocument(branch, ctx.cwd);
	let mode = parsed.sourceMode;

	if (mode === "auto") {
		const selected = await selectSourceMode(ctx, latestPath);
		if (!selected) return undefined;
		mode = selected;
	}

	if (mode === "session") {
		return buildSessionSource(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId(), config.maxSourceChars);
	}

	if (mode === "latest") {
		if (!latestPath) throw new Error("No successful write/edit target was found in the current session");
		return loadDocumentSource(latestPath, ctx.cwd, config.maxSourceChars);
	}

	let path = parsed.path;
	if (!path && ctx.mode === "tui") {
		path = await ctx.ui.input("Document path", latestPath ? displayPath(latestPath, ctx.cwd) : "path/to/document.md");
	}
	if (!path && latestPath) path = latestPath;
	if (!path) throw new Error("Usage: /quorum document <path> [-- focus]");
	return loadDocumentSource(path, ctx.cwd, config.maxSourceChars);
}

function statusText(config: QuorumConfig, ctx: ExtensionCommandContext): string {
	const resolved = resolvePanelModels(ctx, config);
	const latest = findLatestProducedDocument(ctx.sessionManager.getBranch(), ctx.cwd);
	const lines = [
		"# Quorum status",
		"",
		`Config: \`${QUORUM_CONFIG_PATH}\``,
		`Reasoning: \`${config.reasoningEffort}\``,
		`Minimum panelists: ${config.minimumPanelists}`,
		`Source limit: ${config.maxSourceChars.toLocaleString()} characters`,
		`Latest edited file: ${latest ? `\`${displayPath(latest, ctx.cwd)}\`` : "none inferred"}`,
		"",
		"## Resolved panel",
		...resolved.panels.map(
			(panel) =>
				`- **${panel.label}**: \`${panel.model.provider}/${panel.model.id}\` (requested \`${panel.requested}\`)`,
		),
	];
	if (resolved.missing.length > 0) {
		lines.push("", "## Unavailable", ...resolved.missing.map((item) => `- ${item}`));
	}
	return lines.join("\n");
}

function isAbort(error: unknown): boolean {
	return error instanceof DOMException
		? error.name === "AbortError"
		: error instanceof Error && (error.name === "AbortError" || /cancelled|aborted/i.test(error.message));
}

async function runWithLoader(
	ctx: ExtensionCommandContext,
	task: (signal: AbortSignal) => Promise<QuorumRun>,
): Promise<{ run?: QuorumRun; error?: string; cancelled?: true }> {
	if (ctx.mode !== "tui") {
		try {
			return { run: await task(new AbortController().signal) };
		} catch (error) {
			if (isAbort(error)) return { cancelled: true };
			return { error: error instanceof Error ? error.message : String(error) };
		}
	}

	const result = await ctx.ui.custom<{ run?: QuorumRun; error?: string } | null>((tui, theme, _kb, done) => {
		const loader = new BorderedLoader(
			tui,
			theme,
			"Quorum: independent reviews → cross-review → unified guidance (Esc to cancel)",
		);
		loader.onAbort = () => done(null);
		task(loader.signal)
			.then((run) => done({ run }))
			.catch((error) => {
				if (isAbort(error)) done(null);
				else done({ error: error instanceof Error ? error.message : String(error) });
			});
		return loader;
	});

	if (result === null) return { cancelled: true };
	return result;
}

function contentString(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block: any) => block?.type === "text" && typeof block.text === "string")
		.map((block: any) => block.text)
		.join("\n");
}

function formatTokens(value: number): string {
	if (value < 1_000) return String(value);
	if (value < 1_000_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}k`;
	return `${(value / 1_000_000).toFixed(1)}M`;
}

export default function quorumExtension(pi: ExtensionAPI) {
	pi.registerMessageRenderer("quorum", (message, { expanded, outputPad }, theme) => {
		const details = message.details as QuorumDetails | undefined;
		const box = new Box(outputPad, 1, (text) => theme.bg("customMessageBg", text));
		const container = new Container();
		const successful = details?.panel.filter((panel) => panel.initial).length ?? 0;
		const total = details?.panel.length ?? 0;
		const cost = details ? ` • $${details.usage.cost.toFixed(4)}` : "";
		const source = details ? ` • ${details.source.label}` : "";
		container.addChild(
			new Text(
				theme.fg("accent", theme.bold("QUORUM")) +
					theme.fg(
						"muted",
						details ? ` • ${successful}/${total} panelists • chair: ${details.chair}${cost}${source}` : "",
					),
				0,
				0,
			),
		);
		container.addChild(new Spacer(1));
		container.addChild(new Markdown(contentString(message.content), 0, 0, getMarkdownTheme()));

		if (expanded && details) {
			container.addChild(new Spacer(1));
			container.addChild(
				new Text(
					theme.fg(
						"dim",
						`Usage: ↑${formatTokens(details.usage.input)} ↓${formatTokens(details.usage.output)} R${
							formatTokens(details.usage.cacheRead)
						} W${formatTokens(details.usage.cacheWrite)}${
							details.usage.reasoning ? ` reasoning:${formatTokens(details.usage.reasoning)}` : ""
						}`,
					),
					0,
					0,
				),
			);
			for (const panel of details.panel) {
				const sections = [
					`## ${panel.label} · \`${panel.model}\``,
					panel.error
						? `**Independent review failed:** ${panel.error}`
						: `### Independent review\n${panel.initial ?? "Unavailable"}`,
					panel.deliberationError
						? `### Cross-review failed\n${panel.deliberationError}`
						: `### Reconsidered position\n${panel.deliberation ?? "Unavailable"}`,
				];
				container.addChild(new Spacer(1));
				container.addChild(new Markdown(sections.join("\n\n"), 0, 0, getMarkdownTheme()));
			}
		}

		box.addChild(container);
		return box;
	});

	pi.registerCommand("quorum", {
		description: "Get unified guidance from a deliberating frontier-model panel",
		getArgumentCompletions: (prefix) => {
			const items = ["session", "latest", "document", "status", "help"]
				.filter((value) => value.startsWith(prefix))
				.map((value) => ({ value, label: value }));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			await ctx.waitForIdle();

			let config: QuorumConfig;
			try {
				config = loadConfig();
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				return;
			}

			const parsed = parseCommand(args, ctx.cwd);
			if (parsed.action === "help") {
				sendPlainMessage(pi, "quorum-help", helpText());
				return;
			}
			if (parsed.action === "status") {
				sendPlainMessage(pi, "quorum-status", statusText(config, ctx));
				return;
			}

			let source: QuorumSource | undefined;
			try {
				source = await resolveSource(parsed, ctx, config);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				return;
			}
			if (!source) {
				ctx.ui.notify("Quorum cancelled", "info");
				return;
			}

			const focus = parsed.focus?.trim() || DEFAULT_FOCUS;
			const outcome = await runWithLoader(ctx, (signal) => runQuorum(ctx, config, source!, focus, signal));
			if (outcome.cancelled) {
				ctx.ui.notify("Quorum cancelled", "info");
				return;
			}
			if (outcome.error || !outcome.run) {
				ctx.ui.notify(`Quorum failed: ${outcome.error ?? "unknown error"}`, "error");
				return;
			}

			pi.sendMessage({
				customType: "quorum",
				content: outcome.run.guidance,
				display: true,
				details: outcome.run.details,
			});
			ctx.ui.notify(
				`Quorum complete: ${outcome.run.details.panel.filter((panel) => panel.initial).length} panelists, $${
					outcome.run.details.usage.cost.toFixed(4)
				}`,
				"info",
			);
		},
	});
}
