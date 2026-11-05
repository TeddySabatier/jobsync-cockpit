import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const TMP = resolve(ROOT, ".cockpit-tmp");

const cache = new Map<string, { at: number; content: string | null }>();
const TTL_MS = 5 * 60 * 1000;

/** File content at HEAD, or null when the path is not tracked in HEAD. Cached 5 min. */
export function headFile(root: string, rel: string): string | null {
  const k = root + "\0" + rel;
  const hit = cache.get(k);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.content;
  let content: string | null = null;
  try {
    content = execFileSync("git", ["show", `HEAD:${rel}`], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    content = null;
  }
  cache.set(k, { at: Date.now(), content });
  return content;
}

export function splitLines(content: string): string[] {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}
