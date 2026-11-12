import { isGmailSendAllowed } from "@/lib/cockpit/config";
import { assertScopeAndAddress, GMAIL_SEND_SCOPE } from "@/lib/cockpit/gmail/oauth";
import { letterPdfName, sanitizePdfName } from "@/lib/cockpit/letterName";

// Issue #63 review: the refactored helpers decide exactly as the code they
// replaced. The "old" bodies below are copied from origin/main before #63.

// --- letter name -----------------------------------------------------------
const oldLetterPdfName = (cv: string | null | undefined): string => {
  const base = (cv ?? "").replace(/\.pdf$/i, "").trim();
  if (!base) return "Cover_Letter.pdf";
  const swapped = base.replace(/(^|[_\- ])CV($|[_\- ])/i, "$1Cover_Letter$2");
  return `${swapped === base ? `${base}_Cover_Letter` : swapped}.pdf`;
};
const oldLetterAttachmentName = (cv: string | null | undefined) =>
  sanitizePdfName(oldLetterPdfName(sanitizePdfName(cv ?? "")));

const NAMES = [
  null, undefined, "", " ", ".pdf", "CV", "CV.pdf", "cv.pdf", "my cv.pdf", "Jane Doe CV Acme.pdf",
  "Jane_Doe_CV_Acme.pdf", "Jane-CV-Acme.PDF", "..hidden_CV.pdf", "résumé CV.pdf", "日本語.pdf",
  "a.pdf.pdf", "CV_CV.pdf", "_CV_.pdf", "x\r\nBcc: evil@example.com.pdf", 'a"b;c.pdf', "../../etc/CV.pdf",
  "a".repeat(300) + "_CV.pdf", "a".repeat(100) + "CV.pdf", "CV" + "b".repeat(200),
];

describe("letterPdfName equals the old letterAttachmentName", () => {
  it.each(NAMES.map((n) => [JSON.stringify(n), n] as const))("%s", (_l, n) => {
    expect(letterPdfName(n)).toBe(oldLetterAttachmentName(n));
  });
  it("random strings", () => {
    const alphabet = ["a", "B", "_", "-", " ", ".", "CV", "cv", "pdf", ".pdf", "é", "\n", '"', ";", "/"];
    let seed = 12345;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let i = 0; i < 3000; i++) {
      const s = Array.from({ length: Math.floor(rnd() * 14) }, () => alphabet[Math.floor(rnd() * alphabet.length)]).join("");
      expect(letterPdfName(s)).toBe(oldLetterAttachmentName(s));
    }
  });
  it("result is header safe: [A-Za-z0-9._-] only, ends in .pdf, no leading dot", () => {
    for (const n of NAMES) {
      const out = letterPdfName(n);
      expect(out).toMatch(/^[A-Za-z0-9_-][A-Za-z0-9._-]*\.pdf$/);
      expect(out.length).toBeLessThanOrEqual(104 + "_Cover_Letter".length);
    }
  });
});

// --- allow-list ------------------------------------------------------------
const oldSend = (email: string | null | undefined, env: string | undefined) => {
  const allowed = env?.trim().toLowerCase();
  if (!email || !allowed) return false;
  return email.trim().toLowerCase() === allowed;
};
const oldConnectAccepts = (email: string, allowedAddress: string) =>
  email.toLowerCase() === allowedAddress.trim().toLowerCase();
const newConnectAccepts = (email: string, allowedAddress: string) => {
  try {
    assertScopeAndAddress(email, GMAIL_SEND_SCOPE, { allowedAddress } as never);
    return true;
  } catch (e) {
    expect((e as { code?: string }).code).toBe("address_not_allowed");
    return false;
  }
};

const EMAILS = ["", "a@b.com", "A@B.com", " a@b.com", "a@b.com ", "\ta@B.COM\n", "x@b.com", "a@b.com.evil.io"];
const ALLOWED = ["", " ", "a@b.com", "  A@B.COM  ", "\ta@b.com\n", "x@b.com"];

describe("isGmailSendAllowed", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("one-argument form (Send, button) equals the old function for every combination", () => {
    for (const env of [...ALLOWED, undefined]) {
      vi.stubEnv("COCKPIT_GMAIL_ALLOWED_ADDRESS", env as string);
      if (env === undefined) delete process.env.COCKPIT_GMAIL_ALLOWED_ADDRESS;
      for (const email of [...EMAILS, null, undefined]) {
        expect(isGmailSendAllowed(email as never), `${email}|${env}`).toBe(oldSend(email as never, env));
      }
    }
  });
  it("connect side: same accept set as before, except the two documented edges", () => {
    const diffs: Array<[string, string]> = [];
    for (const allowed of ALLOWED) {
      for (const email of EMAILS) {
        if (newConnectAccepts(email, allowed) !== oldConnectAccepts(email, allowed)) {
          diffs.push([email, allowed]);
        }
      }
    }
    expect(diffs.length).toBeGreaterThan(0);
    for (const [email, allowed] of diffs) {
      const emptyBoth = email === "" && allowed.trim() === "";
      const paddedEmail = email !== email.trim() && email.trim().toLowerCase() === allowed.trim().toLowerCase();
      // Old accepted an empty email against a blank allow-list (new refuses:
      // stricter, unreachable). New trims the email too, as Send does (old
      // refused " a@b.com", new accepts it).
      expect(emptyBoth || paddedEmail, JSON.stringify([email, allowed])).toBe(true);
    }
  });
  it("an undefined allowedAddress falls back to the env value (default parameter), null does not", () => {
    vi.stubEnv("COCKPIT_GMAIL_ALLOWED_ADDRESS", "a@b.com");
    expect(isGmailSendAllowed("a@b.com", undefined)).toBe(true);
    expect(isGmailSendAllowed("a@b.com", null)).toBe(false);
  });
});
