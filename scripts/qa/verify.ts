import { z } from "zod";
import { ROOT, headFile, splitLines } from "./git.ts";

export const FindingSchema = z.object({
  id: z.string().default(""),
  lens: z.string(),
  severity: z.enum(["P0", "P1", "P2", "P3"]),
  file: z.string(),
  startLine: z.coerce.number().int(),
  endLine: z.coerce.number().int(),
  quote: z.string(),
  claim: z.string(),
  failureScenario: z.string(),
  suggestedTest: z.string().default(""),
  suggestedFix: z.string().default(""),
  confidence: z.coerce
    .number()
    .transform((n) => Math.min(1, Math.max(0, n)))
    .default(0.5),
});
export type Finding = z.infer<typeof FindingSchema>;

export const VerdictSchema = z.object({
  verdict: z.enum(["confirmed", "refuted", "unclear"]),
  reasoning: z.string().default(""),
  test: z.string().optional(),
});
export type Verdict = z.infer<typeof VerdictSchema>;

export type CheckResult = { ok: boolean; reason: string; actualStart: number };

const fail = (reason: string): CheckResult => ({ ok: false, reason, actualStart: -1 });

/** Drop "123| " prefixes the model may have copied from the numbered shard. */
export function stripLineNumbers(lines: string[]): string[] {
  const first = lines.find((l) => l.trim() !== "");
  if (first === undefined || !/^\s*\d+\s*\|\s?/.test(first)) return lines;
  return lines.map((l) => l.replace(/^\s*\d+\s*\|\s?/, ""));
}

const CONCRETE = /["'`]|\d|\w+\(|\w+\.\w|\b(when|if|with)\b/i;

export function mechanicalCheck(
  f: Finding,
  repoRoot: string = ROOT,
  readHead: (root: string, rel: string) => string | null = headFile,
): CheckResult {
  if (
    !f.file ||
    f.file.startsWith("/") ||
    f.file.includes("\0") ||
    /(^|\/)\.\.(\/|$)/.test(f.file)
  ) {
    return fail("bad-path");
  }
  const content = readHead(repoRoot, f.file);
  if (content === null) return fail("file-not-in-head");
  if (!Number.isInteger(f.startLine) || !Number.isInteger(f.endLine) || f.startLine < 1 || f.endLine < f.startLine) {
    return fail("bad-line-range");
  }
  if (f.claim.trim().length < 30) return fail("claim-too-short");
  if (f.failureScenario.trim().length < 30) return fail("scenario-too-short");

  let q = stripLineNumbers(f.quote.replace(/\r\n/g, "\n").split("\n")).map((l) => l.trim());
  while (q.length && q[0] === "") q.shift();
  while (q.length && q[q.length - 1] === "") q.pop();
  if (q.length < 1 || q.length > 12) return fail("quote-length");

  const lines = splitLines(content).map((l) => l.trim());
  const lo = Math.max(1, f.startLine - 15);
  const hi = Math.min(lines.length, f.endLine + 15);
  let best = -1;
  for (let s = lo; s + q.length - 1 <= hi; s++) {
    let all = true;
    for (let k = 0; k < q.length; k++) {
      if (lines[s - 1 + k] !== q[k]) {
        all = false;
        break;
      }
    }
    if (all && (best < 0 || Math.abs(s - f.startLine) < Math.abs(best - f.startLine))) best = s;
  }
  if (best < 0) return fail("quote-not-found");
  if (!CONCRETE.test(f.failureScenario)) return fail("scenario-not-concrete");
  return { ok: true, reason: "ok", actualStart: best };
}

export function dedupeKey(f: Finding): string {
  const quote = stripLineNumbers(f.quote.split("\n")).join(" ");
  return `${f.file}|${quote.replace(/\s+/g, " ").trim().toLowerCase()}|${f.lens}`;
}
