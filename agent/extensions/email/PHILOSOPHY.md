# Email extension philosophy

This extension is a fast human-in-the-loop Gmail triage surface. It should help one person make explicit decisions faster, without turning email into an opaque automation system.

## Core product stance

- The default workflow is `/email`: a single persistent inbox sweep with keyboard-first actions.
- The extension may fetch and render email locally, but it should not send email content to model providers or third-party services unless a future feature makes that explicit and documented.
- Gmail is the source of truth. If an action will mutate mail, show the Gmail query or target set whenever the action is broader than the current thread.
- The user chooses every mutation. Suggestions are acceptable; silent archive/trash/spam/unsubscribe is not.
- Prefer Gmail-native concepts: threads, labels, Gmail search queries, `INBOX`, `UNREAD`, `SPAM`, and Trash.
- Archive is the normal low-friction action. Trash, spam, and bulk actions need clearer intent because they are more destructive or broader.

## Safety invariants

- Tokens and OAuth client secrets live in macOS Keychain, never in this repo.
- Adding Gmail scopes requires README and status updates, and should force a clear `/email auth` reauthorization path.
- Mutations that remove a thread from the inbox also remove `UNREAD`, so triage does not leave unread counts behind.
- Sender-wide and bulk actions must include the current thread, even when Gmail search results do not return it.
- Thread IDs and URLs should be de-duplicated before action execution.
- Unsubscribe URLs are opened in the user's browser. The extension should not fetch unsubscribe pages, click remote forms, or send `mailto:` unsubscribe requests without a separate explicit confirmation flow.
- Reply actions should either hand off to Gmail in the browser or use a local compose/draft flow with an explicit send confirmation. Never send mail as a side effect of triage navigation.
- Prefetching is allowed for speed, but prefetched items must never reintroduce removed, skipped, or already cached threads.

## Architecture boundaries

The current implementation still lives in one file, but future changes should preserve these boundaries:

- Auth and storage: Google OAuth, token refresh, and Keychain helpers.
- Gmail transport: `gmailGet`, `gmailPost`, error formatting, and access-token-aware request helpers.
- Gmail domain operations: thread listing, thread summaries, archive/spam/trash, reply sending, sender and similar-message selection.
- Message parsing: headers, sender email extraction, payload text decoding, HTML cleanup, unsubscribe URL extraction.
- Triage policy: actions, keybindings, Gmail search query construction, stopwords, and bulk confirmation rules.
- TUI shell: full-screen overlay rendering, scroll state, message cache, prefetch, and keyboard handling.
- Extension surface: command and tool registration only.

If a section grows materially, split it into a module before adding more behavior. Avoid adding another old command path beside `/email` unless it supports a genuinely different workflow.

## Feature triage rubric

Build a feature when it:

- Makes the current inbox sweep faster or more trustworthy.
- Keeps the user in control of every write operation.
- Can explain its target set before mutating Gmail.
- Reuses existing Gmail primitives and TUI conventions.
- Has a clear failure mode that leaves mail untouched.

Push back or redesign when it:

- Requires hidden remote calls with message contents.
- Mutates based only on model judgment.
- Adds a Gmail scope for convenience rather than necessity.
- Creates another parallel sweep mode that duplicates `/email`.
- Makes the keyboard loop slower, modal-heavy, or surprising.

## Adding actions

When adding a triage action:

1. Add the action to `EmailAction`, `EMAIL_ACTIONS`, and the relevant action list.
2. Add one keybinding path in `actionForKey`.
3. Keep the Gmail mutation in a domain helper, not inline in the TUI handler.
4. For bulk actions, show a confirmation overlay with the Gmail query, link, count, and representative subjects.
5. Update README shortcuts and this document if the action changes the philosophy or invariants.

## Automation and AI policy

AI can be useful here, but only as advisory infrastructure unless the user explicitly chooses otherwise. Good uses include grouping suggestions, sender explanations, safer subject keyword extraction, and draft labels for confirmation. Bad uses include automatic archiving, automatic unsubscribe clicks, or hidden summaries that require sending message contents away.

The shape to prefer is: preview, explain target set, ask for intent, then mutate.
