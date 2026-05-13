# Pi Agent Config

Personal configuration for the Pi coding agent.

## Contents

- `agent/settings.json` — default provider, model, thinking level, and skill paths.
- `agent/APPEND_SYSTEM.md` — shared writing and communication instructions.
- `agent/APPEND_SYSTEM.d/` — model- or provider-specific system prompt additions.
- `agent/extensions/` — local Pi extensions and commands.

## Extensions

- `model-append-system.ts` — appends extra system instructions based on the active provider/model and project-local `.pi/APPEND_SYSTEM.d` files.
- `questionnaire.ts` — adds an interactive questionnaire tool for choosing from options or entering custom answers.
- `video-editor.ts` — adds commands that route video editing requests to the video pipeline skills.

## Ignored files

The repo excludes local secrets, sessions, and installed binaries:

- `agent/auth.json`
- `agent/sessions/`
- `agent/bin/`
