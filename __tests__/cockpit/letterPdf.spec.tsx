// @vitest-environment node
import fs from "fs";
import { extractText, getDocumentProxy } from "unpdf";
import { renderLetterPdf, toWinAnsi } from "@/lib/cockpit/letterPdf";
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
    expect(toWinAnsi("é à ç ’ – “x” €")).toBe("é à ç ’ – “x” €");
    expect(toWinAnsi("ok → next \u{1F600} ≥ 3")).toBe("ok -> next  >= 3");
    const text = await textOf(await renderLetterPdf({ letterMd: "Café d’été → fin" }));
    expect(text).toContain("Café d’été");
  });

  it("never turns letter markup into links or images", async () => {
    const text = await textOf(
      await renderLetterPdf({ letterMd: "See [click](https://evil.example/x) and ![img](https://evil.example/i.png)" }),
    );
    expect(text).toContain("https://evil.example/x");
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

  it("keeps Latin letters the font lacks as their base letter, and shows other alphabets as ?", async () => {
    expect(toWinAnsi("Łukasz Wałęsa, Dvořák, Őry, Pań")).toBe("Lukasz Walesa, Dvorák, Ory, Pan");
    expect(toWinAnsi("Ελληνικά Москва")).toBe("???????? ??????");
    const text = await textOf(await renderLetterPdf({ letterMd: "Szanowni Państwo, Łukasz" }));
    expect(text).toContain("Szanowni Panstwo, Lukasz");
  });

  it("turns typographic spaces and hyphens into plain ones, so words never run together", async () => {
    expect(toWinAnsi("99,9 %")).toBe("99,9 %");
    expect(toWinAnsi("a b c")).toBe("a b c");
    expect(toWinAnsi("e‑mail‐x")).toBe("e-mail-x");
    expect(toWinAnsi("a​b­c")).toBe("abc");
    expect(toWinAnsi("a → b ≥ c")).toBe("a -> b >= c");
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
