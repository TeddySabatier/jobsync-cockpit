import { collectCvLeaves, formatCvPath, setCvLeaf } from "@/lib/cockpit/cvLeaves";

const cv = {
  name: "Jane Doe",
  years: 7,
  open: true,
  experience: [
    { role: "Engineer", bullets: ["Built A", "Built B"] },
    { role: "Intern", bullets: [] },
  ],
  nothing: null,
};

describe("cvLeaves", () => {
  it("lists only string leaves, labelled with their JSON path", () => {
    expect(collectCvLeaves(cv).map((l) => [l.path, l.value])).toEqual([
      ["name", "Jane Doe"],
      ["experience[0].role", "Engineer"],
      ["experience[0].bullets[0]", "Built A"],
      ["experience[0].bullets[1]", "Built B"],
      ["experience[1].role", "Intern"],
    ]);
  });

  it("formats paths", () => {
    expect(formatCvPath(["a", 0, "b", 2])).toBe("a[0].b[2]");
  });

  it("replaces one leaf without touching the rest or the input", () => {
    const leaf = collectCvLeaves(cv).find(
      (l) => l.path === "experience[0].bullets[1]",
    )!;
    const next = setCvLeaf(cv, leaf.segments, "Changed") as typeof cv;
    expect(next.experience[0].bullets).toEqual(["Built A", "Changed"]);
    expect(next.years).toBe(7);
    expect(next.nothing).toBeNull();
    expect(cv.experience[0].bullets[1]).toBe("Built B");
  });

  it("keeps a __proto__ key as plain data", () => {
    const evil = JSON.parse('{"__proto__": "x"}');
    const next = setCvLeaf(evil, ["__proto__"], "y") as Record<string, unknown>;
    expect(Object.keys(next)).toEqual(["__proto__"]);
    expect(Object.getPrototypeOf(next)).toBe(Object.prototype);
  });
});
