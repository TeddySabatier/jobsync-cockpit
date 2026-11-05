import fs from "fs";
import { chromium, type BrowserContext, type Frame, type Page } from "@playwright/test";
import { attachPdf } from "../support/cockpit-api";
import { makePdf } from "../support/pdf";
import { detailUrl, expect, test } from "../support/cockpit-fixtures";

// AC-30 / SPEC §11: does Chromium's PDF viewer render a PDF served with
// `Content-Security-Policy: sandbox; frame-ancestors 'self'` inside our
// <iframe>? The result is recorded either way (the CSP is NOT changed). A
// control run strips the CSP from the response inside the test's own browser
// (page.route) to show whether the sandbox is the cause.
const MARKER = "PDF-IFRAME-MARKER-42";
const SHOT_DIR = ".cockpit-tmp/shots";
const OUT = ".cockpit-tmp/findings/l9-pdf-iframe.json";

// Not "load": the PDF frame may never finish loading under the sandbox CSP.
async function openDetail(page: Page, id: string) {
  await page.goto(detailUrl(id), { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("panel-email")).toBeVisible();
}

// locator.count() on a sandboxed PDF-viewer frame can hang forever (no timeout option).
const orDefault = <T>(p: Promise<T>, fallback: T, ms = 5000) =>
  Promise.race([p.catch(() => fallback), new Promise<T>((r) => setTimeout(() => r(fallback), ms))]);

async function inspect(page: Page) {
  // Give the viewer time to boot.
  await page.waitForTimeout(4000);
  const iframe = page.locator('iframe[title="CV PDF"]');
  await expect(iframe).toBeVisible();
  const frames = page.frames().filter((f) => f !== page.mainFrame());
  const info = await Promise.all(
    frames.map(async (f: Frame) => ({
      url: f.url().slice(0, 120),
      hasEmbed: await orDefault(f.locator("embed, pdf-viewer, #viewer").count(), -1),
      text: (await orDefault(f.locator("body").innerText({ timeout: 2000 }), "")).slice(0, 200),
    })),
  );
  return info;
}

test("PDF inside the review iframe under the sandbox CSP (result recorded)", async ({ bot, baseURL }) => {
  test.skip(
    !process.env.COCKPIT_E2E_PDF,
    "AC-30 probe: needs full Chromium with the PDF viewer; run with COCKPIT_E2E_PDF=1. Manual check in HANDOFF §4.",
  );
  test.setTimeout(180_000);
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const pdf = makePdf(MARKER);
  const fileId = await attachPdf(baseURL as string, "pdf-iframe-check.pdf", pdf);
  const pkg = await bot.seed({ cvFileId: fileId });

  // The full Chromium build (new headless) ships the PDF viewer; the default
  // headless shell does not. Full Chromium fails to start when TMPDIR is a long
  // path (profile socket path limit), so keep TMPDIR short. Falls back to the
  // shell and records launchError in the findings file.
  const state = JSON.parse(fs.readFileSync(".cockpit-tmp/e2e-auth-3738.json", "utf8"));
  const profile = ".cockpit-tmp/pw-profile"; // persistent context: cookies are added below
  fs.rmSync(profile, { recursive: true, force: true });
  let build = "chromium (full, new headless)";
  let launchError: string | undefined;
  let ctx: BrowserContext;
  try {
    ctx = await chromium.launchPersistentContext(profile, {
      channel: "chromium",
      baseURL,
      viewport: { width: 1280, height: 900 },
      timeout: 120_000,
    });
  } catch (e) {
    launchError = String(e).slice(0, 300);
    build = "chromium headless shell (no PDF viewer plugin)";
    const browser = await chromium.launch();
    ctx = await browser.newContext({ baseURL, viewport: { width: 1280, height: 900 } });
  }
  await ctx.addCookies(state.cookies);

  const result: Record<string, unknown> = { build, launchError, marker: MARKER };
  try {
    const page = await ctx.newPage();
    let fileHeaders: Record<string, string> = {};
    const served = page.waitForResponse((r) => r.url().includes(`/api/cockpit/files/${pkg.packageId}`));
    await openDetail(page, pkg.packageId);
    fileHeaders = await (await served).allHeaders();
    result.asServed = {
      status: "iframe loaded",
      csp: fileHeaders["content-security-policy"],
      xfo: fileHeaders["x-frame-options"],
      frames: await inspect(page),
    };
    await page.locator('iframe[title="CV PDF"]').screenshot({ path: `${SHOT_DIR}/pdf-iframe.png` });

    // Control: same page, CSP removed from the response by the test browser.
    const page2 = await ctx.newPage();
    await page2.route(`**/api/cockpit/files/${pkg.packageId}`, async (route) => {
      const resp = await route.fetch();
      const headers = { ...resp.headers() };
      delete headers["content-security-policy"];
      await route.fulfill({ response: resp, headers });
    });
    await openDetail(page2, pkg.packageId);
    result.cspStrippedControl = { frames: await inspect(page2) };
    await page2.locator('iframe[title="CV PDF"]').screenshot({ path: `${SHOT_DIR}/pdf-iframe-control-no-csp.png` });
  } finally {
    await ctx.browser()?.close();
    await ctx.close().catch(() => {});
  }

  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  const asServed = result.asServed as { csp?: string; xfo?: string };
  expect(asServed.csp).toContain("sandbox");
  expect(asServed.xfo).toBe("SAMEORIGIN");
});
