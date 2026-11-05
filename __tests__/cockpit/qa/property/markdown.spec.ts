// @vitest-environment node
import fc from "fast-check";
import { renderLetterMarkdown } from "@/lib/cockpit/markdown";
import { fcParams, tag } from "./_fc";

// Property 4 (AC-41): no link, image, script, iframe or event handler is ever emitted.
// A `javascript:` / `onerror=` substring may remain as inert TEXT (the spec says a
// disabled link "stays as inert text"), so attributes are checked per tag, not by substring.
const frag = fc.constantFrom(
  "[x](javascript:alert(1))", "![x](http://example.com/a.png)", "<a href=\"javascript:x\">k</a>",
  "<img src=x onerror=alert(1)>", "<script>alert(1)</script>", "<IFRAME src=//example.com>",
  "<https://example.com>", "https://example.com", "javascript:alert(1)", "onclick=alert(1)",
  "```\"onmouseover=\"x\n<a>\n```", "```js onload=1\ncode\n```", "[ref]: javascript:x\n\n[ref]",
  "<svg/onload=alert(1)>", "&lt;a&gt;", "&#x3C;a href=x&#x3E;", "\\<a>", "<A HREF=x>",
  "| a | b |\n|---|:-:|\n| <a> | ![i](x) |", "# h", "> q", "- li", "1. li", "**b** _i_ `c`",
  "\n", "\n\n", "\u0000", "<", ">", "\"", "'",
);
const input = fc.oneof(
  fc.string({ unit: "binary", maxLength: 200 }),
  fc.string({ unit: "grapheme", maxLength: 200 }),
  fc.array(fc.oneof(frag, fc.string({ maxLength: 6 })), { maxLength: 12 }).map((a) => a.join("")),
);

const ALLOWED_TAGS = new Set([
  "p", "br", "ul", "ol", "li", "em", "strong", "s", "code", "pre", "blockquote", "hr",
  "h1", "h2", "h3", "h4", "h5", "h6", "table", "thead", "tbody", "tr", "th", "td",
]);
const ALLOWED_ATTRS = new Set(["class", "start", "style"]);

describe(tag("renderLetterMarkdown properties"), () => {
  it("emits only inert, attribute-safe tags for any input", () => {
    fc.assert(
      fc.property(input, (text) => {
        const html = renderLetterMarkdown(text);
        expect(html).not.toMatch(/<\s*(a|img|script|iframe|svg|object|embed|form|style|link)\b/i);
        for (const m of html.matchAll(/<[^>]*>/g)) {
          const t = /^<\/?([a-z0-9]+)((?:\s+[a-z-]+(?:="[^"]*")?)*)\s*\/?>$/.exec(m[0]);
          expect(t, `unexpected tag shape: ${m[0]}`).not.toBeNull();
          expect(ALLOWED_TAGS.has(t![1]), `tag ${t![1]}`).toBe(true);
          for (const a of t![2].matchAll(/\s+([a-z-]+)/g)) {
            expect(ALLOWED_ATTRS.has(a[1]), `attribute ${a[1]}`).toBe(true);
          }
        }
        // `<` never survives outside a tag.
        expect(html.replace(/<[^>]*>/g, "")).not.toContain("<");
      }),
      fcParams(),
    );
  });

  it("empty input renders empty", () => {
    expect(renderLetterMarkdown("")).toBe("");
  });
});
