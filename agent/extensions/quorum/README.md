# Quorum

A Pi extension that asks distinct frontier models to independently evaluate an artifact, reconsider their views against
anonymous peer reviews, and return one unified recommendation.

## Process

A normal run makes seven model calls:

1. Three independent reviews run in parallel.
2. The same three models receive all anonymized reviews and reconsider in parallel.
3. One configured chair synthesizes a single answer. If the chair fails, another successful panelist is tried.

The visible result contains only the synthesis. Expand the custom message to inspect individual reviews, reconsidered
positions, model IDs, usage, and cost.

## Usage

```text
/quorum
/quorum session
/quorum session Should we ship this?
/quorum latest -- Focus on narrative clarity
/quorum document docs/plan.md -- Is this technically sound?
/quorum docs/plan.md -- Evaluate launch readiness
/quorum status
/quorum help
```

Bare `/quorum` offers the last successful `write`/`edit` target and the current session when both are available. In
non-TUI modes it defaults to the session.

Session review honors the active branch and compaction state. It includes user/assistant text, tool calls, bounded tool
results, and summaries, but excludes assistant thinking and previous quorum reports.

## Configuration

Edit `~/.pi/agent/quorum.json`. It is read on every invocation, so model/config changes do not require reload.

Default panel:

- `cloudflare-ai-gateway/claude-fable-5`
- `cloudflare-ai-gateway/gpt-5.6-sol`
- `$latest-grok-reasoning` on `cloudflare-ai-gateway`

`$latest-grok-reasoning` resolves at run time to the newest available reasoning-capable general Grok model. It excludes
non-reasoning, multi-agent, image/video, build/code, fast, and mini variants. Exact models fall back to another
authenticated provider with the same model ID if the configured provider is unavailable.

Example:

```json
{
	"models": [
		{ "label": "Claude", "provider": "anthropic", "modelId": "claude-fable-5" },
		{ "label": "OpenAI", "provider": "openai-codex", "modelId": "gpt-5.6-sol" },
		{ "label": "Grok", "provider": "cloudflare-ai-gateway", "modelId": "$latest-grok-reasoning" }
	],
	"chair": "Claude",
	"reasoningEffort": "high",
	"minimumPanelists": 2,
	"maxSourceChars": 240000,
	"outputTokens": {
		"independent": 8192,
		"deliberation": 8192,
		"synthesis": 12288
	}
}
```

Use `/quorum status` to verify model resolution before spending tokens.

## Privacy and cost

The selected session/document is sent to every successful panel model in both rounds and to the synthesis model. Prompt
caching is disabled (`cacheRetention: "none"`). The default source cap is 240,000 characters; oversized sources preserve
their beginning and end with an omission marker.

Quorum records nested-call usage and estimated provider cost in its custom message details. Because this work is
launched by a command rather than a tool result, Pi's normal session footer does not add these calls to its aggregate
usage.

Press Escape while the loader is visible to abort all in-flight calls.

## Installation

This extension is installed globally at `~/.pi/agent/extensions/quorum/`. Run `/reload` in an existing Pi session; new
sessions discover it automatically.
