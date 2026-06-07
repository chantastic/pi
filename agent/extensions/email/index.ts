import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
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
const OLLAMA_API_BASE = process.env.PI_EMAIL_OLLAMA_URL ?? "http://localhost:11434";
const OLLAMA_EMAIL_MODEL = process.env.PI_EMAIL_OLLAMA_MODEL ?? "qwen3:8b";
const OLLAMA_KEEP_ALIVE = process.env.PI_EMAIL_OLLAMA_KEEP_ALIVE ?? "30m";

type EmailAction =
  | "archive"
  | "trash"
  | "spam"
  | "archiveSimilar"
  | "trashSimilar"
  | "unsubscribeArchive"
  | "skip"
  | "escape";

const EMAIL_ACTIONS: Record<EmailAction, { label: string; keys: string[] }> = {
  archive: { label: "Archive", keys: ["Return", "e"] },
  trash: { label: "Trash", keys: ["#"] },
  spam: { label: "Spam", keys: ["!"] },
  archiveSimilar: { label: "Archive messages like this", keys: ["E"] },
  trashSimilar: { label: "Trash messages like this", keys: ["T"] },
  unsubscribeArchive: { label: "Unsubscribe and archive", keys: ["Return"] },
  skip: { label: "Skip", keys: ["j"] },
  escape: { label: "Escape", keys: ["q", "Esc"] },
};

const INBOX_SWEEP_ACTIONS: EmailAction[] = ["archive", "archiveSimilar", "trash", "trashSimilar", "spam", "skip", "escape"];
const UNSUBSCRIBE_SWEEP_ACTIONS: EmailAction[] = ["unsubscribeArchive", "archive", "spam", "trash", "skip", "escape"];

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

type InboxSweepItem = {
  messageId: string;
  threadId: string;
  from: string;
  senderEmail: string;
  subject: string;
  date: string;
  snippet: string;
  bodyText: string;
};

function headerValue(headers: Array<{ name?: string; value?: string }> | undefined, name: string) {
  return headers?.find((header) => header.name?.toLowerCase() === name.toLowerCase())?.value ?? "";
}

function formatGmailApiError(status: number, body: string) {
  const reauthHint = body.includes("insufficient") || body.includes("ACCESS_TOKEN_SCOPE_INSUFFICIENT")
    ? " Run /email auth to grant the current Gmail scopes."
    : "";
  return `Gmail API failed: ${status} ${body}${reauthHint}`;
}

function actionLegend(actions: EmailAction[]) {
  return actions.map((action) => `${EMAIL_ACTIONS[action].keys.join("/")} ${EMAIL_ACTIONS[action].label}`).join("  ·  ");
}

function borderLine(width: number, left: string, fill: string, right: string) {
  return left + fill.repeat(Math.max(0, width - left.length - right.length)) + right;
}

function boxedLines(title: string, bodyLines: string[], footer: string, width: number, theme: any, scrollOffset = 0) {
  const innerWidth = Math.max(20, width - 4);
  const targetHeight = Math.max(12, (process.stdout.rows ?? 24) - 4);
  const topTitle = ` ${title} `;
  const top = "┌" + topTitle + "─".repeat(Math.max(0, width - topTitle.length - 2)) + "┐";
  const bottom = borderLine(width, "└", "─", "┘");
  const separator = borderLine(width, "├", "─", "┤");
  const wrappedContent = wrapDisplayLines(bodyLines, innerWidth);
  const contentHeight = Math.max(1, targetHeight - 3);
  const maxScroll = Math.max(0, wrappedContent.length - contentHeight);
  const offset = Math.min(Math.max(0, scrollOffset), maxScroll);
  const scrollInfo = maxScroll > 0 ? ` ↑↓ ${offset + 1}-${Math.min(wrappedContent.length, offset + contentHeight)}/${wrappedContent.length}` : "";
  const visibleContent = wrappedContent.slice(offset, offset + contentHeight);
  while (visibleContent.length < contentHeight) visibleContent.push("");
  const content = visibleContent.map((line) => `│ ${truncateToWidth(line, innerWidth).padEnd(innerWidth)} │`);
  const footerLine = `│ ${truncateToWidth(`${footer}${scrollInfo}`, innerWidth).padEnd(innerWidth)} │`;
  return [theme?.fg ? theme.fg("accent", top) : top, ...content, separator, theme?.fg ? theme.fg("muted", footerLine) : footerLine, bottom];
}

function actionForKey(data: string, actions: EmailAction[]): EmailAction | undefined {
  if (matchesKey(data, Key.enter)) return actions.includes("unsubscribeArchive") ? "unsubscribeArchive" : "archive";
  if (matchesKey(data, Key.escape) || data === "q") return "escape";
  if (data === "j") return "skip";
  if (data === "e" && actions.includes("archive")) return "archive";
  if (data === "#" && actions.includes("trash")) return "trash";
  if (data === "!" && actions.includes("spam")) return "spam";
  if (data === "E" && actions.includes("archiveSimilar")) return "archiveSimilar";
  if (data === "T" && actions.includes("trashSimilar")) return "trashSimilar";
  return undefined;
}

function wrapDisplayLines(lines: string[], width: number) {
  return lines.flatMap((line) => {
    if (!line) return [""];
    const chunks: string[] = [];
    let rest = line;
    while (rest.length > width) {
      chunks.push(truncateToWidth(rest, width));
      rest = rest.slice(width);
    }
    chunks.push(truncateToWidth(rest, width));
    return chunks;
  });
}

async function chooseEmailAction(
  ctx: any,
  title: string,
  body: string,
  actions: EmailAction[],
): Promise<EmailAction> {
  return await ctx.ui.custom<EmailAction>((tui: { requestRender: () => void }, theme: any, _keybindings: unknown, done: (value: EmailAction) => void) => {
    let showHelp = false;
    const render = (width: number) => {
      const bodyLines = body.split("\n");
      if (showHelp) {
        bodyLines.push("", "Shortcuts:");
        for (const action of actions) bodyLines.push(`  ${EMAIL_ACTIONS[action].keys.join(" / ")} — ${EMAIL_ACTIONS[action].label}`);
        bodyLines.push("  ? — Toggle this legend");
      }
      return boxedLines(title, bodyLines, `${actionLegend(actions)}  ·  ? Help`, width, theme);
    };

    return {
      render,
      handleInput(data: string) {
        if (data === "?") {
          showHelp = !showHelp;
          tui.requestRender();
          return;
        }
        const action = actionForKey(data, actions);
        if (action) done(action);
      },
      invalidate() {},
    };
  }, emailOverlayOptions());
}

function gmailSearchUrl(query: string) {
  return `https://mail.google.com/mail/u/0/#search/${encodeURIComponent(query)}`;
}

async function confirmBulkAction(ctx: any, actionLabel: string, item: InboxSweepItem) {
  type BulkSelection = Awaited<ReturnType<typeof collectSimilarInboxSelection>>;
  type BulkResult = { confirmed: true; selection: BulkSelection } | { confirmed: false };
  const queries = [similarInboxQuery(item), broadSimilarInboxQuery(item)].filter((query, index, list) => list.indexOf(query) === index);

  return await ctx.ui.custom<BulkResult>((tui: { requestRender: () => void }, theme: any, _keybindings: unknown, done: (value: BulkResult) => void) => {
    let queryIndex = 0;
    let selection: BulkSelection | null = null;
    let loading = "Loading matching threads…";

    const load = async () => {
      const query = queries[queryIndex] ?? queries[0]!;
      loading = `Loading matches for: ${query}`;
      selection = null;
      tui.requestRender();
      try {
        selection = await collectSimilarInboxSelection(item, query);
        loading = "";
      } catch (error) {
        loading = `Failed to load matches: ${error instanceof Error ? error.message : String(error)}`;
      }
      tui.requestRender();
    };

    setTimeout(() => void load(), 0);

    return {
      render(width: number) {
        const query = queries[queryIndex] ?? queries[0]!;
        return boxedLines(
          `Confirm ${actionLabel}`,
          [
            `Query: ${query}`,
            `Link: ${gmailSearchUrl(query)}`,
            `Mode: ${queryIndex === 0 ? "filtered by subject" : "expanded to sender"}`,
            "",
            selection ? `Threads included (${selection.threadIds.length}):` : loading,
            ...(selection?.summaries.map((summary, index) => `${index + 1}. ${summary.subject || "(no subject)"}`) ?? []),
          ],
          "+ Expand  ·  - Filter  ·  Return Confirm  ·  Esc Cancel and next",
          width,
          theme,
        );
      },
      handleInput(data: string) {
        if (data === "+" && queryIndex < queries.length - 1) {
          queryIndex++;
          void load();
          return;
        }
        if (data === "-" && queryIndex > 0) {
          queryIndex--;
          void load();
          return;
        }
        if (matchesKey(data, Key.enter) && selection) done({ confirmed: true, selection });
        if (matchesKey(data, Key.escape)) done({ confirmed: false });
      },
      invalidate() {},
    };
  }, emailOverlayOptions());
}

function emailOverlayOptions() {
  return {
    overlay: true,
    overlayOptions: {
      width: "100%",
      maxHeight: "100%",
      anchor: "top-left",
      row: 0,
      col: 0,
      margin: 0,
    },
  };
}

async function gmailRequest<T>(method: "GET" | "POST", path: string, accessToken: string, body?: unknown): Promise<T> {
  const response = await fetch(`${GMAIL_API_BASE}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${accessToken}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(formatGmailApiError(response.status, text));
  return (text ? JSON.parse(text) : {}) as T;
}

async function gmailGet<T>(path: string, accessToken: string): Promise<T> {
  return gmailRequest<T>("GET", path, accessToken);
}

async function gmailPost<T>(path: string, accessToken: string, body: unknown): Promise<T> {
  return gmailRequest<T>("POST", path, accessToken, body);
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

type SenderInboxThread = {
  threadId: string;
  subject: string;
  date: string;
  snippet: string;
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
  unsubscribeMailtos: string[];
  chosenUrl?: string;
  inboxThreads: SenderInboxThread[];
  archiveThreadIds: string[];
  countInboxThreadsFromSender: number;
};

function senderEmail(from: string) {
  return (
    from.match(/<([^>]+)>/)?.[1] ?? from.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] ?? from.trim()
  ).toLowerCase();
}

function decodeBase64Url(data: string) {
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

function collectPayloadText(payload: GmailPayload | undefined): string {
  if (!payload) return "";
  const own = payload.body?.data ? decodeBase64Url(payload.body.data) : "";
  return [own, ...(payload.parts ?? []).map(collectPayloadText)].filter(Boolean).join("\n");
}

function cleanEmailText(text: string) {
  return text
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function extractHttpUrls(text: string) {
  return [...text.matchAll(/https?:\/\/[^\s"'<>]+/gi)]
    .map((match) => match[0].replace(/&amp;/g, "&").replace(/[),.;]+$/, ""))
    .filter((url, index, urls) => /unsubscribe|preferences|email-preference/i.test(url) && urls.indexOf(url) === index);
}

function extractMailtos(text: string) {
  return [...text.matchAll(/mailto:[^\s"'<>]+/gi)]
    .map((match) => match[0].replace(/&amp;/g, "&").replace(/[),.;]+$/, ""))
    .filter((url, index, urls) => urls.indexOf(url) === index);
}

async function listThreadIds(query: string, accessToken: string): Promise<string[]> {
  const ids: string[] = [];
  let pageToken: string | undefined;

  do {
    const params = new URLSearchParams({ q: query, maxResults: "500" });
    if (pageToken) params.set("pageToken", pageToken);
    const page = await gmailGet<{ threads?: Array<{ id: string }>; nextPageToken?: string }>(
      `/users/me/threads?${params}`,
      accessToken,
    );
    ids.push(...(page.threads ?? []).map((thread) => thread.id));
    pageToken = page.nextPageToken;
  } while (pageToken);

  return ids;
}

async function markThreadIdsRead(threadIds: string[], accessToken: string) {
  for (const threadId of threadIds) {
    await gmailPost(`/users/me/threads/${encodeURIComponent(threadId)}/modify`, accessToken, {
      removeLabelIds: ["UNREAD"],
    });
  }
}

async function archiveThreadIds(threadIds: string[]) {
  if (threadIds.length === 0) return;
  const accessToken = await getAccessToken();
  for (const threadId of threadIds) {
    await gmailPost(`/users/me/threads/${encodeURIComponent(threadId)}/modify`, accessToken, {
      removeLabelIds: ["INBOX", "UNREAD"],
    });
  }
}

async function spamThreadIds(threadIds: string[]) {
  if (threadIds.length === 0) return;
  const accessToken = await getAccessToken();
  for (const threadId of threadIds) {
    await gmailPost(`/users/me/threads/${encodeURIComponent(threadId)}/modify`, accessToken, {
      addLabelIds: ["SPAM"],
      removeLabelIds: ["INBOX", "UNREAD"],
    });
  }
}

async function trashThreadIds(threadIds: string[]) {
  if (threadIds.length === 0) return;
  const accessToken = await getAccessToken();
  await markThreadIdsRead(threadIds, accessToken);
  for (const threadId of threadIds) {
    await gmailPost(`/users/me/threads/${encodeURIComponent(threadId)}/trash`, accessToken, {});
  }
}

async function collectThreadSummaries(threadIds: string[], accessToken: string): Promise<SenderInboxThread[]> {
  const summaries: SenderInboxThread[] = [];

  for (const threadId of threadIds) {
    const thread = await gmailGet<{
      id: string;
      snippet?: string;
      messages?: Array<{ snippet?: string; payload?: { headers?: Array<{ name?: string; value?: string }> } }>;
    }>(`/users/me/threads/${encodeURIComponent(threadId)}?${new URLSearchParams({ format: "metadata" })}`, accessToken);
    const latestMessage = thread.messages?.at(-1);

    summaries.push({
      threadId: thread.id,
      subject: headerValue(latestMessage?.payload?.headers, "Subject"),
      date: headerValue(latestMessage?.payload?.headers, "Date"),
      snippet: latestMessage?.snippet ?? thread.snippet ?? "",
    });
  }

  return summaries;
}

function formatThreadTitles(threads: SenderInboxThread[]) {
  return threads.map((thread, index) => `${index + 1}. ${thread.subject || "(no subject)"}`).join("\n");
}

function formatCandidatePrompt(candidate: UnsubscribeCandidate) {
  return [
    `${candidate.senderEmail} — ${candidate.countInboxThreadsFromSender} inbox thread(s)`,
    candidate.sender && candidate.sender !== candidate.senderEmail ? `From: ${candidate.sender}` : undefined,
    `Newest unsubscribe email: ${candidate.subject || "(no subject)"}`,
    "Inbox titles:",
    formatThreadTitles(candidate.inboxThreads),
  ]
    .filter(Boolean)
    .join("\n");
}

function formatCandidateSummary(candidate: UnsubscribeCandidate) {
  return [
    `${candidate.senderEmail} — ${candidate.countInboxThreadsFromSender} inbox thread(s)`,
    `Newest unsubscribe email: ${candidate.subject || "(no subject)"}`,
    "Inbox titles:",
    formatThreadTitles(candidate.inboxThreads),
    candidate.chosenUrl ? `Unsubscribe: ${candidate.chosenUrl}` : "No HTTP unsubscribe URL found.",
  ].join("\n");
}

async function collectNewestInboxSweepItem(excludedThreadIds = new Set<string>()): Promise<InboxSweepItem | null> {
  const accessToken = await getAccessToken();
  let pageToken: string | undefined;

  do {
    const params = new URLSearchParams({ q: "in:inbox", maxResults: "50" });
    if (pageToken) params.set("pageToken", pageToken);
    const page = await gmailGet<{ messages?: Array<{ id: string; threadId: string }>; nextPageToken?: string }>(
      `/users/me/messages?${params}`,
      accessToken,
    );

    for (const message of page.messages ?? []) {
      if (excludedThreadIds.has(message.threadId)) continue;
      const full = await gmailGet<{
        id: string;
        threadId: string;
        snippet?: string;
        payload?: GmailPayload;
      }>(`/users/me/messages/${message.id}?${new URLSearchParams({ format: "full" })}`, accessToken);
      if (excludedThreadIds.has(full.threadId)) continue;

      const from = headerValue(full.payload?.headers, "From");
      return {
        messageId: full.id,
        threadId: full.threadId,
        from,
        senderEmail: senderEmail(from),
        subject: headerValue(full.payload?.headers, "Subject"),
        date: headerValue(full.payload?.headers, "Date"),
        snippet: full.snippet ?? "",
        bodyText: cleanEmailText(collectPayloadText(full.payload)),
      };
    }

    pageToken = page.nextPageToken;
  } while (pageToken);

  return null;
}

function firstReadableExcerpt(item: InboxSweepItem) {
  const text = (item.bodyText || item.snippet || "").trim();
  if (!text) return "No preview text.";

  const paragraph = text.split(/\n\s*\n/).find((part) => part.trim()) ?? text;
  const sentence = paragraph.match(/^.{40,}?[.!?](?:\s|$)/)?.[0] ?? paragraph;
  return sentence.replace(/\s+/g, " ").trim().slice(0, 700);
}

function formatInboxSweepPrompt(item: InboxSweepItem) {
  const query = `in:inbox from:${item.senderEmail}`;
  const body = (item.bodyText || item.snippet || "No preview text.").trim();
  return [
    item.from || item.senderEmail || "unknown sender",
    `Link: ${gmailSearchUrl(query)}`,
    "",
    item.subject || "(no subject)",
    "",
    body,
  ].join("\n");
}

const SUBJECT_STOPWORDS = new Set([
  "about",
  "after",
  "before",
  "digest",
  "email",
  "from",
  "newsletter",
  "notification",
  "this",
  "today",
  "update",
  "weekly",
  "with",
  "your",
]);

function subjectKeywords(subject: string) {
  return (subject.toLowerCase().match(/[a-z0-9]{4,}/g) ?? [])
    .filter((word, index, words) => !SUBJECT_STOPWORDS.has(word) && words.indexOf(word) === index)
    .slice(0, 4);
}

function similarInboxQuery(item: InboxSweepItem) {
  const keywords = subjectKeywords(item.subject);
  const subjectTerms = keywords.map((keyword) => `subject:${keyword}`).join(" ");
  return [`in:inbox`, `from:${item.senderEmail}`, subjectTerms].filter(Boolean).join(" ");
}

function broadSimilarInboxQuery(item: InboxSweepItem) {
  return [`in:inbox`, `from:${item.senderEmail}`].filter(Boolean).join(" ");
}

async function collectSimilarInboxSelection(item: InboxSweepItem, query: string) {
  const accessToken = await getAccessToken();
  const threadIds = await listThreadIds(query, accessToken);
  const uniqueThreadIds = [item.threadId, ...threadIds].filter((threadId, index, ids) => ids.indexOf(threadId) === index);
  return {
    query,
    threadIds: uniqueThreadIds,
    summaries: await collectThreadSummaries(uniqueThreadIds, accessToken),
  };
}

async function collectUnsubscribeCandidates(maxSenders = 10, excludedSenders = new Set<string>()): Promise<UnsubscribeCandidate[]> {
  const accessToken = await getAccessToken();
  const list = await gmailGet<{ messages?: Array<{ id: string; threadId: string }> }>(
    `/users/me/messages?${new URLSearchParams({ q: "in:inbox unsubscribe", maxResults: String(Math.min(Math.max(maxSenders * 10, 50), 100)) })}`,
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
    if (!email || seenSenders.has(email) || excludedSenders.has(email)) continue;
    seenSenders.add(email);

    const listUnsubscribe = headerValue(full.payload?.headers, "List-Unsubscribe");
    const bodyText = collectPayloadText(full.payload);
    const headerUrls = extractHttpUrls(listUnsubscribe);
    const bodyUrls = extractHttpUrls(bodyText);
    const unsubscribeUrls = [...headerUrls, ...bodyUrls].filter((url, index, urls) => urls.indexOf(url) === index);
    const unsubscribeMailtos = [...extractMailtos(listUnsubscribe), ...extractMailtos(bodyText)].filter(
      (url, index, urls) => urls.indexOf(url) === index,
    );
    const matchingThreadIds = await listThreadIds(`in:inbox from:${email}`, accessToken);
    const archiveThreadIds = [full.threadId, ...matchingThreadIds].filter((id, index, ids) => ids.indexOf(id) === index);
    const inboxThreads = await collectThreadSummaries(archiveThreadIds, accessToken);

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
      unsubscribeMailtos,
      chosenUrl: unsubscribeUrls[0],
      inboxThreads,
      archiveThreadIds,
      countInboxThreadsFromSender: archiveThreadIds.length,
    });
  }

  return candidates;
}

async function runInboxSweep(ctx: any) {
  await ctx.ui.custom<void>((tui: { requestRender: () => void }, theme: any, _kb: unknown, done: () => void) => {
    const skippedThreadIds = new Set<string>();
    let item: InboxSweepItem | null = null;
    let nextItemPromise: Promise<InboxSweepItem | null> | null = null;
    let considered = 0;
    let processing = false;
    let message = "Loading newest inbox email…";
    let scrollOffset = 0;

    const excludedForNext = () => {
      const excluded = new Set(skippedThreadIds);
      if (item) excluded.add(item.threadId);
      return excluded;
    };

    const prefetchNext = () => {
      nextItemPromise = collectNewestInboxSweepItem(excludedForNext()).catch((error) => {
        message = `Prefetch failed: ${error instanceof Error ? error.message : String(error)}`;
        tui.requestRender();
        return null;
      });
    };

    const showNext = async (usePrefetch: boolean) => {
      processing = true;
      message = "Loading next inbox email…";
      tui.requestRender();
      item = usePrefetch && nextItemPromise ? await nextItemPromise : await collectNewestInboxSweepItem(skippedThreadIds);
      scrollOffset = 0;
      processing = false;
      if (!item) {
        ctx.ui.notify(considered === 0 ? "No inbox emails found." : "inbox sweep complete", "info");
        done();
        return;
      }
      considered++;
      message = `Triaging ${item.senderEmail || item.from || "email"}`;
      ctx.ui.setStatus("email", `email: ${message.toLowerCase()}`);
      prefetchNext();
      tui.requestRender();
    };

    const act = async (choice: EmailAction) => {
      if (processing || !item) return;
      if (choice === "escape") {
        ctx.ui.notify("inbox sweep stopped", "info");
        done();
        return;
      }
      const current = item;
      try {
        if (choice === "skip") {
          skippedThreadIds.add(current.threadId);
          await showNext(true);
          return;
        }
        if (choice === "archive") {
          processing = true;
          message = `Archiving ${current.senderEmail || "thread"}…`;
          tui.requestRender();
          await archiveThreadIds([current.threadId]);
          await showNext(true);
          return;
        }
        if (choice === "trash") {
          processing = true;
          message = `Moving ${current.senderEmail || "thread"} to trash…`;
          tui.requestRender();
          await trashThreadIds([current.threadId]);
          await showNext(true);
          return;
        }
        if (choice === "spam") {
          processing = true;
          message = `Moving ${current.senderEmail || "thread"} to spam…`;
          tui.requestRender();
          await spamThreadIds([current.threadId]);
          await showNext(true);
          return;
        }
        if (choice === "archiveSimilar" || choice === "trashSimilar") {
          processing = true;
          message = `Finding messages like ${current.senderEmail || "this"}…`;
          tui.requestRender();
          const isTrash = choice === "trashSimilar";
          const result = await confirmBulkAction(ctx, isTrash ? "trash messages like this" : "archive messages like this", current);
          if (!result.confirmed) {
            skippedThreadIds.add(current.threadId);
            await showNext(true);
            return;
          }
          const { query, threadIds } = result.selection;
          message = `${isTrash ? "Moving" : "Archiving"} ${threadIds.length} similar thread(s)…`;
          tui.requestRender();
          if (isTrash) await trashThreadIds(threadIds);
          else await archiveThreadIds(threadIds);
          ctx.ui.notify(`${isTrash ? "moved" : "archived"} ${threadIds.length} similar inbox thread(s) using query: ${query}`, "info");
          await showNext(false);
        }
      } catch (error) {
        message = `Action failed: ${error instanceof Error ? error.message : String(error)}`;
        processing = false;
        tui.requestRender();
      }
    };

    setTimeout(() => void showNext(false), 0);

    return {
      render(width: number) {
        const body = item ? formatInboxSweepPrompt(item).split("\n") : [message];
        if (processing) body.push("", theme?.fg ? theme.fg("muted", message) : message);
        return boxedLines("Inbox sweep", body, `${actionLegend(INBOX_SWEEP_ACTIONS)}  ·  ↑/↓ Scroll  ·  ? Help`, width, theme, scrollOffset);
      },
      handleInput(data: string) {
        if (matchesKey(data, Key.up)) {
          scrollOffset = Math.max(0, scrollOffset - 1);
          tui.requestRender();
          return;
        }
        if (matchesKey(data, Key.down)) {
          scrollOffset += 1;
          tui.requestRender();
          return;
        }
        if (matchesKey(data, "pageup") || matchesKey(data, Key.ctrl("u"))) {
          scrollOffset = Math.max(0, scrollOffset - 10);
          tui.requestRender();
          return;
        }
        if (matchesKey(data, "pagedown") || matchesKey(data, Key.ctrl("d"))) {
          scrollOffset += 10;
          tui.requestRender();
          return;
        }
        const action = actionForKey(data, INBOX_SWEEP_ACTIONS);
        if (action) void act(action);
      },
      invalidate() {},
    };
  }, emailOverlayOptions());
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
          "/email config, /email auth, /email status, /email inbox, /email inbox-sweep, /email unsubscribe-candidates, /email unsubscribe-sweep, /email logout, /email clear-config",
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
        ctx.ui.setStatus("email", "email: loading inbox…");
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
        } finally {
          ctx.ui.setStatus("email", undefined);
        }
        return;
      }

      if (subcommand === "inbox-sweep") {
        try {
          await runInboxSweep(ctx);
        } catch (error) {
          ctx.ui.notify(`inbox sweep failed: ${error instanceof Error ? error.message : String(error)}`, "error");
        } finally {
          ctx.ui.setStatus("email", undefined);
        }
        return;
      }

      if (subcommand === "unsubscribe-candidates") {
        ctx.ui.setStatus("email", "email: finding newest unsubscribe senders…");
        try {
          const candidates = await collectUnsubscribeCandidates(10);
          ctx.ui.notify(
            candidates.length === 0
              ? "No unsubscribe candidates found."
              : candidates.map(formatCandidateSummary).join("\n\n"),
            "info",
          );
        } catch (error) {
          ctx.ui.notify(`unsubscribe candidates failed: ${error instanceof Error ? error.message : String(error)}`, "error");
        } finally {
          ctx.ui.setStatus("email", undefined);
        }
        return;
      }

      if (subcommand === "unsubscribe-sweep") {
        const skippedSenders = new Set<string>();
        let considered = 0;

        try {
          while (true) {
            ctx.ui.setStatus("email", "email: finding newest unsubscribe sender…");
            const [candidate] = await collectUnsubscribeCandidates(1, skippedSenders);
            if (!candidate) {
              ctx.ui.notify(considered === 0 ? "No unsubscribe candidates found." : "unsubscribe sweep complete", "info");
              return;
            }

            considered++;
            ctx.ui.setStatus("email", `email: triaging ${candidate.senderEmail}`);
            const choice = await chooseEmailAction(ctx, "Unsubscribe sweep", formatCandidatePrompt(candidate), UNSUBSCRIBE_SWEEP_ACTIONS);

            if (choice === "escape") {
              ctx.ui.notify("unsubscribe sweep stopped", "info");
              return;
            }

            if (choice === "skip") {
              skippedSenders.add(candidate.senderEmail);
              continue;
            }

            if (choice === "unsubscribeArchive") {
              if (candidate.chosenUrl) await execFileAsync("open", [candidate.chosenUrl]);
              else ctx.ui.notify(`No HTTP unsubscribe link found for ${candidate.senderEmail}. Archiving only.`, "warning");
            }

            if (choice === "spam") {
              ctx.ui.setStatus("email", `email: moving ${candidate.countInboxThreadsFromSender} thread(s) from ${candidate.senderEmail} to spam…`);
              await spamThreadIds(candidate.archiveThreadIds);
              ctx.ui.notify(`moved ${candidate.countInboxThreadsFromSender} inbox thread(s) from ${candidate.senderEmail} to spam`, "info");
              continue;
            }

            if (choice === "trash") {
              ctx.ui.setStatus("email", `email: moving ${candidate.countInboxThreadsFromSender} thread(s) from ${candidate.senderEmail} to trash…`);
              await trashThreadIds(candidate.archiveThreadIds);
              ctx.ui.notify(`moved ${candidate.countInboxThreadsFromSender} inbox thread(s) from ${candidate.senderEmail} to trash`, "info");
              continue;
            }

            ctx.ui.setStatus("email", `email: archiving ${candidate.countInboxThreadsFromSender} thread(s) from ${candidate.senderEmail}…`);
            await archiveThreadIds(candidate.archiveThreadIds);
            ctx.ui.notify(`archived ${candidate.countInboxThreadsFromSender} inbox thread(s) from ${candidate.senderEmail}`, "info");
          }
        } catch (error) {
          ctx.ui.notify(`unsubscribe sweep failed: ${error instanceof Error ? error.message : String(error)}`, "error");
        } finally {
          ctx.ui.setStatus("email", undefined);
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

      ctx.ui.notify(`unknown email command: ${subcommand}`, "warning");
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
                : candidates.map(formatCandidateSummary).join("\n\n"),
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
          localModel: {
            provider: "ollama",
            model: OLLAMA_EMAIL_MODEL,
            baseUrl: OLLAMA_API_BASE,
            keepAlive: OLLAMA_KEEP_ALIVE,
          },
        },
      };
    },
  });
}
