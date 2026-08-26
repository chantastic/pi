# Email extension philosophy

This extension is a fast, human-in-the-loop Gmail triage surface. Its job is to help one person make explicit decisions quickly without turning email into opaque automation.

## Mission

The primary product is one calm keyboard loop:

1. Show the next inbox thread with enough trustworthy context.
2. Let the user choose one legible action.
3. Make the action or move on.
4. Preserve a clear account of failures and broader target sets.

Gmail remains the source of truth. The extension is a focused client, not a second mailbox model.

## Non-negotiable invariants

- The user chooses every Gmail mutation and every sent message.
- No model may silently archive, trash, spam, unsubscribe, or send.
- Message contents stay local unless a feature explicitly discloses another destination before use.
- OAuth client secrets and tokens stay in macOS Keychain.
- Request the least-powerful Gmail scope that supports the shipped product.
- A new scope requires a README change, status support, and an explicit reauthorization path.
- Actions that remove inbox threads also remove `UNREAD`.
- Sender-wide and similar-message actions include the current thread even when Gmail search omits it.
- Bulk targets and URLs are de-duplicated before execution.
- Bulk actions are bounded, previewed, confirmed, and report progress.
- Unsubscribe opens a URL in the user's browser. The extension does not fetch pages, submit forms, or send `mailto:` requests.
- Reply drafts remain recoverable until Gmail confirms send.
- A successful send is never reported as failed because loading the next message failed.
- Prefetch may improve speed, but it cannot reintroduce removed, skipped, or already cached threads.
- Attachment bytes are never interpreted as message text or unsubscribe candidates.

## Product stance

Prefer:

- Gmail-native threads, labels, search queries, Trash, `INBOX`, `UNREAD`, and `SPAM`.
- A persistent keyboard-first sweep over parallel command modes.
- Compact defaults with complete help on demand.
- Archive as the normal low-friction mutation.
- Local deterministic parsing over remote interpretation.
- Recoverable, idempotent operations where Gmail permits them.
- Visible progress and actionable failure text.

Avoid:

- A second inbox database or hidden synchronization layer.
- Duplicate workflows that compete with `/email`.
- Modal steps for ordinary navigation.
- Unbounded list hydration or mutation.
- Optimistic "connected" status based only on stored credentials.
- Convenience abstractions that obscure Gmail queries or thread IDs.

## Architecture

Dependencies flow inward from the Pi surface to deterministic domain code:

- `index.ts`: Pi command and tool registration only.
- `sweep.ts`: TUI rendering, keyboard actions, navigation cache, prefetch, help, and progress.
- `gmail.ts`: authenticated Gmail transport, bounded reads, thread mutations, and send orchestration.
- `auth.ts`: Keychain storage, OAuth callback lifecycle, refresh, scopes, and readiness.
- `message.ts`: sender/header interpretation, unsubscribe discovery, Gmail query policy, and reply MIME.
- `mime.ts`: attachment-aware extraction of inline plain-text and HTML bodies.

Rules for ownership:

- Network calls belong in `auth.ts` or `gmail.ts`.
- Pure mailbox interpretation belongs in `message.ts` or `mime.ts`.
- Gmail mutations never live directly in a key handler.
- Pi registration never contains domain behavior.
- TUI state does not leak into transport functions.
- Add a new module only when it creates a testable ownership boundary.

## Automatic feature triage

Every proposed feature receives one outcome:

- **BUILD**: compatible with the invariants and all required gates are known.
- **REDESIGN**: useful intent, but confirmation, privacy, scope, target, or recovery semantics are incomplete.
- **HOLD**: depends on silent mutation, undisclosed content sharing, unbounded work, or a scope whose value does not justify its access.

Classify risk before implementation:

| Tier | Typical work | Required gate |
| --- | --- | --- |
| 0 | Local rendering, help, navigation, key aliases | Typecheck; interaction remains non-mutating |
| 1 | Gmail reads, parsing, search links, local suggestions | Bounded reads; deterministic tests; no new data destination |
| 2 | One-thread archive/trash/spam, opening an external URL | Explicit key; visible target; actionable failure; safe retry story |
| 3 | Bulk mutation, send, unsubscribe execution, AI content sharing, new OAuth scope | Preview and confirmation as applicable; cap/progress; recovery; privacy and scope review; focused tests |

Escalate to the highest matching tier. "Optional" or "power user" does not lower risk.

## Triage questions

Answer these in order:

1. Does the feature make the sweep faster, clearer, or more trustworthy?
2. What data is read, stored, sent, or opened, and where does it go?
3. Is it navigation, a Gmail read, an external side effect, a mutation, or communication?
4. What exact Gmail primitive and target set does it use?
5. Can the user understand the effect before it happens?
6. Is the operation bounded and observable?
7. What survives a network or partial failure?
8. Is retry safe or idempotent?
9. Does it require another OAuth scope?
10. Which pure rule and failure path can be tested?

If questions 2, 4, 5, 6, or 7 have no concrete answer, the outcome is **REDESIGN**.

## Feature gates

### Read-only features

- Keep reads bounded and request only fields the UI consumes.
- Parse content locally.
- Treat attachments and malformed input conservatively.
- Add fixtures for new message forms or query rules.

### Single-message mutations

- Require an explicit action.
- Keep the target to the visible thread.
- Mark removed threads read.
- Surface Gmail errors without hiding the current message.
- Prefer Gmail operations that are safe to retry.

### Bulk mutations

- Show the Gmail query, search link, count, and representative subjects.
- Include the current thread.
- Enforce a hard maximum.
- Require confirmation after the final query is loaded.
- Report completed/total progress and partial failure counts.
- Invalidate prefetched/cache state after success.

### Sending and composition

- Keep draft text in the editor through failed sends.
- Lock duplicate submit only while a request is active.
- Use the authenticated Gmail profile as explicit `From`.
- Preserve `threadId`, matching subject, `In-Reply-To`, and `References`.
- Separate send success from subsequent navigation failure.
- Never send as a navigation side effect.

### External services and AI

AI is advisory unless the user explicitly promotes a result into an action. Acceptable examples include grouping suggestions, sender explanations, query suggestions, and draft text for review.

Before message content leaves the machine:

- Name the destination and purpose.
- Require an explicit initiating action.
- Document retention/privacy assumptions.
- Provide a local or no-op fallback where practical.
- Never convert model output directly into a hidden mutation.

## Adding an action

1. Add the action and display metadata in `sweep.ts`.
2. Add exactly one key-dispatch path.
3. Put Gmail behavior in `gmail.ts`; put pure policy in `message.ts`.
4. Assign a risk tier and implement its gates.
5. Update the help view and README shortcut list.
6. Add deterministic tests for query, parsing, MIME, or recovery logic.
7. Run `npm run check` and load the extension through Pi.

## Definition of done

A feature is done when:

- Its target, side effects, and failure semantics are explicit.
- It preserves every applicable invariant above.
- Strict TypeScript and all tests pass with `npm run check`.
- Pi loads the extension.
- README behavior, scopes, and shortcuts match the code.
- Status can distinguish missing config, missing/insufficient token, and live Gmail failure.
- No secret, token, message fixture, or local `node_modules` content is committed.

## Feature decision record

Use this compact record for automatic or human triage:

```text
Intent:
Risk tier:
Data read or shared:
Gmail primitive and target:
User confirmation:
Bound and progress:
Failure and retry behavior:
OAuth scope impact:
Tests:
Docs:
Decision: BUILD | REDESIGN | HOLD
```

The preferred shape remains: preview, explain the target, ask for intent when risk requires it, then act.
