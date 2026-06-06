# pi-extension-hey

Minimal pi extension.

## What it includes

- `index.ts` — extension entrypoint (`export default function (pi) { ... }`)
- `package.json` — package metadata plus `pi.extensions` for easy extraction/distribution

## What it does

- Registers `/hey`, which shows `hey!`
- Registers a `hey` tool, which returns `hey!`

## Local install location

This lives at:

```text
~/.pi/agent/extensions/hey/
```

Pi auto-discovers `~/.pi/agent/extensions/*/index.ts`, so `/reload` is enough after edits.

## Extract later

Copy this directory anywhere, then run with:

```bash
pi -e ./index.ts
```

Or package it as a pi package using the `pi.extensions` field already present in `package.json`.
