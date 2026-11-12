import { fakeLog, fakeSends, setFakeMode, type SendMode } from "../support/fake-google-control";
import type { Page } from "@playwright/test";
import { approve, expect, openDetail, openSendDialog, test, type Bot } from "../support/cockpit-fixtures";

// SPEC §6.4 step 5, AC-26/33/34/36. Definitive (400/401/403, token failure):
// lock cleared, package stays approved. Ambiguous (429/500/timeout/network/
// badbody): lock kept, "Check your Gmail Sent folder" panel.
const DEFINITIVE: SendMode[] = ["400", "401", "403"];
const AMBIGUOUS: SendMode[] = ["429", "500", "timeout", "network", "badbody"];

async function trySend(page: Page, bot: Bot, mode: SendMode, delayMs = 0) {
  const pkg = await bot.seed();
  await openDetail(page, pkg.packageId);
  await approve(page);
  setFakeMode({ send: mode, delayMs: mode === "timeout" ? 150 : delayMs });
  const dialog = await openSendDialog(page);
  await dialog.getByRole("button", { name: "Send now" }).click();
  return pkg;
}

test.describe("send failures", () => {
  for (const mode of DEFINITIVE) {
    test(`Gmail ${mode}: definitive, lock cleared, package stays approved`, async ({ page, bot }) => {
      await trySend(page, bot, mode);
      // Review 07 finding 4: the reason stays in the open dialog (a toast vanishes).
      const dialog = page.getByRole("dialog");
      await expect(dialog.getByRole("alert").filter({ hasText: "Gmail rejected the message" })).toBeVisible();
      await expect(dialog.getByRole("button", { name: "Send now" })).toBeEnabled();
      await dialog.getByRole("button", { name: "Cancel" }).click();
      await expect(page.getByRole("region", { name: "Send outcome" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Unapprove" })).toBeVisible();
      expect(fakeSends()).toHaveLength(1); // no automatic retry
      // Google's body never reaches the UI (AC-36).
      await expect(page.getByText("FAKE-GOOGLE-BODY-MARKER")).toHaveCount(0);
    });
  }

  test("token endpoint invalid_grant: reconnect required, nothing sent, lock cleared", async ({ page, bot }) => {
    const pkg = await bot.seed();
    await openDetail(page, pkg.packageId);
    await approve(page);
    setFakeMode({ token: "invalid_grant" });
    const dialog = await openSendDialog(page);
    await dialog.getByRole("button", { name: "Send now" }).click();
    await expect(
      dialog.getByRole("alert").filter({ hasText: "Reconnect Gmail in the cockpit settings" }),
    ).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByRole("region", { name: "Send outcome" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible();
    expect(fakeSends()).toHaveLength(0);
    expect(fakeLog().filter((e) => e.kind === "token" && e.status === 400)).toHaveLength(1);
  });

  for (const mode of AMBIGUOUS) {
    test(`Gmail ${mode}: ambiguous, lock kept, outcome panel shown, package frozen`, async ({ page, bot }) => {
      const pkg = await trySend(page, bot, mode);
      const panel = page.getByRole("region", { name: "Send outcome" });
      await expect(panel).toBeVisible();
      await expect(panel).toContainText("Check your Gmail Sent folder");
      await expect(panel.getByRole("button", { name: "Mark as sent (manual)" })).toBeVisible();
      await expect(panel.getByRole("button", { name: "Release lock" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Send", exact: true })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Edit", exact: true })).toHaveCount(0);
      expect(fakeSends()).toHaveLength(1);
      await expect(page.getByText("FAKE-GOOGLE-BODY-MARKER")).toHaveCount(0);

      // Survives a reload (the lock is in the DB), and the bot cannot supersede it (AC-34).
      await page.reload();
      await expect(page.getByRole("region", { name: "Send outcome" })).toBeVisible();
      const resubmit = await bot.call("submit_application_package", {
        jobId: pkg.jobId,
        emailSubject: "v2",
        emailBody: "v2",
        fitGrade: "A",
      });
      expect(resubmit.isError).toBe(true);
      expect(resubmit.text).toContain("CONFLICT");
    });
  }

  test("ambiguous -> Release lock: package is approved again and can be sent", async ({ page, bot }) => {
    const pkg = await trySend(page, bot, "500");
    // Only this package's sends: a slow earlier request may still log late.
    const mine = () => fakeSends().filter((e) => e.to === pkg.to);
    const panel = page.getByRole("region", { name: "Send outcome" });
    await panel.getByRole("button", { name: "Release lock" }).click();
    const confirm = page.getByRole("alertdialog");
    await expect(confirm).toContainText("NOT in your Gmail Sent folder");
    await confirm.getByRole("button", { name: "Release lock" }).click();
    await expect(page.getByRole("region", { name: "Send outcome" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible();

    setFakeMode({ send: "ok" });
    const dialog = await openSendDialog(page);
    await dialog.getByRole("button", { name: "Send now" }).click();
    await expect(page.locator("header").getByText("Sent", { exact: true })).toBeVisible();
    expect(mine()).toHaveLength(2);
  });

  test("ambiguous -> Mark as sent (manual): package sent, job applied, no extra send", async ({ page, bot }) => {
    const pkg = await trySend(page, bot, "network");
    const panel = page.getByRole("region", { name: "Send outcome" });
    await panel.getByRole("button", { name: "Mark as sent (manual)" }).click();
    const confirm = page.getByRole("alertdialog");
    await expect(confirm).toContainText("in your Gmail Sent folder");
    await confirm.getByRole("button", { name: "Mark as sent" }).click();
    await expect(page.locator("header").getByText("Sent", { exact: true })).toBeVisible();
    expect(fakeSends()).toHaveLength(1);
    const job = await bot.call("get_job", { jobId: pkg.jobId });
    expect(job.json?.status).toBe("applied");
  });

  test("real 20 s client timeout (fake hangs until the abort signal)", async ({ page, bot }) => {
    test.setTimeout(120_000);
    const pkg = await bot.seed();
    await openDetail(page, pkg.packageId);
    await approve(page);
    setFakeMode({ send: "timeout" }); // no delayMs: hangs until AbortSignal.timeout(20000)
    const dialog = await openSendDialog(page);
    await dialog.getByRole("button", { name: "Send now" }).click();
    await expect(page.getByRole("region", { name: "Send outcome" })).toBeVisible({ timeout: 60_000 });
    expect(fakeSends()).toHaveLength(1);
  });
});
