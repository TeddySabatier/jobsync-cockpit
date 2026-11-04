// @vitest-environment node
import { dedupeKey, mechanicalCheck } from "../../scripts/qa/verify.ts";
import type { Finding } from "../../scripts/qa/verify.ts";

const FILE = "src/a.ts";
const SRC = [
  "import x from 'x';",
  "",
  "export function save(userId: string, id: string) {",
  "  const pkg = db.find(id);",
  "  return db.update({ where: { id } });",
  "}",
].join("\n");
const read = (_root: string, rel: string) => (rel === FILE ? SRC : null);

function finding(over: Partial<Finding> = {}): Finding {
  return {
    id: "t1",
    lens: "L1",
    severity: "P1",
    file: FILE,
    startLine: 4,
    endLine: 5,
    quote: "const pkg = db.find(id);\nreturn db.update({ where: { id } });",
    claim: "update is not scoped by userId so another user can modify the record",
    failureScenario: "user B calls save('b', 'pkg-of-a') and the update succeeds",
    suggestedTest: "",
    suggestedFix: "",
    confidence: 0.8,
    ...over,
  };
}
const check = (f: Finding) => mechanicalCheck(f, "/repo", read);

describe("mechanicalCheck", () => {
  it("accepts an exact quote (whitespace-insensitive per line)", () => {
    const r = check(finding());
    expect(r.ok).toBe(true);
    expect(r.actualStart).toBe(4);
  });

  it("accepts a quote with copied line-number prefixes", () => {
    const r = check(finding({ quote: "4|   const pkg = db.find(id);\n5|   return db.update({ where: { id } });" }));
    expect(r.ok).toBe(true);
  });

  it("rejects a fabricated quote", () => {
    const r = check(finding({ quote: "const pkg = db.findUnique(id);" }));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("quote-not-found");
  });

  it("rejects a quote that exists only outside the +-15 line window", () => {
    const big = Array.from({ length: 100 }, (_, i) => `line${i}`);
    big[80] = "const secret = 1;";
    const r = mechanicalCheck(
      finding({ quote: "const secret = 1;", startLine: 10, endLine: 10 }),
      "/repo",
      () => big.join("\n"),
    );
    expect(r.ok).toBe(false);
  });

  it("rejects a missing file", () => {
    const r = check(finding({ file: "src/missing.ts" }));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("file-not-in-head");
  });

  it("rejects short claims and non-concrete scenarios", () => {
    expect(check(finding({ claim: "bad" })).ok).toBe(false);
    expect(check(finding({ failureScenario: "something somehow goes wrong badly here for people" })).reason).toBe(
      "scenario-not-concrete",
    );
  });
});

describe("dedupeKey", () => {
  it("normalizes whitespace, case and line prefixes", () => {
    expect(dedupeKey(finding({ quote: "A   b\n  C" }))).toBe(dedupeKey(finding({ quote: "1| a b\n2| c" })));
    expect(dedupeKey(finding({ lens: "L2" }))).not.toBe(dedupeKey(finding()));
  });
});
