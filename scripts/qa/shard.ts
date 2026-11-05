import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { ROOT, headFile, splitLines } from "./git.ts";

export type Shard = {
  id: string;
  file: string;
  startLine: number;
  endLine: number;
  /** "123| code" per line, absolute 1-based file line numbers */
  text: string;
};

const SURFACE = [
  "src/lib/cockpit/**",
  "src/lib/mcp/**",
  "src/actions/cockpit*.actions.ts",
  "src/actions/mcpToken.actions.ts",
  "src/app/api/cockpit/**",
  "src/app/api/mcp/**",
  "src/app/dashboard/review/**",
  "src/components/cockpit/**",
  "next.config.mjs",
  "src/middleware.ts",
  "prisma/schema.prisma",
  "prisma/migrations/20261104120000_cockpit_v0/migration.sql",
];

function globRe(g: string): RegExp {
  const src = g
    .replace(/[.+^${}()|[\]\\?]/g, "\\$&")
    .replace(/\*\*/g, "\0")
    .replace(/\*/g, "[^/]*")
    .replace(/\0/g, ".*");
  return new RegExp(`^${src}$`);
}

export function listSurface(extra: string[] = [], root: string = ROOT): string[] {
  const out = execFileSync("git", ["ls-files"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  const res = [...SURFACE, ...extra].map(globRe);
  return out
    .split("\n")
    .filter((f) => f && res.some((re) => re.test(f)))
    .sort();
}

const DECL =
  /^(export\b|function\b|async function\b|const\b|let\b|class\b|interface\b|type\b|describe\(|it\(|model\s|CREATE\s)/;

/** True when a chunk may start at line index i (0-based). */
function isBoundary(lines: string[], i: number): boolean {
  if (DECL.test(lines[i])) return true;
  return i >= 2 && lines[i - 1].trim() === "" && lines[i - 2].startsWith("}");
}

/** Chunk ranges as [startIdx, endIdxExclusive) over 0-based line indexes. */
export function chunkRanges(
  lines: string[],
  maxLines: number,
  seed: number,
): Array<[number, number]> {
  const max = Math.max(1, Math.floor(maxLines));
  const n = lines.length;
  const out: Array<[number, number]> = [];
  const half = Math.max(1, Math.floor(max / 2));
  const offset = (Math.abs(seed) * 37) % half;
  let pos = 0;
  let target = Math.max(1, max - offset);
  while (pos < n) {
    let end = Math.min(pos + target, n);
    if (end < n) {
      const minCut = pos + Math.max(1, Math.floor(target / 2));
      for (let i = end; i >= minCut; i--) {
        if (isBoundary(lines, i)) {
          end = i;
          break;
        }
      }
    }
    out.push([pos, end]);
    pos = end;
    target = max;
  }
  return out;
}

export function makeShards(
  files: string[],
  maxLines: number,
  seed: number,
  read: (rel: string) => string | null = (rel) => headFile(ROOT, rel),
): Shard[] {
  const shards: Shard[] = [];
  for (const file of files) {
    const content = read(file);
    if (content === null) continue;
    const lines = splitLines(content);
    for (const [s, e] of chunkRanges(lines, maxLines, seed)) {
      const text = lines
        .slice(s, e)
        .map((l, k) => `${s + k + 1}| ${l}`)
        .join("\n");
      shards.push({ id: `${file}#${s + 1}-${e}`, file, startLine: s + 1, endLine: e, text });
    }
  }
  return shards;
}

const STOP = new Set([
  "index", "route", "page", "layout", "actions", "action", "client", "utils", "types",
  "lib", "src", "cockpit", "api", "app", "dashboard", "components", "component",
  "migration", "prisma", "schema", "test", "tests",
]);

function keywords(file: string): string[] {
  const base = basename(file).replace(/\.[^.]+$/, "");
  const parent = basename(dirname(file));
  return [
    ...new Set(
      `${parent} ${base}`
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .split(/[^A-Za-z0-9]+/)
        .map((w) => w.toLowerCase())
        .filter((w) => w.length >= 4 && !STOP.has(w)),
    ),
  ];
}

function readIfExists(p: string): string[] {
  return existsSync(p) ? splitLines(readFileSync(p, "utf8")) : [];
}

function specSection10(spec: string[]): string[] {
  const startIdx = spec.findIndex((l) => /^#{1,6}\s*(§\s*)?10[.\s):-]/.test(l));
  if (startIdx < 0) return [];
  const level = spec[startIdx].match(/^#+/)?.[0].length ?? 2;
  const out: string[] = [];
  for (let i = startIdx + 1; i < spec.length; i++) {
    const h = spec[i].match(/^(#+)\s/);
    if (h && h[1].length <= level) break;
    out.push(spec[i]);
  }
  return out;
}

export function contextPack(file: string, root: string = ROOT): string {
  const src = headFile(root, file) ?? "";
  const imports = splitLines(src).filter((l) => /^import\b|^\}\s*from\s/.test(l));
  const kws = keywords(file);
  const spec = specSection10(readIfExists(join(root, "cockpit/SPEC.md")))
    .filter((l) => {
      const low = l.toLowerCase();
      return l.trim() !== "" && kws.some((k) => low.includes(k));
    })
    .slice(0, 60);
  const decisions = readIfExists(join(root, "cockpit/DECISIONS.md"))
    .filter((l) => l.startsWith("#") || l.startsWith("| D-"))
    .slice(0, 120);
  const nonIssues = [
    ...readIfExists(join(root, "cockpit/qa/REJECTED.md")),
    ...readIfExists(join(root, ".cockpit-tmp/known-non-issues.txt")),
  ]
    .filter((l) => l.trim() !== "")
    .slice(0, 40);
  const sec = (title: string, ls: string[]) =>
    ls.length ? `### ${title}\n${ls.join("\n")}\n` : "";
  return [
    sec(`Imports of ${file}`, imports),
    sec("SPEC section 10 (acceptance criteria) lines relevant to this file", spec),
    sec("DECISIONS (headings)", decisions),
    sec("Known non-issues (do NOT report these)", nonIssues),
  ]
    .filter(Boolean)
    .join("\n");
}
