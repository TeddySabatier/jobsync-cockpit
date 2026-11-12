// @vitest-environment node
// Issue #82: the server's blank rule (isBlankText, TypeScript) and the bot
// script's (is_blank_text, Python) must agree. One shared list of strings is
// run through both. Invisible-only strings are blank; any string with a visible
// character is not, so an owner can always save a real subject. Escapes only:
// no invisible character is typed into this file.
import { spawnSync } from "child_process";
import path from "path";
import { isBlankText } from "@/lib/cockpit/schemas";

const botDir = path.resolve(__dirname, "../../scripts/bot");

const BLANK: string[] = [
  "",
  " ",
  "\t\r\n",
  "\u00A0",
  "\u1680",
  "\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A",
  "\u2028\u2029",
  "\u202F\u205F\u3000",
  "\u200B\u200C\u200D",
  "\u2060\u2061\u2062\u2063\u2064",
  "\uFEFF",
  "\u00AD",
  "\u180E",
  "\u115F\u1160\u3164\uFFA0",
  "\u2800",
  "\u034F",
  "\u200E\u200F",
  "\u202A\u202B\u202C\u202D\u202E",
  "\u2066\u2067\u2068\u2069",
  "\u061C",
  "\u{E0001}\u{E0020}\u{E007F}", // tag characters
  "\u0000\u0007\u001B\u007F\u0085",
  " \u200B \u00A0\uFEFF\u00AD",
];

const VISIBLE: string[] = [
  "a",
  "0",
  "-",
  ".",
  "\u{1F600}", // emoji
  "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}", // ZWJ family sequence
  "\u2764\uFE0F", // heart + variation selector-16
  "\uFE0F", // variation selector alone is a mark, not an invisible-only blank
  "\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}", // flag with tag characters
  "\u4E2D\u6587", // CJK
  "\u3042\u30A2", // kana
  "\uD55C\uAE00", // Hangul syllables
  "\u1100\u1161\u11A8", // conjoining jamo (leading consonant is not the filler)
  "\u0645\u0631\u062D\u0628\u0627", // Arabic
  "\u0645\u06CC\u200C\u062E\u0648\u0627\u0647\u0645", // Persian with ZWNJ inside a word
  "\u0627\u0644\u0639\u0631\u0628\u064A\u0629\u200F", // Arabic ending with an RLM
  "\u202Bshalom\u202C", // bidi controls around real text
  "\u200Fa\u200E",
  "\u0E2A\u0E27\u0E31\u0E2A\u0E14\u0E35", // Thai with combining vowel marks
  "\u0939\u093F\u0928\u094D\u0926\u0940", // Hindi with virama and matras
  "\u0915\u094D\u200D\u0937", // Devanagari conjunct with ZWJ
  "Cr\u00E9ation d\u2019\u00E9quipe", // French
  "Cre\u0301ation", // French, decomposed (combining acute)
  "Zam\u00F3wienie \u017C\u00F3\u0142\u0107", // Polish
  "\u00A0Hello\u00A0",
  "\u200Bx",
  "x\u200B",
  "\u2800a",
  "a\u034F",
  "\u00AD-\u00AD",
  "\u0301", // a lone combining mark is visible to the engine: not blank
];

describe("isBlankText on the shared table", () => {
  it.each(BLANK)("blank: %j", (s) => {
    expect(isBlankText(s)).toBe(true);
  });
  it.each(VISIBLE)("kept: %j", (s) => {
    expect(isBlankText(s)).toBe(false);
  });
});

const probe = spawnSync("python3", ["--version"], { stdio: "ignore" });

describe.skipIf(probe.error !== undefined || probe.status !== 0)(
  "is_blank_text (Python) agrees with isBlankText (TypeScript)",
  () => {
    it("gives the same answer on every string of the table", () => {
      const all = [...BLANK, ...VISIBLE];
      const run = spawnSync(
        "python3",
        [
          "-I",
          "-c",
          [
            "import json, sys",
            "sys.path.insert(0, sys.argv[1])",
            "import cockpit_submit as cs",
            "print(json.dumps([cs.is_blank_text(s) for s in json.load(sys.stdin)]))",
          ].join("\n"),
          botDir,
        ],
        { input: JSON.stringify(all), encoding: "utf8" },
      );
      expect(run.status, run.stderr).toBe(0);
      const python = JSON.parse(run.stdout) as boolean[];
      expect(python).toHaveLength(all.length);
      all.forEach((s, i) => {
        expect(python[i], JSON.stringify(s)).toBe(isBlankText(s));
      });
    });
  },
);
