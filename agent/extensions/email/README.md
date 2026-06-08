# pi-extension-email

Email-focused pi extension scaffold. Currently supports one Gmail account via Google OAuth and stores tokens in macOS Keychain.

## Setup

Create a Google OAuth Desktop app, then run:

```text
/email config
```

Paste the client ID and client secret. They are stored in macOS Keychain, not in this repo. Env vars still work as a fallback for development:

```bash
export PI_EMAIL_GOOGLE_CLIENT_ID="..."
export PI_EMAIL_GOOGLE_CLIENT_SECRET="..."
```

Redirect URI used by the extension:

```text
http://127.0.0.1:53682/oauth2/callback
```

## Commands

```text
/email              # start inbox triage
/email config       # store Google OAuth client credentials in Keychain
/email auth         # open Google OAuth, store Gmail token in Keychain
/email status       # check whether config and Gmail auth are present
/email logout       # delete stored Gmail token
/email clear-config # delete stored OAuth client credentials
```

## Tool

- `email_status` — reports backend, storage, scope, and auth readiness

## Security posture

- Uses Gmail API, not IMAP/app passwords.
- Requests Gmail scopes:
  - `https://www.googleapis.com/auth/gmail.readonly`
  - `https://www.googleapis.com/auth/gmail.modify`
- Adding a new scope requires re-authentication with `/email auth` so Google issues a token with the updated grant.
- Stores OAuth client credentials and token JSON in macOS Keychain as:
  - token service: `pi-email-gmail`
  - config service: `pi-email-gmail-config`
  - account: `default`
- No tokens or secrets are written into this repo.
- `/email` fetches the full current message and displays it locally. It does not call Ollama or any remote model provider during triage.
- Long-running actions show an `email:` footer status while loading, triaging, archiving, moving to spam, or moving to trash.
- `/email` opens a persistent top-left full-screen overlay, prefetches the next email while you triage the current one, shows sender, a Gmail inbox search link for that sender, any detected unsubscribe link, full subject, and the message text in a scrollable pane, then accepts Gmail-like shortcuts:
  - `Return` / `e` — Archive
  - `E` — Archive messages like this
  - `#` — Trash
  - `T` — Trash messages like this
  - `!` — Spam
  - `u` — Open detected unsubscribe link
  - `U` — Open detected unsubscribe link and archive all inbox threads from that sender
  - `j` — Next message
  - `k` — Previous loaded message
  - `J` — Jump next 10 messages
  - `K` — Jump previous 10 loaded messages
  - `↑` / `↓` — Scroll message pane
  - `PageUp` / `PageDown`, `Ctrl-U` / `Ctrl-D` — Jump message pane
  - `q` / `Esc` — Escape
  - `?` — Toggle shortcut legend
- Archive/Trash messages like this opens a confirmation view with a Gmail search query, Gmail search link, and matching thread titles. It starts filtered by sender plus up to four meaningful subject keywords. Press `+` to expand to all inbox messages from that sender, `-` to restore the subject filter, `Return` to execute the currently shown query, or `Esc` to cancel and move to the next inbox message.
- Archive, spam, and trash actions remove `UNREAD` so affected threads are marked read while leaving the inbox. Spam applies Gmail's `SPAM` label and removes `INBOX` from the matching threads. Trash moves matching threads to Gmail Trash. Next/previous navigation leaves threads untouched. Escape stops triage.
- Unsubscribe links are extracted from `List-Unsubscribe` and message body HTTP URLs. `u` opens the first detected unsubscribe link. `U` opens it and archives all inbox threads from that sender. It does not ask for confirmation or fall back to `mailto:` yet.
- The extension never fetches unsubscribe URLs server-side, clicks through pages, or sends mail. Archive/spam/trash actions run only after an explicit triage choice.
- Sender-wide archive targets always include the current thread plus all inbox threads matching the sender email. This avoids leaving the selected sender visible when Gmail's thread UI and message-level searches disagree.

## Local install location

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
