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
/email config                 # store Google OAuth client credentials in Keychain
/email auth                   # open Google OAuth, store Gmail token in Keychain
/email status                 # check whether config and Gmail auth are present
/email inbox                  # list recent unread inbox metadata/snippets
/email unsubscribe-candidates # list newest unsubscribe senders with inbox thread titles
/email unsubscribe-sweep      # triage unsubscribe/archive decisions interactively
/email logout                 # delete stored Gmail token
/email clear-config           # delete stored OAuth client credentials
```

## Tool

- `email_status` — reports backend, storage, scope, and auth readiness
- `email_collect_inbox` — collects recent unread inbox message metadata/snippets
- `email_collect_unsubscribe_candidates` — finds newest inbox messages containing unsubscribe text, groups by sender, extracts candidate unsubscribe URLs/mailtos, and reports the matching inbox thread titles that would be archived

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
- Inbox collection uses `format=metadata` plus Gmail snippets; it does not fetch full message bodies.
- Unsubscribe candidate collection fetches full latest messages only to extract unsubscribe headers/body links.
- Long-running commands show an `email:` footer status while loading candidates, triaging, archiving, moving to spam, or moving to trash.
- `/email unsubscribe-sweep` repeatedly finds the newest inbox email containing unsubscribe text, queries all matching inbox threads from that sender, shows the sender email plus thread titles, then asks for one of:
  1. Unsubscribe and archive all
  2. Archive-only
  3. Spam all
  4. Trash all
  5. Skip
  6. Escape
- Spam all applies Gmail's `SPAM` label and removes `INBOX` from the matching threads. Trash all moves matching threads to Gmail Trash. Skip leaves that sender untouched for this run and moves to the next candidate. Escape stops the sweep.
- Choosing unsubscribe opens the HTTP unsubscribe link in the local browser when available, then archives the matching inbox threads. It does not ask for confirmation or fall back to `mailto:` yet.
- The extension never fetches unsubscribe URLs server-side, clicks through pages, or sends mail. Archive/spam/trash actions run only after an explicit sweep choice.
- Archive targets always include the candidate's latest thread plus all inbox threads matching the sender email. This avoids leaving the selected sender visible when Gmail's thread UI and message-level searches disagree.

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
