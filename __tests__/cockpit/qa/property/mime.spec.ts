// @vitest-environment node
import fc from "fast-check";
import { buildMimeMessage } from "@/lib/cockpit/gmail/mime";
import { fcParams, tag } from "./_fc";

// Property 1 (SPEC §6.3, AC-24): no header injection, round trip, boundary safety.
const lb = /[\r\n]/;
const ctl = fc.constantFrom("\r", "\n", "\r\n", "\u0000", "\u2028", "\u0085", "\t", "\u202e");
const text = fc.oneof(
  fc.string({ unit: "grapheme", maxLength: 400 }),
  fc.string({ unit: "binary-ascii", maxLength: 400 }),
  fc
    .array(fc.oneof(ctl, fc.string({ unit: "grapheme", maxLength: 8 })), { maxLength: 30 })
    .map((a) => a.join("")),
  fc.string({ unit: "grapheme", minLength: 3000, maxLength: 6000 }),
  fc.constantFrom(
    "a\r\nBcc: evil@example.com",
    "x\nX-Injected: 1",
    "Hello\r\n\r\n--boundary",
    "ok\rX: y",
  ),
);
const addr = fc.oneof(
  fc.constant("jobs@example.com"),
  fc.emailAddress(),
  text,
);
const fileName = fc.oneof(
  fc.stringMatching(/^[a-zA-Z0-9._ -]{1,40}$/),
  fc.constant("cv.pdf"),
  text,
);
const content = fc.uint8Array({ maxLength: 3000 }).map((u) => Buffer.from(u));

const EXPECTED_HEADERS = [
  "From",
  "To",
  "Subject",
  "MIME-Version",
  "Date",
  "Message-ID",
  "Content-Type",
];
const B64_WORD = /^=\?UTF-8\?B\?([A-Za-z0-9+/=]*)\?=$/;

describe(tag("buildMimeMessage properties"), () => {
  it("never injects headers, round-trips subject/body/attachment, boundary stays out of parts", () => {
    let accepted = 0;
    fc.assert(
      fc.property(addr, addr, text, text, fileName, content, (from, to, subject, bodyText, name, bytes) => {
        const nameBad =
          lb.test(name) || !/^[\x20-\x7e]+$/.test(name) || /["\\]/.test(name);
        const shouldThrow =
          [from, to, subject].some((s) => lb.test(s)) || nameBad || !from || !to;

        let msg: string;
        try {
          msg = buildMimeMessage({
            from,
            to,
            subject,
            bodyText,
            attachment: { fileName: name, content: bytes },
          });
        } catch (e) {
          expect(e).toBeInstanceOf(Error);
          expect(shouldThrow).toBe(true);
          return;
        }
        expect(shouldThrow).toBe(false);
        accepted++;

        // No bare CR or LF anywhere.
        expect(/\r(?!\n)|(?<!\r)\n/.test(msg)).toBe(false);

        const sep = msg.indexOf("\r\n\r\n");
        expect(sep).toBeGreaterThan(0);
        const headLines = msg.slice(0, sep).split("\r\n");
        const names = headLines.filter((l) => !l.startsWith(" ")).map((l) => l.split(":")[0]);
        expect(names).toEqual(EXPECTED_HEADERS);

        // Subject round trip (RFC 2047 words folded with CRLF + space).
        const si = headLines.findIndex((l) => l.startsWith("Subject:"));
        const subjLines = [headLines[si].slice("Subject: ".length)];
        for (let i = si + 1; headLines[i]?.startsWith(" "); i++) subjLines.push(headLines[i].slice(1));
        if (/^[\x20-\x7e]*$/.test(subject)) {
          expect(subjLines).toEqual([subject]);
        } else {
          const decoded = subjLines.map((w) => {
            expect(w.length).toBeLessThanOrEqual(75);
            const m = B64_WORD.exec(w);
            expect(m).not.toBeNull();
            return Buffer.from(m![1], "base64").toString("utf8");
          });
          expect(decoded.join("")).toBe(subject);
        }
        // RFC 5322 hard line limit (inputs bounded like the schema: subject <= 300).
        if (subject.length <= 300 && to.length <= 254 && from.length <= 254) {
          for (const l of headLines) expect(l.length).toBeLessThanOrEqual(998);
        }

        // Parts.
        const boundary = /boundary="([^"]+)"/.exec(msg.slice(0, sep))![1];
        const rest = msg.slice(sep + 4).split("\r\n");
        const delims = rest.flatMap((l, i) => (l.startsWith("--") ? [i] : []));
        expect(delims.map((i) => rest[i])).toEqual([`--${boundary}`, `--${boundary}`, `--${boundary}--`]);
        const part = (a: number, b: number) => {
          const lines = rest.slice(a + 1, b);
          const blank = lines.indexOf("");
          return { headers: lines.slice(0, blank), b64: lines.slice(blank + 1) };
        };
        const p1 = part(delims[0], delims[1]);
        const p2 = part(delims[1], delims[2]);
        expect(p1.headers.map((h) => h.split(":")[0])).toEqual([
          "Content-Type",
          "Content-Transfer-Encoding",
        ]);
        expect(p2.headers.map((h) => h.split(":")[0])).toEqual([
          "Content-Type",
          "Content-Disposition",
          "Content-Transfer-Encoding",
        ]);
        for (const l of [...p1.b64, ...p2.b64]) {
          expect(l.length).toBeLessThanOrEqual(76);
          expect(l).toMatch(/^[A-Za-z0-9+/=]*$/);
          expect(l).not.toContain(boundary);
        }
        expect(Buffer.from(p1.b64.join(""), "base64").toString("utf8")).toBe(
          bodyText.replace(/\r?\n/g, "\r\n"),
        );
        expect(Buffer.from(p2.b64.join(""), "base64").equals(bytes)).toBe(true);
        expect(p2.headers[1]).toBe(`Content-Disposition: attachment; filename="${name}"`);
      }),
      fcParams(),
    );
    expect(accepted).toBeGreaterThan(0);
  });
});
