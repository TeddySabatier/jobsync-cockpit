// @vitest-environment node
import fs from "fs";
import { extractText, getDocumentProxy } from "unpdf";
import { Font } from "@react-pdf/renderer";
import path from "path";
// @ts-expect-error fontkit ships no types; it is react-pdf's own font parser
import * as fontkit from "fontkit";
import { FONT_DIR, FONT_RANGES, renderLetterPdf, toPdfText } from "@/lib/cockpit/letterPdf";
import { letterPdfName } from "@/lib/cockpit/letterName";
import { buildMimeMessage } from "@/lib/cockpit/gmail/mime";

const LETTER = [
  "Dear Hiring Team,",
  "",
  "Your platform team runs **Kafka** and *Terraform* on Google Cloud, which is exactly where I spent the last two years: élevé à 99,9 % d’uptime.",
  "",
  "- Cut the release time from 40 to 12 minutes",
  "- Moved 30 services to infrastructure as code",
  "",
  "Best regards,",
  "",
  "Jane Doe",
  "+00 0 00 00 00 00 · jane@example.com",
].join("\n");

const CV_JSON = JSON.stringify({
  name: "Jane Doe",
  title: "Platform Engineer",
  contact: ["jane@example.com", "+00 0 00 00 00 00", "Geneva"],
});

async function textOf(pdf: Buffer): Promise<string> {
  const doc = await getDocumentProxy(new Uint8Array(pdf));
  const { text } = await extractText(doc, { mergePages: true });
  return text;
}

describe("renderLetterPdf", () => {
  it("makes a real PDF that holds the letterhead and the letter text", async () => {
    const pdf = await renderLetterPdf({ letterMd: LETTER, cvJson: CV_JSON });
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    if (process.env.LETTER_PDF_SAMPLE) fs.writeFileSync(process.env.LETTER_PDF_SAMPLE, pdf);
    const text = await textOf(pdf);
    expect(text).toContain("Jane Doe");
    expect(text).toContain("Platform Engineer");
    expect(text).toContain("jane@example.com");
    expect(text).toContain("Dear Hiring Team,");
    expect(text).toContain("Kafka");
    expect(text).toContain("Cut the release time from 40 to 12 minutes");
    expect(text).toContain("Best regards,");
    expect(text).not.toContain("**");
  });

  it("renders without a letterhead when the CV data is missing or broken", async () => {
    for (const cvJson of [null, "", "not json", JSON.stringify({ title: "no name" })]) {
      const text = await textOf(await renderLetterPdf({ letterMd: "Hello there", cvJson }));
      expect(text).toContain("Hello there");
      expect(text).not.toContain("no name");
    }
  });

  it("keeps accents and typographic quotes, drops glyphs the PDF font cannot draw", async () => {
    expect(toPdfText("é à ç ’ – “x” €")).toBe("é à ç ’ – “x” €");
    expect(toPdfText("ok → next \u{1F600} ≥ 3")).toBe("ok -> next  >= 3");
    const text = await textOf(await renderLetterPdf({ letterMd: "Café d’été → fin" }));
    expect(text).toContain("Café d’été");
  });

  it("never turns letter markup into links or images", async () => {
    const pdf = await renderLetterPdf({
      letterMd: "See [click](https://evil.example/x) and ![img](https://evil.example/i.png) and https://evil.example/bare",
    });
    expect(await textOf(pdf)).toContain("https://evil.example/x");
    // The URL is plain text, not a link: the page carries no link annotation.
    const doc = await getDocumentProxy(new Uint8Array(pdf));
    const annotations = await (await doc.getPage(1)).getAnnotations();
    expect(annotations.filter((a: { subtype?: string }) => a.subtype === "Link")).toEqual([]);
  });

  it("keeps a reference-definition line in the PDF, like the HTML preview (D-018 e)", async () => {
    const text = await textOf(
      await renderLetterPdf({
        letterMd: "See my work [1].\n\n[1]: https://portfolio.example/jane",
      }),
    );
    expect(text).toContain("[1]: https://portfolio.example/jane");
  });

  it("flows a long letter onto more pages instead of cutting it", async () => {
    const long = Array.from({ length: 60 }, (_, i) => `Paragraph ${i + 1} ${"word ".repeat(40)}`).join("\n\n");
    const pdf = await renderLetterPdf({ letterMd: long, cvJson: CV_JSON });
    const doc = await getDocumentProxy(new Uint8Array(pdf));
    expect(doc.numPages).toBeGreaterThan(1);
    expect(await textOf(pdf)).toContain("Paragraph 60");
  });
});

describe("renderLetterPdf: nothing is lost silently (review findings)", () => {
  it("breaks a very long unbroken word instead of cutting it at the margin", async () => {
    const url = "https://example.com/portfolio/" + "a".repeat(100) + "/END-MARK";
    for (const md of [`See ${url} now`, `- ${url}`]) {
      // The PDF engine adds a hyphen where it breaks a word; the text is all there.
      const flat = (await textOf(await renderLetterPdf({ letterMd: md }))).replace(/[-\s]+/g, "");
      expect(flat).toContain(url.replace(/-/g, ""));
    }
    const huge = "x".repeat(5000);
    const flat = (await textOf(await renderLetterPdf({ letterMd: huge }))).replace(/[-\s]+/g, "");
    expect(flat.length).toBe(5000);
  });

  it("still breaks long words when another callback was registered in the same process (D-022 g)", async () => {
    // react-pdf keeps one process-wide callback. Any code in the same process
    // (another test, future server code) may register its own, e.g. (w) => [w].
    Font.registerHyphenationCallback((word) => [word]);
    const huge = "y".repeat(5000);
    const flat = (await textOf(await renderLetterPdf({ letterMd: huge }))).replace(/[-\s]+/g, "");
    expect(flat.length).toBe(5000);
  });

  it("lets a long bullet flow over a page break", async () => {
    const bullet = `- ${"word ".repeat(1500)}LAST-WORD`;
    expect(await textOf(await renderLetterPdf({ letterMd: bullet }))).toContain("LAST-WORD");
  });

  it("keeps indented and fenced code as plain text", async () => {
    const text = await textOf(
      await renderLetterPdf({ letterMd: "Intro\n\n    INDENTED-CODE\n\n```\nFENCED-CODE\nsecond line\n```\n\nOutro" }),
    );
    for (const s of ["INDENTED-CODE", "FENCED-CODE", "second line", "Outro"]) expect(text).toContain(s);
  });

  it("draws Polish, Czech, Greek and Cyrillic letters; shows CJK as ? (D-026)", async () => {
    expect(toPdfText("Łukasz Wałęsa, Dvořák, Őry, Pań")).toBe("Łukasz Wałęsa, Dvořák, Őry, Pań");
    expect(toPdfText("Ελληνικά Москва")).toBe("Ελληνικά Москва");
    expect(toPdfText("日本語 한국어 ア")).toBe("??? ??? ?");
    const text = await textOf(await renderLetterPdf({ letterMd: "Hello 日本語 world" }));
    expect(text).toContain("Hello ??? world");
  });
  it("turns typographic spaces and hyphens into plain ones, so words never run together", async () => {
    expect(toPdfText("99,9 %")).toBe("99,9 %");
    expect(toPdfText("a b c")).toBe("a b c");
    expect(toPdfText("e‑mail‐x")).toBe("e-mail-x");
    expect(toPdfText("a​b­c")).toBe("abc");
    expect(toPdfText("a → b ≥ c")).toBe("a -> b >= c");
  });

  it("numbers nested ordered lists correctly and honours the start number", async () => {
    const text = await textOf(
      await renderLetterPdf({ letterMd: "1. one\n2. two\n   - sub\n3. three\n\nBreak\n\n5. five\n6. six" }),
    );
    const flat = text.replace(/\s+/g, " ");
    expect(flat).toMatch(/1\. one 2\. two .*sub 3\. three/);
    expect(flat).toContain("5. five 6. six");
  });
});

describe("renderLetterPdf: embedded Noto Sans (D-026)", () => {
  const POLISH = "Zażółć gęślą jaźń, Łukasz Wałęsa, Dąbrowski";
  const CZECH = "Příliš žluťoučký kůň úpěl ďábelské ódy, Dvořák";
  const GREEK = "Αγαπητοί κύριοι, Ελληνικά ΩΏΊ ά έ ή ί ό ύ ώ";
  const CYRILLIC = "Уважаемые господа, Москва Ёё Щщ Юю Ґґ Її";

  it("round-trips Polish, Czech, Greek and Cyrillic through the PDF text layer", async () => {
    const letterMd = [POLISH, CZECH, GREEK, CYRILLIC].map((s, i) => (i === 1 ? `**${s}**` : i === 2 ? `*${s}*` : s)).join("\n\n");
    const text = await textOf(await renderLetterPdf({ letterMd }));
    for (const s of [POLISH, CZECH, GREEK, CYRILLIC]) expect(text).toContain(s);
    expect(text).not.toContain("?");
  });

  it("draws the letterhead, bold-italic, bullets and code in the same font", async () => {
    const cvJson = JSON.stringify({ name: "Łukasz Ωμέγα Петров", title: "Ingénieur Σύστημα", contact: ["Zürich", "Köln"] });
    const letterMd = `# Ελληνικά\n\n***Петров Łódź***\n\n- Příliš\n- Ωμέγα\n\n    код Ωμέγα\n`;
    const text = await textOf(await renderLetterPdf({ letterMd, cvJson }));
    for (const s of ["Łukasz Ωμέγα Петров", "Ingénieur Σύστημα", "Zürich", "Ελληνικά", "Петров Łódź", "Příliš", "Ωμέγα", "код Ωμέγα"]) {
      expect(text).toContain(s);
    }
    expect(text).not.toContain("?");
  });

  it("round-trips every drawable code point in all four faces", async () => {
    const chars: string[] = [];
    for (const [lo, hi] of FONT_RANGES) for (let c = Math.max(lo, 0x21); c <= hi; c++) if (c !== 0xad && c !== 0xa0) chars.push(String.fromCodePoint(c));
    const words: string[] = [];
    for (let i = 0; i < chars.length; i += 1) words.push(chars[i]);
    const plain = words.join(" ");
    const letterMd = [plain, `**${plain}**`, `*${plain}*`, `***${plain}***`].join("\n\n");
    // Markdown escapes would change the text: only compare the characters that
    // are not markdown syntax.
    const syntax = new Set("\\`*_{}[]()#+-.!|<>&~^:\"'=/$%@;,?".split(""));
    const text = (await textOf(await renderLetterPdf({ letterMd, cvJson: CV_JSON }))).normalize("NFC");
    const missing = chars.filter((ch) => !syntax.has(ch) && !text.includes((ch === "µ" ? "μ" : toPdfText(ch)).normalize("NFC")));
    expect(missing.map((m) => m.codePointAt(0)!.toString(16))).toEqual([]);
  });

  it("is not affected by earlier letters in the same process (shared glyph cache)", async () => {
    await renderLetterPdf({ letterMd: `**${CZECH}**\n\n***${GREEK}***`, cvJson: JSON.stringify({ name: "Ñandú Zzz" }) });
    const cvJson = JSON.stringify({ name: "Łukasz Ωμέγα Петров" });
    const text = await textOf(await renderLetterPdf({ letterMd: "**Zażółć** zz", cvJson }));
    expect(text).toContain("Łukasz Ωμέγα Петров");
    expect(text).toContain("Zażółć zz");
  });

  it("leaves the process-wide font registry as it found it, after a render and after a failed one", async () => {
    const before = Object.keys(Font.getRegisteredFonts()).sort();
    await renderLetterPdf({ letterMd: "Zażółć **x**", cvJson: CV_JSON });
    expect(Object.keys(Font.getRegisteredFonts()).sort()).toEqual(before);
    await expect(renderLetterPdf({ letterMd: null as unknown as string })).rejects.toThrow();
    expect(Object.keys(Font.getRegisteredFonts()).sort()).toEqual(before);
  });

  it("embeds the matching face for regular, bold, italic and bold italic text", async () => {
    const faces = async (letterMd: string) => {
      // The embedded subset font names are plain text in the PDF (ABCDEF+NotoSans-Bold).
      const raw = (await renderLetterPdf({ letterMd })).toString("latin1");
      return [...new Set([...raw.matchAll(/[A-Z]{6}\+(NotoSans-[A-Za-z]+)/g)].map((m) => m[1]))].sort();
    };
    expect(await faces("plain")).toEqual(["NotoSans-Regular"]);
    expect(await faces("**bold**")).toEqual(["NotoSans-Bold"]);
    expect(await faces("*italic*")).toEqual(["NotoSans-Italic"]);
    expect(await faces("***both***")).toEqual(["NotoSans-BoldItalic"]);
  });

  it("keeps every letter intact when renders overlap (preview and send at once)", async () => {
    const samples = [POLISH, CZECH, GREEK, CYRILLIC, "Café d’été « oui » 12 €"];
    for (let round = 0; round < 3; round++) {
      const texts = await Promise.all(
        samples.map(async (s, i) =>
          textOf(await renderLetterPdf({ letterMd: `**${s}**\n\n*${samples[(i + 1) % 5]}*`, cvJson: JSON.stringify({ name: samples[(i + 2) % 5] }) })),
        ),
      );
      texts.forEach((t, i) => {
        for (const s of [samples[i], samples[(i + 1) % 5], samples[(i + 2) % 5]]) expect(t.replace(/\s+/g, " ")).toContain(s);
      });
    }
  });

  it("registers all four faces, and the shipped font covers every code point the filter lets through", () => {
    for (const f of ["Regular", "Bold", "Italic", "BoldItalic"]) {
      const font = fontkit.openSync(path.join(FONT_DIR, `NotoSans-${f}.ttf`)) as unknown as {
        hasGlyphForCodePoint(c: number): boolean;
      };
      const missing: string[] = [];
      for (const [lo, hi] of FONT_RANGES) {
        for (let c = lo; c <= hi; c++) if (!font.hasGlyphForCodePoint(c)) missing.push(c.toString(16));
      }
      expect(missing, `${f} lacks ${missing.join(",")}`).toEqual([]);
    }
    const licence = fs.readFileSync(path.join(FONT_DIR, "OFL.txt"), "utf8");
    expect(licence).toContain("SIL OPEN FONT LICENSE Version 1.1");
  });

  it("keeps the PDF small and the render fast (cost bounds)", async () => {
    const letterMd = Array.from({ length: 12 }, () => `${POLISH}. ${GREEK}. ${CYRILLIC}. **bold** *italic* ${"lorem ipsum ".repeat(20)}`).join("\n\n");
    await renderLetterPdf({ letterMd, cvJson: CV_JSON }); // warm-up: font parsing
    const t0 = performance.now();
    const pdf = await renderLetterPdf({ letterMd, cvJson: CV_JSON });
    const ms = performance.now() - t0;
    // Fonts are subset into the PDF, not embedded whole: four 230 KB files
    // would make a PDF of more than 900 KB.
    expect(pdf.length).toBeLessThan(250_000);
    expect(ms).toBeLessThan(4000);
    if (process.env.LETTER_PDF_COST) console.log(`letter PDF ${pdf.length} bytes, ${ms.toFixed(0)} ms`);
  });
});

describe("letterPdfName", () => {
  it("pairs with the CV file name", () => {
    expect(letterPdfName("Jane_Doe_CV_Acme.pdf")).toBe("Jane_Doe_Cover_Letter_Acme.pdf");
    expect(letterPdfName("Jane-CV.pdf")).toBe("Jane-Cover_Letter.pdf");
    expect(letterPdfName("resume.pdf")).toBe("resume_Cover_Letter.pdf");
    expect(letterPdfName(null)).toBe("Cover_Letter.pdf");
    expect(letterPdfName("")).toBe("Cover_Letter.pdf");
  });
});

describe("buildMimeMessage with a second attachment", () => {
  it("carries both PDFs in one multipart message", () => {
    const mime = buildMimeMessage({
      from: "me@example.com",
      to: "hr@example.com",
      subject: "Application",
      bodyText: "Hello",
      attachment: { fileName: "CV.pdf", content: Buffer.from("%PDF-cv") },
      extraAttachments: [{ fileName: "Cover_Letter.pdf", content: Buffer.from("%PDF-letter") }],
    });
    expect(mime).toContain('filename="CV.pdf"');
    expect(mime).toContain('filename="Cover_Letter.pdf"');
    expect(mime.match(/Content-Type: application\/pdf/g)).toHaveLength(2);
    expect(mime.indexOf("CV.pdf")).toBeLessThan(mime.indexOf("Cover_Letter.pdf"));
  });
  it("rejects an extra attachment with an unsafe name", () => {
    expect(() =>
      buildMimeMessage({
        from: "me@example.com",
        to: "hr@example.com",
        subject: "x",
        bodyText: "y",
        attachment: { fileName: "CV.pdf", content: Buffer.from("a") },
        extraAttachments: [{ fileName: 'a"b.pdf', content: Buffer.from("b") }],
      }),
    ).toThrow("Invalid attachment name");
  });
});
