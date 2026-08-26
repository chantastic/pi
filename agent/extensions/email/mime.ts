export type GmailPayload = {
  mimeType?: string;
  filename?: string;
  body?: {
    data?: string;
    attachmentId?: string;
    size?: number;
  };
  headers?: Array<{ name?: string; value?: string }>;
  parts?: GmailPayload[];
};

type PayloadTexts = {
  plain: string[];
  html: string[];
};

function decodeBase64Url(data: string) {
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

function isAttachment(payload: GmailPayload) {
  const contentDisposition = payload.headers?.find(
    (header) => header.name?.toLowerCase() === "content-disposition",
  )?.value;
  return Boolean(
    payload.filename?.trim() ||
    payload.body?.attachmentId ||
    contentDisposition?.trim().toLowerCase().startsWith("attachment"),
  );
}

function collectPayloadTexts(payload: GmailPayload | undefined): PayloadTexts {
  const texts: PayloadTexts = { plain: [], html: [] };
  if (!payload || isAttachment(payload)) return texts;

  for (const part of payload.parts ?? []) {
    const nested = collectPayloadTexts(part);
    texts.plain.push(...nested.plain);
    texts.html.push(...nested.html);
  }

  if (!payload.body?.data) return texts;
  const mimeType = payload.mimeType?.split(";", 1)[0]?.trim().toLowerCase();
  if (mimeType === "text/plain") texts.plain.push(decodeBase64Url(payload.body.data));
  if (mimeType === "text/html") texts.html.push(decodeBase64Url(payload.body.data));
  return texts;
}

export function collectPreferredPayloadText(payload: GmailPayload | undefined) {
  const texts = collectPayloadTexts(payload);
  return (texts.plain.length > 0 ? texts.plain : texts.html).filter(Boolean).join("\n");
}

export function collectAllPayloadText(payload: GmailPayload | undefined) {
  const texts = collectPayloadTexts(payload);
  return [...texts.plain, ...texts.html].filter(Boolean).join("\n");
}
