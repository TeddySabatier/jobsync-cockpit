import fs from "fs";
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { setFakeMode } from "../support/fake-google-control";
import { approve, expect, openDetail, openSendDialog, test } from "../support/cockpit-fixtures";

// Accessibility scan (axe) of the cockpit screens. Violations are recorded by
// impact in .cockpit-tmp/findings/l9-axe.json; the assertion is zero
// serious/critical outside KNOWN, so a failing test here IS a finding.
// The upstream app shell (header, sidebar) is excluded: not cockpit code.
const OUT = ".cockpit-tmp/findings/l9-axe.json";

// Known cockpit finding, reported in the PR; remove the entry when fixed.
const KNOWN = new Set([
  // Read-only Tiptap panels (Posting, Cover letter) are role=textbox with no name.
  "aria-input-field-name",
]);

type Recorded = {
  id: string;
  impact: string | null | undefined;
  help: string;
  nodes: number;
  targets: string[];
};
const report: { byScreen: Record<string, Recorded[]>; summary: Record<string, Record<string, number>> } = {
  byScreen: {},
  summary: {},
};

async function scan(page: Page, screen: string) {
  const { violations } = await new AxeBuilder({ page }).exclude("header").exclude("aside").analyze();
  report.byScreen[screen] = violations.map((v) => ({
    id: v.id,
    impact: v.impact,
    help: v.help,
    nodes: v.nodes.length,
    targets: v.nodes.slice(0, 3).map((n) => n.target.join(" ")),
  }));
  const counts: Record<string, number> = {};
  for (const v of violations) counts[v.impact ?? "unknown"] = (counts[v.impact ?? "unknown"] ?? 0) + 1;
  report.summary[screen] = counts;
  fs.mkdirSync(".cockpit-tmp/findings", { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  return violations.filter(
    (v) => (v.impact === "serious" || v.impact === "critical") && !KNOWN.has(v.id),
  );
}

const describeBad = (v: Awaited<ReturnType<typeof scan>>) =>
  v.map((x) => `${x.id} (${x.impact}) ${x.nodes.length} node(s)`).join("; ");

test.describe("axe", () => {
  test("queue", async ({ page, bot }) => {
    await bot.seed();
    await page.goto("/dashboard/review");
    await expect(page.getByRole("link", { name: /Acme/ }).first()).toBeVisible();
    const bad = await scan(page, "queue");
    expect(bad.length, describeBad(bad)).toBe(0);
  });

  test("detail", async ({ page, bot }) => {
    const pkg = await bot.seed();
    await openDetail(page, pkg.packageId);
    const bad = await scan(page, "detail");
    expect(bad.length, describeBad(bad)).toBe(0);
  });

  test("edit", async ({ page, bot }) => {
    const pkg = await bot.seed();
    await openDetail(page, pkg.packageId);
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    await expect(page.getByRole("form", { name: "Edit package" })).toBeVisible();
    const bad = await scan(page, "edit");
    expect(bad.length, describeBad(bad)).toBe(0);
  });

  test("settings", async ({ page }) => {
    await page.goto("/dashboard/review/settings");
    await expect(page.getByRole("heading", { name: "Review settings" })).toBeVisible();
    const bad = await scan(page, "settings");
    expect(bad.length, describeBad(bad)).toBe(0);
  });

  test("send dialog", async ({ page, bot }) => {
    const pkg = await bot.seed();
    await openDetail(page, pkg.packageId);
    await approve(page);
    await openSendDialog(page);
    const bad = await scan(page, "send-dialog");
    expect(bad.length, describeBad(bad)).toBe(0);
  });

  test("outcome panel", async ({ page, bot }) => {
    const pkg = await bot.seed();
    await openDetail(page, pkg.packageId);
    await approve(page);
    setFakeMode({ send: "500" });
    const dialog = await openSendDialog(page);
    await dialog.getByRole("button", { name: "Send now" }).click();
    await expect(page.getByRole("region", { name: "Send outcome" })).toBeVisible();
    const bad = await scan(page, "outcome-panel");
    expect(bad.length, describeBad(bad)).toBe(0);
  });
});
