import assert from "node:assert/strict";
import test from "node:test";

import {
  broadSimilarInboxQuery,
  buildReplyRawMessage,
  createInboxSweepItem,
  type InboxSweepItem,
  similarInboxQuery,
} from "./message.ts";

function encoded(value: string) {
  return Buffer.from(value, "utf8").toString("base64url");
}

function item(overrides: Partial<InboxSweepItem> = {}): InboxSweepItem {
  return {
    threadId: "thread-1",
    from: "Sender <sender@example.com>",
    senderEmail: "sender@example.com",
    subject: "Weekly product launch update",
    snippet: "",
    bodyText: "Message",
    replyTo: "reply@example.com",
    messageIdHeader: "<message-1@example.com>",
    referencesHeader: "<message-0@example.com>",
    ...overrides,
  };
}

test("builds a complete threaded reply from the authenticated sender", () => {
  const raw = buildReplyRawMessage(item(), "Thanks!\n", "me@example.com");
  const message = Buffer.from(raw, "base64url").toString("utf8");

  assert.match(message, /^From: me@example\.com\r\nTo: reply@example\.com\r\n/);
  assert.match(message, /Subject: Re: Weekly product launch update\r\n/);
  assert.match(message, /In-Reply-To: <message-1@example\.com>\r\n/);
  assert.match(message, /References: <message-0@example\.com> <message-1@example\.com>\r\n/);
  assert.match(message, /\r\n\r\nThanks!\r\n$/);
});

test("rejects an invalid authenticated sender and sanitizes incoming headers", () => {
  assert.throws(() => buildReplyRawMessage(item(), "Body", "me@example.com\r\nBcc: bad@example.com"));

  const raw = buildReplyRawMessage(
    item({ subject: "Hello\r\nBcc: bad@example.com", replyTo: "reply@example.com\r\nCc: bad@example.com" }),
    "Body",
    "me@example.com",
  );
  const message = Buffer.from(raw, "base64url").toString("utf8");
  assert.doesNotMatch(message, /\r\n(?:Bcc|Cc):/);
});

test("creates a display item from inline content without scanning attachments", () => {
  const message = createInboxSweepItem({
    threadId: "thread-1",
    payload: {
      mimeType: "multipart/mixed",
      headers: [
        { name: "From", value: "Sender <SENDER@example.com>" },
        { name: "Subject", value: "Hello" },
        { name: "List-Unsubscribe", value: "<https://example.com/unsubscribe>" },
      ],
      parts: [
        { mimeType: "text/html", body: { data: encoded("<p>Hello &amp; welcome</p>") } },
        {
          mimeType: "text/plain",
          filename: "attachment.txt",
          body: { data: encoded("https://bad.example/unsubscribe") },
        },
      ],
    },
  });

  assert.equal(message.senderEmail, "sender@example.com");
  assert.equal(message.bodyText, "Hello & welcome");
  assert.equal(message.chosenUnsubscribeUrl, "https://example.com/unsubscribe");
});

test("builds bounded sender queries and rejects a missing sender", () => {
  assert.equal(
    similarInboxQuery(item()),
    "in:inbox from:sender@example.com subject:product subject:launch",
  );
  assert.equal(broadSimilarInboxQuery(item()), "in:inbox from:sender@example.com");
  assert.throws(() => broadSimilarInboxQuery(item({ senderEmail: "" })), /sender address is missing/);
});
