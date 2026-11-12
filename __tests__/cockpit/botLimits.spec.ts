// @vitest-environment node
// Issue #83: scripts/bot/cockpit_limits.json is the ONE table of server limits
// that the bot script and its test stub read. This test pins every value to
// the real Zod schemas (src/lib/cockpit/schemas.ts), so the table, the script
// and the stub cannot drift from the server.
import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import {
  AttachFileSchema,
  ListChangeRequestsSchema,
  ListDueFollowUpsSchema,
  ListJobsSchema,
  SubmitApplicationPackageSchema,
  SubmitFollowUpSchema,
} from "@/lib/cockpit/schemas";

const botDir = path.resolve(__dirname, "../../scripts/bot");
const limits = JSON.parse(
  fs.readFileSync(path.join(botDir, "cockpit_limits.json"), "utf8"),
) as Record<string, number | string>;

const num = (k: string) => limits[k] as number;

const submit = (over: Record<string, unknown> = {}) =>
  SubmitApplicationPackageSchema.safeParse({
    jobId: "job-1",
    emailSubject: "Application",
    emailBody: "Hello",
    fitGrade: "A",
    ...over,
  }).success;

// A JSON object whose compact serialization is exactly `length` characters.
const jsonOfLength = (length: number) => {
  const overhead = JSON.stringify({ x: "" }).length;
  const obj = { x: "y".repeat(length - overhead) };
  expect(JSON.stringify(obj).length).toBe(length);
  return obj;
};

// An address of exactly `length` characters (labels of at most 63).
const addressOfLength = (length: number) => {
  const local = "a".repeat(60);
  let domain = "";
  const room = length - local.length - 1;
  while (domain.length < room - 4) {
    const label = "b".repeat(Math.min(60, room - 4 - domain.length - 1));
    domain += `${label}.`;
  }
  const address = `${local}@${domain}com`;
  return address.padEnd(length, "m").slice(0, length);
};

describe("cockpit_limits.json matches the real schemas (issue #83)", () => {
  it("has exactly the keys the script and stub use", () => {
    expect(Object.keys(limits).filter((k) => k !== "_comment").sort()).toEqual(
      [
        "base64Max",
        "cvJsonMax",
        "emailAddressMax",
        "emailBodyMax",
        "fileNameMax",
        "fileNameMin",
        "fitAnalysisMax",
        "idempotencyKeyPattern",
        "letterMdMax",
        "listLimitMax",
        "listLimitMin",
        "sourceFolderMax",
        "subjectMax",
      ].sort(),
    );
  });

  it("subject: 1 to subjectMax, no blank", () => {
    expect(submit({ emailSubject: "s".repeat(num("subjectMax")) })).toBe(true);
    expect(submit({ emailSubject: "s".repeat(num("subjectMax") + 1) })).toBe(false);
    expect(submit({ emailSubject: "" })).toBe(false);
  });

  it("emailBody: 1 to emailBodyMax", () => {
    expect(submit({ emailBody: "b".repeat(num("emailBodyMax")) })).toBe(true);
    expect(submit({ emailBody: "b".repeat(num("emailBodyMax") + 1) })).toBe(false);
    expect(submit({ emailBody: "" })).toBe(false);
  });

  it("letterMd: at most letterMdMax", () => {
    expect(submit({ letterMd: "l".repeat(num("letterMdMax")) })).toBe(true);
    expect(submit({ letterMd: "l".repeat(num("letterMdMax") + 1) })).toBe(false);
  });

  it("sourceFolder: at most sourceFolderMax", () => {
    expect(submit({ sourceFolder: "f".repeat(num("sourceFolderMax")) })).toBe(true);
    expect(submit({ sourceFolder: "f".repeat(num("sourceFolderMax") + 1) })).toBe(false);
  });

  it.each([
    ["cvJson", "cvJsonMax"],
    ["fitAnalysis", "fitAnalysisMax"],
  ])("%s: serialized JSON at most %s", (field, key) => {
    expect(submit({ [field]: jsonOfLength(num(key)) })).toBe(true);
    expect(submit({ [field]: jsonOfLength(num(key) + 1) })).toBe(false);
  });

  it("emailTo: at most emailAddressMax characters", () => {
    expect(submit({ emailTo: addressOfLength(num("emailAddressMax")) })).toBe(true);
    expect(submit({ emailTo: addressOfLength(num("emailAddressMax") + 1) })).toBe(false);
  });

  it("idempotencyKey: the pattern accepts and refuses what the schema does", () => {
    const pattern = new RegExp(limits.idempotencyKeyPattern as string);
    for (const key of [
      "a",
      "A.b_c:d-",
      "k".repeat(100),
      "k".repeat(101),
      "",
      "bad key",
      "bad!",
      "café",
      "line\nbreak",
    ]) {
      expect(submit({ idempotencyKey: key }), JSON.stringify(key)).toBe(
        pattern.test(key),
      );
    }
  });

  it("attach_file: fileName 1 to fileNameMax, contentBase64 at most base64Max", () => {
    const attach = (over: Record<string, unknown>) =>
      AttachFileSchema.safeParse({
        fileName: "cv.pdf",
        mimeType: "application/pdf",
        contentBase64: "JVBERi0=",
        ...over,
      }).success;
    expect(attach({ fileName: "f".repeat(num("fileNameMax")) })).toBe(true);
    expect(attach({ fileName: "f".repeat(num("fileNameMax") + 1) })).toBe(false);
    expect(attach({ fileName: "f".repeat(num("fileNameMin") - 1) })).toBe(false);
    expect(attach({ contentBase64: "A".repeat(num("base64Max")) })).toBe(true);
    expect(attach({ contentBase64: "A".repeat(num("base64Max") + 1) })).toBe(false);
  });

  it.each([
    ["list_jobs", ListJobsSchema],
    ["list_change_requests", ListChangeRequestsSchema],
    ["list_due_follow_ups", ListDueFollowUpsSchema],
  ])("%s: limit from listLimitMin to listLimitMax, refused outside (not clamped)", (_n, schema) => {
    const limit = (v: unknown) => schema.safeParse({ limit: v }).success;
    expect(limit(num("listLimitMin"))).toBe(true);
    expect(limit(num("listLimitMax"))).toBe(true);
    expect(limit(num("listLimitMin") - 1)).toBe(false);
    expect(limit(num("listLimitMax") + 1)).toBe(false);
  });

  // D-034: submit_follow_up shares the subject, body and key limits.
  it("submit_follow_up: subject, emailBody and idempotencyKey follow the same table", () => {
    const fu = (over: Record<string, unknown> = {}) =>
      SubmitFollowUpSchema.safeParse({
        jobId: "job-1",
        emailSubject: "Re: Application",
        emailBody: "Hello",
        idempotencyKey: "k1",
        ...over,
      }).success;
    expect(fu({ emailSubject: "s".repeat(num("subjectMax")) })).toBe(true);
    expect(fu({ emailSubject: "s".repeat(num("subjectMax") + 1) })).toBe(false);
    expect(fu({ emailSubject: "\u200B" })).toBe(false);
    expect(fu({ emailBody: "b".repeat(num("emailBodyMax")) })).toBe(true);
    expect(fu({ emailBody: "b".repeat(num("emailBodyMax") + 1) })).toBe(false);
    expect(fu({ emailBody: "\u3000\u2060" })).toBe(false);
    const pattern = new RegExp(limits.idempotencyKeyPattern as string);
    for (const key of ["a", "A.b_c:d-", "k".repeat(100), "k".repeat(101), "", "bad key", "café"]) {
      expect(fu({ idempotencyKey: key }), JSON.stringify(key)).toBe(pattern.test(key));
    }
  });

  it("the Python script reads this table (nothing hard-coded)", () => {
    const probe = spawnSync(
      "python3",
      [
        "-c",
        [
          "import json, cockpit_submit as cs",
          "print(json.dumps(dict(base64Max=cs.MAX_BASE64_CHARS, cvJsonMax=cs.MAX_CV_JSON,",
          "emailAddressMax=cs.MAX_ADDRESS, emailBodyMax=cs.MAX_TEXT, fileNameMax=cs.MAX_FILE_NAME,",
          "fitAnalysisMax=cs.MAX_FIT_ANALYSIS, listLimitMax=cs.MAX_CHANGE_REQUESTS,",
          "listLimitMin=cs.MIN_LIST_LIMIT, sourceFolderMax=cs.MAX_SOURCE_FOLDER, subjectMax=cs.MAX_SUBJECT)))",
        ].join("\n"),
      ],
      { cwd: botDir, encoding: "utf8" },
    );
    if (probe.error) return; // no python3 on this machine: the Python tests cover it
    expect(probe.status, probe.stderr).toBe(0);
    const fromScript = JSON.parse(probe.stdout) as Record<string, number>;
    for (const [key, value] of Object.entries(fromScript)) {
      expect(value, key).toBe(limits[key]);
    }
    // letterMd shares the emailBody cap in the script (one MAX_TEXT)
    expect(limits.letterMdMax).toBe(limits.emailBodyMax);
  });

  it("the script's built-in fallback equals this table, and a script copied alone still runs", () => {
    // The bot setup copies cockpit_submit.py into the bot folder; the table
    // may not come along. The script then uses _FALLBACK_LIMITS.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-alone-"));
    try {
      fs.copyFileSync(
        path.join(botDir, "cockpit_submit.py"),
        path.join(dir, "cockpit_submit.py"),
      );
      const probe = spawnSync(
        "python3",
        [
          "-I",
          "-c",
          [
            "import json, sys",
            "sys.path.insert(0, sys.argv[1])",
            "import cockpit_submit as cs",
            "print(json.dumps([cs.LIMITS, cs._FALLBACK_LIMITS]))",
          ].join("\n"),
          dir,
        ],
        { encoding: "utf8" },
      );
      if (probe.error) return; // no python3 on this machine
      expect(probe.status, probe.stderr).toBe(0);
      const [alone, fallback] = JSON.parse(probe.stdout);
      expect(alone).toEqual(fallback);
      const { _comment, ...table } = limits;
      expect(_comment).toBeDefined();
      expect(fallback).toEqual(table);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
