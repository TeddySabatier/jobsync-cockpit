import fs from "fs";
import path from "path";

import { letterAttachmentName } from "@/lib/cockpit/attachments";
import { letterPdfName, sanitizePdfName } from "@/lib/cockpit/letterName";
import { isGmailSendAllowed } from "@/lib/cockpit/config";
import { assertScopeAndAddress, GMAIL_SEND_SCOPE } from "@/lib/cockpit/gmail/oauth";
import { activePackageWhere, pickActive } from "@/lib/cockpit/activePackage";
import { STALE_LOCK_MS } from "@/lib/cockpit/constants";

// Issue #63 (D-029): the one-definition helpers that replaced parallel copies.

describe("one letter name function", () => {
  it("letterAttachmentName is letterPdfName (same function, same names)", () => {
    expect(letterAttachmentName).toBe(letterPdfName);
    expect(letterPdfName("Jane(CV).pdf")).toBe("Jane_Cover_Letter_.pdf");
    expect(letterPdfName("CV–Acme.pdf")).toBe("Cover_Letter_Acme.pdf");
    expect(letterPdfName(null)).toBe("attachment_Cover_Letter.pdf");
    expect(letterPdfName("a".repeat(300) + "_CV.pdf").length).toBeLessThanOrEqual(104);
  });
  it("sanitizePdfName is exported from both modules", async () => {
    const m = await import("@/lib/cockpit/attachments");
    expect(m.sanitizePdfName).toBe(sanitizePdfName);
  });
});

describe("connect-side allow-list uses isGmailSendAllowed", () => {
  const cfg = { allowedAddress: "  Owner@Example.com " } as never;
  it("isGmailSendAllowed takes the allowed address as an argument, trimmed and case-insensitive", () => {
    expect(isGmailSendAllowed("owner@example.com", " OWNER@example.com ")).toBe(true);
    expect(isGmailSendAllowed("other@example.com", "owner@example.com")).toBe(false);
    expect(isGmailSendAllowed("owner@example.com", "")).toBe(false);
    expect(isGmailSendAllowed("", "")).toBe(false);
  });
  it("assertScopeAndAddress accepts the allowed address and refuses another", () => {
    expect(() => assertScopeAndAddress("OWNER@example.com", GMAIL_SEND_SCOPE, cfg)).not.toThrow();
    const code = (email: string, scope: string) => {
      try {
        assertScopeAndAddress(email, scope, cfg);
      } catch (e) {
        return (e as { code?: string }).code;
      }
      return undefined;
    };
    expect(code("x@example.com", GMAIL_SEND_SCOPE)).toBe("address_not_allowed");
    expect(code("OWNER@example.com", "openid")).toBe("missing_scope");
  });
  it("connect refuses what Send would refuse: the same function decides", () => {
    const src = fs.readFileSync(path.join(process.cwd(), "src/lib/cockpit/gmail/oauth.ts"), "utf8");
    expect(src).toMatch(/isGmailSendAllowed\(/);
  });
});

describe("active package helper", () => {
  it("pickActive takes the first non-superseded version of a newest-first list", () => {
    const v = [
      { id: "3", status: "superseded" },
      { id: "2", status: "pending" },
      { id: "1", status: "superseded" },
    ];
    expect(pickActive(v)?.id).toBe("2");
    expect(pickActive([{ id: "1", status: "superseded" }])).toBeNull();
    expect(pickActive([])).toBeNull();
  });
  it("activePackageWhere adds the status filter to a scope", () => {
    expect(activePackageWhere({ userId: "u", jobId: "j" })).toEqual({
      userId: "u",
      jobId: "j",
      kind: "application",
      status: { not: "superseded" },
    });
  });
  it("activePackageWhere is per kind and defaults to the application (D-030)", () => {
    expect(activePackageWhere({ jobId: "j" }, "follow_up")).toEqual({
      jobId: "j",
      kind: "follow_up",
      status: { not: "superseded" },
    });
  });
});

describe("STALE_LOCK_MS", () => {
  it("the client constant is the value send.ts uses", () => {
    const src = fs.readFileSync(path.join(process.cwd(), "src/lib/cockpit/send.ts"), "utf8");
    const m = /export const STALE_LOCK_MS = ([\d_]+);/.exec(src);
    expect(Number((m as RegExpExecArray)[1].replace(/_/g, ""))).toBe(STALE_LOCK_MS);
  });
});
