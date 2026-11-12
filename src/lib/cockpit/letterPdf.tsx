import "server-only";
import React from "react";
import { letterMarkdown } from "./markdown";
import path from "path";
import { Document, Font, Page, StyleSheet, Text, View, renderToBuffer } from "@react-pdf/renderer";

// Cover-letter PDF (cockpit/DECISIONS.md D-015). The Review preview and the
// attachment of the sent email come from this one function, so what the owner
// sees is exactly what is sent. Input is the current letter text (markdown,
// as edited in Review) and the package's cvJson for the letterhead.

// Same parser instance as the HTML preview (markdown.ts).
const md = letterMarkdown;

const ACCENT = "#1F4E79";
const MUTED = "#555555";
const PAGE_MARGIN = 54;
const INDENT = 14;

// Noto Sans (SIL OFL, assets/fonts/noto-sans/OFL.txt), subset to Latin, Latin
// Extended, Greek, Cyrillic and common punctuation (D-026). Loaded from disk at
// render time (no network); next.config.mjs traces the folder into the
// standalone output. The family is registered once per process.
export const FONT_DIR = path.join(process.cwd(), "assets", "fonts", "noto-sans");

// react-pdf caches parsed fonts and glyphs process-wide, and the text-layer map
// of a glyph (ToUnicode) comes from the first run that used it. Sharing one
// parsed font between letters made a later letter extract "Lukas<U+0006>" for
// "Lukasz" (seen in tests, D-026; the page looks right, the copied text does
// not). So every render registers its own family under a fresh name, which
// parses the files anew (a few ms), and removes it afterwards.
let familySeq = 0;
function registerFonts(): string {
  const family = "NotoSans" + familySeq++;
  const f = (file: string) => path.join(FONT_DIR, file);
  Font.register({
    family,
    fonts: [
      { src: f("NotoSans-Regular.ttf"), fontWeight: 400, fontStyle: "normal" },
      { src: f("NotoSans-Bold.ttf"), fontWeight: 700, fontStyle: "normal" },
      { src: f("NotoSans-Italic.ttf"), fontWeight: 400, fontStyle: "italic" },
      { src: f("NotoSans-BoldItalic.ttf"), fontWeight: 700, fontStyle: "italic" },
    ],
  });
  return family;
}

const styles = StyleSheet.create({
  page: {
    fontSize: 11,
    lineHeight: 1.4,
    paddingTop: PAGE_MARGIN,
    paddingBottom: PAGE_MARGIN,
    paddingHorizontal: PAGE_MARGIN,
    color: "#000000",
  },
  name: { fontWeight: 700, fontSize: 18, color: ACCENT, marginBottom: 2 },
  title: { fontSize: 11, color: MUTED, marginBottom: 2 },
  contact: { fontSize: 9.5, color: MUTED },
  rule: { height: 1, backgroundColor: ACCENT, marginTop: 8, marginBottom: 18 },
  paragraph: { marginBottom: 10 },
  code: { fontSize: 10, marginBottom: 10 },
  heading: { fontWeight: 700, fontSize: 12, marginTop: 4, marginBottom: 4 },
  listRow: { flexDirection: "row", marginBottom: 2 },
  bullet: { width: INDENT },
  listText: { flex: 1 },
  listEnd: { height: 8 },
  bold: { fontWeight: 700 },
  italic: { fontStyle: "italic" as const },
  boldItalic: { fontWeight: 700, fontStyle: "italic" as const },
});

// Code points the bundled Noto Sans subset can draw (D-026). The same ranges
// were given to the subsetter; a test checks every one against the font file.
// Nothing is dropped silently when it is a letter: a letter outside the font
// (CJK, Arabic, ...) shows as "?" so the owner sees it in the preview. Symbols
// and emoji are dropped.
export const FONT_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x20, 0x7e], // ASCII
  [0xa0, 0x1f7], // Latin-1, Latin Extended-A and B (U+01F8/9 left out: see D-026)
  [0x1fa, 0x24f],
  [0x370, 0x377], // Greek (unassigned code points left out)
  [0x37a, 0x37f],
  [0x384, 0x38a],
  [0x38c, 0x38c],
  [0x38e, 0x3a1],
  [0x3a3, 0x3e1],
  [0x3f0, 0x3ff],
  [0x400, 0x4ff], // Cyrillic
  [0x2010, 0x2027], // dashes, quotes, bullet, ellipsis
  [0x2030, 0x2044], // per mille, primes, guillemets
  [0x20ac, 0x20ac], // euro
  [0x2122, 0x2122], // trade mark
  [0x2212, 0x2212], // minus
];
const SPACES = new Set([0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x202f, 0x205f, 0x3000]);
const HYPHENS = new Set([0x2010, 0x2011, 0x2012, 0x2212]);
const INVISIBLE = new Set([0x200b, 0x200c, 0x200d, 0x2060, 0xfeff, 0xad]);
// Noto Sans has no arrows or comparison signs; keep the old ASCII stand-ins.
const REPLACEMENTS: Record<string, string> = { "→": "->", "←": "<-", "≥": ">=", "≤": "<=", "≠": "!=" };
const LETTER = /\p{L}/u;
const MARKS = /\p{M}/gu;

function drawable(c: number): boolean {
  if (c === 0x0a) return true;
  for (const [lo, hi] of FONT_RANGES) if (c >= lo && c <= hi) return true;
  return false;
}

export function toPdfText(text: string): string {
  let out = "";
  for (const ch of text.normalize("NFC")) {
    const c = ch.codePointAt(0)!;
    if (c === 0xad) continue; // soft hyphen is invisible
    if (c === 0x09 || SPACES.has(c)) {
      out += " ";
    } else if (HYPHENS.has(c)) {
      out += "-";
    } else if (drawable(c)) {
      out += ch;
    } else if (INVISIBLE.has(c)) {
      continue;
    } else if (REPLACEMENTS[ch]) {
      out += REPLACEMENTS[ch];
    } else if (LETTER.test(ch)) {
      // A Latin letter with a mark the font lacks keeps its base letter; any
      // other alphabet (CJK, Arabic, ...) shows as "?".
      const base = ch.normalize("NFD").replace(MARKS, "");
      out += base !== ch && [...base].every((b) => drawable(b.codePointAt(0)!)) ? base : "?";
    }
  }
  return out;
}

// A word wider than the text column would run past the margin and be cut off.
// Long words (a deep link) may break anywhere instead.
const WORD_CHUNK = 30;
function breakLongWords(word: string): string[] {
  if (word.length <= WORD_CHUNK * 2) return [word];
  const parts: string[] = [];
  for (let i = 0; i < word.length; i += WORD_CHUNK) parts.push(word.slice(i, i + WORD_CHUNK));
  return parts;
}

type Token = ReturnType<typeof md.parse>[number];

function inlineNodes(tokens: Token[] | null, keyPrefix: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  let bold = 0;
  let italic = 0;
  let n = 0;
  for (const t of tokens ?? []) {
    if (t.type === "strong_open") bold++;
    else if (t.type === "strong_close") bold--;
    else if (t.type === "em_open") italic++;
    else if (t.type === "em_close") italic--;
    else if (t.type === "softbreak" || t.type === "hardbreak") nodes.push("\n");
    else if (t.type === "text" || t.type === "code_inline") {
      const text = toPdfText(t.content);
      if (!text) continue;
      const style = bold && italic ? styles.boldItalic : bold ? styles.bold : italic ? styles.italic : null;
      nodes.push(style ? <Text key={`${keyPrefix}-${n++}`} style={style}>{text}</Text> : text);
    }
  }
  return nodes;
}

type ListState = { ordered: boolean; next: number };

function bodyNodes(letterMd: string): React.ReactElement[] {
  const tokens = md.parse(letterMd, {});
  const out: React.ReactElement[] = [];
  const lists: ListState[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === "bullet_list_open" || t.type === "ordered_list_open") {
      const start = Number(t.attrGet("start"));
      lists.push({ ordered: t.type === "ordered_list_open", next: Number.isFinite(start) && start > 0 ? start : 1 });
    } else if (t.type === "bullet_list_close" || t.type === "ordered_list_close") {
      lists.pop();
      if (lists.length === 0) out.push(<View key={`end${i}`} style={styles.listEnd} />);
    } else if (t.type === "code_block" || t.type === "fence") {
      // Indented and fenced blocks keep their line breaks, as plain text.
      const text = toPdfText(t.content).replace(/\n+$/, "");
      if (text) out.push(<Text key={`c${i}`} style={styles.code}>{text}</Text>);
    } else if (t.type === "inline") {
      const prev = tokens[i - 1];
      const kids = inlineNodes(t.children, `n${i}`);
      if (prev?.type === "heading_open") {
        out.push(<Text key={`n${i}`} style={styles.heading}>{kids}</Text>);
      } else if (lists.length > 0) {
        const list = lists[lists.length - 1];
        const marker = list.ordered ? `${list.next}.` : "•";
        list.next++;
        out.push(
          <View key={`n${i}`} style={[styles.listRow, { paddingLeft: (lists.length - 1) * INDENT }]}>
            <Text style={styles.bullet}>{marker}</Text>
            <Text style={styles.listText}>{kids}</Text>
          </View>,
        );
      } else {
        out.push(<Text key={`n${i}`} style={styles.paragraph}>{kids}</Text>);
      }
    }
  }
  return out;
}

function letterhead(cvJson: string | null | undefined) {
  if (!cvJson) return null;
  try {
    const cv = JSON.parse(cvJson) as { name?: unknown; title?: unknown; contact?: unknown };
    const name = typeof cv.name === "string" ? toPdfText(cv.name).trim() : "";
    if (!name) return null;
    const title = typeof cv.title === "string" ? toPdfText(cv.title).trim() : "";
    const contact = Array.isArray(cv.contact)
      ? cv.contact.filter((c): c is string => typeof c === "string").map((c) => toPdfText(c).trim()).filter(Boolean)
      : [];
    return { name, title, contact };
  } catch {
    return null;
  }
}

export async function renderLetterPdf(input: { letterMd: string; cvJson?: string | null }): Promise<Buffer> {
  const family = registerFonts();
  try {
    return await renderOnce(input, family);
  } finally {
    delete Font.getRegisteredFonts()[family];
  }
}

async function renderOnce(input: { letterMd: string; cvJson?: string | null }, family: string): Promise<Buffer> {
  // Set on every render on purpose: react-pdf keeps ONE process-wide
  // hyphenation callback (global state). Setting it here is a cheap assignment
  // and keeps the letter independent of whatever else registers a callback in
  // the same process (tests, or future server code). Today the app's other
  // registrations run only in the browser (D-022 g).
  Font.registerHyphenationCallback(breakLongWords);
  const head = letterhead(input.cvJson);
  const doc = (
    <Document title="Cover letter" author={head?.name ?? ""} creator="JobSync cockpit" producer="react-pdf">
      <Page size="A4" style={[styles.page, { fontFamily: family }]} wrap>
        {head && (
          <View>
            <Text style={styles.name}>{head.name}</Text>
            {head.title ? <Text style={styles.title}>{head.title}</Text> : null}
            {head.contact.length > 0 ? <Text style={styles.contact}>{head.contact.join("  ·  ")}</Text> : null}
            <View style={styles.rule} />
          </View>
        )}
        {bodyNodes(input.letterMd)}
      </Page>
    </Document>
  );
  return renderToBuffer(doc);
}
