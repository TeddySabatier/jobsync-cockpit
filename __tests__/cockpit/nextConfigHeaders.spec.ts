// @vitest-environment node
import nextConfig from "../../next.config.mjs";

async function loadHeaders() {
  if (!nextConfig.headers) throw new Error("headers() is not defined");
  return nextConfig.headers();
}

// AC-37 (config part): order and values of the headers() output.
describe("next.config.mjs headers()", () => {
  it("global DENY entry first, then the scoped SAMEORIGIN entry only (CV and letter PDF)", async () => {
    const entries = await loadHeaders();
    expect(entries).toEqual([
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
        ],
      },
      {
        source: "/api/cockpit/:kind(files|letter)/:packageId",
        headers: [{ key: "X-Frame-Options", value: "SAMEORIGIN" }],
      },
    ]);
  });

  it("does not set a CSP in the config (the route handler owns it)", async () => {
    const entries = await loadHeaders();
    const keys = entries.flatMap((e) => e.headers.map((h) => h.key));
    expect(keys.some((k) => /content-security-policy/i.test(k))).toBe(
      false,
    );
  });
});

// The scoped source must match exactly the two PDF routes, evaluated the way
// Next evaluates header sources (its own path-to-regexp matcher).
describe("scoped SAMEORIGIN source pattern", () => {
  it("matches /api/cockpit/files/x and /api/cockpit/letter/x and nothing else", async () => {
    const { getPathMatch } = await import("next/dist/shared/lib/router/utils/path-match");
    const entries = await loadHeaders();
    const scoped = entries.find((e: { source: string }) => e.source !== "/(.*)");
    const match = getPathMatch(scoped!.source);
    for (const yes of ["/api/cockpit/files/x", "/api/cockpit/letter/x", "/api/cockpit/files/abc-123"]) {
      expect(match(yes), yes).not.toBe(false);
    }
    for (const no of [
      "/api/cockpit/files",
      "/api/cockpit/letter",
      "/api/cockpit/files/x/y",
      "/api/cockpit/gmail/connect",
      "/api/cockpit/gmail/callback",
      "/api/cockpit/filesx/x",
      "/api/cockpit/letters/x",
      "/api/cockpit/mcp",
      "/x/api/cockpit/files/x",
      "/dashboard/cockpit/files/x",
    ]) {
      expect(match(no), no).toBe(false);
    }
  });
});
