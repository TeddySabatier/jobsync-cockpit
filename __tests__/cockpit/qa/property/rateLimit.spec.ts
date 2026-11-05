// @vitest-environment node
import fc from "fast-check";
import { checkMcpRateLimit } from "@/lib/mcp/rate-limit";
import { APP_CONSTANTS } from "@/lib/constants";
import { fcParams, tag } from "./_fc";

// Property 6 (AC-50): fixed-window counter. The store is module state, so every
// run uses its own user-id prefix.
const CFGS = [
  undefined,
  { bucket: "x", max: 3, windowMs: 1_000 },
  { bucket: "y", max: 1, windowMs: 50 },
  { bucket: "z", max: 7, windowMs: 10_000 },
] as const;

type Op = { t: "call"; u: number; c: number } | { t: "adv"; ms: number };
const op: fc.Arbitrary<Op> = fc.oneof(
  { weight: 4, arbitrary: fc.record({ t: fc.constant("call" as const), u: fc.integer({ min: 0, max: 2 }), c: fc.integer({ min: 0, max: 3 }) }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant("adv" as const), ms: fc.integer({ min: 0, max: 25_000 }) }) },
);

let run = 0;
afterEach(() => vi.useRealTimers());

describe(tag("checkMcpRateLimit properties"), () => {
  it("never allows more than max per window, for any interleaving of calls and time", () => {
    fc.assert(
      fc.property(fc.array(op, { maxLength: 120 }), (ops) => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-11-04T12:00:00Z"));
        const prefix = `prop${++run}-`;
        const allowedAt = new Map<string, number[]>();
        const model = new Map<string, { count: number; reset: number }>();

        for (const o of ops) {
          if (o.t === "adv") {
            vi.advanceTimersByTime(o.ms);
            continue;
          }
          const cfg = CFGS[o.c];
          const user = `${prefix}${o.u}`;
          const key = cfg ? `${user}:${cfg.bucket}` : user;
          const max = cfg?.max ?? APP_CONSTANTS.MCP_RATE_LIMIT_MAX;
          const win = cfg?.windowMs ?? APP_CONSTANTS.MCP_RATE_LIMIT_WINDOW_MS;
          const now = Date.now();
          const res = checkMcpRateLimit(user, cfg);

          expect(res.remaining).toBeGreaterThanOrEqual(0);
          expect(res.remaining).toBeLessThanOrEqual(max - 1);
          expect(res.resetIn).toBeLessThanOrEqual(win);

          // Reference fixed-window model.
          const e = model.get(key);
          let expected: typeof res;
          if (!e || now > e.reset) {
            model.set(key, { count: 1, reset: now + win });
            expected = { allowed: true, remaining: max - 1, resetIn: win };
          } else if (e.count >= max) {
            expected = { allowed: false, remaining: 0, resetIn: e.reset - now };
          } else {
            e.count++;
            expected = { allowed: true, remaining: max - e.count, resetIn: e.reset - now };
          }
          expect(res).toEqual(expected);

          if (res.allowed) {
            const list = allowedAt.get(key) ?? [];
            list.push(now);
            allowedAt.set(key, list);
          }
        }

        // Independent bound: an interval of one window touches at most two
        // fixed windows, so at most 2*max calls pass in any such interval.
        for (const [key, times] of allowedAt) {
          const cfg = CFGS.find((c) => c && key.endsWith(`:${c.bucket}`));
          const max = cfg?.max ?? APP_CONSTANTS.MCP_RATE_LIMIT_MAX;
          const win = cfg?.windowMs ?? APP_CONSTANTS.MCP_RATE_LIMIT_WINDOW_MS;
          for (let i = 0; i < times.length; i++) {
            const inWin = times.filter((t) => t >= times[i] && t <= times[i] + win).length;
            expect(inWin).toBeLessThanOrEqual(2 * max);
          }
        }
        vi.useRealTimers();
      }),
      fcParams(),
    );
  });

  it("expired entries are cleaned past the 500-key threshold without changing behaviour", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-04T12:00:00Z"));
    const opts = { bucket: "mem", max: 1, windowMs: 10 };
    for (let i = 0; i < 700; i++) expect(checkMcpRateLimit(`mem-${i}`, opts).allowed).toBe(true);
    expect(checkMcpRateLimit("mem-0", opts).allowed).toBe(false);
    vi.advanceTimersByTime(20);
    // Triggers the sweep; every key is a fresh window afterwards.
    for (let i = 0; i < 700; i++) {
      expect(checkMcpRateLimit(`mem-${i}`, opts)).toMatchObject({ allowed: true, remaining: 0 });
    }
  });
});
