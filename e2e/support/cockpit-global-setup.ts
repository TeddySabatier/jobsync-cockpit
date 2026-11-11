import { chromium, expect, type FullConfig } from "@playwright/test";
import fs from "fs";
import { attachPdf, connectGmail, CV_FILE_NAME, cvPdf, listToolNames, seedPackage } from "./cockpit-api";
import { resetFake } from "./fake-google-control";

// Logs in once (storage state), picks up the seeded bot MCP token, and, with the flag on,
// connects Gmail through the real routes and attaches one shared CV PDF.
// The attach_file bucket allows only 30 calls/hour, hence one shared file.
export default async function globalSetup(config: FullConfig) {
  const use = config.projects[0].use;
  const baseURL = use.baseURL as string;
  const statePath = use.storageState as string;
  const flagOff = process.env.COCKPIT_E2E_FLAG_OFF === "1";

  const browser = await chromium.launch();
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();
  page.setDefaultTimeout(90_000);

  await page.goto("/");
  await page.getByPlaceholder("id@example.com").fill("admin@example.com");
  await page.getByRole("textbox", { name: "Password" }).fill("password123");
  await page.getByRole("button", { name: "Login" }).click();
  await expect(page).toHaveURL(baseURL + "/dashboard", { timeout: 90_000 });

  // Seeded by cockpit-server.mjs (the Settings UI flow hangs under next dev).
  const token = fs
    .readFileSync(`.cockpit-tmp/e2e-mcp-token-${new URL(baseURL).port}.txt`, "utf8")
    .trim();
  expect(token).toMatch(/^jsync_/);
  process.env.E2E_MCP_TOKEN = token;
  // The seeded token lives 24 h; a server kept up longer (reuseExistingServer)
  // would otherwise fail every spec with an unexplained 401.
  await listToolNames(baseURL).catch((e) => {
    throw new Error(
      `The seeded MCP token was rejected (expired after 24 h, or the server is not the one that wrote it): stop the server on port ${new URL(baseURL).port} and rerun. ${e}`,
    );
  });

  if (!flagOff) {
    // Warm the dev compiler for the pages the specs hit first.
    await page.goto("/dashboard/review");
    await page.goto("/dashboard/review/settings");
    const res = await connectGmail(context.request);
    expect(res.location).toContain("connected=1");
    process.env.E2E_CV_FILE_ID = await attachPdf(baseURL, CV_FILE_NAME, cvPdf());
    // First compile of the detail route takes longer than an expect timeout.
    const warm = await seedPackage(baseURL, {});
    await page.goto(`/dashboard/review/${warm.packageId}`);
  }

  await context.storageState({ path: statePath });
  await browser.close();
  resetFake();
  fs.mkdirSync(".cockpit-tmp/shots", { recursive: true });
  fs.mkdirSync(".cockpit-tmp/findings", { recursive: true });
}
