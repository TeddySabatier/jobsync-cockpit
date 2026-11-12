// @vitest-environment node
import { z } from "zod";
import {
  AttachFileInputShape,
  AttachFileSchema,
  ListChangeRequestsSchema,
  ListJobsSchema,
  MarkChangeRequestDoneSchema,
  RejectPackageSchema,
  SubmitApplicationPackageInputShape,
  SubmitApplicationPackageSchema,
  UpdatePackageContentSchema,
} from "@/lib/cockpit/schemas";

const valid = {
  jobId: "job-1",
  emailSubject: "Application - Engineer",
  emailBody: "Hello, I am Jane Doe.",
  fitGrade: "A" as const,
};

const ok = (over: Record<string, unknown> = {}) =>
  SubmitApplicationPackageSchema.safeParse({ ...valid, ...over });

describe("SubmitApplicationPackageSchema (AC-07)", () => {
  it("accepts a minimal valid input", () => {
    expect(ok().success).toBe(true);
  });

  it("turns an empty emailTo into null and keeps a valid one", () => {
    const empty = ok({ emailTo: "" });
    expect(empty.success && empty.data.emailTo).toBeNull();
    const set = ok({ emailTo: "hr@example.com" });
    expect(set.success && set.data.emailTo).toBe("hr@example.com");
  });

  it.each([
    ["comma in emailTo", { emailTo: "a@example.com,b@example.com" }],
    ["CR/LF in emailTo", { emailTo: "a@example.com\r\nBcc: x@example.com" }],
    ["not an address", { emailTo: "not-an-address" }],
    ["emailTo > 254", { emailTo: `${"a".repeat(250)}@example.com` }],
    ["CR in subject", { emailSubject: "Hi\rthere" }],
    ["LF in subject", { emailSubject: "Hi\nthere" }],
    ["empty subject", { emailSubject: "" }],
    ["subject > 300", { emailSubject: "s".repeat(301) }],
    ["empty body", { emailBody: "" }],
    ["body > 20000", { emailBody: "b".repeat(20_001) }],
    ["letter > 20000", { letterMd: "l".repeat(20_001) }],
    ["fitGrade C", { fitGrade: "C" }],
    [
      "fitAnalysis serialized > 20000",
      { fitAnalysis: { a: "x".repeat(20_001) } },
    ],
    ["cvJson serialized > 200000", { cvJson: { a: "x".repeat(200_001) } }],
    ["cvJson not an object", { cvJson: ["a"] }],
    ["sourceFolder > 300", { sourceFolder: "f".repeat(301) }],
    ["idempotencyKey with space", { idempotencyKey: "a b" }],
    ["idempotencyKey > 100", { idempotencyKey: "k".repeat(101) }],
    ["empty idempotencyKey", { idempotencyKey: "" }],
  ])("rejects %s", (_name, over) => {
    expect(ok(over).success).toBe(false);
  });

  it("accepts values at the limits", () => {
    expect(
      ok({
        emailSubject: "s".repeat(300),
        emailBody: "b".repeat(20_000),
        letterMd: "l".repeat(20_000),
        sourceFolder: "f".repeat(300),
        idempotencyKey: "A.b_c:d-".padEnd(100, "k"),
        fitAnalysis: { grade: "A" },
        cvJson: { name: "Jane Doe" },
      }).success,
    ).toBe(true);
  });

  it.each([
    ["blank subject", { emailSubject: " " }],
    ["tab-only subject", { emailSubject: "\t  " }],
    ["blank body", { emailBody: " " }],
    ["whitespace-only body", { emailBody: " \n\n \t" }],
  ])("rejects a %s (review 01 #5)", (_name, over) => {
    expect(ok(over).success).toBe(false);
  });

  it.each([
    ["NBSP subject", { emailSubject: "\u00A0" }],
    ["ideographic-space subject", { emailSubject: "\u3000\u2003" }],
    ["BOM subject", { emailSubject: "\uFEFF " }],
    ["NBSP body", { emailBody: "\u00A0\u00A0" }],
    ["line / paragraph separator body", { emailBody: "\u2028\u2029\n" }],
  ])("rejects a unicode-whitespace-only %s (review 01 #5)", (_name, over) => {
    expect(ok(over).success).toBe(false);
  });

  // Issue #82: strings with no visible character are blank, not just
  // whitespace. Escapes keep the invisible characters readable in review.
  const INVISIBLE_ONLY: Array<[string, string]> = [
    ["zero width space U+200B", "\u200B"],
    ["zero width non-joiner U+200C", "\u200C\u200C"],
    ["zero width joiner U+200D", "\u200D"],
    ["word joiner U+2060", "\u2060"],
    ["BOM / ZWNBSP U+FEFF", "\uFEFF"],
    ["soft hyphen U+00AD", "\u00AD"],
    ["NBSP U+00A0", "\u00A0\u00A0"],
    ["line separator U+2028", "\u2028"],
    ["paragraph separator U+2029", "\u2029"],
    ["ideographic space U+3000", "\u3000"],
    ["en/em/thin/narrow spaces", "\u2002\u2003\u2009\u202F\u205F"],
    ["control characters", "\u0000\u0007"],
    ["Hangul filler U+3164", "\u3164"],
    ["Braille blank U+2800", "\u2800"],
    ["a mix with ordinary whitespace", " \u200B\t\u00A0\uFEFF\n\u2060 "],
  ];

  it.each(INVISIBLE_ONLY)("rejects a subject made only of %s", (_n, v) => {
    expect(ok({ emailSubject: v }).success).toBe(false);
    expect(UpdatePackageContentSchema.safeParse({ emailSubject: v }).success).toBe(false);
  });

  it.each(INVISIBLE_ONLY)("rejects a body made only of %s", (_n, v) => {
    expect(ok({ emailBody: v }).success).toBe(false);
    expect(UpdatePackageContentSchema.safeParse({ emailBody: v }).success).toBe(false);
  });

  it("keeps text that has a visible character, invisible ones included, unchanged", () => {
    const subject = "\u200BHi\u00AD there\uFEFF";
    const body = "\u2060 Hello\u200B\n\n";
    const r = ok({ emailSubject: subject, emailBody: body });
    expect(r.success && r.data.emailSubject).toBe(subject);
    expect(r.success && r.data.emailBody).toBe(body);
    const e = UpdatePackageContentSchema.parse({ emailSubject: subject, emailBody: body });
    expect(e.emailSubject).toBe(subject);
    expect(e.emailBody).toBe(body);
  });

  it("does not treat real text in other scripts or emoji as blank", () => {
    for (const v of ["é", "你好", "\u{1F600}", "ا", "a\u200Db"]) {
      expect(ok({ emailSubject: v, emailBody: v }).success).toBe(true);
    }
  });

  it("keeps surrounding whitespace of a non-blank body (no trimming)", () => {
    const r = ok({ emailBody: "  Hello\n\n" });
    expect(r.success && r.data.emailBody).toBe("  Hello\n\n");
  });

  it("rejects an unknown key instead of dropping it (review 01 #6)", () => {
    const r = ok({ emailTooo: "hr@example.com" });
    expect(r.success).toBe(false);
  });

  it("exports the field-level shape separately", () => {
    expect(
      z.object(SubmitApplicationPackageInputShape).safeParse(valid).success,
    ).toBe(true);
  });
});

describe("AttachFileInputShape / AttachFileSchema", () => {
  const base = { fileName: "cv.pdf", mimeType: "application/pdf" as const };

  it("caps contentBase64 at 7,000,000 chars in the shape", () => {
    const shape = z.object(AttachFileInputShape);
    expect(
      shape.safeParse({ ...base, contentBase64: "A".repeat(7_000_000) })
        .success,
    ).toBe(true);
    expect(
      shape.safeParse({ ...base, contentBase64: "A".repeat(7_000_001) })
        .success,
    ).toBe(false);
    expect(
      AttachFileSchema.safeParse({
        ...base,
        contentBase64: "A".repeat(7_000_001),
      }).success,
    ).toBe(false);
  });

  it("rejects another mime type and a long file name", () => {
    expect(
      AttachFileSchema.safeParse({
        ...base,
        mimeType: "text/plain",
        contentBase64: "A",
      }).success,
    ).toBe(false);
    expect(
      AttachFileSchema.safeParse({
        ...base,
        fileName: "f".repeat(121),
        contentBase64: "A",
      }).success,
    ).toBe(false);
  });
});

describe("other schemas", () => {
  it("trims and bounds reason / response (1-2000)", () => {
    const r = RejectPackageSchema.parse({ reason: "  not a fit  " });
    expect(r.reason).toBe("not a fit");
    // D-041: the reject reason is optional; blank becomes "".
    expect(RejectPackageSchema.parse({ reason: "   " }).reason).toBe("");
    expect(RejectPackageSchema.safeParse({}).success).toBe(true);
    expect(
      RejectPackageSchema.safeParse({ reason: "r".repeat(2_001) }).success,
    ).toBe(false);
    expect(
      MarkChangeRequestDoneSchema.safeParse({
        packageId: "p",
        response: "done",
      }).success,
    ).toBe(true);
    expect(
      MarkChangeRequestDoneSchema.safeParse({ packageId: "p", response: "" })
        .success,
    ).toBe(false);
  });

  it("applies list defaults and bounds", () => {
    expect(ListJobsSchema.parse({})).toMatchObject({ limit: 50, offset: 0 });
    expect(ListJobsSchema.safeParse({ limit: 101 }).success).toBe(false);
    expect(ListJobsSchema.safeParse({ limit: 0 }).success).toBe(false);
    expect(ListJobsSchema.safeParse({ offset: -1 }).success).toBe(false);
    expect(ListChangeRequestsSchema.safeParse({ limit: 100 }).success).toBe(
      true,
    );
    expect(ListChangeRequestsSchema.safeParse({ limit: 101 }).success).toBe(
      false,
    );
  });

  it("requires at least one field to edit and normalizes emailTo", () => {
    expect(UpdatePackageContentSchema.safeParse({}).success).toBe(false);
    const r = UpdatePackageContentSchema.parse({ emailTo: "" });
    expect(r.emailTo).toBeNull();
    expect(
      UpdatePackageContentSchema.safeParse({ emailSubject: "a\nb" }).success,
    ).toBe(false);
  });

  it("edit: refuses blank subject / body and unknown keys (review 01 #5, #6)", () => {
    for (const patch of [
      { emailSubject: "  " },
      { emailBody: " \n " },
      { emailBody: "ok", emailBdy: "typo" },
    ]) {
      expect(UpdatePackageContentSchema.safeParse(patch).success).toBe(false);
    }
  });
});
