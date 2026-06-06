import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const TOKEN_KEYCHAIN_SERVICE = "pi-email-gmail";
const CONFIG_KEYCHAIN_SERVICE = "pi-email-gmail-config";
const KEYCHAIN_ACCOUNT = "default";
const REDIRECT_PORT = 53682;
const REDIRECT_URI = `http://127.0.0.1:${REDIRECT_PORT}/oauth2/callback`;
const GMAIL_SCOPES = ["https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/gmail.modify"];
const GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1";

type GmailToken = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  expires_at?: number;
  scope?: string;
  token_type?: string;
};

type GoogleClientConfig = {
  clientId: string;
  clientSecret: string;
};

async function readKeychainJson<T>(service: string): Promise<T | null> {
  try {
    const { stdout } = await execFileAsync("security", [
      "find-generic-password",
      "-s",
      service,
      "-a",
      KEYCHAIN_ACCOUNT,
      "-w",
    ]);
    return JSON.parse(stdout.trim()) as T;
  } catch {
    return null;
  }
}

async function writeKeychainJson(service: string, value: unknown) {
  await execFileAsync("security", [
    "add-generic-password",
    "-U",
    "-s",
    service,
    "-a",
    KEYCHAIN_ACCOUNT,
    "-w",
    JSON.stringify(value),
  ]);
}

async function deleteKeychainItem(service: string) {
  try {
    await execFileAsync("security", ["delete-generic-password", "-s", service, "-a", KEYCHAIN_ACCOUNT]);
  } catch {
    // Already absent.
  }
}

async function getGoogleClientConfig(): Promise<GoogleClientConfig> {
  const keychainConfig = await readKeychainJson<GoogleClientConfig>(CONFIG_KEYCHAIN_SERVICE);
  const clientId = keychainConfig?.clientId ?? process.env.PI_EMAIL_GOOGLE_CLIENT_ID ?? process.env.GOOGLE_CLIENT_ID;
  const clientSecret =
    keychainConfig?.clientSecret ?? process.env.PI_EMAIL_GOOGLE_CLIENT_SECRET ?? process.env.GOOGLE_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error("Run /email config to store Google OAuth client credentials in macOS Keychain.");
  }

  return { clientId, clientSecret };
}

async function readToken(): Promise<GmailToken | null> {
  return readKeychainJson<GmailToken>(TOKEN_KEYCHAIN_SERVICE);
}

async function writeToken(token: GmailToken) {
  await writeKeychainJson(TOKEN_KEYCHAIN_SERVICE, token);
}

async function deleteToken() {
  await deleteKeychainItem(TOKEN_KEYCHAIN_SERVICE);
}

async function refreshAccessToken(token: GmailToken): Promise<GmailToken> {
  if (token.access_token && token.expires_at && token.expires_at > Date.now() + 60_000) return token;
  if (!token.refresh_token) throw new Error("Missing Gmail refresh token. Run /email auth again.");

  const { clientId, clientSecret } = await getGoogleClientConfig();
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: token.refresh_token,
      grant_type: "refresh_token",
    }),
  });

  if (!response.ok) throw new Error(`Token refresh failed: ${response.status} ${await response.text()}`);

  const refreshed = (await response.json()) as GmailToken;
  const next = {
    ...token,
    ...refreshed,
    refresh_token: token.refresh_token,
    expires_at: Date.now() + (refreshed.expires_in ?? 0) * 1000,
  };
  await writeToken(next);
  return next;
}

async function getAccessToken(): Promise<string> {
  const token = await readToken();
  if (!token) throw new Error("Gmail is not connected. Run /email auth.");
  const refreshed = await refreshAccessToken(token);
  if (!refreshed.access_token) throw new Error("Missing Gmail access token. Run /email auth again.");
  return refreshed.access_token;
}

type InboxItem = {
  id: string;
  threadId: string;
  from: string;
  subject: string;
  date: string;
  snippet: string;
  labelIds: string[];
};

function headerValue(headers: Array<{ name?: string; value?: string }> | undefined, name: string) {
  return headers?.find((header) => header.name?.toLowerCase() === name.toLowerCase())?.value ?? "";
}

async function gmailGet<T>(path: string, accessToken: string): Promise<T> {
  const response = await fetch(`${GMAIL_API_BASE}${path}`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) throw new Error(`Gmail API failed: ${response.status} ${await response.text()}`);
  return (await response.json()) as T;
}

async function collectInbox(maxResults = 10): Promise<InboxItem[]> {
  const accessToken = await getAccessToken();
  const list = await gmailGet<{ messages?: Array<{ id: string; threadId: string }> }>(
    `/users/me/messages?${new URLSearchParams({ q: "in:inbox is:unread", maxResults: String(maxResults) })}`,
    accessToken,
  );

  const items: InboxItem[] = [];
  for (const message of list.messages ?? []) {
    const full = await gmailGet<{
      id: string;
      threadId: string;
      labelIds?: string[];
      snippet?: string;
      payload?: { headers?: Array<{ name?: string; value?: string }> };
    }>(`/users/me/messages/${message.id}?${new URLSearchParams({ format: "metadata" })}`, accessToken);

    items.push({
      id: full.id,
      threadId: full.threadId,
      from: headerValue(full.payload?.headers, "From"),
      subject: headerValue(full.payload?.headers, "Subject"),
      date: headerValue(full.payload?.headers, "Date"),
      snippet: full.snippet ?? "",
      labelIds: full.labelIds ?? [],
    });
  }

  return items;
}

type GmailPayload = {
  mimeType?: string;
  body?: { data?: string };
  headers?: Array<{ name?: string; value?: string }>;
  parts?: GmailPayload[];
};

type UnsubscribeCandidate = {
  sender: string;
  senderEmail: string;
  latestMessageId: string;
  latestThreadId: string;
  subject: string;
  date: string;
  snippet: string;
  listUnsubscribe: string;
  unsubscribeUrls: string[];
  chosenUrl?: string;
};

function senderEmail(from: string) {
  return from.match(/<([^>]+)>/)?.[1]?.toLowerCase() ?? from.trim().toLowerCase();
}

function decodeBase64Url(data: string) {
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

function collectPayloadText(payload: GmailPayload | undefined): string {
  if (!payload) return "";
  const own = payload.body?.data ? decodeBase64Url(payload.body.data) : "";
  return [own, ...(payload.parts ?? []).map(collectPayloadText)].filter(Boolean).join("\n");
}

function extractHttpUrls(text: string) {
  return [...text.matchAll(/https?:\/\/[^\s"'<>]+/gi)]
    .map((match) => match[0].replace(/[),.;]+$/, ""))
    .filter((url, index, urls) => /unsubscribe|preferences|email-preference/i.test(url) && urls.indexOf(url) === index);
}

async function collectUnsubscribeCandidates(maxSenders = 10): Promise<UnsubscribeCandidate[]> {
  const accessToken = await getAccessToken();
  const list = await gmailGet<{ messages?: Array<{ id: string; threadId: string }> }>(
    `/users/me/messages?${new URLSearchParams({ q: "in:inbox unsubscribe", maxResults: String(Math.min(maxSenders * 3, 50)) })}`,
    accessToken,
  );

  const seenSenders = new Set<string>();
  const candidates: UnsubscribeCandidate[] = [];

  for (const message of list.messages ?? []) {
    if (candidates.length >= maxSenders) break;
    const full = await gmailGet<{
      id: string;
      threadId: string;
      snippet?: string;
      payload?: GmailPayload;
    }>(`/users/me/messages/${message.id}?${new URLSearchParams({ format: "full" })}`, accessToken);

    const from = headerValue(full.payload?.headers, "From");
    const email = senderEmail(from);
    if (!email || seenSenders.has(email)) continue;
    seenSenders.add(email);

    const listUnsubscribe = headerValue(full.payload?.headers, "List-Unsubscribe");
    const headerUrls = extractHttpUrls(listUnsubscribe);
    const bodyUrls = extractHttpUrls(collectPayloadText(full.payload));
    const unsubscribeUrls = [...headerUrls, ...bodyUrls].filter((url, index, urls) => urls.indexOf(url) === index);

    candidates.push({
      sender: from,
      senderEmail: email,
      latestMessageId: full.id,
      latestThreadId: full.threadId,
      subject: headerValue(full.payload?.headers, "Subject"),
      date: headerValue(full.payload?.headers, "Date"),
      snippet: full.snippet ?? "",
      listUnsubscribe,
      unsubscribeUrls,
      chosenUrl: unsubscribeUrls[0],
    });
  }

  return candidates;
}

async function exchangeCodeForToken(code: string): Promise<GmailToken> {
  const { clientId, clientSecret } = await getGoogleClientConfig();
  const body = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: REDIRECT_URI,
    grant_type: "authorization_code",
  });

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!response.ok) throw new Error(`Token exchange failed: ${response.status} ${await response.text()}`);

  const token = (await response.json()) as GmailToken;
  return { ...token, expires_at: Date.now() + (token.expires_in ?? 0) * 1000 };
}

async function startOAuthFlow(): Promise<GmailToken> {
  const { clientId } = await getGoogleClientConfig();
  const state = crypto.randomUUID();

  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", GMAIL_SCOPES.join(" "));
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("prompt", "consent");
  authUrl.searchParams.set("state", state);

  return await new Promise<GmailToken>((resolve, reject) => {
    const server = createServer(async (req, res) => {
      try {
        const url = new URL(req.url ?? "/", REDIRECT_URI);
        if (url.pathname !== "/oauth2/callback") return;

        if (url.searchParams.get("state") !== state) throw new Error("OAuth state mismatch.");
        const code = url.searchParams.get("code");
        if (!code) throw new Error(url.searchParams.get("error") ?? "Missing OAuth code.");

        res.writeHead(200, { "content-type": "text/plain" });
        res.end("pi email auth complete. You can close this tab.\n");
        server.close();
        resolve(await exchangeCodeForToken(code));
      } catch (error) {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end(String(error));
        server.close();
        reject(error);
      }
    });

    server.once("error", reject);
    server.listen(REDIRECT_PORT, "127.0.0.1", async () => {
      await execFileAsync("open", [authUrl.toString()]);
    });
  });
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("email", {
    description: "Email assistant commands",
    handler: async (args, ctx) => {
      const subcommand = args.trim() || "help";

      if (subcommand === "help") {
        ctx.ui.notify(
          "/email config, /email auth, /email status, /email inbox, /email unsubscribe-candidates, /email unsubscribe-open, /email logout, /email clear-config",
          "info",
        );
        return;
      }

      if (subcommand === "status") {
        const token = await readToken();
        const config = await readKeychainJson<GoogleClientConfig>(CONFIG_KEYCHAIN_SERVICE);
        ctx.ui.notify(
          `gmail auth: ${token?.refresh_token ? "connected" : "not connected"}; config: ${config ? "stored" : "missing"}`,
          "info",
        );
        return;
      }

      if (subcommand === "config") {
        const clientId = await ctx.ui.input("Google OAuth client ID", "paste client ID...");
        if (!clientId) {
          ctx.ui.notify("email config cancelled", "info");
          return;
        }

        const clientSecret = await ctx.ui.input("Google OAuth client secret", "paste client secret...");
        if (!clientSecret) {
          ctx.ui.notify("email config cancelled", "info");
          return;
        }

        await writeKeychainJson(CONFIG_KEYCHAIN_SERVICE, { clientId: clientId.trim(), clientSecret: clientSecret.trim() });
        ctx.ui.notify("gmail OAuth config stored in macOS Keychain", "info");
        return;
      }

      if (subcommand === "clear-config") {
        await deleteKeychainItem(CONFIG_KEYCHAIN_SERVICE);
        ctx.ui.notify("gmail OAuth config removed from Keychain", "info");
        return;
      }

      if (subcommand === "inbox") {
        try {
          const items = await collectInbox(10);
          if (items.length === 0) {
            ctx.ui.notify("No unread inbox messages found.", "info");
            return;
          }
          ctx.ui.notify(
            items.map((item) => `${item.from || "unknown"}: ${item.subject || "(no subject)"}`).join("\n"),
            "info",
          );
        } catch (error) {
          ctx.ui.notify(`gmail inbox failed: ${error instanceof Error ? error.message : String(error)}`, "error");
        }
        return;
      }

      if (subcommand === "unsubscribe-candidates") {
        try {
          const candidates = await collectUnsubscribeCandidates(10);
          ctx.ui.notify(
            candidates.length === 0
              ? "No unsubscribe candidates found."
              : candidates
                  .map((candidate) =>
                    `${candidate.sender || candidate.senderEmail}: ${candidate.subject || "(no subject)"}\n${candidate.chosenUrl ? `  ${new URL(candidate.chosenUrl).host}` : "  no http unsubscribe URL found"}`,
                  )
                  .join("\n"),
            "info",
          );
        } catch (error) {
          ctx.ui.notify(`unsubscribe candidates failed: ${error instanceof Error ? error.message : String(error)}`, "error");
        }
        return;
      }

      if (subcommand === "unsubscribe-open") {
        try {
          const candidates = await collectUnsubscribeCandidates(10);
          for (const candidate of candidates) {
            if (!candidate.chosenUrl) continue;
            const ok = await ctx.ui.confirm(
              "Open unsubscribe link?",
              `${candidate.sender || candidate.senderEmail}\n${candidate.subject || "(no subject)"}\n${candidate.chosenUrl}`,
            );
            if (ok) await execFileAsync("open", [candidate.chosenUrl]);
          }
        } catch (error) {
          ctx.ui.notify(`unsubscribe open failed: ${error instanceof Error ? error.message : String(error)}`, "error");
        }
        return;
      }

      if (subcommand === "auth") {
        try {
          ctx.ui.notify("Opening Google OAuth…", "info");
          const token = await startOAuthFlow();
          await writeToken(token);
          ctx.ui.notify("gmail auth: connected. refresh token stored in macOS Keychain.", "info");
        } catch (error) {
          ctx.ui.notify(`gmail auth failed: ${error instanceof Error ? error.message : String(error)}`, "error");
        }
        return;
      }

      if (subcommand === "logout") {
        await deleteToken();
        ctx.ui.notify("gmail auth removed from Keychain", "info");
        return;
      }

      ctx.ui.notify(`unknown email command: ${subcommand}`, "warn");
    },
  });

  pi.registerTool({
    name: "email_collect_inbox",
    label: "Collect Gmail Inbox",
    description: "Collect recent unread Gmail inbox message metadata and snippets. Read-only.",
    parameters: Type.Object({
      maxResults: Type.Optional(Type.Number({ minimum: 1, maximum: 25, description: "Maximum unread inbox messages to fetch" })),
    }),
    async execute(_toolCallId, params) {
      const items = await collectInbox(params.maxResults ?? 10);
      return {
        content: [
          {
            type: "text",
            text:
              items.length === 0
                ? "No unread inbox messages found."
                : items.map((item) => `- ${item.from || "unknown"}: ${item.subject || "(no subject)"}\n  ${item.snippet}`).join("\n"),
          },
        ],
        details: { count: items.length, items },
      };
    },
  });

  pi.registerTool({
    name: "email_collect_unsubscribe_candidates",
    label: "Collect Unsubscribe Candidates",
    description: "Find recent inbox senders with unsubscribe text and extract candidate unsubscribe URLs. Read-only.",
    parameters: Type.Object({
      maxSenders: Type.Optional(Type.Number({ minimum: 1, maximum: 25, description: "Maximum senders to inspect" })),
    }),
    async execute(_toolCallId, params) {
      const candidates = await collectUnsubscribeCandidates(params.maxSenders ?? 10);
      return {
        content: [
          {
            type: "text",
            text:
              candidates.length === 0
                ? "No unsubscribe candidates found."
                : candidates
                    .map(
                      (candidate) =>
                        `- ${candidate.sender || candidate.senderEmail}: ${candidate.subject || "(no subject)"}\n  ${candidate.chosenUrl ?? "No http unsubscribe URL found."}`,
                    )
                    .join("\n"),
          },
        ],
        details: { count: candidates.length, candidates },
      };
    },
  });

  pi.registerTool({
    name: "email_status",
    label: "Email Status",
    description: "Report whether the Gmail email extension is authenticated",
    parameters: Type.Object({}),
    async execute() {
      const token = await readToken();
      const connected = Boolean(token?.refresh_token);
      return {
        content: [{ type: "text", text: connected ? "gmail auth: connected" : "gmail auth: not connected" }],
        details: {
          ready: connected,
          backend: "gmail",
          tokenStorage: "macOS Keychain",
          scopes: GMAIL_SCOPES,
        },
      };
    },
  });
}
