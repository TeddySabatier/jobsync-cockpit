import { approve, detailUrl, expect, openDetail, test } from "../support/cockpit-fixtures";

// SPEC §5.2-5.4, AC-17/18/48: queue -> detail -> edit -> request changes ->
// bot marks done -> bot resubmits (new version banner) -> approve.
test.describe("review flow", () => {
  test("queue lists a bot-submitted package and opens its detail", async ({ page, bot }) => {
    const pkg = await bot.seed();
    await page.goto("/dashboard/review");
    const row = page.getByRole("link", { name: new RegExp(pkg.company) });
    await expect(row).toBeVisible();
    await expect(row).toContainText("Pending");
    await expect(row).toContainText("v1");
    await expect(row).toContainText(pkg.to as string);
    await expect(page.getByText("j / k: next / previous in To do")).toBeVisible();

    await row.click();
    await expect(page).toHaveURL(detailUrl(pkg.packageId));
    await expect(page.getByRole("heading", { name: pkg.company })).toBeVisible();
    for (const id of ["posting", "cv", "fit", "email", "letter"]) {
      await expect(page.getByTestId(`panel-${id}`)).toBeVisible();
    }
    await expect(page.getByTestId("panel-email")).toContainText(pkg.subject);
    await expect(page.getByTestId("panel-fit")).toContainText("Strong match on backend experience.");
  });

  test("edit, request changes, bot marks done, resubmits, approve", async ({ page, bot }) => {
    const pkg = await bot.seed();
    await openDetail(page, pkg.packageId);

    // Edit: email subject, letter and one CV string leaf.
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    const form = page.getByRole("form", { name: "Edit package" });
    await expect(form).toBeVisible();
    await form.getByLabel("Subject").fill("Edited subject – hello");
    await form.getByLabel("Letter (Markdown)").fill("Edited letter for Jane Doe.");
    await form.getByLabel("experience[0].bullets[0]", { exact: true }).fill("Built APIs at scale");
    await expect(form.getByText("PDF will be marked stale")).toBeVisible();
    await form.getByRole("button", { name: "Save" }).click();
    await expect(form).toBeHidden();

    await expect(page.getByTestId("panel-email")).toContainText("Edited subject – hello");
    await expect(page.getByTestId("panel-letter")).toContainText("Edited letter for Jane Doe.");
    await expect(page.getByText("PDF stale").first()).toBeVisible();
    await expect(page.getByText("PDF out of date")).toBeVisible();

    // Request changes.
    await page.getByRole("button", { name: "Request changes", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Request changes" });
    await dialog.getByLabel("Change request").fill("Please shorten the letter.");
    await dialog.getByRole("button", { name: "Request changes" }).click();
    await expect(page.getByText("Waiting for the bot to resubmit")).toBeVisible();

    // Bot side: the request is listed, then closed.
    const listed = await bot.call("list_change_requests", {});
    expect(listed.isError).toBe(false);
    expect(listed.text).toContain(pkg.packageId);
    expect(listed.text).toContain("Please shorten the letter.");
    const done = await bot.call("mark_change_request_done", {
      packageId: pkg.packageId,
      response: "Letter shortened.",
    });
    expect(done.isError).toBe(false);
    expect(done.json?.status).toBe("pending");

    await page.reload();
    await expect(page.getByText("Bot response")).toBeVisible();
    await expect(page.getByText("Letter shortened.")).toBeVisible();
    await expect(page.getByText("Please shorten the letter.")).toBeVisible();

    // Bot resubmits: v2 supersedes v1, the old page shows the banner.
    const v2 = await bot.call("submit_application_package", {
      jobId: pkg.jobId,
      emailTo: pkg.to,
      emailSubject: "Application v2",
      emailBody: "Version two body.",
      fitGrade: "B",
    });
    expect(v2.json?.version).toBe(2);
    expect(v2.json?.supersededIds).toContain(pkg.packageId);

    await page.reload();
    const banner = page.getByTestId("version-banner");
    await expect(banner).toContainText("Viewing v1");
    await expect(banner).toContainText("superseded");
    await expect(page.getByRole("region", { name: "Actions" })).toHaveCount(0);

    await banner.getByRole("link", { name: "Open v2" }).click();
    await expect(page.getByTestId("panel-email")).toContainText("Application v2");
    await approve(page);
    await expect(page.getByText("Approved", { exact: true }).first()).toBeVisible();
  });

  test("reject keeps the reason, tab filtering follows the status", async ({ page, bot }) => {
    const pkg = await bot.seed({ noEmail: true });
    await openDetail(page, pkg.packageId);
    await page.getByRole("button", { name: "Reject", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Reject this package" });
    await dialog.getByLabel("Reject reason").fill("Not interested.");
    await dialog.getByRole("button", { name: "Reject", exact: true }).click();
    await expect(page.getByText("Not interested.")).toBeVisible();

    await page.goto("/dashboard/review?tab=rejected");
    await expect(page.getByRole("link", { name: new RegExp(pkg.company) })).toBeVisible();
    await page.goto("/dashboard/review?tab=todo");
    await expect(page.getByRole("link", { name: new RegExp(pkg.company) })).toHaveCount(0);

    // JOB_REJECTED: the bot must not resurrect it (SPEC §2.2 step 4).
    const again = await bot.call("submit_application_package", {
      jobId: pkg.jobId,
      emailSubject: "again",
      emailBody: "again",
      fitGrade: "A",
    });
    expect(again.isError).toBe(true);
    expect(again.text).toContain("JOB_REJECTED");
  });
});
