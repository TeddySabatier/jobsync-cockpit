import { z } from "zod";

// Field limits (cockpit/SPEC.md §2.3). Each rule set is exported twice:
// `XInputShape` (field-level rules, what `server.tool` takes) and `XSchema`
// (`z.object(shape)` plus cross-field rules, used by the UI services and
// tests; the MCP handlers rely on the SDK's check of the shape).

const noLineBreak = /^[^\r\n]*$/;
const noLineBreakOrComma = /^[^\r\n,]*$/;

const emailAddress = z
  .string()
  .max(254)
  .email()
  .regex(noLineBreakOrComma, "A single address, no comma or line break");

// "" means "apply via link"; the Schemas below turn it into null.
const emailToField = z.union([z.literal(""), emailAddress]).optional();

// A string with no visible character is blank: whitespace (incl. NBSP, U+2028,
// U+2029, U+3000), any other Unicode separator (Z*), control or format
// character (Cc, Cf: zero-width space/joiners U+200B-200D, U+2060, BOM U+FEFF,
// soft hyphen U+00AD), and the characters that render as empty space though
// they are letters or marks (Hangul fillers, Braille blank, combining grapheme
// joiner). Only the test strips them; the stored text is never changed.
// scripts/bot/cockpit_submit.py applies the same rule (is_blank_text).
const INVISIBLE = /[\s\p{Z}\p{Cc}\p{Cf}\u034F\u115F\u1160\u2800\u3164\uFFA0]/gu;
export const isBlankText = (v: string) => v.replace(INVISIBLE, "").length === 0;
const notBlank = (v: string) => !isBlankText(v);

const emailSubjectField = z
  .string()
  .min(1)
  .max(300)
  .regex(noLineBreak, "No line break allowed")
  .refine(notBlank, "Must not be blank");

const emailBodyField = z
  .string()
  .min(1)
  .max(20_000)
  .refine(notBlank, "Must not be blank");
const letterMdField = z.string().max(20_000);

const jsonObject = (maxChars: number) =>
  z
    .record(z.string(), z.unknown())
    .refine((v) => JSON.stringify(v).length <= maxChars, {
      message: `Serialized JSON must be at most ${maxChars} characters`,
    });

const shortText = z.string().trim().min(1).max(2_000);

export const emptyToNull = <T extends { emailTo?: string }>(
  v: T,
): Omit<T, "emailTo"> & { emailTo?: string | null } => ({
  ...v,
  emailTo: v.emailTo === undefined ? undefined : v.emailTo || null,
});

// ---- attach_file ----------------------------------------------------------
export const AttachFileInputShape = {
  fileName: z.string().min(1).max(120),
  mimeType: z.literal("application/pdf"),
  // ~5 MB decoded; capped before decoding.
  contentBase64: z.string().max(7_000_000),
};
export const AttachFileSchema = z.object(AttachFileInputShape);

// ---- submit_application_package -------------------------------------------
export const SubmitApplicationPackageInputShape = {
  jobId: z.string().min(1),
  emailTo: emailToField,
  emailSubject: emailSubjectField,
  emailBody: emailBodyField,
  letterMd: letterMdField.optional(),
  fitGrade: z.enum(["A", "B"]),
  fitAnalysis: jsonObject(20_000).optional(),
  cvJson: jsonObject(200_000).optional(),
  cvFileId: z.string().min(1).optional(),
  sourceFolder: z.string().max(300).optional(),
  // Where the recipient address was found (a URL or a short note, D-041).
  contactSource: z.string().trim().max(300).optional(),
  idempotencyKey: z
    .string()
    .regex(/^[A-Za-z0-9._:-]{1,100}$/)
    .optional(),
};
// Strict: an unknown key (a bot typo like `emailTooo`) is a validation error,
// never a silently dropped field. The MCP tool registers this object, so the
// SDK refuses the call before the handler runs.
export const SubmitApplicationPackageObject = z.strictObject(
  SubmitApplicationPackageInputShape,
);
export const SubmitApplicationPackageSchema =
  SubmitApplicationPackageObject.transform(emptyToNull);
export type SubmitApplicationPackageInput = z.output<
  typeof SubmitApplicationPackageSchema
>;

// ---- list_jobs ------------------------------------------------------------
export const ListJobsInputShape = {
  status: z.string().min(1).optional(),
  hasPackage: z.boolean().optional(),
  limit: z.number().int().min(1).max(100).default(50),
  offset: z.number().int().min(0).default(0),
};
export const ListJobsSchema = z.object(ListJobsInputShape);

// ---- get_job --------------------------------------------------------------
export const GetJobInputShape = { jobId: z.string().min(1) };
export const GetJobSchema = z.object(GetJobInputShape);

// ---- list_change_requests -------------------------------------------------
export const ListChangeRequestsInputShape = {
  limit: z.number().int().min(1).max(100).default(50),
};
export const ListChangeRequestsSchema = z.object(ListChangeRequestsInputShape);

// ---- mark_change_request_done ---------------------------------------------
export const MarkChangeRequestDoneInputShape = {
  packageId: z.string().min(1),
  response: shortText,
};
export const MarkChangeRequestDoneSchema = z.object(
  MarkChangeRequestDoneInputShape,
);

// ---- review actions (UI side, used by the service) ------------------------
// The reason is optional (D-041): quick triage should not need typing. Blank = none.
export const RejectPackageInputShape = { reason: z.string().trim().max(2_000).optional() };
export const RejectPackageSchema = z.object(RejectPackageInputShape);

export const RequestPackageChangesInputShape = { instruction: shortText };
export const RequestPackageChangesSchema = z.object(
  RequestPackageChangesInputShape,
);

export const UpdatePackageContentInputShape = {
  emailTo: emailToField,
  emailSubject: emailSubjectField.optional(),
  emailBody: emailBodyField.optional(),
  letterMd: letterMdField.optional(),
  cvJson: jsonObject(200_000).optional(),
};
export const UpdatePackageContentSchema = z
  .strictObject(UpdatePackageContentInputShape)
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: "At least one field is required",
  })
  .transform(emptyToNull);
export type UpdatePackageContentInput = z.output<
  typeof UpdatePackageContentSchema
>;
