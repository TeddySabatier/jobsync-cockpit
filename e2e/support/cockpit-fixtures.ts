import { test as base, expect, type Page } from "@playwright/test";
import {
  callTool,
  seedPackage,
  type SeedOptions,
  type Seeded,
  type ToolOutcome,
} from "./cockpit-api";
import { resetFake } from "./fake-google-control";

export type Bot = {
  call: (name: string, args: Record<string, unknown>) => Promise<ToolOutcome>;
  seed: (opts?: SeedOptions) => Promise<Seeded>;
};

export const test = base.extend<{ bot: Bot; fresh: void }>({
  bot: async ({ baseURL }, use) => {
    const url = baseURL as string;
    await use({
      call: (name, args) => callTool(url, name, args),
      seed: (opts) => seedPackage(url, opts),
    });
  },
  // Every test starts with a clean fake-Google log and mode.
  fresh: [
    async ({}, use) => {
      resetFake();
      await use();
      resetFake();
    },
    { auto: true },
  ],
});

export { expect };

export const detailUrl = (id: string) => `/dashboard/review/${id}`;

export async function openDetail(page: Page, id: string) {
  await page.goto(detailUrl(id));
  await expect(page.getByTestId("panel-email")).toBeVisible();
}

// Approve through the UI (the only way: there is no MCP approve tool).
export async function approve(page: Page) {
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(page.getByRole("button", { name: "Unapprove" })).toBeVisible();
}

export async function openSendDialog(page: Page) {
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Send this application" });
  await expect(dialog).toBeVisible();
  return dialog;
}

// bytes as the UI prints them (formatBytes in Panels.tsx, < 1 KB case).
export const sizeLabel = (n: number) =>
  n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`;
