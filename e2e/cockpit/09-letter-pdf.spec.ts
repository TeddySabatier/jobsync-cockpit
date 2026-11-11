import { expect, openDetail, test } from "../support/cockpit-fixtures";
import { fakeSends } from "../support/fake-google-control";
import { approve, openSendDialog } from "../support/cockpit-fixtures";

// D-015: the cover letter is a PDF. The preview in Review and the attachment of
// the sent email come from the same renderer.
test.describe("cover letter PDF", () => {
  test("letter route: framed by our own pages, sandboxed, a real PDF", async ({ request, bot }) => {
    const pkg = await bot.seed();
    const res = await request.get(`/api/cockpit/letter/${pkg.packageId}`);
    expect(res.status()).toBe(200);
    const h = res.headersArray();
    const all = (name: string) => h.filter((x) => x.name.toLowerCase() === name).map((x) => x.value);
    expect(all("x-frame-options")).toEqual(["SAMEORIGIN"]);
    expect(all("content-security-policy")).toEqual(["sandbox; frame-ancestors 'self'"]);
    expect(all("content-type")[0]).toContain("application/pdf");
    expect((await res.body()).subarray(0, 5).toString()).toBe("%PDF-");
  });

  test("unknown package: 404", async ({ request }) => {
    expect((await request.get("/api/cockpit/letter/does-not-exist")).status()).toBe(404);
  });

  test("Review shows the PDF preview, and Send attaches the letter next to the CV", async ({ page, bot }) => {
    const pkg = await bot.seed();
    await openDetail(page, pkg.packageId);
    const frame = page.getByTestId("letter-pdf-preview");
    await expect(frame).toBeVisible();
    await expect(frame).toHaveAttribute("src", new RegExp(`^/api/cockpit/letter/${pkg.packageId}\\?v=\\d+$`));

    await approve(page);
    const dialog = await openSendDialog(page);
    await expect(dialog.getByTestId("send-letter-attachment")).toContainText("Cover_Letter.pdf");
    await dialog.getByRole("button", { name: "Send now" }).click();
    await expect(page.locator("header").getByText("Sent", { exact: true })).toBeVisible();

    const sends = fakeSends();
    expect(sends).toHaveLength(1);
    expect(sends[0].attachmentName).toBe("jane-doe-cv.pdf");
  });
});
