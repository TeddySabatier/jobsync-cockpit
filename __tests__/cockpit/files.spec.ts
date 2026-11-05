// @vitest-environment node
import fs from "fs";
import os from "os";
import path from "path";

const state = vi.hoisted(() => ({ uploads: "" }));

// UPLOADS_DIR is read through a getter so each test can point it elsewhere.
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

let root: string;
let outside: string;

const write = (p: string, content = "%PDF-1.4") => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-files-"));
  outside = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-outside-"));
  state.uploads = root;
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

describe("cockpitUserDir", () => {
  it("is evaluated at call time", () => {
    expect(cockpitUserDir("u1")).toBe(
      path.join(root, "files", "cockpit", "u1"),
    );
    state.uploads = "/elsewhere";
    expect(cockpitUserDir("u1")).toBe(
      path.join("/elsewhere", "files", "cockpit", "u1"),
    );
  });

  it.each(["", ".", "..", "a/b", "../x"])("rejects %j as user id", (id) => {
    expect(() => cockpitUserDir(id)).toThrow("Invalid cockpit user id");
  });
});

describe("resolveCockpitFile (AC-42)", () => {
  it("accepts a file inside the user's cockpit dir and returns its real path", async () => {
    const file = write(path.join(cockpitUserDir("u1"), "a.pdf"));
    expect(await resolveCockpitFile("u1", { filePath: file })).toBe(
      fs.realpathSync(file),
    );
  });

  it("accepts a relative UPLOADS_DIR (resolved against cwd)", async () => {
    const rel = path.relative(process.cwd(), root);
    state.uploads = rel;
    write(path.join(root, "files", "cockpit", "u1", "a.pdf"));
    const stored = path.join(rel, "files", "cockpit", "u1", "a.pdf");
    expect(await resolveCockpitFile("u1", { filePath: stored })).not.toBeNull();
  });

  it("rejects a file outside the cockpit dir", async () => {
    const file = write(path.join(outside, "a.pdf"));
    expect(await resolveCockpitFile("u1", { filePath: file })).toBeNull();
    const resume = write(path.join(root, "files", "resumes", "r.pdf"));
    expect(await resolveCockpitFile("u1", { filePath: resume })).toBeNull();
  });

  it("rejects .. segments that escape the dir", async () => {
    write(path.join(cockpitUserDir("u1"), "a.pdf"));
    write(path.join(root, "files", "cockpit", "u2", "b.pdf"));
    // Built by hand: path.join would normalize the ".." away.
    const raw = `${cockpitUserDir("u1")}${path.sep}..${path.sep}u2${path.sep}b.pdf`;
    expect(await resolveCockpitFile("u1", { filePath: raw })).toBeNull();
  });

  it("does not match a sibling dir sharing the prefix (u1 vs u10)", async () => {
    const other = write(path.join(cockpitUserDir("u10"), "a.pdf"));
    expect(await resolveCockpitFile("u1", { filePath: other })).toBeNull();
    expect(await resolveCockpitFile("u10", { filePath: other })).not.toBeNull();
  });

  it("rejects a symlink inside the dir that points outside", async () => {
    const target = write(path.join(outside, "secret.pdf"));
    fs.mkdirSync(cockpitUserDir("u1"), { recursive: true });
    const link = path.join(cockpitUserDir("u1"), "link.pdf");
    fs.symlinkSync(target, link);
    expect(await resolveCockpitFile("u1", { filePath: link })).toBeNull();
  });

  it("rejects the dir itself and a missing file", async () => {
    fs.mkdirSync(cockpitUserDir("u1"), { recursive: true });
    expect(
      await resolveCockpitFile("u1", { filePath: cockpitUserDir("u1") }),
    ).toBeNull();
    expect(
      await resolveCockpitFile("u1", {
        filePath: path.join(cockpitUserDir("u1"), "nope.pdf"),
      }),
    ).toBeNull();
  });

  it("rejects a userId that is not a single path segment", async () => {
    const file = write(path.join(root, "files", "cockpit", "u2", "a.pdf"));
    expect(
      await resolveCockpitFile("../cockpit/u2", { filePath: file }),
    ).toBeNull();
    expect(await resolveCockpitFile("", { filePath: file })).toBeNull();
  });
});
