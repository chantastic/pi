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
/email config       # store Google OAuth client credentials in Keychain
/email auth         # open Google OAuth, store Gmail token in Keychain
/email status       # check whether config and Gmail auth are present
/email inbox                  # list recent unread inbox metadata/snippets
/email unsubscribe-candidates # find senders with unsubscribe links
/email unsubscribe-open       # confirm/open unsubscribe links in browser
/email logout                 # delete stored Gmail token
/email clear-config # delete stored OAuth client credentials
```

## Tool

- `email_status` — reports backend, storage, scope, and auth readiness
- `email_collect_inbox` — collects recent unread inbox message metadata/snippets
- `email_collect_unsubscribe_candidates` — groups recent inbox messages containing unsubscribe text by sender and extracts candidate HTTP unsubscribe URLs

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
- `/email unsubscribe-open` asks before each URL and opens it in the local browser. It does not fetch links server-side, click through pages, archive mail, or send mail.

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
