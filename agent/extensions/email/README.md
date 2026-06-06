# pi-extension-email

Minimal email-focused pi extension scaffold.

## What it includes

- `index.ts` — extension entrypoint (`export default function (pi) { ... }`)
- `package.json` — package metadata plus `pi.extensions` for easy extraction/distribution

## What it does

- Registers `/email`, which shows a placeholder
- Registers an `email_status` tool, which returns a placeholder

## Local install location

This lives at:

```text
~/.pi/agent/extensions/email/
```

Pi auto-discovers `~/.pi/agent/extensions/*/index.ts`, so `/reload` is enough after edits.

## Extract later

Copy this directory anywhere, then run with:

```bash
pi -e ./index.ts
```

Or package it as a pi package using the `pi.extensions` field already present in `package.json`.
