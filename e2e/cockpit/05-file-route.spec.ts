import { expect, test } from "../support/cockpit-fixtures";

// SPEC §4, AC-16/37, D-011. Real response headers of the file route.
test.describe("file route", () => {
  test("authenticated: one X-Frame-Options SAMEORIGIN, sandbox CSP, nosniff, generated name", async ({
    request,
    bot,
  }) => {
    const pkg = await bot.seed();
    const res = await request.get(`/api/cockpit/files/${pkg.packageId}`);
    expect(res.status()).toBe(200);
    const h = res.headersArray();
    const all = (name: string) => h.filter((x) => x.name.toLowerCase() === name).map((x) => x.value);

    expect(all("x-frame-options")).toEqual(["SAMEORIGIN"]);
    const csp = all("content-security-policy");
    expect(csp).toHaveLength(1);
    expect(csp[0]).toContain("sandbox");
    expect(csp[0]).toContain("frame-ancestors 'self'");
    expect(all("x-content-type-options")).toEqual(["nosniff"]);
    expect(all("content-type")[0]).toContain("application/pdf");
    // Generated <uuid>.pdf name, never the stored fileName.
    const cd = all("content-disposition")[0];
    expect(cd).toMatch(/^inline; filename="[0-9a-f-]{36}\.pdf"$/);
    expect(cd).not.toContain("jane-doe-cv");
    const body = await res.body();
    expect(body.subarray(0, 5).toString()).toBe("%PDF-");
  });

  test("other routes keep the global X-Frame-Options: DENY", async ({ request }) => {
    const res = await request.get("/dashboard/review");
    const xfo = res.headersArray().filter((x) => x.name.toLowerCase() === "x-frame-options");
    expect(xfo.map((x) => x.value)).toEqual(["DENY"]);
  });

  test("unknown package id: 404 with an empty body", async ({ request }) => {
    const res = await request.get("/api/cockpit/files/does-not-exist");
    expect(res.status()).toBe(404);
    expect((await res.body()).length).toBe(0);
  });

  test("package without a CV file: 404", async ({ request, bot }) => {
    const pkg = await bot.seed({ noCv: true });
    expect((await request.get(`/api/cockpit/files/${pkg.packageId}`)).status()).toBe(404);
  });

  test("unauthenticated: 307 to /signin and no file data (D-011)", async ({ playwright, baseURL, bot }) => {
    const pkg = await bot.seed();
    const anon = await playwright.request.newContext({ baseURL, storageState: undefined });
    const res = await anon.get(`/api/cockpit/files/${pkg.packageId}`, { maxRedirects: 0 });
    expect(res.status()).toBe(307);
    expect(res.headers()["location"]).toContain("/signin");
    expect((await res.body()).toString()).not.toContain("%PDF");
    await anon.dispose();
  });
});
