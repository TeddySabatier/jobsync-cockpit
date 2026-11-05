import { cvPdf, CV_FILE_NAME } from "../support/cockpit-api";
import { fakeLog, fakeSends, setFakeMode } from "../support/fake-google-control";
import {
  approve,
  expect,
  openDetail,
  openSendDialog,
  sizeLabel,
  test,
} from "../support/cockpit-fixtures";

// SPEC §5.3 send dialog, §6.4 send, AC-25/26/45. Google is the fake preload;
// the log is the oracle for "exactly one send".
test.describe("send", () => {
  test("dialog shows To, From, subject, attachment name+size and the full body; send OK sends exactly one mail", async ({
    page,
    bot,
  }) => {
    const body = Array.from({ length: 30 }, (_, i) => `Line ${i + 1} of the email body.`).join("\n");
    const pkg = await bot.seed({ body });
    await openDetail(page, pkg.packageId);
    await approve(page);

    const dialog = await openSendDialog(page);
    await expect(dialog.getByTestId("send-to")).toHaveText(pkg.to as string);
    await expect(dialog).toContainText("you@example.com");
    await expect(dialog).toContainText(pkg.subject);
    await expect(dialog).toContainText(`${CV_FILE_NAME} (${sizeLabel(cvPdf().length)})`);
    // Whole body present (the <pre> scrolls, nothing is truncated).
    await expect(dialog.getByTestId("send-body")).toHaveText(body);
    // Company-matching recipient domain: no warning.
    await expect(dialog.getByRole("alert")).toHaveCount(0);

    await dialog.getByRole("button", { name: "Send now" }).click();
    await expect(page.locator("header").getByText("Sent", { exact: true })).toBeVisible();

    const sends = fakeSends();
    expect(sends).toHaveLength(1);
    expect(sends[0].to).toBe(pkg.to);
    expect(sends[0].subject).toBe(pkg.subject);
    expect(sends[0].from).toBe("you@example.com");
    expect(sends[0].attachmentName).toBe(CV_FILE_NAME);
    expect(sends[0].attachmentBytes).toBe(cvPdf().length);
    expect(fakeLog().filter((e) => e.kind === "blocked")).toHaveLength(0);

    // Job became applied (SPEC §6.4 step 6).
    const job = await bot.call("get_job", { jobId: pkg.jobId });
    expect(job.json?.status).toBe("applied");
    expect(job.json?.applied).toBe(true);

    // Sent is terminal: no action bar, a resubmit is refused (ALREADY_SENT).
    await expect(page.getByRole("region", { name: "Actions" })).toHaveCount(0);
    const again = await bot.call("submit_application_package", {
      jobId: pkg.jobId,
      emailSubject: "again",
      emailBody: "again",
      fitGrade: "A",
    });
    expect(again.text).toContain("ALREADY_SENT");
  });

  test("double click on Send now produces exactly one send request", async ({ page, bot }) => {
    setFakeMode({ send: "ok", delayMs: 1500 });
    const pkg = await bot.seed();
    await openDetail(page, pkg.packageId);
    await approve(page);
    const dialog = await openSendDialog(page);

    await dialog.getByRole("button", { name: "Send now" }).dblclick();
    await expect(page.locator("header").getByText("Sent", { exact: true })).toBeVisible({ timeout: 30_000 });
    expect(fakeSends()).toHaveLength(1);
  });

  test("two tabs racing on the same package: one send only", async ({ page, bot, context }) => {
    setFakeMode({ send: "ok", delayMs: 1500 });
    const pkg = await bot.seed();
    await openDetail(page, pkg.packageId);
    await approve(page);
    const page2 = await context.newPage();
    await openDetail(page2, pkg.packageId);

    const d1 = await openSendDialog(page);
    const d2 = await openSendDialog(page2);
    await Promise.all([
      d1.getByRole("button", { name: "Send now" }).click(),
      d2.getByRole("button", { name: "Send now" }).click(),
    ]);
    await expect(page.locator("header").getByText("Sent", { exact: true })).toBeVisible({ timeout: 30_000 });
    expect(fakeSends()).toHaveLength(1);
    await page2.close();
  });

  test("domain mismatch and free-mail recipients show a warning", async ({ page, bot }) => {
    const mismatch = await bot.seed({ emailTo: "hr@unrelated.test" });
    await openDetail(page, mismatch.packageId);
    await approve(page);
    let dialog = await openSendDialog(page);
    await expect(dialog.getByRole("alert")).toContainText("does not match the company");
    await dialog.getByRole("button", { name: "Cancel" }).click();

    const free = await bot.seed({ emailTo: "someone@gmail.com" });
    await openDetail(page, free.packageId);
    await approve(page);
    dialog = await openSendDialog(page);
    await expect(dialog.getByRole("alert")).toContainText("free-mail");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    expect(fakeSends()).toHaveLength(0);
  });

  test("packages that cannot be sent explain why and offer no Send", async ({ page, bot }) => {
    const noCv = await bot.seed({ noCv: true });
    await openDetail(page, noCv.packageId);
    await approve(page);
    await expect(page.getByText("No CV file is attached.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Send", exact: true })).toHaveCount(0);

    // Link-apply: primary CTA is the posting link; manual apply sits in the overflow menu.
    const link = await bot.seed({ noEmail: true });
    await openDetail(page, link.packageId);
    await approve(page);
    await expect(page.getByRole("link", { name: "Open job posting" })).toBeVisible();
    await page.getByRole("button", { name: "Overflow menu" }).click();
    await page.getByRole("menuitem", { name: "Mark applied manually" }).click();
    const confirm = page.getByRole("alertdialog");
    await expect(confirm).toContainText(link.company);
    await expect(confirm).toContainText(link.role);
    await expect(confirm).toContainText(link.jobUrl);
    await confirm.getByRole("button", { name: "Mark applied" }).click();
    await expect(page.locator("header").getByText("Sent", { exact: true })).toBeVisible();
    expect(fakeSends()).toHaveLength(0);
    const job = await bot.call("get_job", { jobId: link.jobId });
    expect(job.json?.status).toBe("applied");
  });
});
