import "server-only";
import React from "react";
import MarkdownIt from "markdown-it";
import { Document, Font, Page, StyleSheet, Text, View, renderToBuffer } from "@react-pdf/renderer";

// Cover-letter PDF (cockpit/DECISIONS.md D-015). The Review preview and the
// attachment of the sent email come from this one function, so what the owner
// sees is exactly what is sent. Input is the current letter text (markdown,
// as edited in Review) and the package's cvJson for the letterhead.

const md = new MarkdownIt({ html: false, linkify: false, breaks: true });
md.disable(["image", "link", "autolink"]);

const ACCENT = "#1F4E79";
const MUTED = "#555555";
const PAGE_MARGIN = 54;

const styles = StyleSheet.create({
  page: {
    fontFamily: "Helvetica",
    fontSize: 11,
    lineHeight: 1.4,
    paddingTop: PAGE_MARGIN,
    paddingBottom: PAGE_MARGIN,
    paddingHorizontal: PAGE_MARGIN,
    color: "#000000",
  },
  name: { fontFamily: "Helvetica-Bold", fontSize: 18, color: ACCENT, marginBottom: 2 },
  title: { fontSize: 11, color: MUTED, marginBottom: 2 },
  contact: { fontSize: 9.5, color: MUTED },
  rule: { height: 1, backgroundColor: ACCENT, marginTop: 8, marginBottom: 18 },
  listEnd: { height: 8 },
  paragraph: { marginBottom: 10 },
  heading: { fontFamily: "Helvetica-Bold", fontSize: 12, marginTop: 4, marginBottom: 4 },
  listRow: { flexDirection: "row", marginBottom: 2 },
  bullet: { width: 14 },
  listText: { flex: 1 },
  bold: { fontFamily: "Helvetica-Bold" },
  italic: { fontFamily: "Helvetica-Oblique" },
  boldItalic: { fontFamily: "Helvetica-BoldOblique" },
});

// The standard PDF fonts cover WinAnsi only. Anything else would print as a
// wrong glyph, so it is dropped instead.
const WIN_ANSI_EXTRA = "–—‘’‚“”„•…€™†‡‰‹›ŒœŠšŽžŸƒˆ˜";
export function toWinAnsi(text: string): string {
  let out = "";
  for (const ch of text.normalize("NFC")) {
    const c = ch.codePointAt(0)!;
    if (c === 0x0a || (c >= 0x20 && c <= 0x7e) || (c >= 0xa0 && c <= 0xff) || WIN_ANSI_EXTRA.includes(ch)) {
      out += ch;
    } else if (c === 0x09) {
      out += " ";
    }
  }
  return out;
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
      const text = toWinAnsi(t.content);
      if (!text) continue;
      const style = bold && italic ? styles.boldItalic : bold ? styles.bold : italic ? styles.italic : null;
      nodes.push(style ? <Text key={`${keyPrefix}-${n++}`} style={style}>{text}</Text> : text);
    }
  }
  return nodes;
}

function bodyNodes(letterMd: string): React.ReactElement[] {
  const tokens = md.parse(letterMd, {});
  const out: React.ReactElement[] = [];
  let listDepth = 0;
  let ordered = false;
  let itemNo = 0;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === "bullet_list_open" || t.type === "ordered_list_open") {
      listDepth++;
      ordered = t.type === "ordered_list_open";
      itemNo = 0;
    } else if (t.type === "bullet_list_close" || t.type === "ordered_list_close") {
      listDepth--;
      if (listDepth === 0) out.push(<View key={`end${i}`} style={styles.listEnd} />);
    } else if (t.type === "inline") {
      const prev = tokens[i - 1];
      const kids = inlineNodes(t.children, `n${i}`);
      if (prev?.type === "heading_open") {
        out.push(<Text key={`n${i}`} style={styles.heading}>{kids}</Text>);
      } else if (listDepth > 0) {
        itemNo++;
        out.push(
          <View key={`n${i}`} style={styles.listRow} wrap={false}>
            <Text style={styles.bullet}>{ordered ? `${itemNo}.` : "•"}</Text>
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
    const name = typeof cv.name === "string" ? toWinAnsi(cv.name).trim() : "";
    if (!name) return null;
    const title = typeof cv.title === "string" ? toWinAnsi(cv.title).trim() : "";
    const contact = Array.isArray(cv.contact)
      ? cv.contact.filter((c): c is string => typeof c === "string").map((c) => toWinAnsi(c).trim()).filter(Boolean)
      : [];
    return { name, title, contact };
  } catch {
    return null;
  }
}

export async function renderLetterPdf(input: {
  letterMd: string;
  cvJson?: string | null;
}): Promise<Buffer> {
  Font.registerHyphenationCallback((word) => [word]);
  const head = letterhead(input.cvJson);
  const doc = (
    <Document title="Cover letter" author={head?.name ?? ""} creator="JobSync cockpit" producer="react-pdf">
      <Page size="A4" style={styles.page} wrap>
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
