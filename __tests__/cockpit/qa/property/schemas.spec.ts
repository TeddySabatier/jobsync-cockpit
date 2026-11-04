// @vitest-environment node
import fc from "fast-check";
import { ZodError, type ZodTypeAny } from "zod";
import * as S from "@/lib/cockpit/schemas";
import { fcParams, tag } from "./_fc";

// Property 3 (SPEC §2.3): safeParse never throws; accepted values obey bounds.
const SCHEMAS: Record<string, ZodTypeAny> = {
  AttachFileSchema: S.AttachFileSchema,
  SubmitApplicationPackageSchema: S.SubmitApplicationPackageSchema,
  ListJobsSchema: S.ListJobsSchema,
  GetJobSchema: S.GetJobSchema,
  ListChangeRequestsSchema: S.ListChangeRequestsSchema,
  MarkChangeRequestDoneSchema: S.MarkChangeRequestDoneSchema,
  RejectPackageSchema: S.RejectPackageSchema,
  RequestPackageChangesSchema: S.RequestPackageChangesSchema,
  UpdatePackageContentSchema: S.UpdatePackageContentSchema,
};

const weirdStr = fc.oneof(
  fc.string({ unit: "grapheme", maxLength: 400 }),
  fc.string({ maxLength: 50 }),
  fc.constantFrom("", " ", "jane@example.com", "a@b.co", "a\n@b.co", "x@y.zz,z@y.zz", "A", "B", "a\r"),
  fc.stringMatching(/^[A-Za-z0-9._:-]{0,120}$/),
  fc.string({ minLength: 20_001, maxLength: 20_050 }),
);
const maybe = <T>(valid: fc.Arbitrary<T>, weird: fc.Arbitrary<unknown>) =>
  fc.oneof({ weight: 3, arbitrary: valid }, { weight: 1, arbitrary: weird });
const obj = fc.oneof(fc.object(), fc.jsonValue());

const submitArb = fc.record(
  {
    jobId: maybe(fc.constant("job-1"), weirdStr),
    emailTo: maybe(fc.constantFrom("", "jane@example.com"), weirdStr),
    emailSubject: maybe(fc.constant("Application"), weirdStr),
    emailBody: maybe(fc.constant("Hello, Jane Doe."), weirdStr),
    letterMd: weirdStr,
    fitGrade: maybe(fc.constantFrom("A", "B"), fc.oneof(weirdStr, fc.integer())),
    fitAnalysis: obj,
    cvJson: obj,
    cvFileId: weirdStr,
    sourceFolder: weirdStr,
    idempotencyKey: maybe(fc.constant("key-1"), weirdStr),
  },
  { requiredKeys: [] },
);
const listArb = fc.record(
  {
    status: weirdStr,
    hasPackage: fc.oneof(fc.boolean(), weirdStr),
    limit: fc.oneof(fc.integer({ min: -5, max: 200 }), fc.double(), weirdStr),
    offset: fc.oneof(fc.integer({ min: -5, max: 200 }), fc.double(), weirdStr),
  },
  { requiredKeys: [] },
);
const updateArb = fc.record(
  { emailTo: weirdStr, emailSubject: weirdStr, emailBody: weirdStr, letterMd: weirdStr, cvJson: obj },
  { requiredKeys: [] },
);

describe(tag("schema properties"), () => {
  it("safeParse never throws and fails only with a ZodError, for any JSON-like input", () => {
    fc.assert(
      fc.property(fc.oneof(fc.anything(), fc.jsonValue(), submitArb, listArb, updateArb), (v) => {
        for (const schema of Object.values(SCHEMAS)) {
          const r = schema.safeParse(v);
          if (!r.success) expect(r.error).toBeInstanceOf(ZodError);
        }
      }),
      fcParams(),
    );
  });

  it("submit_application_package: accepted values respect the declared bounds", () => {
    let accepted = 0;
    fc.assert(
      fc.property(submitArb, (v) => {
        const r = S.SubmitApplicationPackageSchema.safeParse(v);
        if (!r.success) return;
        accepted++;
        const o = r.data;
        expect(o.jobId.length).toBeGreaterThanOrEqual(1);
        expect(o.emailSubject.length).toBeGreaterThanOrEqual(1);
        expect(o.emailSubject.length).toBeLessThanOrEqual(300);
        expect(o.emailSubject).not.toMatch(/[\r\n]/);
        expect(o.emailBody.length).toBeGreaterThanOrEqual(1);
        expect(o.emailBody.length).toBeLessThanOrEqual(20_000);
        expect(["A", "B"]).toContain(o.fitGrade);
        if (o.emailTo !== undefined && o.emailTo !== null) {
          expect(o.emailTo.length).toBeGreaterThanOrEqual(1);
          expect(o.emailTo.length).toBeLessThanOrEqual(254);
          expect(o.emailTo).not.toMatch(/[\r\n,]/);
        }
        if (o.letterMd !== undefined) expect(o.letterMd.length).toBeLessThanOrEqual(20_000);
        if (o.idempotencyKey !== undefined) expect(o.idempotencyKey).toMatch(/^[A-Za-z0-9._:-]{1,100}$/);
        if (o.fitAnalysis) expect(JSON.stringify(o.fitAnalysis).length).toBeLessThanOrEqual(20_000);
        if (o.cvJson) expect(JSON.stringify(o.cvJson).length).toBeLessThanOrEqual(200_000);
        if (o.sourceFolder !== undefined) expect(o.sourceFolder.length).toBeLessThanOrEqual(300);
      }),
      fcParams(),
    );
    expect(accepted).toBeGreaterThan(0);
  });

  it("list_jobs: limit is an int in 1..100, offset an int >= 0", () => {
    fc.assert(
      fc.property(listArb, (v) => {
        const r = S.ListJobsSchema.safeParse(v);
        if (!r.success) return;
        expect(Number.isInteger(r.data.limit)).toBe(true);
        expect(r.data.limit).toBeGreaterThanOrEqual(1);
        expect(r.data.limit).toBeLessThanOrEqual(100);
        expect(Number.isInteger(r.data.offset)).toBe(true);
        expect(r.data.offset).toBeGreaterThanOrEqual(0);
      }),
      fcParams(),
    );
  });

  it("update content: needs one field; subject/body/recipient bounds hold", () => {
    fc.assert(
      fc.property(updateArb, (v) => {
        const r = S.UpdatePackageContentSchema.safeParse(v);
        if (!r.success) return;
        const o = r.data;
        expect(Object.values(o).some((x) => x !== undefined)).toBe(true);
        if (o.emailSubject !== undefined) {
          expect(o.emailSubject.length).toBeLessThanOrEqual(300);
          expect(o.emailSubject).not.toMatch(/[\r\n]/);
          expect(o.emailSubject.length).toBeGreaterThanOrEqual(1);
        }
        if (o.emailBody !== undefined) {
          expect(o.emailBody.length).toBeGreaterThanOrEqual(1);
          expect(o.emailBody.length).toBeLessThanOrEqual(20_000);
        }
        if (typeof o.emailTo === "string") expect(o.emailTo).not.toMatch(/[\r\n,]/);
      }),
      fcParams(),
    );
  });

  it("reject / change-request / mark-done text is trimmed, 1..2000", () => {
    fc.assert(
      fc.property(weirdStr, (s) => {
        for (const [schema, key] of [
          [S.RejectPackageSchema, "reason"],
          [S.RequestPackageChangesSchema, "instruction"],
          [S.MarkChangeRequestDoneSchema, "response"],
        ] as const) {
          const r = schema.safeParse({ [key]: s, packageId: "p1" });
          if (!r.success) continue;
          const out = (r.data as Record<string, string>)[key];
          expect(out.length).toBeGreaterThanOrEqual(1);
          expect(out.length).toBeLessThanOrEqual(2_000);
          expect(out).toBe(out.trim());
        }
      }),
      fcParams(),
    );
  });
});
