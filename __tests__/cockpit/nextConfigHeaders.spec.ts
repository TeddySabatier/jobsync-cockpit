// @vitest-environment node
import nextConfig from "../../next.config.mjs";

async function loadHeaders() {
  if (!nextConfig.headers) throw new Error("headers() is not defined");
  return nextConfig.headers();
}

// AC-37 (config part): order and values of the headers() output.
describe("next.config.mjs headers()", () => {
  it("global DENY entry first, then the scoped SAMEORIGIN entries only (CV and letter PDF)", async () => {
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
        source: "/api/cockpit/files/:packageId",
        headers: [{ key: "X-Frame-Options", value: "SAMEORIGIN" }],
      },
      {
        source: "/api/cockpit/letter/:packageId",
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
