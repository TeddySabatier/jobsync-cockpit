// @vitest-environment node
import fs from "fs";
import os from "os";
import path from "path";

// AC-35: no send path over MCP. Nothing under src/lib/mcp/** or
// src/app/api/mcp/** may (transitively) import the send module or anything
// under cockpit/gmail/.

const ROOT = path.resolve(__dirname, "../..");
const SRC = path.join(ROOT, "src");

const IMPORT_RE =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)["']([^"']+)["']/g;
const EXTS = [".ts", ".tsx", ".js", ".mjs"];

function listFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return listFiles(p);
    return EXTS.includes(path.extname(e.name)) ? [p] : [];
  });
}

function resolveFile(base: string): string | null {
  const candidates = [
    base,
    ...EXTS.map((x) => base + x),
    ...EXTS.map((x) => path.join(base, "index" + x)),
  ];
  return (
    candidates.find((c) => fs.existsSync(c) && fs.statSync(c).isFile()) ?? null
  );
}

// Resolves `@/` aliases and relative paths; bare package names are skipped.
function resolveImport(from: string, spec: string, src: string): string | null {
  if (spec.startsWith("@/")) return resolveFile(path.join(src, spec.slice(2)));
  if (spec.startsWith(".")) return resolveFile(path.resolve(path.dirname(from), spec));
  return null;
}

// Every file reachable from `entries`, mapped to the file that imported it.
function reachable(entries: string[], src: string): Map<string, string | null> {
  const seen = new Map<string, string | null>(entries.map((e) => [e, null]));
  const queue = [...entries];
  while (queue.length) {
    const file = queue.pop() as string;
    const code = fs.readFileSync(file, "utf8");
    for (const m of code.matchAll(IMPORT_RE)) {
      const target = resolveImport(file, m[1], src);
      if (target && !seen.has(target)) {
        seen.set(target, file);
        queue.push(target);
      }
    }
  }
  return seen;
}

function isForbidden(file: string, src: string): boolean {
  const rel = path.relative(src, file).split(path.sep).join("/");
  return (
    /^lib\/cockpit\/send(\.|\/|$)/.test(rel) ||
    /^lib\/cockpit\/send[A-Z]/.test(rel) ||
    rel.startsWith("lib/cockpit/gmail/") ||
    /^actions\/cockpitSend/.test(rel)
  );
}

function violations(entries: string[], src: string): string[] {
  const seen = reachable(entries, src);
  return [...seen.keys()]
    .filter((f) => isForbidden(f, src))
    .map((f) => {
      const chain = [path.relative(src, f)];
      for (let p = seen.get(f); p; p = seen.get(p) ?? null) chain.unshift(path.relative(src, p));
      return chain.join(" -> ");
    });
}

describe("MCP import graph (AC-35)", () => {
  it("covers the cockpit tools (the walk really follows imports)", () => {
    const entries = [
      ...listFiles(path.join(SRC, "lib/mcp")),
      ...listFiles(path.join(SRC, "app/api/mcp")),
    ];
    const seen = [...reachable(entries, SRC).keys()].map((f) =>
      path.relative(SRC, f).split(path.sep).join("/"),
    );
    expect(seen).toEqual(
      expect.arrayContaining([
        "app/api/mcp/route.ts",
        "lib/mcp/tools/cockpit.ts",
        "lib/cockpit/packages.ts",
        "lib/cockpit/files.ts",
        "lib/cockpit/attachments.ts",
      ]),
    );
  });

  it("nothing under src/lib/mcp or src/app/api/mcp reaches the send or Gmail modules", () => {
    const entries = [
      ...listFiles(path.join(SRC, "lib/mcp")),
      ...listFiles(path.join(SRC, "app/api/mcp")),
    ];
    expect(entries.length).toBeGreaterThan(5);
    expect(violations(entries, SRC)).toEqual([]);
  });

  it("send.ts, mime.ts and gmail/client.ts start with import \"server-only\"", () => {
    for (const rel of [
      "lib/cockpit/send.ts",
      "lib/cockpit/gmail/mime.ts",
      "lib/cockpit/gmail/client.ts",
    ]) {
      const file = path.join(SRC, rel);
      expect(fs.existsSync(file), rel).toBe(true);
      expect(fs.readFileSync(file, "utf8").trimStart()).toMatch(
        /^import\s+["']server-only["']/,
      );
    }
  });

  // AC-28: the send service has exactly one caller, the sendPackage action file.
  it("only cockpitSend.actions.ts imports the send service or calls sendApplicationPackage", () => {
    const importers = listFiles(SRC)
      .filter((f) => {
        const code = fs.readFileSync(f, "utf8");
        return /cockpit\/send["']|\.\/send["']|sendApplicationPackage/.test(code);
      })
      .map((f) => path.relative(SRC, f).split(path.sep).join("/"))
      .sort();
    expect(importers).toEqual(["actions/cockpitSend.actions.ts", "lib/cockpit/send.ts"]);
  });

  it("only the send and Gmail settings actions import gmail/mime", () => {
    const importers = listFiles(SRC)
      .filter((f) => /gmail\/mime["']|\.\/gmail\/mime["']|\.\/mime["']/.test(fs.readFileSync(f, "utf8")))
      .map((f) => path.relative(SRC, f).split(path.sep).join("/"));
    expect(importers).toEqual(["lib/cockpit/send.ts"]);
  });

  describe("the walker catches violations (fixture tree)", () => {
    let tmp: string;
    const write = (rel: string, code: string) => {
      const p = path.join(tmp, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, code);
      return p;
    };
    beforeEach(() => {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-graph-"));
      write("lib/cockpit/send.ts", 'import "server-only";\nexport const x = 1;\n');
      write("lib/cockpit/gmail/client.ts", "export const y = 1;\n");
    });
    afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

    it.each([
      ["static @/ alias", 'import { x } from "@/lib/cockpit/send";'],
      ["relative path", 'import { x } from "../cockpit/send";'],
      ["dynamic import()", 'export const f = () => import("../cockpit/send");'],
      ["export-from", 'export { y } from "@/lib/cockpit/gmail/client";'],
    ])("direct: %s", (_name, code) => {
      const entry = write("lib/mcp/tool.ts", code);
      expect(violations([entry], tmp)).toHaveLength(1);
    });

    it("transitive: mcp → helper → send", () => {
      write("lib/cockpit/helper.ts", 'import("./send");');
      const entry = write("lib/mcp/tool.ts", 'import "@/lib/cockpit/helper";');
      const found = violations([entry], tmp);
      expect(found).toEqual([
        "lib/mcp/tool.ts -> lib/cockpit/helper.ts -> lib/cockpit/send.ts",
      ]);
    });

    it("a clean tree has no violation", () => {
      write("lib/cockpit/packages.ts", "export const p = 1;");
      const entry = write("lib/mcp/tool.ts", 'import { p } from "@/lib/cockpit/packages";');
      expect(violations([entry], tmp)).toEqual([]);
    });
  });
});
