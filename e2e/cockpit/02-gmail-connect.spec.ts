import { connectGmail } from "../support/cockpit-api";
import { fakeLog } from "../support/fake-google-control";
import { expect, test } from "../support/cockpit-fixtures";

// SPEC §6.2, AC-22/23, D-010. The OAuth state cookie is unsigned JSON, so the
// real connect route is driven first (its redirect to Google is NOT followed)
// and the callback gets the state + a fake code the fake token endpoint turns
// into an unsigned id_token (the app does not verify signatures).
// Serial, and the afterAll below reconnects Gmail even when a test aborted
// after Disconnect: later specs (03/04/08) rely on a connected account.
test.describe.configure({ mode: "serial" });

test.afterAll(async ({ playwright }) => {
  // Test-scoped fixtures (baseURL, storageState) are not available here.
  const { baseURL, storageState } = test.info().project.use;
  const ctx = await playwright.request.newContext({ baseURL, storageState: storageState as string });
  const r = await connectGmail(ctx);
  await ctx.dispose();
  expect(r.location).toContain("connected=1");
});

const SETTINGS = "/dashboard/review/settings";

test.describe("Gmail connect", () => {
  test("connect route sets the state cookie and redirects to Google with the right params", async ({
    request,
  }) => {
    const res = await request.get("/api/cockpit/gmail/connect", { maxRedirects: 0 });
    expect(res.status()).toBe(302);
    const loc = new URL(res.headers()["location"]);
    expect(loc.origin + loc.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    const q = loc.searchParams;
    expect(q.get("scope")).toBe("https://www.googleapis.com/auth/gmail.send openid email");
    expect(q.get("code_challenge_method")).toBe("S256");
    expect(q.get("access_type")).toBe("offline");
    expect(q.get("prompt")).toBe("consent");
    expect(q.get("nonce")).toBeTruthy();
    expect(q.get("redirect_uri")).toMatch(/\/api\/cockpit\/gmail\/callback$/);

    const cookie = res
      .headersArray()
      .filter((h) => h.name.toLowerCase() === "set-cookie")
      .map((h) => h.value)
      .find((v) => v.startsWith("cockpit_gmail_oauth="));
    expect(cookie).toBeTruthy();
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=lax/i);
    expect(cookie).toMatch(/Path=\/api\/cockpit\/gmail/);
    expect(cookie).toMatch(/Max-Age=600/);
    expect(cookie).not.toMatch(/Secure/i); // redirect URI is http
    // Nothing was sent to Google.
    expect(fakeLog()).toHaveLength(0);
  });

  test("settings: disconnect, then connect again through the callback", async ({ page, request }) => {
    // ?connected=1 is still in the URL after the OAuth callback (review 07 finding 1).
    await page.goto(`${SETTINGS}?connected=1`);
    await expect(page.getByText("Connected as")).toBeVisible();
    await expect(page.getByText("you@example.com").first()).toBeVisible();

    await page.getByRole("button", { name: "Disconnect" }).click();
    // Disconnect asks first (finding 6): Cancel does nothing.
    await page.getByRole("alertdialog").getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByText("Connected as")).toBeVisible();
    await page.getByRole("button", { name: "Disconnect" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Disconnect" }).click();
    await expect(page.getByText("Gmail is not connected.")).toBeVisible();
    await expect(page.getByText("Gmail connected.")).toHaveCount(0);
    // Disconnect revokes (best effort) at the fake endpoint.
    await expect.poll(() => fakeLog().filter((e) => e.kind === "revoke").length).toBe(1);

    // Queue indicator reflects it.
    await page.goto("/dashboard/review");
    await expect(page.getByText("Gmail: not connected")).toBeVisible();

    const r = await connectGmail(request);
    expect(r.status).toBe(302);
    expect(r.location).toContain("connected=1");
    await page.goto(r.location.replace(/^https?:\/\/[^/]+/, ""));
    await expect(page.getByText("Gmail connected.")).toBeVisible();
    await expect(page.getByText("Connected as")).toBeVisible();
    await expect(page.getByText("https://www.googleapis.com/auth/gmail.send").first()).toBeVisible();

    // Token exchange hit only the fake, once; same-email reconnect revokes nothing (D-010).
    expect(fakeLog().filter((e) => e.kind === "token" && e.grant === "authorization_code")).toHaveLength(1);
    expect(fakeLog().filter((e) => e.kind === "revoke")).toHaveLength(1);
    expect(fakeLog().filter((e) => e.kind === "blocked")).toHaveLength(0);
  });

  // The fake validates what the app posts (PKCE verifier vs the challenge sent
  // to Google, client secret, redirect URI) and answers 400 otherwise, so the
  // connect above would already fail; this pins the exact fields and that
  // nothing was refused.
  test("token exchange sends PKCE, the client secret and the redirect URI (and the fake accepted them)", async ({ request }) => {
    const r = await connectGmail(request);
    expect(r.location).toContain("connected=1");
    const exchange = fakeLog().filter((e) => e.kind === "token" && e.grant === "authorization_code");
    expect(exchange).toHaveLength(1);
    expect(exchange[0].fields).toEqual(
      expect.arrayContaining(["code", "code_verifier", "client_id", "client_secret", "redirect_uri", "grant_type"]),
    );
    expect(exchange[0].status).toBe(200);
    expect(fakeLog().filter((e) => e.rejected)).toEqual([]);
  });

  const failures: Array<{
    name: string;
    spec: Parameters<typeof connectGmail>[1];
    state?: string;
    code: string;
    message: string;
  }> = [
    { name: "wrong state", spec: {}, state: "not-the-state", code: "invalid_state", message: "The Gmail connection attempt expired or was invalid." },
    { name: "foreign address", spec: { email: "someone@example.com" }, code: "address_not_allowed", message: "not the address allowed" },
    { name: "no refresh token", spec: { refreshToken: false }, code: "no_refresh_token", message: "did not return a refresh token" },
    { name: "unverified email", spec: { emailVerified: false }, code: "email_unverified", message: "not verified" },
    { name: "missing send scope", spec: { scope: "openid email" }, code: "missing_scope", message: "permission to send email was not granted" },
    { name: "wrong audience", spec: { aud: "other-client" }, code: "bad_id_token", message: "could not be verified" },
    { name: "expired id_token", spec: { expOffsetS: -60 }, code: "bad_id_token", message: "could not be verified" },
  ];

  for (const f of failures) {
    test(`callback rejects: ${f.name}`, async ({ page, request }) => {
      const r = await connectGmail(request, f.spec, f.state);
      expect(r.status).toBe(302);
      expect(r.location).toContain(`error=${f.code}`);
      await page.goto(r.location.replace(/^https?:\/\/[^/]+/, ""));
      await expect(page.getByRole("alert").filter({ hasText: f.message })).toBeVisible();
      // The existing connection survives a rejected attempt.
      await expect(page.getByText("Connected as")).toBeVisible();
    });
  }

  test("unknown ?error= value shows the generic message, never the raw value", async ({ page }) => {
    await page.goto(`${SETTINGS}?error=%3Cb%3Eevil%3C%2Fb%3E`);
    await expect(page.getByText("Gmail could not be connected.")).toBeVisible();
    await expect(page.getByText("evil")).toHaveCount(0);
  });

  test("callback without a state cookie is rejected", async ({ playwright, baseURL, storageState }) => {
    const ctx = await playwright.request.newContext({ baseURL, storageState: storageState as string });
    const res = await ctx.get("/api/cockpit/gmail/callback?state=x&code=y", { maxRedirects: 0 });
    expect(res.status()).toBe(302);
    expect(res.headers()["location"]).toContain("error=invalid_state");
    await ctx.dispose();
  });
});
