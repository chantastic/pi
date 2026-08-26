import { getAccessToken } from "./auth.ts";
import {
  broadSimilarInboxQuery,
  buildReplyRawMessage,
  createInboxSweepItem,
  type GmailMessageContent,
  type InboxSweepItem,
  verifiedEmailAddress,
} from "./message.ts";

export { broadSimilarInboxQuery, replySubject, similarInboxQuery } from "./message.ts";
export type { InboxSweepItem } from "./message.ts";

const GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1";
const MAX_BULK_THREADS = 500;
const BULK_PREVIEW_THREADS = 25;
const GMAIL_REQUEST_CONCURRENCY = 5;

type ThreadSummary = {
  subject: string;
};

type GmailThreadModifyBody = {
  addLabelIds?: string[];
  removeLabelIds?: string[];
};

export type GmailRequestProgress = (completed: number, total: number) => void;

function headerValue(headers: Array<{ name?: string; value?: string }> | undefined, name: string) {
  return headers?.find((header) => header.name?.toLowerCase() === name.toLowerCase())?.value ?? "";
}

function uniqueValues<T>(values: T[]) {
  return Array.from(new Set(values));
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  map: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;

  const worker = async () => {
    while (nextIndex < values.length) {
      const index = nextIndex++;
      results[index] = await map(values[index]!, index);
    }
  };

  const workers = Array.from({ length: Math.min(concurrency, values.length) }, () => worker());
  const outcomes = await Promise.allSettled(workers);
  const failure = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
  if (failure) throw failure.reason;
  return results;
}

function formatGmailApiError(status: number, body: string) {
  const reauthHint = body.includes("insufficient") || body.includes("ACCESS_TOKEN_SCOPE_INSUFFICIENT")
    ? " Run /email auth to grant the current Gmail scopes."
    : "";
  return `Gmail API failed: ${status} ${body}${reauthHint}`;
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

async function gmailGet<T>(path: string, accessToken: string) {
  return await gmailRequest<T>("GET", path, accessToken);
}

async function gmailPost(path: string, accessToken: string, body: unknown) {
  await gmailRequest("POST", path, accessToken, body);
}

export async function getAuthenticatedEmailAddress(accessToken: string) {
  const profile = await gmailGet<{ emailAddress?: string }>("/users/me/profile", accessToken);
  return verifiedEmailAddress(profile.emailAddress ?? "");
}

async function listThreadIds(query: string, accessToken: string) {
  const ids: string[] = [];
  let pageToken: string | undefined;

  do {
    const remaining = MAX_BULK_THREADS + 1 - ids.length;
    const params = new URLSearchParams({
      q: query,
      maxResults: String(Math.min(500, remaining)),
      fields: "threads(id),nextPageToken",
    });
    if (pageToken) params.set("pageToken", pageToken);
    const page = await gmailGet<{ threads?: Array<{ id: string }>; nextPageToken?: string }>(
      `/users/me/threads?${params}`,
      accessToken,
    );
    ids.push(...(page.threads ?? []).map((thread) => thread.id));
    pageToken = page.nextPageToken;
  } while (pageToken && ids.length <= MAX_BULK_THREADS);

  if (ids.length > MAX_BULK_THREADS) {
    throw new Error(`More than ${MAX_BULK_THREADS} threads match. Narrow the Gmail query before continuing.`);
  }
  return ids;
}

function boundedBulkThreadIds(threadIds: string[]) {
  const uniqueThreadIds = uniqueValues(threadIds);
  if (uniqueThreadIds.length > MAX_BULK_THREADS) {
    throw new Error(`More than ${MAX_BULK_THREADS} threads match. Narrow the Gmail query before continuing.`);
  }
  return uniqueThreadIds;
}

async function modifyThreadIds(
  threadIds: string[],
  accessToken: string,
  body: GmailThreadModifyBody,
  onProgress?: GmailRequestProgress,
) {
  const uniqueThreadIds = boundedBulkThreadIds(threadIds);
  let completed = 0;
  await mapWithConcurrency(uniqueThreadIds, GMAIL_REQUEST_CONCURRENCY, async (threadId) => {
    await gmailPost(`/users/me/threads/${encodeURIComponent(threadId)}/modify`, accessToken, body);
    onProgress?.(++completed, uniqueThreadIds.length);
  });
}

export async function archiveThreadIds(threadIds: string[], onProgress?: GmailRequestProgress) {
  if (threadIds.length === 0) return;
  const accessToken = await getAccessToken();
  await modifyThreadIds(threadIds, accessToken, { removeLabelIds: ["INBOX", "UNREAD"] }, onProgress);
}

export async function spamThreadIds(threadIds: string[], onProgress?: GmailRequestProgress) {
  if (threadIds.length === 0) return;
  const accessToken = await getAccessToken();
  await modifyThreadIds(
    threadIds,
    accessToken,
    { addLabelIds: ["SPAM"], removeLabelIds: ["INBOX", "UNREAD"] },
    onProgress,
  );
}

export async function trashThreadIds(threadIds: string[], onProgress?: GmailRequestProgress) {
  const uniqueThreadIds = boundedBulkThreadIds(threadIds);
  if (uniqueThreadIds.length === 0) return;
  const accessToken = await getAccessToken();
  let completed = 0;
  await mapWithConcurrency(uniqueThreadIds, GMAIL_REQUEST_CONCURRENCY, async (threadId) => {
    await gmailPost(`/users/me/threads/${encodeURIComponent(threadId)}/modify`, accessToken, {
      removeLabelIds: ["UNREAD"],
    });
    await gmailPost(`/users/me/threads/${encodeURIComponent(threadId)}/trash`, accessToken, {});
    onProgress?.(++completed, uniqueThreadIds.length);
  });
}

async function collectThreadSummaries(
  threadIds: string[],
  accessToken: string,
  onProgress?: GmailRequestProgress,
): Promise<ThreadSummary[]> {
  let completed = 0;
  return await mapWithConcurrency(threadIds, GMAIL_REQUEST_CONCURRENCY, async (threadId) => {
    const params = new URLSearchParams({
      format: "metadata",
      metadataHeaders: "Subject",
      fields: "messages(payload(headers))",
    });
    const thread = await gmailGet<{
      messages?: Array<{ payload?: { headers?: Array<{ name?: string; value?: string }> } }>;
    }>(`/users/me/threads/${encodeURIComponent(threadId)}?${params}`, accessToken);
    const summary = { subject: headerValue(thread.messages?.at(-1)?.payload?.headers, "Subject") };
    onProgress?.(++completed, threadIds.length);
    return summary;
  });
}

export async function sendReply(item: InboxSweepItem, body: string) {
  const accessToken = await getAccessToken();
  const fromAddress = await getAuthenticatedEmailAddress(accessToken);
  await gmailPost("/users/me/messages/send", accessToken, {
    raw: buildReplyRawMessage(item, body, fromAddress),
    threadId: item.threadId,
  });
}

async function collectInboxSweepItemFromMessage(
  message: { id: string; threadId: string },
  accessToken: string,
): Promise<InboxSweepItem> {
  const full = await gmailGet<GmailMessageContent>(
    `/users/me/messages/${message.id}?${new URLSearchParams({ format: "full" })}`,
    accessToken,
  );
  return createInboxSweepItem(full);
}

export async function collectInboxSweepItemAtOffset(
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
    const params = new URLSearchParams({
      q: "in:inbox",
      maxResults: "100",
      fields: "messages(id,threadId),nextPageToken",
    });
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
      return { item: await collectInboxSweepItemFromMessage(message, accessToken), skippedThreadIds };
    }
    pageToken = page.nextPageToken;
  } while (pageToken);

  if (!lastCandidate) return { item: null, skippedThreadIds };
  return {
    item: await collectInboxSweepItemFromMessage(lastCandidate, accessToken),
    skippedThreadIds: skippedThreadIds.filter((threadId) => threadId !== lastCandidate!.threadId),
  };
}

export async function collectNewestInboxSweepItem(excludedThreadIds = new Set<string>()) {
  return (await collectInboxSweepItemAtOffset(0, excludedThreadIds)).item;
}

export async function collectInboxThreadIdsFromSender(item: InboxSweepItem) {
  const query = broadSimilarInboxQuery(item);
  const threadIds = await listThreadIds(query, await getAccessToken());
  return { query, threadIds: boundedBulkThreadIds([item.threadId, ...threadIds]) };
}

export async function collectSimilarInboxSelection(
  item: InboxSweepItem,
  query: string,
  onProgress?: (message: string) => void,
) {
  const accessToken = await getAccessToken();
  const threadIds = boundedBulkThreadIds([item.threadId, ...await listThreadIds(query, accessToken)]);
  const previewThreadIds = threadIds.slice(0, BULK_PREVIEW_THREADS);
  onProgress?.(`Found ${threadIds.length} threads. Loading preview 0/${previewThreadIds.length}…`);
  return {
    query,
    threadIds,
    summaries: await collectThreadSummaries(previewThreadIds, accessToken, (completed, total) => {
      onProgress?.(`Found ${threadIds.length} threads. Loading preview ${completed}/${total}…`);
    }),
  };
}
