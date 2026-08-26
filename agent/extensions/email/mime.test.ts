import assert from "node:assert/strict";
import test from "node:test";

import { collectAllPayloadText, collectPreferredPayloadText, type GmailPayload } from "./mime.ts";

function encoded(value: string) {
  return Buffer.from(value, "utf8").toString("base64url");
}

test("prefers inline plain text while retaining HTML for URL discovery", () => {
  const payload: GmailPayload = {
    mimeType: "multipart/alternative",
    parts: [
      { mimeType: "text/plain", body: { data: encoded("Plain message") } },
      { mimeType: "text/html", body: { data: encoded("<p>HTML message</p>") } },
    ],
  };

  assert.equal(collectPreferredPayloadText(payload), "Plain message");
  assert.equal(collectAllPayloadText(payload), "Plain message\n<p>HTML message</p>");
});

test("uses inline HTML when a plain text body is absent", () => {
  const payload: GmailPayload = {
    mimeType: "text/html; charset=UTF-8",
    body: { data: encoded("<p>Hello</p>") },
  };

  assert.equal(collectPreferredPayloadText(payload), "<p>Hello</p>");
});

test("ignores binary parts and text attachments", () => {
  const payload: GmailPayload = {
    mimeType: "multipart/mixed",
    parts: [
      { mimeType: "text/plain", body: { data: encoded("Visible body") } },
      { mimeType: "image/png", body: { data: encoded("binary unsubscribe payload") } },
      {
        mimeType: "text/plain",
        filename: "offer.txt",
        body: { data: encoded("https://example.com/unsubscribe") },
      },
    ],
  };

  assert.equal(collectPreferredPayloadText(payload), "Visible body");
  assert.equal(collectAllPayloadText(payload), "Visible body");
});

test("ignores attachment subtrees and attachment IDs", () => {
  const payload: GmailPayload = {
    mimeType: "multipart/mixed",
    parts: [
      { mimeType: "text/plain", body: { data: encoded("Visible body") } },
      {
        mimeType: "message/rfc822",
        filename: "forwarded.eml",
        parts: [{ mimeType: "text/plain", body: { data: encoded("Forwarded attachment") } }],
      },
      {
        mimeType: "text/plain",
        body: { attachmentId: "attachment-1", data: encoded("Attached body") },
      },
    ],
  };

  assert.equal(collectAllPayloadText(payload), "Visible body");
});

test("honors Content-Disposition attachment without a filename", () => {
  const payload: GmailPayload = {
    mimeType: "text/plain",
    headers: [{ name: "Content-Disposition", value: "attachment" }],
    body: { data: encoded("Attached body") },
  };

  assert.equal(collectPreferredPayloadText(payload), "");
});
