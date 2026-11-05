import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import {
  ask, askJson, benchModel, unbenchAll, flushBudget, getLast429, killAll, laneBlockedUntil,
  modelBenchedUntil, setConcurrency, spentTokens,
} from "./ask.ts";
import { ROOT, TMP, headFile, splitLines } from "./git.ts";
import { AttackSchema, LANES, buildReviewPrompt, buildVerifyPrompt, laneApplies } from "./lenses.ts";
import { contextPack, listSurface, makeShards } from "./shard.ts";
import type { Shard } from "./shard.ts";
import { FindingSchema, VerdictSchema, dedupeKey, mechanicalCheck } from "./verify.ts";
import type { Finding, Verdict } from "./verify.ts";

// ---------- paths / small helpers ----------
const CONFIG_PATH = join(TMP, "engine-config.json");
const FIND_DIR = join(TMP, "findings");
const INDEX_PATH = join(FIND_DIR, "index.json");
const STATS_PATH = join(FIND_DIR, "stats.json");
const EVENTS_PATH = join(FIND_DIR, "events.jsonl");
const CONFIRMED_PATH = join(FIND_DIR, "confirmed.jsonl");
const ROUND_PATH = join(TMP, "engine-round.txt");
const AUTO = "freellmapi/auto";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const iso = () => new Date().toISOString();
const log = (msg: string) => console.log(`${iso()} ENGINE ${msg}`);
const slug = (s: string) => s.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "");

function writeJsonAtomic(path: string, v: unknown): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(v, null, 2));
  renameSync(tmp, path);
}
function appendJsonl(path: string, v: unknown): void {
  appendFileSync(path, JSON.stringify(v) + "\n");
}
function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

// ---------- config (hot reloaded) ----------
type Config = {
  targetTokens: number;
  deadline: string;
  models: string[];
  reviewerModels: string[];
  concurrency: number;
  maxConcurrency: number;
  laneWeights: Record<string, number>;
  shardSizes: number[];
  extraGlobs: string[];
  pausedLanes: string[];
};
const NAMED_MODELS = [
  "freellmapi/gemini-3.8-flash",
  "freellmapi/gpt-oss-120b",
  "freellmapi/qwen-3.8-27b",
  "freellmapi/nemotron-3-super-120b",
  "freellmapi/gemma-4-31b-it",
  "freellmapi/glm-4.7-flash",
  "freellmapi/command-a-2",
  "freellmapi/llama-3.3-70b-fp8-fast",
  "freellmapi/gemini-2.5-flash",
];
function defaultConfig(): Config {
  return {
    targetTokens: 100_000_000,
    deadline: new Date(Date.now() + 24 * 3_600_000).toISOString(),
    models: [AUTO, ...NAMED_MODELS],
    reviewerModels: [AUTO, ...NAMED_MODELS.slice(0, 5)],
    concurrency: 12,
    maxConcurrency: 24,
    laneWeights: { L1: 16, L2: 10, L3: 6, L4: 6, L6: 6, L7: 8, L10: 10 },
    shardSizes: [350, 200, 120, 600, 800],
    extraGlobs: [],
    pausedLanes: [],
  };
}
let lastGoodConfig: Config | undefined;
function loadConfig(): Config {
  if (!existsSync(CONFIG_PATH)) writeJsonAtomic(CONFIG_PATH, defaultConfig());
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Partial<Config>;
    lastGoodConfig = { ...defaultConfig(), ...raw };
  } catch (e) {
    log(`config unreadable, keeping previous: ${String(e)}`);
  }
  return lastGoodConfig ?? defaultConfig();
}

// ---------- args ----------
const argv = process.argv.slice(2);
const flagVal = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const DRY = flagVal("--dry-run") !== undefined ? Math.max(1, Number(flagVal("--dry-run")) || 1) : 0;
const ONLY_LANES = flagVal("--lanes")?.split(",").map((s) => s.trim()).filter(Boolean);

// ---------- state ----------
type Entry = {
  finding: Finding;
  votes: number[];
  models: string[];
  firstSeen: string;
  state: "new" | "confirmed-by-review" | "refuted" | "unclear";
  verdicts: Array<{ model: string; verdict: string; reasoning: string }>;
  verified: boolean;
};
type LaneStats = {
  jobs: number; failedJobs: number; findings: number; valid: number; invalid: number;
  invalidRate: number; reasons: Record<string, number>; attacks: number;
};
let cfg: Config;
let stopping = false;
let inflight = 0;
let started = 0;
let round = Number(readJson<number | string>(ROUND_PATH, 0)) || 0;
const index = new Map<string, Entry>(Object.entries(readJson<Record<string, Entry>>(INDEX_PATH, {})));
const stats: { lanes: Record<string, LaneStats> } = readJson(STATS_PATH, { lanes: {} });
const reviewQ: Job[] = [];
const verifyQ: Array<() => Promise<void>> = [];
let reviewerIdx = 0;
let verifierIdx = 0;

type Job = { lane: string; shard: Shard; seed: number };

function persist(): void {
  writeJsonAtomic(INDEX_PATH, Object.fromEntries(index));
  for (const s of Object.values(stats.lanes)) s.invalidRate = s.findings ? +(s.invalid / s.findings).toFixed(3) : 0;
  writeJsonAtomic(STATS_PATH, stats);
}
const laneStats = (lane: string): LaneStats =>
  (stats.lanes[lane] ??= { jobs: 0, failedJobs: 0, findings: 0, valid: 0, invalid: 0, invalidRate: 0, reasons: {}, attacks: 0 });

const healthy = (m: string) => modelBenchedUntil(m) <= Date.now();

// ---------- rounds ----------
function activeLanes(c: Config): string[] {
  const base = ONLY_LANES ?? Object.keys(c.laneWeights);
  return base.filter((l) => LANES.includes(l) && !c.pausedLanes.includes(l));
}
function buildRound(r: number, c: Config): Job[] {
  const size = c.shardSizes[r % c.shardSizes.length];
  const shards = makeShards(listSurface(c.extraGlobs), size, r);
  const lanes = activeLanes(c);
  const maxW = Math.max(1, ...lanes.map((l) => c.laneWeights[l] ?? 1));
  const jobs: Job[] = [];
  for (const shard of shards) {
    for (const lane of lanes) {
      if (!laneApplies(lane, shard.file)) continue;
      if (Math.random() < Math.min(1, (c.laneWeights[lane] ?? 1) / maxW)) jobs.push({ lane, shard, seed: r });
    }
  }
  for (let i = jobs.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [jobs[i], jobs[j]] = [jobs[j], jobs[i]];
  }
  return jobs;
}
let emptyRounds = 0;
function refill(): void {
  const need = DRY ? DRY : 3 * cfg.concurrency;
  while (reviewQ.length < need && !stopping) {
    const jobs = buildRound(round, cfg);
    log(`round ${round}: ${jobs.length} jobs (shard size ${cfg.shardSizes[round % cfg.shardSizes.length]})`);
    round++;
    writeFileSync(ROUND_PATH, String(round));
    if (!jobs.length) {
      if (++emptyRounds >= 3) return;
      continue;
    }
    emptyRounds = 0;
    reviewQ.push(...jobs);
    if (DRY) {
      reviewQ.length = Math.min(reviewQ.length, DRY);
      return;
    }
  }
}
function nextReview(): Job | undefined {
  if (DRY && started >= DRY) return undefined;
  const i = reviewQ.findIndex(
    (j) => laneBlockedUntil(j.lane) <= Date.now() && !cfg.pausedLanes.includes(j.lane),
  );
  if (i < 0) return undefined;
  started++;
  return reviewQ.splice(i, 1)[0];
}

// ---------- findings ----------
function event(key: string, state: string, extra: Record<string, unknown> = {}): void {
  appendJsonl(EVENTS_PATH, { ts: iso(), key, state, ...extra });
}

const ReviewOut = z.object({ findings: z.array(z.unknown()).default([]) });
const AttackOut = z.object({
  attacks: z.array(z.unknown()).default([]),
  findings: z.array(z.unknown()).default([]),
});

function pickReviewer(): string | undefined {
  const pool = cfg.reviewerModels.filter(healthy);
  return pool.length ? pool[reviewerIdx++ % pool.length] : undefined;
}
function pickVerifier(exclude: string[]): string | undefined {
  const pool = [...new Set([...cfg.models, ...cfg.reviewerModels])].filter(
    (m) => m !== AUTO && !exclude.includes(m) && healthy(m),
  );
  return pool.length ? pool[verifierIdx++ % pool.length] : undefined;
}

function codeAround(f: Finding): string {
  const content = headFile(ROOT, f.file);
  if (content === null) return "";
  const lines = splitLines(content);
  const lo = Math.max(1, f.startLine - 40);
  const hi = Math.min(lines.length, f.endLine + 40);
  return lines.slice(lo - 1, hi).map((l, i) => `${lo + i}| ${l}`).join("\n");
}

async function runVerify(key: string, e: Entry, reviewer: string): Promise<void> {
  const f = e.finding;
  const prompt = (() => {
    try {
      return buildVerifyPrompt(f, codeAround(f));
    } catch (err) {
      log(`verify prompt refused for ${f.file}: ${String(err)}`);
      return undefined;
    }
  })();
  const tests: Array<string | undefined> = [];
  const finish = (state: Entry["state"]) => {
    e.state = state;
    event(key, state, { verdicts: e.verdicts });
    if (state === "confirmed-by-review") {
      appendJsonl(CONFIRMED_PATH, { ts: iso(), key, finding: f, verdicts: e.verdicts, test: tests.find(Boolean) });
    }
    persist();
  };
  if (!prompt) return finish("unclear");

  const used = [reviewer];
  for (let n = 0; n < 2; n++) {
    const v = pickVerifier(used);
    if (!v) return finish("unclear");
    used.push(v);
    const out = await askJson({ lane: `${f.lens}-verify`, model: v, prompt, timeoutMs: 240_000 }, VerdictSchema);
    const verdict: Verdict | undefined = out?.data;
    if (!verdict) return finish("unclear");
    e.verdicts.push({ model: v, verdict: verdict.verdict, reasoning: verdict.reasoning });
    tests.push(verdict.test);
    if (verdict.verdict === "refuted") return finish("refuted");
    if (verdict.verdict !== "confirmed") return finish("unclear");
  }
  finish("confirmed-by-review");
}

function maybeVerify(key: string, e: Entry, reviewer: string): void {
  if (e.verified) return;
  const sev = e.finding.severity;
  if (sev === "P0" || sev === "P1" || (sev === "P2" && e.votes.length >= 2)) {
    e.verified = true;
    verifyQ.push(() => runVerify(key, e, reviewer));
  }
}

function handleFindings(raw: unknown[], job: Job, model: string): void {
  const st = laneStats(job.lane);
  for (const r of raw.slice(0, 8)) {
    st.findings++;
    const p = FindingSchema.safeParse(r);
    let reason = "";
    let f: Finding | undefined;
    if (!p.success) reason = "schema";
    else {
      f = { ...p.data, lens: job.lane };
      if (!f.id) f.id = createHash("sha1").update(f.file + f.quote + f.claim).digest("hex").slice(0, 10);
      if (f.file !== job.shard.file) reason = "file-mismatch";
      else {
        const c = mechanicalCheck(f, ROOT);
        if (!c.ok) reason = c.reason;
      }
    }
    if (reason || !f) {
      st.invalid++;
      st.reasons[reason] = (st.reasons[reason] ?? 0) + 1;
      continue;
    }
    st.valid++;
    const key = dedupeKey(f);
    let e = index.get(key);
    if (!e) {
      e = { finding: f, votes: [job.seed], models: [model], firstSeen: iso(), state: "new", verdicts: [], verified: false };
      index.set(key, e);
      event(key, "new", { severity: f.severity, file: f.file, model });
    } else {
      if (!e.votes.includes(job.seed)) e.votes.push(job.seed);
      if (!e.models.includes(model)) e.models.push(model);
    }
    maybeVerify(key, e, model);
  }
}

async function runReview(job: Job): Promise<void> {
  const st = laneStats(job.lane);
  st.jobs++;
  const model = pickReviewer();
  if (!model) {
    st.failedJobs++;
    // whole pool benched usually means the OpenCode service blipped, not that every model died
    log("no healthy reviewer model, sleeping 60s then unbenching all");
    await sleep(60_000);
    unbenchAll();
    return;
  }
  let prompt: string;
  try {
    prompt = buildReviewPrompt(job.lane, job.shard, contextPack(job.shard.file), job.seed);
  } catch (err) {
    st.failedJobs++;
    log(`skip ${job.shard.id} ${job.lane}: ${String(err)}`);
    return;
  }
  const isAttack = job.lane === "L10";
  const out = isAttack
    ? await askJson({ lane: job.lane, model, prompt, timeoutMs: 240_000 }, AttackOut)
    : await askJson({ lane: job.lane, model, prompt, timeoutMs: 240_000 }, ReviewOut);
  if (!out) {
    st.failedJobs++;
    persist();
    return;
  }
  const data = out.data as { findings: unknown[]; attacks?: unknown[] };
  if (isAttack && data.attacks) {
    mkdirSync(join(TMP, "attacks"), { recursive: true });
    for (const a of data.attacks.slice(0, 15)) {
      const p = AttackSchema.safeParse(a);
      if (!p.success) continue;
      st.attacks++;
      appendJsonl(join(TMP, "attacks", `${job.lane}-${slug(job.shard.file)}.jsonl`), {
        ts: iso(), seed: job.seed, model, shard: job.shard.id, ...p.data,
      });
    }
  }
  handleFindings(data.findings, job, model);
  persist();
}

// ---------- workers ----------
const drained = () => DRY > 0 && started >= DRY && inflight === 0 && verifyQ.length === 0;

async function worker(): Promise<void> {
  while (!stopping) {
    const verify = verifyQ.shift();
    let task: (() => Promise<void>) | undefined = verify;
    if (!task) {
      const job = nextReview();
      if (job) task = () => runReview(job);
    }
    if (!task) {
      if (drained()) return;
      await sleep(300);
      continue;
    }
    inflight++;
    try {
      await task();
    } catch (err) {
      log(`task error: ${String(err)}`);
    } finally {
      inflight--;
    }
  }
}

// ---------- probe ----------
async function probeAll(c: Config): Promise<void> {
  const models = [...new Set([...c.models, ...c.reviewerModels])];
  await Promise.all(
    models.map(async (m) => {
      try {
        const r = await ask({ lane: "probe", model: m, prompt: 'Reply with exactly {"ok":true}', timeoutMs: 60_000, noCache: true, maxTries: 2 });
        if (!/ok/i.test(r.text)) throw new Error(`unexpected reply ${r.text.slice(0, 60)}`);
        log(`probe OK ${m} ${r.ms}ms in=${r.tokensIn} out=${r.tokensOut}`);
      } catch (err) {
        benchModel(m, 30 * 60_000);
        log(`probe FAIL ${m}: ${String(err).slice(0, 160)} (benched 30min)`);
      }
    }),
  );
}

// ---------- pacing ----------
let lastPace = { t: Date.now(), spent: spentTokens() };
let appliedConcurrency = -1;
function applyConcurrency(c: Config): void {
  if (c.concurrency !== appliedConcurrency) {
    setConcurrency(c.concurrency, c.maxConcurrency);
    appliedConcurrency = c.concurrency;
  }
}
function pace(): void {
  cfg = loadConfig();
  const spent = spentTokens();
  const hoursLeft = Math.max(0.01, (Date.parse(cfg.deadline) - Date.now()) / 3_600_000);
  const needed = Math.max(0, (cfg.targetTokens - spent) / hoursLeft);
  const actual = (spent - lastPace.spent) / Math.max(1e-6, (Date.now() - lastPace.t) / 3_600_000);
  lastPace = { t: Date.now(), spent };
  let note = "";
  if (actual < needed && Date.now() - getLast429() > 300_000 && cfg.concurrency < cfg.maxConcurrency) {
    cfg.concurrency = Math.min(cfg.maxConcurrency, cfg.concurrency + 2);
    writeJsonAtomic(CONFIG_PATH, cfg);
    note = ` -> concurrency raised to ${cfg.concurrency}`;
  }
  applyConcurrency(cfg);
  log(`pace spent=${spent} target=${cfg.targetTokens} needed/h=${Math.round(needed)} actual/h=${Math.round(actual)}${note}`);
}

// ---------- main ----------
async function main(): Promise<void> {
  for (const d of [TMP, FIND_DIR, join(TMP, "logs"), join(TMP, "attacks")]) mkdirSync(d, { recursive: true });
  writeFileSync(join(TMP, "engine.pid"), String(process.pid));
  const beat = () => writeFileSync(join(TMP, "heartbeat"), String(Math.floor(Date.now() / 1000)));
  beat();
  const hb = setInterval(beat, 30_000);
  const stop = () => {
    if (!stopping) log("stop requested, finishing in-flight work");
    stopping = true;
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);

  cfg = loadConfig();
  applyConcurrency(cfg);
  log(`start pid=${process.pid} dry=${DRY || "no"} lanes=${ONLY_LANES?.join(",") ?? "all"} round=${round}`);
  await probeAll(cfg);

  const workers = Array.from({ length: cfg.maxConcurrency }, () => worker());
  let lastPaceTick = Date.now();
  const allDone = Promise.all(workers);
  let finished = false;
  void allDone.then(() => (finished = true));

  while (!stopping && !finished) {
    if (!DRY && Date.now() > Date.parse(cfg.deadline)) {
      log("deadline reached");
      break;
    }
    if (!DRY && Date.now() - lastPaceTick > 300_000) {
      pace();
      lastPaceTick = Date.now();
    }
    if (!DRY || (started === 0 && reviewQ.length === 0)) {
      cfg = loadConfig();
      applyConcurrency(cfg);
      refill();
    }
    await sleep(DRY ? 1000 : 2000);
  }

  stopping = true;
  await Promise.race([allDone, sleep(25_000)]);
  killAll();
  clearInterval(hb);
  persist();
  flushBudget();
  rmSync(join(TMP, "engine.pid"), { force: true });
  log(`done spent=${spentTokens()} findings=${index.size}`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  flushBudget();
  process.exit(1);
});
