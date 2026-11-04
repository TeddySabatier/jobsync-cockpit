// @vitest-environment node
import { checkMcpRateLimit } from "@/lib/mcp/rate-limit";
import { APP_CONSTANTS } from "@/lib/constants";
import { COCKPIT_RATE_LIMITS } from "@/lib/cockpit/config";

// The store is module-level state: every test uses its own user ids.
describe("checkMcpRateLimit extension (AC-50)", () => {
  it("without opts: 60 per hour on the plain userId key, as before", () => {
    expect(APP_CONSTANTS.MCP_RATE_LIMIT_MAX).toBe(60);
    const first = checkMcpRateLimit("rl-plain");
    expect(first).toEqual({
      allowed: true,
      remaining: APP_CONSTANTS.MCP_RATE_LIMIT_MAX - 1,
      resetIn: APP_CONSTANTS.MCP_RATE_LIMIT_WINDOW_MS,
    });
    for (let i = 1; i < APP_CONSTANTS.MCP_RATE_LIMIT_MAX; i++) {
      expect(checkMcpRateLimit("rl-plain").allowed).toBe(true);
    }
    expect(checkMcpRateLimit("rl-plain").allowed).toBe(false);
  });

  it("buckets are independent of the default key and of each other", () => {
    const opts = { bucket: "b1", max: 2, windowMs: 1000 };
    expect(checkMcpRateLimit("rl-b", opts).allowed).toBe(true);
    expect(checkMcpRateLimit("rl-b", opts).allowed).toBe(true);
    expect(checkMcpRateLimit("rl-b", opts).allowed).toBe(false);
    expect(checkMcpRateLimit("rl-b").allowed).toBe(true);
    expect(checkMcpRateLimit("rl-b", { ...opts, bucket: "b2" }).allowed).toBe(true);
    // Per user.
    expect(checkMcpRateLimit("rl-b-other", opts).allowed).toBe(true);
  });

  it("honours max and windowMs", () => {
    vi.useFakeTimers();
    try {
      const opts = { bucket: "w", max: 1, windowMs: 1000 };
      expect(checkMcpRateLimit("rl-w", opts)).toMatchObject({ allowed: true, remaining: 0, resetIn: 1000 });
      expect(checkMcpRateLimit("rl-w", opts).allowed).toBe(false);
      vi.advanceTimersByTime(1001);
      expect(checkMcpRateLimit("rl-w", opts).allowed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cockpit buckets: 120 per hour, attach 30 per hour", () => {
    expect(COCKPIT_RATE_LIMITS.cockpit).toMatchObject({ bucket: "cockpit", max: 120 });
    expect(COCKPIT_RATE_LIMITS.attach).toMatchObject({ bucket: "cockpit-attach", max: 30 });

    for (let i = 0; i < 30; i++) {
      expect(checkMcpRateLimit("rl-c", COCKPIT_RATE_LIMITS.attach).allowed).toBe(true);
    }
    expect(checkMcpRateLimit("rl-c", COCKPIT_RATE_LIMITS.attach).allowed).toBe(false);

    for (let i = 0; i < 120; i++) {
      expect(checkMcpRateLimit("rl-c", COCKPIT_RATE_LIMITS.cockpit).allowed).toBe(true);
    }
    expect(checkMcpRateLimit("rl-c", COCKPIT_RATE_LIMITS.cockpit).allowed).toBe(false);
  });
});
