// @vitest-environment node
import { assertSendable } from "../../scripts/qa/scrub.ts";

describe("assertSendable", () => {
  it.each([
    "src/lib/cockpit/x.ts",
    "__tests__/a.test.ts",
    "prisma/migrations/1/migration.sql",
    "cockpit/SPEC.md",
    "docs/a.md",
    "e2e/a.spec.ts",
    "prisma/schema.prisma",
    "next.config.mjs",
    "package.json",
  ])("allows %s", (p) => {
    expect(() => assertSendable(p, "const a = 1;")).not.toThrow();
  });

  it.each([
    ".env",
    "src/.env.local",
    "src/dev.db",
    "src/x.sqlite",
    "src/lib/secrets/a.ts",
    "package-lock.json",
    "scripts/qa/ask.ts",
    "/etc/passwd",
    "src/../.env",
  ])("denies %s", (p) => {
    expect(() => assertSendable(p, "x")).toThrow();
  });

  it.each([
    "-----BEGIN RSA PRIVATE KEY-----",
    "token = ghp_" + "a".repeat(24),
    "key = sk-" + "b".repeat(24),
  ])("denies secret content %#", (c) => {
    expect(() => assertSendable("src/a.ts", c)).toThrow();
  });
});
