import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { extractJson } from "./json.ts";
import { ROOT, TMP } from "./git.ts";

export { extractJson };

export type AskOpts = {
  lane: string;
  model: string;
  prompt: string;
  timeoutMs?: number;
  noCache?: boolean;
  /** defaults to 5 */
  maxTries?: number;
};
export type AskResult = {
  text: string;
  json?: unknown;
  model: string;
  tokensIn: number;
  tokensOut: number;
  estimated: boolean;
  ms: number;
  cached: boolean;
};
export type Validator<T> = {
  safeParse(v: unknown):
    | { success: true; data: T }
    | { success: false; error: { message: string } };
};

const MAX_TRIES = 5;
const MAX_PROMPT_BYTES = 125_000; // Linux caps a single argv string at 128 KiB

// ---------- logging ----------
export type LogEntry = {
  lane: string;
  model: string;
  ms: number;
  tokensIn: number;
  tokensOut: number;
  status: string;
};
let logger: (e: LogEntry) => void = (e) =>
  console.log(
    `${new Date().toISOString()} ${e.lane} ${e.model} ${e.ms}ms in=${e.tokensIn} out=${e.tokensOut} ${e.status}`,
  );
export function setLogger(fn: (e: LogEntry) => void): void {
  logger = fn;
}

// ---------- semaphore with dynamic limit ----------
let limit = 12;
let maxLimit = 24;
let active = 0;
let last429 = 0;
let lastHalve = 0;
let lastRaise = Date.now();
const waiters: Array<() => void> = [];

function pump(): void {
  while (active < limit) {
    const w = waiters.shift();
    if (!w) return;
    active++;
    w();
  }
}
function acquire(): Promise<void> {
  if (active < limit) {
    active++;
    return Promise.resolve();
  }
  return new Promise((r) => waiters.push(r));
}
function maybeRaise(): void {
  const now = Date.now();
  if (limit < maxLimit && now - last429 > 120_000 && now - lastRaise > 120_000) {
    limit++;
    lastRaise = now;
    pump();
  }
}
function release(): void {
  active--;
  maybeRaise();
  pump();
}
function on429(): void {
  const now = Date.now();
  last429 = now;
  if (now - lastHalve > 10_000) {
    limit = Math.max(4, Math.floor(limit / 2));
    lastHalve = now;
  }
}
export function setConcurrency(start: number, max: number): void {
  maxLimit = Math.max(4, max);
  limit = Math.max(4, Math.min(start, maxLimit));
  pump();
}
export const getLimit = (): number => limit;
export const getLast429 = (): number => last429;

// ---------- lane circuit breaker / model health ----------
const laneHist = new Map<string, Array<{ t: number; ok: boolean }>>();
const laneUntil = new Map<string, number>();
const modelFails = new Map<string, number>();
const modelUntil = new Map<string, number>();

export const laneBlockedUntil = (lane: string): number => laneUntil.get(lane) ?? 0;
export const modelBenchedUntil = (model: string): number => modelUntil.get(model) ?? 0;
export function benchModel(model: string, ms: number): void {
  modelUntil.set(model, Date.now() + ms);
}

function recordLane(lane: string, ok: boolean): void {
  const now = Date.now();
  const h = (laneHist.get(lane) ?? []).filter((x) => now - x.t < 5 * 60_000);
  h.push({ t: now, ok });
  laneHist.set(lane, h);
  if (h.length >= 10 && h.filter((x) => !x.ok).length / h.length > 0.5) {
    laneUntil.set(lane, now + 10 * 60_000);
    laneHist.set(lane, []);
    logger({ lane, model: "-", ms: 0, tokensIn: 0, tokensOut: 0, status: "LANE PAUSED 10min (circuit breaker)" });
  }
}
function modelOk(model: string): void {
  modelFails.set(model, 0);
}
function modelFail(model: string): void {
  const n = (modelFails.get(model) ?? 0) + 1;
  modelFails.set(model, n);
  if (n >= 5) {
    benchModel(model, 15 * 60_000);
    modelFails.set(model, 0);
    logger({ lane: "-", model, ms: 0, tokensIn: 0, tokensOut: 0, status: "MODEL BENCHED 15min (5 consecutive failures)" });
  }
}

// ---------- budget ----------
type Counts = {
  calls: number; ok: number; failed: number; cached: number;
  in: number; out: number; estIn: number; estOut: number;
};
type ModelStat = { calls: number; ok: number; failed: number; in: number; out: number; avgMs: number };
type Budget = {
  startedAt: string;
  updatedAt: string;
  total: Counts;
  lanes: Record<string, Counts>;
  models: Record<string, ModelStat>;
};
const zeroCounts = (): Counts => ({ calls: 0, ok: 0, failed: 0, cached: 0, in: 0, out: 0, estIn: 0, estOut: 0 });
const BUDGET_PATH = join(TMP, "budget.json");
let budget: Budget | undefined;
let initialized = false;

function loadBudget(): Budget {
  try {
    const b = JSON.parse(readFileSync(BUDGET_PATH, "utf8")) as Budget;
    if (b && b.total && b.lanes && b.models) return b;
  } catch {
    // no previous budget
  }
  const now = new Date().toISOString();
  return { startedAt: now, updatedAt: now, total: zeroCounts(), lanes: {}, models: {} };
}

export function flushBudget(): void {
  if (!budget) return;
  budget.updatedAt = new Date().toISOString();
  mkdirSync(TMP, { recursive: true });
  const tmp = `${BUDGET_PATH}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(budget, null, 2));
  renameSync(tmp, BUDGET_PATH);
}

function init(): Budget {
  if (!initialized) {
    initialized = true;
    budget = loadBudget();
    setInterval(flushBudget, 60_000).unref();
    setInterval(maybeRaise, 10_000).unref();
    process.on("exit", flushBudget);
  }
  return budget as Budget;
}

export function spentTokens(): number {
  const t = init().total;
  return t.in + t.out + t.estIn + t.estOut;
}

type Outcome = { ok: boolean; cached: boolean; in: number; out: number; estimated: boolean; ms: number };
function account(lane: string, model: string, o: Outcome): void {
  const b = init();
  const lc = (b.lanes[lane] ??= zeroCounts());
  const ms = (b.models[model] ??= { calls: 0, ok: 0, failed: 0, in: 0, out: 0, avgMs: 0 });
  for (const c of [b.total, lc]) {
    c.calls++;
    if (o.ok) c.ok++;
    else c.failed++;
    if (o.cached) c.cached++;
    else if (o.estimated) {
      c.estIn += o.in;
      c.estOut += o.out;
    } else {
      c.in += o.in;
      c.out += o.out;
    }
  }
  ms.calls++;
  if (o.ok) ms.ok++;
  else ms.failed++;
  if (o.ok && !o.cached) {
    ms.in += o.in;
    ms.out += o.out;
    ms.avgMs = Math.round(ms.avgMs + (o.ms - ms.avgMs) / ms.ok);
  }
}

// ---------- process execution ----------
const children = new Set<ChildProcess>();
export function killAll(): void {
  for (const c of children) {
    try {
      if (c.pid) process.kill(-c.pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
}

type ExecResult = { stdout: string; stderr: string; code: number; timedOut: boolean };
function exec(args: string[], timeoutMs: number): Promise<ExecResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const child = spawn("opencode", args, {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true, // own process group so a timeout kills opencode's children too
    });
    children.add(child);
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (d: string) => (stdout += d));
    child.stderr?.on("data", (d: string) => (stderr += d));
    const done = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      children.delete(child);
      resolve({ stdout, stderr, code, timedOut });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, timeoutMs);
    child.on("error", (e) => {
      stderr += String(e);
      done(-1);
    });
    child.on("close", (code) => done(code ?? -1));
  });
}

type Ev = { type?: string; sessionID?: string; part?: { text?: string } };
function parseEvents(stdout: string): { sessionID: string; text: string; errors: string } {
  let sessionID = "";
  let text = "";
  let errors = "";
  for (const line of stdout.split("\n")) {
    const s = line.trim();
    if (!s.startsWith("{")) continue;
    let ev: Ev;
    try {
      ev = JSON.parse(s) as Ev;
    } catch {
      continue;
    }
    if (!sessionID && typeof ev.sessionID === "string") sessionID = ev.sessionID;
    if (ev.type === "text" && typeof ev.part?.text === "string") text += ev.part.text;
    else if (ev.type === "error") errors += s + "\n";
  }
  return { sessionID, text, errors };
}

type Exported = { info?: { model?: unknown; tokens?: { input?: unknown; output?: unknown } } };
function modelName(m: unknown, fallback: string): string {
  if (typeof m === "string") return m;
  if (m && typeof m === "object") {
    const o = m as { providerID?: string; modelID?: string; id?: string };
    if (o.providerID && o.modelID) return `${o.providerID}/${o.modelID}`;
    if (o.modelID) return o.modelID;
    if (o.id) return o.id;
  }
  return fallback;
}

type Attempt = { res?: AskResult; error: string; is429: boolean };
const RE_429 = /429|rate.?limit|quota/i;

async function attemptOnce(opts: AskOpts): Promise<Attempt> {
  const t0 = Date.now();
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const r = await exec(
    ["run", "--agent", "qa-free", "-m", opts.model, "--format", "json", "--title", `qa-${opts.lane}`, opts.prompt],
    timeoutMs,
  );
  const ev = parseEvents(r.stdout);
  const text = ev.text.trim();
  // Only scan stdout for 429 when there is no answer: real answers may legitimately say "quota".
  const errBlob = r.stderr + ev.errors + (text ? "" : r.stdout);
  const is429 = RE_429.test(errBlob);
  const cleanup = async () => {
    if (ev.sessionID) await exec(["session", "delete", ev.sessionID], 30_000).catch(() => undefined);
  };
  if (r.timedOut) {
    await cleanup();
    return { error: "timeout", is429: false };
  }
  if (r.code !== 0) {
    await cleanup();
    return { error: `exit ${r.code}: ${errBlob.trim().slice(-300)}`, is429 };
  }
  if (!text) {
    await cleanup();
    return { error: `empty text ${errBlob.trim().slice(-200)}`, is429 };
  }

  let tokensIn = Math.ceil(opts.prompt.length / 4);
  let tokensOut = Math.ceil(text.length / 4);
  let estimated = true;
  let resolved = opts.model;
  if (ev.sessionID) {
    const ex = await exec(["session", "export", ev.sessionID], 30_000);
    if (ex.code === 0) {
      const parsed = extractJson(ex.stdout) as Exported | undefined;
      const tk = parsed?.info?.tokens;
      if (tk && typeof tk.input === "number" && typeof tk.output === "number") {
        tokensIn = tk.input;
        tokensOut = tk.output;
        estimated = false;
        resolved = modelName(parsed?.info?.model, opts.model);
      }
    }
  }
  await cleanup();
  return {
    error: "",
    is429: false,
    res: { text, json: extractJson(text), model: resolved, tokensIn, tokensOut, estimated, ms: Date.now() - t0, cached: false },
  };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const backoff = (n: number) => Math.min(60_000, 2_000 * 2 ** n) * (0.5 + Math.random() * 0.5);
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

function writeRaw(lane: string, key: string, text: string): void {
  try {
    const dir = join(TMP, "raw", lane);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${key.slice(0, 40)}.txt`), text);
  } catch {
    // raw dump is best-effort
  }
}

export async function ask(opts: AskOpts): Promise<AskResult> {
  init();
  const key = sha(opts.model + "\n" + opts.prompt);
  const cachePath = join(TMP, "cache", `${key}.json`);
  if (!opts.noCache && existsSync(cachePath)) {
    try {
      const c = JSON.parse(readFileSync(cachePath, "utf8")) as AskResult;
      account(opts.lane, opts.model, { ok: true, cached: true, in: 0, out: 0, estimated: false, ms: 0 });
      logger({ lane: opts.lane, model: opts.model, ms: 0, tokensIn: 0, tokensOut: 0, status: "cached" });
      return { ...c, ms: 0, cached: true };
    } catch {
      // corrupt cache entry: fall through and re-ask
    }
  }
  if (Buffer.byteLength(opts.prompt) > MAX_PROMPT_BYTES) {
    throw new Error(`prompt too large (${Buffer.byteLength(opts.prompt)} bytes)`);
  }
  if (laneBlockedUntil(opts.lane) > Date.now()) throw new Error(`lane ${opts.lane} paused`);
  if (modelBenchedUntil(opts.model) > Date.now()) throw new Error(`model ${opts.model} benched`);

  let lastErr = "";
  const tries = opts.maxTries ?? MAX_TRIES;
  for (let i = 0; i < tries; i++) {
    if (i > 0) await sleep(backoff(i - 1));
    const t0 = Date.now();
    await acquire();
    let a: Attempt;
    try {
      a = await attemptOnce(opts);
    } catch (e) {
      a = { error: String(e), is429: false };
    } finally {
      release();
    }
    if (a.res) {
      modelOk(opts.model);
      recordLane(opts.lane, true);
      account(opts.lane, opts.model, {
        ok: true, cached: false, in: a.res.tokensIn, out: a.res.tokensOut, estimated: a.res.estimated, ms: a.res.ms,
      });
      logger({
        lane: opts.lane, model: opts.model, ms: a.res.ms, tokensIn: a.res.tokensIn, tokensOut: a.res.tokensOut,
        status: a.res.estimated ? "ok(est)" : "ok",
      });
      writeRaw(opts.lane, key, a.res.text);
      if (!opts.noCache) {
        try {
          mkdirSync(join(TMP, "cache"), { recursive: true });
          const tmp = `${cachePath}.${process.pid}.tmp`;
          writeFileSync(tmp, JSON.stringify(a.res));
          renameSync(tmp, cachePath);
        } catch {
          // cache is best-effort
        }
      }
      return a.res;
    }
    lastErr = a.error;
    if (a.is429) on429();
    modelFail(opts.model);
    logger({
      lane: opts.lane, model: opts.model, ms: Date.now() - t0, tokensIn: 0, tokensOut: 0,
      status: `retry ${i + 1}/${tries}: ${a.error.replace(/\s+/g, " ").slice(0, 120)}`,
    });
    if (modelBenchedUntil(opts.model) > Date.now()) break;
  }
  recordLane(opts.lane, false);
  account(opts.lane, opts.model, { ok: false, cached: false, in: 0, out: 0, estimated: false, ms: 0 });
  logger({ lane: opts.lane, model: opts.model, ms: 0, tokensIn: 0, tokensOut: 0, status: `FAILED ${lastErr.slice(0, 120)}` });
  throw new Error(lastErr || "ask failed");
}

function validate<T>(text: string, schema: Validator<T>): { ok: true; data: T } | { ok: false; error: string } {
  const j = extractJson(text);
  if (j === undefined) return { ok: false, error: "no JSON object found" };
  const p = schema.safeParse(j);
  if (!p.success) return { ok: false, error: p.error.message.replace(/\s+/g, " ").slice(0, 500) };
  return { ok: true, data: p.data };
}

/** Ask, parse + validate; one repair re-ask on bad output; null when the model never gets it right. */
export async function askJson<T>(
  opts: AskOpts,
  schema: Validator<T>,
): Promise<{ data: T; res: AskResult } | null> {
  let res: AskResult;
  try {
    res = await ask(opts);
  } catch {
    return null;
  }
  const first = validate(res.text, schema);
  if (first.ok) return { data: first.data, res };
  try {
    const res2 = await ask({
      ...opts,
      prompt: `${opts.prompt}\n\nYour previous output was not valid JSON for the schema: ${first.error}. Output ONLY the JSON.`,
    });
    const second = validate(res2.text, schema);
    if (second.ok) return { data: second.data, res: res2 };
  } catch {
    // fall through
  }
  return null;
}
