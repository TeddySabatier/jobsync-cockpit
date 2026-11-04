// @vitest-environment node
import fc from "fast-check";
import { sanitizePdfName } from "@/lib/cockpit/attachments";
import { fcParams, tag } from "./_fc";

// Property 5 (SPEC §3): the stored display name is a safe, bounded `*.pdf`.
vi.mock("@/lib/db", () => ({ default: {} }));

const name = fc.oneof(
  fc.string({ unit: "binary", maxLength: 300 }),
  fc.string({ unit: "grapheme", maxLength: 300 }),
  fc.array(fc.constantFrom("/", "\\", "\u0000", "\r", "\n", '"', "'", "..", ".pdf", ".PDF", "é", " ", "a"), { maxLength: 40 }).map((a) => a.join("")),
  fc.constantFrom("", ".pdf", "..pdf", "...", "../../etc/passwd", "a.pdf.pdf"),
);

describe(tag("sanitizePdfName properties"), () => {
  it("is safe, non-empty, bounded, ends with .pdf and is idempotent", () => {
    fc.assert(
      fc.property(name, (input) => {
        const out = sanitizePdfName(input);
        expect(out).not.toMatch(/[/\\\u0000\r\n"']/);
        expect(out).toMatch(/^[A-Za-z0-9._-]+$/);
        expect(out.endsWith(".pdf")).toBe(true);
        expect(out.length).toBeGreaterThan(".pdf".length);
        expect(out.length).toBeLessThanOrEqual(104);
        expect(out.startsWith(".")).toBe(false);
        expect(sanitizePdfName(out)).toBe(out);
      }),
      fcParams(),
    );
  });
});
