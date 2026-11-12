// @vitest-environment node
import { buildMimeMessage, encodeRaw, isValidMessageId, newMessageId } from "@/lib/cockpit/gmail/mime";

// AC-24. Synthetic data only.
const pdf = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(100, 7)]);
const base = {
  from: "you@example.com",
  to: "jobs@acme.example",
  subject: "Application for Staff Engineer",
  bodyText: "Hello,\nPlease find my CV.\n",
  attachment: { fileName: "cv.pdf", content: pdf },
};
const opts = {
  now: new Date("2026-11-04T12:00:00Z"),
  boundary: "BOUNDARY",
  messageId: "<fixed@jobsync.local>",
};

describe("buildMimeMessage (AC-24)", () => {
  it("golden output: headers, parts, base64, CRLF", () => {
    const body = Buffer.from("Hello,\r\nPlease find my CV.\r\n").toString("base64");
    expect(buildMimeMessage(base, opts)).toBe(
      [
        "From: you@example.com",
        "To: jobs@acme.example",
        "Subject: Application for Staff Engineer",
        "MIME-Version: 1.0",
        "Date: Wed, 04 Nov 2026 12:00:00 GMT",
        "Message-ID: <fixed@jobsync.local>",
        'Content-Type: multipart/mixed; boundary="BOUNDARY"',
        "",
        "--BOUNDARY",
        "Content-Type: text/plain; charset=UTF-8",
        "Content-Transfer-Encoding: base64",
        "",
        body,
        "--BOUNDARY",
        'Content-Type: application/pdf; name="cv.pdf"',
        'Content-Disposition: attachment; filename="cv.pdf"',
        "Content-Transfer-Encoding: base64",
        "",
        ...(pdf.toString("base64").match(/.{1,76}/g) as string[]),
        "--BOUNDARY--",
        "",
      ].join("\r\n"),
    );
  });

  it("uses CRLF only and wraps base64 at 76 chars", () => {
    const mime = buildMimeMessage(
      { ...base, bodyText: "x".repeat(500) },
      opts,
    );
    expect(mime.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
    // RFC 5322 2.1.1: lines SHOULD be at most 78 characters.
    for (const line of mime.split("\r\n")) expect(line.length).toBeLessThanOrEqual(78);
    const b64Lines = mime
      .split("\r\n")
      .filter((l) => /^[A-Za-z0-9+/=]{20,}$/.test(l));
    expect(b64Lines.length).toBeGreaterThan(2);
    b64Lines.forEach((l) => expect(l.length).toBeLessThanOrEqual(76));
  });

  it("RFC 2047 encodes a non-ASCII subject and the words decode back", () => {
    const subject = "Application – Staff Engineer ✓ " + "é".repeat(80);
    const mime = buildMimeMessage({ ...base, subject }, opts);
    const head = mime.split("\r\n\r\n")[0];
    const unfolded = head.split("\r\n").reduce<string[]>((acc, l) => {
      if (l.startsWith(" ")) acc[acc.length - 1] += l;
      else acc.push(l);
      return acc;
    }, []);
    const line = unfolded.find((l) => l.startsWith("Subject: ")) as string;
    const words = [...line.matchAll(/=\?UTF-8\?B\?([A-Za-z0-9+/=]+)\?=/g)];
    expect(words.length).toBeGreaterThan(1);
    // Each encoded word is at most 75 chars (RFC 2047).
    words.forEach((w) => expect(w[0].length).toBeLessThanOrEqual(75));
    const decoded = words.map((w) => Buffer.from(w[1], "base64").toString("utf8")).join("");
    expect(decoded).toBe(subject);
    expect(head).not.toContain("–");
  });

  it("encodes the body as UTF-8 base64", () => {
    const mime = buildMimeMessage({ ...base, bodyText: "Café – ok" }, opts);
    expect(mime).toContain(Buffer.from("Café – ok", "utf8").toString("base64"));
  });

  it("encodeRaw is base64url (no +, / or padding) and round-trips", () => {
    const mime = buildMimeMessage(base, opts);
    const raw = encodeRaw(mime);
    expect(raw).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(raw, "base64url").toString("utf8")).toBe(mime);
  });

  it.each([
    ["From", { from: "a@example.com\r\nBcc: x@example.com" }],
    ["To LF", { to: "a@example.com\nBcc: x@example.com" }],
    ["To CR", { to: "a@example.com\rBcc: x@example.com" }],
    ["Subject", { subject: "Hi\r\nBcc: x@example.com" }],
    [
      "attachment name CRLF",
      { attachment: { fileName: "cv.pdf\r\nX: y", content: pdf } },
    ],
    ["attachment name quote", { attachment: { fileName: 'cv".pdf', content: pdf } }],
  ])("rejects header injection: %s", (_n, over) => {
    expect(() => buildMimeMessage({ ...base, ...over }, opts)).toThrow();
  });
});

describe("buildMimeMessage: follow-up shape (D-042)", () => {
  const plain = { ...base, attachment: null, subject: "Re: Application for Staff Engineer" };

  it("no attachment: a single text/plain message, no multipart", () => {
    const body = Buffer.from("Hello,\r\nPlease find my CV.\r\n").toString("base64");
    expect(buildMimeMessage(plain, opts)).toBe(
      [
        "From: you@example.com",
        "To: jobs@acme.example",
        "Subject: Re: Application for Staff Engineer",
        "MIME-Version: 1.0",
        "Date: Wed, 04 Nov 2026 12:00:00 GMT",
        "Message-ID: <fixed@jobsync.local>",
        "Content-Type: text/plain; charset=UTF-8",
        "Content-Transfer-Encoding: base64",
        "",
        body,
        "",
      ].join("\r\n"),
    );
  });

  it("In-Reply-To and References carry the stored Message-ID", () => {
    const mime = buildMimeMessage({ ...plain, inReplyTo: "<orig-1@jobsync.local>" }, opts);
    expect(mime).toContain("\r\nIn-Reply-To: <orig-1@jobsync.local>\r\n");
    expect(mime).toContain("\r\nReferences: <orig-1@jobsync.local>\r\n");
    expect(mime).not.toContain("multipart");
  });

  it.each([
    ["no brackets", "orig@jobsync.local"],
    ["space", "<a b@jobsync.local>"],
    ["two at", "<a@b@jobsync.local>"],
    ["CRLF", "<a@jobsync.local>\r\nBcc: x@evil.example"],
    ["trailing text", "<a@jobsync.local> x"],
  ])("refuses an In-Reply-To that is not a strict Message-ID: %s", (_n, v) => {
    expect(() => buildMimeMessage({ ...plain, inReplyTo: v }, opts)).toThrow();
  });

  it("newMessageId matches the strict pattern", () => {
    expect(isValidMessageId(newMessageId())).toBe(true);
  });
});
