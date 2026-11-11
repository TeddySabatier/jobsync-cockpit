import "server-only";
import { randomBytes, randomUUID } from "crypto";

// MIME builder for the Gmail API (cockpit/SPEC.md §6.3). Pure: no I/O.

export interface MimeInput {
  from: string;
  to: string;
  subject: string;
  bodyText: string;
  attachment: { fileName: string; content: Buffer };
  // More PDFs after the first one (the generated cover letter, D-015).
  extraAttachments?: { fileName: string; content: Buffer }[];
}

// Test seams only; production callers pass nothing.
export interface MimeOptions {
  now?: Date;
  boundary?: string;
  messageId?: string;
}

const CRLF = "\r\n";

// Header injection guard (SPEC §6.3): any CR or LF in a header value throws.
function header(name: string, value: string): string {
  if (/[\r\n]/.test(value)) {
    throw new Error(`Invalid ${name}: line break not allowed`);
  }
  return value;
}

// Base64 with lines of at most 76 chars.
const wrap76 = (b64: string) => (b64.match(/.{1,76}/g) ?? []).join(CRLF);

// RFC 2047 encoded words are limited to 75 chars; 45 bytes -> 60 base64 chars
// plus 12 of framing. Split on code point boundaries so no character is cut.
function encodeSubject(subject: string): string {
  if (/^[\x20-\x7e]*$/.test(subject)) return subject;
  const words: string[] = [];
  let chunk: number[] = [];
  const flush = () => {
    if (chunk.length) {
      words.push(`=?UTF-8?B?${Buffer.from(chunk).toString("base64")}?=`);
      chunk = [];
    }
  };
  for (const ch of subject) {
    const bytes = [...Buffer.from(ch, "utf8")];
    if (chunk.length + bytes.length > 45) flush();
    chunk.push(...bytes);
  }
  flush();
  return words.join(`${CRLF} `);
}

// Returns the RFC 5322 message text (CRLF throughout).
export function buildMimeMessage(
  { from, to, subject, bodyText, attachment, extraAttachments = [] }: MimeInput,
  opts: MimeOptions = {},
): string {
  header("From", from);
  header("To", to);
  header("Subject", subject);
  const all = [attachment, ...extraAttachments];
  for (const a of all) {
    header("attachment name", a.fileName);
    // shortcut: ASCII-only attachment names, no RFC 2231 (names are sanitized
    // before they get here). Upgrade if user-chosen names are ever sent.
    if (!/^[\x20-\x7e]+$/.test(a.fileName) || /["\\]/.test(a.fileName)) {
      throw new Error("Invalid attachment name");
    }
  }
  if (!from || !to) throw new Error("From and To are required");

  const boundary = opts.boundary ?? `cockpit-${randomBytes(16).toString("hex")}`;
  const messageId = opts.messageId ?? `<${randomUUID()}@jobsync.local>`;
  const date = (opts.now ?? new Date()).toUTCString();
  const body = bodyText.replace(/\r?\n/g, CRLF);

  return [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encodeSubject(subject)}`,
    "MIME-Version: 1.0",
    `Date: ${date}`,
    `Message-ID: ${messageId}`,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    wrap76(Buffer.from(body, "utf8").toString("base64")),
    ...all.flatMap((a) => [
      `--${boundary}`,
      `Content-Type: application/pdf; name="${a.fileName}"`,
      `Content-Disposition: attachment; filename="${a.fileName}"`,
      "Content-Transfer-Encoding: base64",
      "",
      wrap76(a.content.toString("base64")),
    ]),
    `--${boundary}--`,
    "",
  ].join(CRLF);
}

// The Gmail API `raw` field.
export function encodeRaw(mime: string): string {
  return Buffer.from(mime, "utf8").toString("base64url");
}
