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
    ["NBSP subject", { emailSubject: " " }],
    ["ideographic-space subject", { emailSubject: "　 " }],
    ["BOM subject", { emailSubject: "﻿ " }],
    ["NBSP body", { emailBody: "  " }],
    ["line / paragraph separator body", { emailBody: "  \n" }],
  ])("rejects a unicode-whitespace-only %s (review 01 #5)", (_name, over) => {
    expect(ok(over).success).toBe(false);
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
    expect(RejectPackageSchema.safeParse({ reason: "   " }).success).toBe(
      false,
    );
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
