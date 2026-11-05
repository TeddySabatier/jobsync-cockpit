import { defineConfig, devices } from "@playwright/test";

// Cockpit E2E (L9). Separate from playwright.config.ts (which targets the
// real app port). Own dev server on 3738 with a synthetic DB and a fake Google
// preload; see e2e/support/cockpit-server.mjs. COCKPIT_E2E_FLAG_OFF=1 runs the
// flag-off spec against a second server (3739) with COCKPIT_ENABLED=false.
const flagOff = process.env.COCKPIT_E2E_FLAG_OFF === "1";
const port = flagOff ? 3739 : 3738;

export default defineConfig({
  testDir: "./e2e/cockpit",
  testMatch: flagOff ? /flag-off\.spec\.ts/ : /\.spec\.ts/,
  testIgnore: flagOff ? [] : /flag-off\.spec\.ts/,
  // One dev server, one SQLite file, one fake-Google control file: serial.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: "list",
  outputDir: ".cockpit-tmp/pw-results",
  globalSetup: "./e2e/support/cockpit-global-setup.ts",
  globalTeardown: "./e2e/support/cockpit-global-teardown.ts",
  use: {
    baseURL: `http://localhost:${port}`,
    storageState: `.cockpit-tmp/e2e-auth-${port}.json`,
    trace: "off",
    screenshot: "off",
    navigationTimeout: 60_000,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "node e2e/support/cockpit-server.mjs",
    url: `http://localhost:${port}/signin`,
    reuseExistingServer: true,
    timeout: 600_000,
    env: {
      E2E_PORT: String(port),
      COCKPIT_ENABLED: flagOff ? "false" : "true",
    },
  },
});
