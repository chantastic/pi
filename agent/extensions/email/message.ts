import { collectAllPayloadText, collectPreferredPayloadText, type GmailPayload } from "./mime.ts";

export type InboxSweepItem = {
  threadId: string;
  from: string;
  senderEmail: string;
  subject: string;
  snippet: string;
  bodyText: string;
  replyTo: string;
  messageIdHeader: string;
  referencesHeader: string;
  chosenUnsubscribeUrl?: string;
};

export type GmailMessageContent = {
  threadId: string;
  snippet?: string;
  payload?: GmailPayload;
};

function headerValue(headers: Array<{ name?: string; value?: string }> | undefined, name: string) {
  return headers?.find((header) => header.name?.toLowerCase() === name.toLowerCase())?.value ?? "";
}

function uniqueValues<T>(values: T[]) {
  return Array.from(new Set(values));
}

function senderEmail(from: string) {
  return (
    from.match(/<([^>]+)>/)?.[1] ?? from.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] ?? from.trim()
  ).toLowerCase();
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

export function verifiedEmailAddress(value: string) {
  const emailAddress = sanitizeHeaderValue(value);
  if (emailAddress !== value.trim() || !/^[^\s@<>]+@[^\s@<>]+$/.test(emailAddress)) {
    throw new Error("Gmail profile returned an invalid sender address.");
  }
  return emailAddress;
}

function encodeMimeHeader(value: string) {
  const sanitized = sanitizeHeaderValue(value);
  return /^[\x20-\x7E]*$/.test(sanitized) ? sanitized : `=?UTF-8?B?${Buffer.from(sanitized, "utf8").toString("base64")}?=`;
}

export function replySubject(subject: string) {
  const sanitized = sanitizeHeaderValue(subject);
  if (!sanitized) return "Re: (no subject)";
  return /^re\s*:/i.test(sanitized) ? sanitized : `Re: ${sanitized}`;
}

function base64UrlEncode(value: string) {
  return Buffer.from(value, "utf8").toString("base64url");
}

export function buildReplyRawMessage(item: InboxSweepItem, body: string, fromAddress: string) {
  const messageId = sanitizeHeaderValue(item.messageIdHeader);
  const priorReferences = sanitizeHeaderValue(item.referencesHeader);
  const references = [priorReferences, messageId].filter(Boolean).join(" ");
  const headers = [
    `From: ${verifiedEmailAddress(fromAddress)}`,
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

export function createInboxSweepItem(full: GmailMessageContent): InboxSweepItem {
  const from = headerValue(full.payload?.headers, "From");
  const rawBodyText = collectPreferredPayloadText(full.payload);
  const allBodyText = collectAllPayloadText(full.payload);
  const unsubscribeUrls = uniqueValues([
    ...extractHttpUrls(headerValue(full.payload?.headers, "List-Unsubscribe")),
    ...extractHttpUrls(allBodyText),
  ]);

  return {
    threadId: full.threadId,
    from,
    senderEmail: senderEmail(from),
    subject: headerValue(full.payload?.headers, "Subject"),
    snippet: full.snippet ?? "",
    bodyText: cleanEmailText(rawBodyText),
    replyTo: headerValue(full.payload?.headers, "Reply-To") || from,
    messageIdHeader: headerValue(full.payload?.headers, "Message-ID"),
    referencesHeader: headerValue(full.payload?.headers, "References"),
    chosenUnsubscribeUrl: unsubscribeUrls[0],
  };
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

function bulkSenderEmail(item: InboxSweepItem) {
  if (!item.senderEmail) throw new Error("Cannot select similar messages because the sender address is missing.");
  return item.senderEmail;
}

export function similarInboxQuery(item: InboxSweepItem) {
  const subjectTerms = subjectKeywords(item.subject).map((keyword) => `subject:${keyword}`).join(" ");
  return ["in:inbox", `from:${bulkSenderEmail(item)}`, subjectTerms].filter(Boolean).join(" ");
}

export function broadSimilarInboxQuery(item: InboxSweepItem) {
  return `in:inbox from:${bulkSenderEmail(item)}`;
}
