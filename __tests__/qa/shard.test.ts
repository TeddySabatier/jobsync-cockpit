// @vitest-environment node
import { chunkRanges, makeShards } from "../../scripts/qa/shard.ts";

function synthetic(n: number): string[] {
  const lines: string[] = [];
  let i = 0;
  while (lines.length < n) {
    lines.push(`export function f${i}() {`, "  const a = 1;", "  return a;", "}", "");
    i++;
  }
  return lines.slice(0, n);
}

describe("chunkRanges", () => {
  it.each([1, 7, 50, 120])("no chunk exceeds max and every line is covered once (max %i)", (max) => {
    const lines = synthetic(503);
    for (const seed of [0, 1, 2, 5]) {
      const ranges = chunkRanges(lines, max, seed);
      let pos = 0;
      for (const [s, e] of ranges) {
        expect(s).toBe(pos);
        expect(e).toBeGreaterThan(s);
        expect(e - s).toBeLessThanOrEqual(max);
        pos = e;
      }
      expect(pos).toBe(lines.length);
    }
  });

  it("seed changes the boundaries", () => {
    const lines = synthetic(600);
    const a = chunkRanges(lines, 100, 0).map((r) => r[1]);
    const b = chunkRanges(lines, 100, 1).map((r) => r[1]);
    expect(a).not.toEqual(b);
  });

  it("cuts at declarations when possible", () => {
    const lines = synthetic(300);
    const ranges = chunkRanges(lines, 100, 0);
    for (const [, e] of ranges.slice(0, -1)) expect(lines[e]).toMatch(/^export function/);
  });

  it("empty input gives no ranges", () => {
    expect(chunkRanges([], 10, 0)).toEqual([]);
  });
});

describe("makeShards", () => {
  it("numbers lines with absolute 1-based numbers and skips unreadable files", () => {
    const content = synthetic(30).join("\n") + "\n";
    const shards = makeShards(["a.ts", "gone.ts"], 10, 0, (f) => (f === "a.ts" ? content : null));
    expect(shards.every((s) => s.file === "a.ts")).toBe(true);
    expect(shards[0].startLine).toBe(1);
    expect(shards[0].text.split("\n")[0]).toBe("1| export function f0() {");
    const last = shards[shards.length - 1];
    expect(last.endLine).toBe(30);
    expect(last.text.split("\n").at(-1)?.startsWith("30| ")).toBe(true);
  });
});
