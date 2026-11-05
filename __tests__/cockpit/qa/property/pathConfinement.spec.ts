// @vitest-environment node
import fc from "fast-check";
import fs from "fs";
import os from "os";
import path from "path";
import { fcParams, tag } from "./_fc";

const state = vi.hoisted(() => ({ uploads: "" }));
vi.mock("@/lib/constants", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/constants")>();
  return {
    ...mod,
    APP_CONSTANTS: {
      ...mod.APP_CONSTANTS,
      get UPLOADS_DIR() {
        return state.uploads;
      },
    },
  };
});

import { cockpitUserDir, resolveCockpitFile } from "@/lib/cockpit/files";

// Property 2 (SPEC §4): resolveCockpitFile is null or inside the user's dir.
let root: string;
let outside: string;
const USERS = ["u1", "u10", "u2"];

beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "qa-prop-path-")));
  state.uploads = path.join(root, "uploads");
  outside = path.join(root, "outside");
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, "secret.pdf"), "%PDF-1.4");
  for (const u of USERS) fs.mkdirSync(cockpitUserDir(u), { recursive: true });
  fs.writeFileSync(path.join(cockpitUserDir("u1"), "a.pdf"), "%PDF-1.4");
  fs.writeFileSync(path.join(cockpitUserDir("u10"), "b.pdf"), "%PDF-1.4");
  const u1 = cockpitUserDir("u1");
  fs.symlinkSync(outside, path.join(u1, "out"));
  fs.symlinkSync(path.join(outside, "secret.pdf"), path.join(u1, "outfile"));
  fs.symlinkSync(path.join(u1, "a.pdf"), path.join(u1, "inlink"));
  fs.symlinkSync(cockpitUserDir("u10"), path.join(u1, "to10"));
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const seg = fc.constantFrom(
  "..", ".", "%2e%2e", "%2e%2e%2f", "..%5c", "..\\", "....//", "a.pdf", "b.pdf", "out",
  "outfile", "inlink", "to10", "u1", "u10", "u2", "files", "cockpit", "secret.pdf",
  "\u0000", "a.pdf\u0000x", "é", "日本", "", " ", "~", "C:", "\\\\server\\share",
);
const sep = fc.constantFrom("/", "\\", "//");

const filePath = fc.oneof(
  fc.string({ unit: "binary", maxLength: 60 }),
  fc
    .tuple(
      fc.constantFrom(
        () => cockpitUserDir("u1"),
        () => cockpitUserDir("u2"),
        () => cockpitUserDir("u10"),
        () => state.uploads,
        () => outside,
        () => "/",
        () => "/etc/passwd",
        () => "",
      ),
      fc.array(fc.tuple(sep, seg), { maxLength: 6 }),
    )
    .map(([r, parts]) => r() + parts.map(([s, g]) => s + g).join("")),
);

describe(tag("resolveCockpitFile properties"), () => {
  it("control: a real file and an in-dir symlink resolve", async () => {
    const dir = fs.realpathSync(cockpitUserDir("u1"));
    expect(await resolveCockpitFile("u1", { filePath: path.join(dir, "a.pdf") })).toBe(path.join(dir, "a.pdf"));
    expect(await resolveCockpitFile("u1", { filePath: path.join(dir, "inlink") })).toBe(path.join(dir, "a.pdf"));
    expect(await resolveCockpitFile("u1", { filePath: path.join(dir, "out", "secret.pdf") })).toBeNull();
  });

  it("any path string is rejected or lies inside the user's dir", async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(...USERS), filePath, async (userId, fp) => {
        const r = await resolveCockpitFile(userId, { filePath: fp });
        if (r === null) return;
        const base = fs.realpathSync(cockpitUserDir(userId));
        const rel = path.relative(base, r);
        expect(rel.startsWith("..")).toBe(false);
        expect(path.isAbsolute(rel)).toBe(false);
        expect(rel).not.toBe("");
      }),
      fcParams(),
    );
  });

  it("arbitrary userIds (other than dot segments) never leave their own dir", async () => {
    const userId = fc.oneof(
      fc.string({ unit: "binary", maxLength: 20 }),
      fc.constantFrom("", "u1/../u10", "u1\\..\\u10", "u1/", "/u1", "u1\u0000", "%2e%2e", "u1/.."),
    );
    await fc.assert(
      fc.asyncProperty(userId, filePath, async (uid, fp) => {
        if (uid === "." || uid === "..") return; // covered by the it.fails below
        const r = await resolveCockpitFile(uid, { filePath: fp });
        if (r === null) return;
        const rel = path.relative(fs.realpathSync(path.join(state.uploads, "files", "cockpit")), r);
        expect(rel.split(path.sep)[0]).toBe(uid);
      }),
      fcParams(),
    );
  });

  // BUG (see .cockpit-tmp/findings/l8-failures.md): "." and ".." pass the
  // `path.basename(userId) !== userId` guard, so base becomes the parent dir.
  it.fails('rejects "." and ".." as userId (single-segment guard)', async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(".", ".."), async (uid) => {
        const fp = path.join(cockpitUserDir("u1"), "a.pdf");
        expect(await resolveCockpitFile(uid, { filePath: fp })).toBeNull();
      }),
      fcParams(10),
    );
  });
});
