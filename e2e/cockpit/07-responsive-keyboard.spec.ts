import type { Page } from "@playwright/test";
import { approve, expect, openDetail, openSendDialog, test } from "../support/cockpit-fixtures";

// AC-19, AC-20, AC-48: phone width, j/k, dialog focus handling.
const noHScroll = (page: Page) =>
  page.evaluate(() => {
    const el = document.scrollingElement as HTMLElement;
    return { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth };
  });

async function expectNoHorizontalScroll(page: Page, shot: string) {
  await page.screenshot({ path: `.cockpit-tmp/shots/${shot}.png`, fullPage: true });
  const { scrollWidth, clientWidth } = await noHScroll(page);
  expect(scrollWidth, `${shot}: scrollWidth ${scrollWidth} > clientWidth ${clientWidth}`).toBeLessThanOrEqual(clientWidth);
}

test.describe("375 px viewport", () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test("queue, detail, edit and settings do not scroll horizontally", async ({ page, bot }) => {
    // A long URL in the body and a long (but spaced) subject.
    const longUrl = "https://example.com/" + "a".repeat(180);
    const pkg = await bot.seed({
      body: `See ${longUrl}\n\nBest,\nJane Doe`,
      subject: "Application for the Senior Backend Engineer position on the platform team ".repeat(2),
    });

    await page.goto("/dashboard/review");
    await expect(page.getByRole("link", { name: new RegExp(pkg.company) })).toBeVisible();
    await expectNoHorizontalScroll(page, "375-queue");

    await openDetail(page, pkg.packageId);
    await expectNoHorizontalScroll(page, "375-detail");

    // Narrow container: secondary actions live in the "More" sheet (AC-48).
    await page.getByRole("button", { name: "More" }).click();
    const sheet = page.getByRole("dialog", { name: "More actions" });
    await expect(sheet.getByRole("button", { name: "Edit" })).toBeVisible();
    await expect(sheet.getByRole("button", { name: "Reject" })).toBeVisible();
    await sheet.getByRole("button", { name: "Edit" }).click();
    await expect(page.getByRole("form", { name: "Edit package" })).toBeVisible();
    await expectNoHorizontalScroll(page, "375-edit");

    await page.goto("/dashboard/review/settings");
    await expect(page.getByRole("heading", { name: "Review settings" })).toBeVisible();
    await expectNoHorizontalScroll(page, "375-settings");
  });

  test("an unbroken 120-character subject does not scroll horizontally", async ({ page, bot }) => {
    const pkg = await bot.seed({ subject: "S".repeat(120) });
    await openDetail(page, pkg.packageId);
    await expectNoHorizontalScroll(page, "375-detail-long-subject");
  });

  test("approved package: Send dialog fits the phone", async ({ page, bot }) => {
    const pkg = await bot.seed();
    await openDetail(page, pkg.packageId);
    // Unapprove lives in the "More" sheet at this width, so wait for Send instead.
    await page.getByRole("button", { name: "Approve", exact: true }).click();
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible();
    await openSendDialog(page);
    await expectNoHorizontalScroll(page, "375-send-dialog");
  });
});

test.describe("keyboard", () => {
  test("j / k walk the To do queue from a detail page; ignored in dialogs and fields", async ({ page, bot }) => {
    await bot.seed();
    await bot.seed();
    await page.goto("/dashboard/review?tab=todo");
    const hrefs = await page.locator("ul a[href^='/dashboard/review/']").evaluateAll((as) =>
      as.map((a) => a.getAttribute("href") as string),
    );
    expect(hrefs.length).toBeGreaterThanOrEqual(2);

    await page.goto(hrefs[0]);
    await expect(page.getByTestId("panel-email")).toBeVisible();
    // The key listener only exists after hydration: press again until it lands,
    // but never once the URL has already changed.
    const pressUntil = (key: string, from: string, to: string) =>
      expect(async () => {
        if (page.url().endsWith(from)) await page.keyboard.press(key);
        await expect(page).toHaveURL(to, { timeout: 2000 });
      }).toPass({ timeout: 30_000 });
    await pressUntil("j", hrefs[0], hrefs[1]);
    await expect(page.getByTestId("panel-email")).toBeVisible();
    await pressUntil("k", hrefs[1], hrefs[0]);
    await expect(page.getByTestId("panel-email")).toBeVisible();

    // Typing j/k inside a dialog textarea must not navigate.
    await page.getByRole("button", { name: "Request changes", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Request changes" });
    await dialog.getByLabel("Change request").fill("");
    await dialog.getByLabel("Change request").pressSequentially("jkjk");
    await expect(dialog.getByLabel("Change request")).toHaveValue("jkjk");
    await expect(page).toHaveURL(hrefs[0]);
    await page.keyboard.press("Escape");
  });

  test("Send dialog: Tab / Shift+Tab stay inside, Escape closes", async ({ page, bot }) => {
    const pkg = await bot.seed();
    await openDetail(page, pkg.packageId);
    await approve(page);
    const send = page.getByRole("button", { name: "Send", exact: true });
    await send.focus();
    await send.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Send this application" });
    await expect(dialog).toBeVisible();

    const insideDialog = () =>
      page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'));
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press("Tab");
      expect(await insideDialog(), `Tab #${i + 1} left the dialog`).toBe(true);
    }
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press("Shift+Tab");
      expect(await insideDialog(), `Shift+Tab #${i + 1} left the dialog`).toBe(true);
    }

    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  });

  // FINDING (medium, a11y): after Escape closes the Send dialog, focus is on
  // <body>, not on the Send button that opened it. Tracked in #39.
  test.fixme("Send dialog: focus returns to Send after Escape", async ({ page, bot }) => {
    const pkg = await bot.seed();
    await openDetail(page, pkg.packageId);
    await approve(page);
    const send = page.getByRole("button", { name: "Send", exact: true });
    await send.focus();
    await send.press("Enter");
    await expect(page.getByRole("dialog", { name: "Send this application" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(send).toBeFocused();
  });
});
