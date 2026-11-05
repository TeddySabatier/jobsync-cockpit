import { listToolNames } from "../support/cockpit-api";
import { expect, test } from "@playwright/test";

// Run with COCKPIT_E2E_FLAG_OFF=1 (server on 3739, COCKPIT_ENABLED=false).
// SPEC §1 P4, AC-13/21: no page, route, nav entry or MCP tool.
test.describe("cockpit flag off", () => {
  test("review pages render not-found and the nav entry is hidden", async ({ page }) => {
    for (const p of ["/dashboard/review", "/dashboard/review/settings", "/dashboard/review/some-id"]) {
      await page.goto(p);
      // The not-found UI renders and no review UI does. The HTTP status is
      // 200, not 404: review/loading.tsx flushes the shell before notFound()
      // runs (Next soft 404). Tracked as a finding in the PR (AC-13 wording).
      await expect(page.getByRole("heading", { name: "Not found" }), p).toBeVisible();
    }
    await page.goto("/dashboard");
    await expect(page.getByRole("link", { name: "Review", exact: true })).toHaveCount(0);
  });

  test("cockpit API routes return 404 and no data", async ({ request }) => {
    for (const p of [
      "/api/cockpit/files/some-id",
      "/api/cockpit/gmail/connect",
      "/api/cockpit/gmail/callback?state=x&code=y",
    ]) {
      const res = await request.get(p, { maxRedirects: 0 });
      expect(res.status(), p).toBe(404);
      expect((await res.body()).length, p).toBe(0);
    }
  });

  test("cockpit MCP tools are not registered; the upstream ones are", async ({ baseURL }) => {
    const names = await listToolNames(baseURL as string);
    expect(names).toContain("add_job");
    for (const n of [
      "attach_file",
      "submit_application_package",
      "list_jobs",
      "get_job",
      "list_change_requests",
      "mark_change_request_done",
    ]) {
      expect(names).not.toContain(n);
    }
  });
});
