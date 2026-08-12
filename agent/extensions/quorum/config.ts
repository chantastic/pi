import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export type ReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max";

export interface PanelSpec {
	label: string;
	provider: string;
	modelId: string;
}

export interface QuorumConfig {
	models: PanelSpec[];
	chair: string;
	reasoningEffort: ReasoningEffort;
	minimumPanelists: number;
	maxSourceChars: number;
	outputTokens: {
		independent: number;
		deliberation: number;
		synthesis: number;
	};
}

export const DEFAULT_CONFIG: QuorumConfig = {
	models: [
		{
			label: "Claude",
			provider: "cloudflare-ai-gateway",
			modelId: "claude-fable-5",
		},
		{
			label: "OpenAI",
			provider: "cloudflare-ai-gateway",
			modelId: "gpt-5.6-sol",
		},
		{
			label: "Grok",
			provider: "cloudflare-ai-gateway",
			modelId: "$latest-grok-reasoning",
		},
	],
	chair: "Claude",
	reasoningEffort: "high",
	minimumPanelists: 2,
	maxSourceChars: 240_000,
	outputTokens: {
		independent: 8_192,
		deliberation: 8_192,
		synthesis: 12_288,
	},
};

export const QUORUM_CONFIG_PATH = join(getAgentDir(), "quorum.json");

const EFFORTS = new Set<ReasoningEffort>(["low", "medium", "high", "xhigh", "max"]);

function positiveInteger(value: unknown, fallback: number, field: string): number {
	if (value === undefined) return fallback;
	if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
		throw new Error(`${field} must be a positive integer`);
	}
	return value;
}

export function loadConfig(): QuorumConfig {
	let raw: any;
	try {
		raw = JSON.parse(readFileSync(QUORUM_CONFIG_PATH, "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return DEFAULT_CONFIG;
		throw new Error(`Could not read ${QUORUM_CONFIG_PATH}: ${error instanceof Error ? error.message : String(error)}`);
	}

	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		throw new Error(`${QUORUM_CONFIG_PATH} must contain a JSON object`);
	}

	const models = raw.models ?? DEFAULT_CONFIG.models;
	if (!Array.isArray(models) || models.length < 2) {
		throw new Error("quorum models must contain at least two panelists");
	}

	const parsedModels: PanelSpec[] = models.map((model: any, index: number) => {
		if (!model || typeof model !== "object") throw new Error(`models[${index}] must be an object`);
		for (const key of ["label", "provider", "modelId"] as const) {
			if (typeof model[key] !== "string" || !model[key].trim()) {
				throw new Error(`models[${index}].${key} must be a non-empty string`);
			}
		}
		return {
			label: model.label.trim(),
			provider: model.provider.trim(),
			modelId: model.modelId.trim(),
		};
	});

	const labels = new Set(parsedModels.map((model) => model.label.toLowerCase()));
	if (labels.size !== parsedModels.length) throw new Error("quorum model labels must be unique");

	const chair = raw.chair ?? DEFAULT_CONFIG.chair;
	if (typeof chair !== "string" || !parsedModels.some((model) => model.label === chair)) {
		throw new Error(`quorum chair must match one of: ${parsedModels.map((model) => model.label).join(", ")}`);
	}

	const reasoningEffort = raw.reasoningEffort ?? DEFAULT_CONFIG.reasoningEffort;
	if (!EFFORTS.has(reasoningEffort)) {
		throw new Error(`reasoningEffort must be one of: ${Array.from(EFFORTS).join(", ")}`);
	}

	const minimumPanelists = positiveInteger(
		raw.minimumPanelists,
		DEFAULT_CONFIG.minimumPanelists,
		"minimumPanelists",
	);
	if (minimumPanelists < 2 || minimumPanelists > parsedModels.length) {
		throw new Error(`minimumPanelists must be between 2 and ${parsedModels.length}`);
	}

	const outputTokens = raw.outputTokens ?? {};
	if (!outputTokens || typeof outputTokens !== "object" || Array.isArray(outputTokens)) {
		throw new Error("outputTokens must be an object");
	}

	return {
		models: parsedModels,
		chair,
		reasoningEffort,
		minimumPanelists,
		maxSourceChars: positiveInteger(raw.maxSourceChars, DEFAULT_CONFIG.maxSourceChars, "maxSourceChars"),
		outputTokens: {
			independent: positiveInteger(
				outputTokens.independent,
				DEFAULT_CONFIG.outputTokens.independent,
				"outputTokens.independent",
			),
			deliberation: positiveInteger(
				outputTokens.deliberation,
				DEFAULT_CONFIG.outputTokens.deliberation,
				"outputTokens.deliberation",
			),
			synthesis: positiveInteger(
				outputTokens.synthesis,
				DEFAULT_CONFIG.outputTokens.synthesis,
				"outputTokens.synthesis",
			),
		},
	};
}
