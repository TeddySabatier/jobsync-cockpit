// @vitest-environment node
import { extractJson } from "../../scripts/qa/json.ts";

describe("extractJson", () => {
  it("parses plain JSON", () => {
    expect(extractJson('{"findings":[]}')).toEqual({ findings: [] });
  });

  it("parses fenced JSON", () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it("skips a chatter prefix and suffix, even with braces in the chatter", () => {
    expect(extractJson('Sure! Here is the {result} you wanted:\n{"a":{"b":"}"},"c":[1,2]}\nHope it helps.')).toEqual({
      a: { b: "}" },
      c: [1, 2],
    });
  });

  it("parses a top-level array", () => {
    expect(extractJson("Here: [1,2,3]")).toEqual([1, 2, 3]);
  });

  it("returns undefined for invalid input", () => {
    expect(extractJson("no json here")).toBeUndefined();
    expect(extractJson('{"a":')).toBeUndefined();
  });
});
