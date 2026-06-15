import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Editor, type EditorTheme, Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
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

type EmailAction =
  | "archive"
  | "trash"
  | "spam"
  | "archiveSimilar"
  | "trashSimilar"
  | "replyNext"
  | "unsubscribeOpen"
  | "unsubscribeArchiveSender"
  | "skip"
  | "previous"
  | "jumpNext"
  | "jumpPrevious"
  | "escape";

const EMAIL_ACTIONS: Record<EmailAction, { label: string; keys: string[] }> = {
  archive: { label: "Archive", keys: ["Return", "e"] },
  trash: { label: "Trash", keys: ["#"] },
  spam: { label: "Spam", keys: ["!"] },
  archiveSimilar: { label: "Archive messages like this", keys: ["E"] },
  trashSimilar: { label: "Trash messages like this", keys: ["T"] },
  replyNext: { label: "Reply and next", keys: ["r"] },
  unsubscribeOpen: { label: "Open unsubscribe link", keys: ["u"] },
  unsubscribeArchiveSender: { label: "Open unsubscribe and archive sender", keys: ["U"] },
  skip: { label: "Next", keys: ["j"] },
  previous: { label: "Previous", keys: ["k"] },
  jumpNext: { label: "Jump next 10", keys: ["J"] },
  jumpPrevious: { label: "Jump previous 10", keys: ["K"] },
  escape: { label: "Escape", keys: ["q", "Esc"] },
};

const INBOX_SWEEP_ACTIONS: EmailAction[] = [
  "archive",
  "archiveSimilar",
  "trash",
  "trashSimilar",
  "spam",
  "replyNext",
  "unsubscribeOpen",
  "unsubscribeArchiveSender",
  "skip",
  "previous",
  "jumpNext",
  "jumpPrevious",
  "escape",
];

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

type InboxSweepItem = {
  messageId: string;
  threadId: string;
  from: string;
  senderEmail: string;
  subject: string;
  date: string;
  snippet: string;
  bodyText: string;
  replyTo: string;
  messageIdHeader: string;
  referencesHeader: string;
  unsubscribeUrls: string[];
  chosenUnsubscribeUrl?: string;
};

function headerValue(headers: Array<{ name?: string; value?: string }> | undefined, name: string) {
  return headers?.find((header) => header.name?.toLowerCase() === name.toLowerCase())?.value ?? "";
}

function uniqueValues<T>(values: T[]): T[] {
  return Array.from(new Set(values));
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
  if (matchesKey(data, Key.enter) && actions.includes("archive")) return "archive";
  if ((matchesKey(data, Key.escape) || data === "q") && actions.includes("escape")) return "escape";
  if (data === "j" && actions.includes("skip")) return "skip";
  if (data === "k" && actions.includes("previous")) return "previous";
  if (data === "J" && actions.includes("jumpNext")) return "jumpNext";
  if (data === "K" && actions.includes("jumpPrevious")) return "jumpPrevious";
  if (data === "e" && actions.includes("archive")) return "archive";
  if (data === "#" && actions.includes("trash")) return "trash";
  if (data === "!" && actions.includes("spam")) return "spam";
  if (data === "E" && actions.includes("archiveSimilar")) return "archiveSimilar";
  if (data === "T" && actions.includes("trashSimilar")) return "trashSimilar";
  if (data === "r" && actions.includes("replyNext")) return "replyNext";
  if (data === "u" && actions.includes("unsubscribeOpen")) return "unsubscribeOpen";
  if (data === "U" && actions.includes("unsubscribeArchiveSender")) return "unsubscribeArchiveSender";
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

function gmailSearchUrl(query: string) {
  return `https://mail.google.com/mail/u/0/#search/${encodeURIComponent(query)}`;
}

async function confirmBulkAction(ctx: any, actionLabel: string, item: InboxSweepItem) {
  type BulkSelection = Awaited<ReturnType<typeof collectSimilarInboxSelection>>;
  type BulkResult = { confirmed: true; selection: BulkSelection } | { confirmed: false };
  const queries = uniqueValues([similarInboxQuery(item), broadSimilarInboxQuery(item)]);

  return await ctx.ui.custom<BulkResult>((tui: { requestRender: () => void }, theme: any, _keybindings: unknown, done: (value: BulkResult) => void) => {
    let queryIndex = 0;
    let selection: BulkSelection | null = null;
    let loading = "Loading matching threads…";
    let loadVersion = 0;

    const load = async () => {
      const version = ++loadVersion;
      const query = queries[queryIndex] ?? queries[0]!;
      loading = `Loading matches for: ${query}`;
      selection = null;
      tui.requestRender();
      try {
        const nextSelection = await collectSimilarInboxSelection(item, query);
        if (version !== loadVersion) return;
        selection = nextSelection;
        loading = "";
      } catch (error) {
        if (version !== loadVersion) return;
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

type ReplyComposeResult = { send: true; body: string } | { send: false };

async function composeReply(ctx: any, item: InboxSweepItem): Promise<ReplyComposeResult> {
  return await ctx.ui.custom<ReplyComposeResult>((tui: any, theme: any, _keybindings: unknown, done: (value: ReplyComposeResult) => void) => {
    const editorTheme: EditorTheme = {
      borderColor: (text) => theme?.fg ? theme.fg("accent", text) : text,
      selectList: {
        selectedPrefix: (text) => theme?.fg ? theme.fg("accent", text) : text,
        selectedText: (text) => theme?.fg ? theme.fg("accent", text) : text,
        description: (text) => theme?.fg ? theme.fg("muted", text) : text,
        scrollInfo: (text) => theme?.fg ? theme.fg("dim", text) : text,
        noMatch: (text) => theme?.fg ? theme.fg("warning", text) : text,
      },
    };
    const editor = new Editor(tui, editorTheme, { paddingX: 1 });
    editor.focused = true;
    editor.disableSubmit = true;
    let message = "";

    const submit = () => {
      const body = editor.getExpandedText().trim();
      if (!body) {
        message = "Write a reply before sending.";
        tui.requestRender();
        return;
      }
      done({ send: true, body });
    };

    return {
      render(width: number) {
        const innerWidth = Math.max(20, width - 4);
        const topTitle = " Reply ";
        const top = "┌" + topTitle + "─".repeat(Math.max(0, width - topTitle.length - 2)) + "┐";
        const bottom = borderLine(width, "└", "─", "┘");
        const separator = borderLine(width, "├", "─", "┤");
        const headerLines = [
          `To: ${item.replyTo || item.from || item.senderEmail}`,
          `Subject: ${replySubject(item.subject)}`,
          item.subject ? `Thread: ${item.subject}` : undefined,
          message ? "" : undefined,
          message || undefined,
        ].filter((line) => line !== undefined) as string[];
        const header = headerLines.map((line) => `│ ${truncateToWidth(line, innerWidth).padEnd(innerWidth)} │`);
        const editorLines = editor.render(innerWidth).map((line) => `│ ${truncateToWidth(line, innerWidth).padEnd(innerWidth)} │`);
        const footerText = "Ctrl-S/Ctrl-X Send  ·  Esc Cancel  ·  Enter New Line";
        const footer = `│ ${truncateToWidth(footerText, innerWidth).padEnd(innerWidth)} │`;
        return [theme?.fg ? theme.fg("accent", top) : top, ...header, separator, ...editorLines, separator, theme?.fg ? theme.fg("muted", footer) : footer, bottom];
      },
      handleInput(data: string) {
        message = "";
        if (matchesKey(data, Key.escape)) {
          done({ send: false });
          return;
        }
        if (matchesKey(data, Key.ctrl("s")) || matchesKey(data, Key.ctrl("x"))) {
          submit();
          return;
        }
        if (matchesKey(data, Key.enter)) {
          editor.insertTextAtCursor("\n");
          tui.requestRender();
          return;
        }
        editor.handleInput(data);
        tui.requestRender();
      },
      invalidate() {
        editor.invalidate();
      },
    };
  }, emailOverlayOptions());
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

type GmailThreadModifyBody = {
  addLabelIds?: string[];
  removeLabelIds?: string[];
};

function senderEmail(from: string) {
  return (
    from.match(/<([^>]+)>/)?.[1] ?? from.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] ?? from.trim()
  ).toLowerCase();
}

function decodeBase64Url(data: string) {
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

function collectPayloadTexts(payload: GmailPayload | undefined): { plain: string[]; html: string[]; other: string[] } {
  if (!payload) return { plain: [], html: [], other: [] };

  const nested = (payload.parts ?? []).map(collectPayloadTexts).reduce(
    (acc, part) => ({
      plain: [...acc.plain, ...part.plain],
      html: [...acc.html, ...part.html],
      other: [...acc.other, ...part.other],
    }),
    { plain: [] as string[], html: [] as string[], other: [] as string[] },
  );

  if (!payload.body?.data) return nested;

  const text = decodeBase64Url(payload.body.data);
  const mimeType = payload.mimeType?.toLowerCase() ?? "";
  if (mimeType === "text/plain") nested.plain.push(text);
  else if (mimeType === "text/html") nested.html.push(text);
  else nested.other.push(text);
  return nested;
}

function collectPreferredPayloadText(payload: GmailPayload | undefined): string {
  const texts = collectPayloadTexts(payload);
  const preferred = texts.plain.length > 0 ? texts.plain : texts.html.length > 0 ? texts.html : texts.other;
  return preferred.filter(Boolean).join("\n");
}

function collectAllPayloadText(payload: GmailPayload | undefined): string {
  const texts = collectPayloadTexts(payload);
  return [...texts.plain, ...texts.html, ...texts.other].filter(Boolean).join("\n");
}

function decodeHtmlCodePoint(codePoint: number, fallback: string) {
  return Number.isFinite(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : fallback;
}

function decodeHtmlEntities(text: string) {
  return text
    .replace(/&#(\d+);/g, (match, code) => decodeHtmlCodePoint(Number(code), match))
    .replace(/&#x([0-9a-f]+);/gi, (match, code) => decodeHtmlCodePoint(parseInt(code, 16), match))
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'");
}

function cleanEmailText(text: string) {
  return decodeHtmlEntities(text)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sanitizeHeaderValue(value: string) {
  return value.replace(/[\r\n]+/g, " ").trim();
}

function encodeMimeHeader(value: string) {
  const sanitized = sanitizeHeaderValue(value);
  return /^[\x20-\x7E]*$/.test(sanitized) ? sanitized : `=?UTF-8?B?${Buffer.from(sanitized, "utf8").toString("base64")}?=`;
}

function replySubject(subject: string) {
  const sanitized = sanitizeHeaderValue(subject);
  if (!sanitized) return "Re: (no subject)";
  return /^re\s*:/i.test(sanitized) ? sanitized : `Re: ${sanitized}`;
}

function base64UrlEncode(value: string) {
  return Buffer.from(value, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function buildReplyRawMessage(item: InboxSweepItem, body: string) {
  const messageId = sanitizeHeaderValue(item.messageIdHeader);
  const priorReferences = sanitizeHeaderValue(item.referencesHeader);
  const references = [priorReferences, messageId].filter(Boolean).join(" ");
  const headers = [
    `To: ${sanitizeHeaderValue(item.replyTo || item.from || item.senderEmail)}`,
    `Subject: ${encodeMimeHeader(replySubject(item.subject))}`,
    messageId ? `In-Reply-To: ${messageId}` : undefined,
    references ? `References: ${references}` : undefined,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
  ].filter((line) => line !== undefined);

  return base64UrlEncode(`${headers.join("\r\n")}\r\n\r\n${body.trimEnd()}\r\n`);
}

function extractHttpUrls(text: string) {
  return uniqueValues(
    [...text.matchAll(/https?:\/\/[^\s"'<>]+/gi)]
      .map((match) => match[0].replace(/&amp;/g, "&").replace(/[),.;]+$/, ""))
      .filter((url) => /unsubscribe|preferences|email-preference/i.test(url)),
  );
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

async function modifyThreadIds(threadIds: string[], accessToken: string, body: GmailThreadModifyBody) {
  for (const threadId of uniqueValues(threadIds)) {
    await gmailPost(`/users/me/threads/${encodeURIComponent(threadId)}/modify`, accessToken, {
      ...body,
    });
  }
}

async function markThreadIdsRead(threadIds: string[], accessToken: string) {
  await modifyThreadIds(threadIds, accessToken, { removeLabelIds: ["UNREAD"] });
}

async function archiveThreadIds(threadIds: string[]) {
  if (threadIds.length === 0) return;
  const accessToken = await getAccessToken();
  await modifyThreadIds(threadIds, accessToken, { removeLabelIds: ["INBOX", "UNREAD"] });
}

async function spamThreadIds(threadIds: string[]) {
  if (threadIds.length === 0) return;
  const accessToken = await getAccessToken();
  await modifyThreadIds(threadIds, accessToken, { addLabelIds: ["SPAM"], removeLabelIds: ["INBOX", "UNREAD"] });
}

async function trashThreadIds(threadIds: string[]) {
  const uniqueThreadIds = uniqueValues(threadIds);
  if (uniqueThreadIds.length === 0) return;
  const accessToken = await getAccessToken();
  await markThreadIdsRead(uniqueThreadIds, accessToken);
  for (const threadId of uniqueThreadIds) {
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

async function sendReply(item: InboxSweepItem, body: string) {
  const accessToken = await getAccessToken();
  return await gmailPost<{ id: string; threadId: string }>(`/users/me/messages/send`, accessToken, {
    raw: buildReplyRawMessage(item, body),
    threadId: item.threadId,
  });
}

async function collectInboxSweepItemFromMessage(message: { id: string; threadId: string }, accessToken: string): Promise<InboxSweepItem> {
  const full = await gmailGet<{
    id: string;
    threadId: string;
    snippet?: string;
    payload?: GmailPayload;
  }>(`/users/me/messages/${message.id}?${new URLSearchParams({ format: "full" })}`, accessToken);

  const from = headerValue(full.payload?.headers, "From");
  const replyTo = headerValue(full.payload?.headers, "Reply-To") || from;
  const listUnsubscribe = headerValue(full.payload?.headers, "List-Unsubscribe");
  const rawBodyText = collectPreferredPayloadText(full.payload);
  const allBodyText = collectAllPayloadText(full.payload);
  const unsubscribeUrls = uniqueValues([...extractHttpUrls(listUnsubscribe), ...extractHttpUrls(allBodyText)]);

  return {
    messageId: full.id,
    threadId: full.threadId,
    from,
    senderEmail: senderEmail(from),
    subject: headerValue(full.payload?.headers, "Subject"),
    date: headerValue(full.payload?.headers, "Date"),
    snippet: full.snippet ?? "",
    bodyText: cleanEmailText(rawBodyText),
    replyTo,
    messageIdHeader: headerValue(full.payload?.headers, "Message-ID"),
    referencesHeader: headerValue(full.payload?.headers, "References"),
    unsubscribeUrls,
    chosenUnsubscribeUrl: unsubscribeUrls[0],
  };
}

async function collectInboxSweepItemAtOffset(
  offset: number,
  excludedThreadIds = new Set<string>(),
): Promise<{ item: InboxSweepItem | null; skippedThreadIds: string[] }> {
  const accessToken = await getAccessToken();
  const seenThreadIds = new Set(excludedThreadIds);
  const skippedThreadIds: string[] = [];
  let pageToken: string | undefined;
  let remaining = Math.max(0, offset);
  let lastCandidate: { id: string; threadId: string } | null = null;

  do {
    const params = new URLSearchParams({ q: "in:inbox", maxResults: "100" });
    if (pageToken) params.set("pageToken", pageToken);
    const page = await gmailGet<{ messages?: Array<{ id: string; threadId: string }>; nextPageToken?: string }>(
      `/users/me/messages?${params}`,
      accessToken,
    );

    for (const message of page.messages ?? []) {
      if (seenThreadIds.has(message.threadId)) continue;
      seenThreadIds.add(message.threadId);
      lastCandidate = message;

      if (remaining > 0) {
        skippedThreadIds.push(message.threadId);
        remaining--;
        continue;
      }

      return {
        item: await collectInboxSweepItemFromMessage(message, accessToken),
        skippedThreadIds,
      };
    }

    pageToken = page.nextPageToken;
  } while (pageToken);

  if (!lastCandidate) return { item: null, skippedThreadIds };

  return {
    item: await collectInboxSweepItemFromMessage(lastCandidate, accessToken),
    skippedThreadIds: skippedThreadIds.filter((threadId) => threadId !== lastCandidate!.threadId),
  };
}

async function collectNewestInboxSweepItem(excludedThreadIds = new Set<string>()): Promise<InboxSweepItem | null> {
  return (await collectInboxSweepItemAtOffset(0, excludedThreadIds)).item;
}

function formatInboxSweepPrompt(item: InboxSweepItem) {
  const query = `in:inbox from:${item.senderEmail}`;
  const body = (item.bodyText || item.snippet || "No preview text.").trim();
  return [
    item.from || item.senderEmail || "unknown sender",
    `Link: ${gmailSearchUrl(query)}`,
    item.chosenUnsubscribeUrl ? `Unsubscribe: ${item.chosenUnsubscribeUrl}` : undefined,
    "",
    item.subject || "(no subject)",
    "",
    body,
  ].filter((line) => line !== undefined).join("\n");
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
  return uniqueValues(subject.toLowerCase().match(/[a-z0-9]{4,}/g) ?? [])
    .filter((word) => !SUBJECT_STOPWORDS.has(word))
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

async function collectInboxThreadIdsFromSender(item: InboxSweepItem) {
  const query = broadSimilarInboxQuery(item);
  const threadIds = await listThreadIds(query, await getAccessToken());
  return {
    query,
    threadIds: uniqueValues([item.threadId, ...threadIds]),
  };
}

async function collectSimilarInboxSelection(item: InboxSweepItem, query: string) {
  const accessToken = await getAccessToken();
  const threadIds = await listThreadIds(query, accessToken);
  const uniqueThreadIds = uniqueValues([item.threadId, ...threadIds]);
  return {
    query,
    threadIds: uniqueThreadIds,
    summaries: await collectThreadSummaries(uniqueThreadIds, accessToken),
  };
}

async function runInboxSweep(ctx: any) {
  await ctx.ui.custom<void>((tui: { requestRender: () => void }, theme: any, _kb: unknown, done: () => void) => {
    const removedThreadIds = new Set<string>();
    const passedThreadIds = new Set<string>();
    const items: InboxSweepItem[] = [];
    let currentIndex = -1;
    let item: InboxSweepItem | null = null;
    let nextItemPromise: Promise<InboxSweepItem | null> | null = null;
    let considered = 0;
    let processing = false;
    let message = "Loading newest inbox email…";
    let scrollOffset = 0;

    const currentLabel = (current: InboxSweepItem) => current.senderEmail || current.from || "email";

    const excludedForNext = () => {
      const excluded = new Set(removedThreadIds);
      for (const threadId of passedThreadIds) excluded.add(threadId);
      for (const cached of items) excluded.add(cached.threadId);
      return excluded;
    };

    const prefetchNext = () => {
      nextItemPromise = collectNewestInboxSweepItem(excludedForNext()).then((prefetched) => {
        if (!prefetched) return null;
        if (removedThreadIds.has(prefetched.threadId)) return null;
        if (passedThreadIds.has(prefetched.threadId)) return null;
        if (items.some((cached) => cached.threadId === prefetched.threadId)) return null;
        return prefetched;
      }).catch((error) => {
        message = `Prefetch failed: ${error instanceof Error ? error.message : String(error)}`;
        tui.requestRender();
        return null;
      });
    };

    const setCurrentItem = (next: InboxSweepItem) => {
      item = next;
      scrollOffset = 0;
      message = `Triaging ${currentLabel(next)}`;
      ctx.ui.setStatus("email", `email: ${message.toLowerCase()}`);
    };

    const loadNextInboxItem = async (usePrefetch: boolean) => {
      const prefetched = usePrefetch && nextItemPromise ? await nextItemPromise : null;
      nextItemPromise = null;
      if (
        prefetched &&
        !removedThreadIds.has(prefetched.threadId) &&
        !passedThreadIds.has(prefetched.threadId) &&
        !items.some((cached) => cached.threadId === prefetched.threadId)
      ) {
        return prefetched;
      }
      return await collectNewestInboxSweepItem(excludedForNext());
    };

    const loadJumpInboxItem = async (offset: number) => {
      nextItemPromise = null;
      const result = await collectInboxSweepItemAtOffset(offset, excludedForNext());
      for (const threadId of result.skippedThreadIds) passedThreadIds.add(threadId);
      return result.item;
    };

    const showNext = async (count = 1, usePrefetch = true) => {
      processing = true;
      message = count > 1 ? `Jumping ahead ${count} inbox emails…` : "Loading next inbox email…";
      tui.requestRender();

      const futureCount = Math.max(0, items.length - currentIndex - 1);
      if (count <= futureCount) {
        currentIndex += count;
        setCurrentItem(items[currentIndex]!);
        processing = false;
        prefetchNext();
        tui.requestRender();
        return;
      }

      const remaining = count - futureCount;
      if (futureCount > 0) {
        currentIndex = items.length - 1;
        setCurrentItem(items[currentIndex]!);
      }

      const next = remaining === 1 ? await loadNextInboxItem(usePrefetch) : await loadJumpInboxItem(remaining - 1);
      processing = false;

      if (!next) {
        if (!item) {
          ctx.ui.notify(considered === 0 ? "No inbox emails found." : "inbox sweep complete", "info");
          done();
          return;
        }
        message = "No more inbox emails loaded.";
        tui.requestRender();
        return;
      }

      items.push(next);
      currentIndex = items.length - 1;
      considered++;
      setCurrentItem(next);
      prefetchNext();
      tui.requestRender();
    };

    const showPrevious = (count = 1) => {
      if (!item) return;
      if (currentIndex <= 0) {
        message = "At newest loaded email.";
        tui.requestRender();
        return;
      }
      currentIndex = Math.max(0, currentIndex - count);
      setCurrentItem(items[currentIndex]!);
      prefetchNext();
      tui.requestRender();
    };

    const removeThreadIdsFromCache = (threadIds: string[]) => {
      for (const threadId of threadIds) removedThreadIds.add(threadId);
      const removed = new Set(threadIds);
      for (let index = items.length - 1; index >= 0; index--) {
        if (!removed.has(items[index]!.threadId)) continue;
        items.splice(index, 1);
        if (index <= currentIndex) currentIndex--;
      }
      if (currentIndex >= items.length) currentIndex = items.length - 1;
      item = currentIndex >= 0 ? items[currentIndex]! : null;
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
          await showNext(1, true);
          return;
        }
        if (choice === "previous") {
          showPrevious(1);
          return;
        }
        if (choice === "jumpNext") {
          await showNext(10, true);
          return;
        }
        if (choice === "jumpPrevious") {
          showPrevious(10);
          return;
        }
        if (choice === "archive") {
          processing = true;
          message = `Archiving ${currentLabel(current)}…`;
          tui.requestRender();
          await archiveThreadIds([current.threadId]);
          removeThreadIdsFromCache([current.threadId]);
          await showNext(1, true);
          return;
        }
        if (choice === "trash") {
          processing = true;
          message = `Moving ${currentLabel(current)} to trash…`;
          tui.requestRender();
          await trashThreadIds([current.threadId]);
          removeThreadIdsFromCache([current.threadId]);
          await showNext(1, true);
          return;
        }
        if (choice === "spam") {
          processing = true;
          message = `Moving ${currentLabel(current)} to spam…`;
          tui.requestRender();
          await spamThreadIds([current.threadId]);
          removeThreadIdsFromCache([current.threadId]);
          await showNext(1, true);
          return;
        }
        if (choice === "replyNext") {
          const reply = await composeReply(ctx, current);
          if (!reply.send) {
            message = "Reply cancelled.";
            tui.requestRender();
            return;
          }
          processing = true;
          message = `Sending reply to ${currentLabel(current)}…`;
          tui.requestRender();
          await sendReply(current, reply.body);
          ctx.ui.notify(`sent reply to ${currentLabel(current)}`, "info");
          await showNext(1, true);
          return;
        }
        if (choice === "unsubscribeOpen") {
          if (current.chosenUnsubscribeUrl) {
            await execFileAsync("open", [current.chosenUnsubscribeUrl]);
            message = `Opened unsubscribe link for ${currentLabel(current)}`;
          } else {
            message = "No unsubscribe link found for this message.";
          }
          tui.requestRender();
          return;
        }
        if (choice === "unsubscribeArchiveSender") {
          if (!current.chosenUnsubscribeUrl) {
            message = "No unsubscribe link found for this message.";
            tui.requestRender();
            return;
          }
          processing = true;
          message = `Opening unsubscribe and archiving ${currentLabel(current)}…`;
          tui.requestRender();
          await execFileAsync("open", [current.chosenUnsubscribeUrl]);
          const { query, threadIds } = await collectInboxThreadIdsFromSender(current);
          await archiveThreadIds(threadIds);
          removeThreadIdsFromCache(threadIds);
          nextItemPromise = null;
          ctx.ui.notify(`opened unsubscribe link and archived ${threadIds.length} inbox thread(s) using query: ${query}`, "info");
          await showNext(1, false);
          return;
        }
        if (choice === "archiveSimilar" || choice === "trashSimilar") {
          processing = true;
          message = `Finding messages like ${currentLabel(current)}…`;
          tui.requestRender();
          const isTrash = choice === "trashSimilar";
          const result = await confirmBulkAction(ctx, isTrash ? "trash messages like this" : "archive messages like this", current);
          if (!result.confirmed) {
            await showNext(1, true);
            return;
          }
          const { query, threadIds } = result.selection;
          message = `${isTrash ? "Moving" : "Archiving"} ${threadIds.length} similar thread(s)…`;
          tui.requestRender();
          if (isTrash) await trashThreadIds(threadIds);
          else await archiveThreadIds(threadIds);
          removeThreadIdsFromCache(threadIds);
          nextItemPromise = null;
          ctx.ui.notify(`${isTrash ? "moved" : "archived"} ${threadIds.length} similar inbox thread(s) using query: ${query}`, "info");
          await showNext(1, false);
        }
      } catch (error) {
        message = `Action failed: ${error instanceof Error ? error.message : String(error)}`;
        processing = false;
        tui.requestRender();
      }
    };

    setTimeout(() => void showNext(1, false), 0);

    return {
      render(width: number) {
        const body = item ? formatInboxSweepPrompt(item).split("\n") : [message];
        if (processing) body.push("", theme?.fg ? theme.fg("muted", message) : message);
        return boxedLines("Email", body, `${actionLegend(INBOX_SWEEP_ACTIONS)}  ·  ↑/↓ Scroll  ·  Ctrl-U/Ctrl-D Scroll  ·  ? Help`, width, theme, scrollOffset);
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
        if (url.pathname !== "/oauth2/callback") {
          res.writeHead(404, { "content-type": "text/plain" });
          res.end("Not found.\n");
          return;
        }

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
    server.listen(REDIRECT_PORT, "127.0.0.1", () => {
      execFileAsync("open", [authUrl.toString()]).catch((error) => {
        server.close();
        reject(error);
      });
    });
  });
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("email", {
    description: "Triage Gmail inbox",
    handler: async (args, ctx) => {
      const subcommand = args.trim();

      if (!subcommand) {
        try {
          await runInboxSweep(ctx);
        } catch (error) {
          ctx.ui.notify(`email failed: ${error instanceof Error ? error.message : String(error)}`, "error");
        } finally {
          ctx.ui.setStatus("email", undefined);
        }
        return;
      }

      if (subcommand === "help") {
        ctx.ui.notify("/email starts inbox triage. Setup/admin: /email config, /email auth, /email status, /email logout, /email clear-config", "info");
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
