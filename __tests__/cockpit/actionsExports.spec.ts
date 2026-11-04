// @vitest-environment node
import fs from "fs";
import path from "path";

// AC-44: a "use server" file may only export the intended async functions.
const ALLOWED: Record<string, string[]> = {
  "cockpit.actions.ts": [
    "approvePackage",
    "unapprovePackage",
    "rejectPackage",
    "requestPackageChanges",
    "updatePackageContent",
    "markPackageAppliedManually",
    "getReviewQueue",
    "getPackageDetail",
    "getAdjacentPackageIds",
  ],
  // C-09 / C-10 add their own entries (cockpitSend.actions.ts, ...).
};

const dir = path.join(process.cwd(), "src", "actions");
const files = fs
  .readdirSync(dir)
  .filter((f) => /^cockpit.*\.actions\.ts$/.test(f));

describe("cockpit*.actions.ts exports (AC-44)", () => {
  it("finds the cockpit action files", () => {
    expect(files).toContain("cockpit.actions.ts");
  });

  it.each(files)("%s", (file) => {
    const src = fs.readFileSync(path.join(dir, file), "utf8");
    expect(src.trimStart().startsWith('"use server"')).toBe(true);

    // Every export statement must be `export type ...` or `export async function name(`.
    const exportLines = src
      .split("\n")
      .filter((l) => /^export\s/.test(l))
      .filter((l) => !/^export\s+(type|interface)\s/.test(l));
    const names: string[] = [];
    for (const line of exportLines) {
      const match = /^export\s+async\s+function\s+(\w+)\s*[<(]/.exec(line);
      expect(match, `not an async function export: ${line}`).not.toBeNull();
      names.push(match![1]);
    }
    expect(ALLOWED[file], `${file} has no allowlist entry`).toBeDefined();
    expect([...names].sort()).toEqual([...ALLOWED[file]].sort());
    // No re-exports or export lists hiding non-functions.
    expect(src).not.toMatch(/^export\s*(\{|\*|default)/m);
    // No send/gmail imports in this ticket, and no handleError (AC-49).
    expect(src).not.toMatch(/cockpit\/send|cockpit\/gmail|handleError/);
  });
});
