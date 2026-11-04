import MarkdownIt from "markdown-it";

// Cover-letter renderer (cockpit/SPEC.md §5.3, AC-41). Same flags as
// src/lib/agent/markdown.ts, but deliberately a separate instance: that one
// runs stripThinking, which would alter a letter. Isomorphic, no server-only.
//
// html:false escapes raw HTML; TipTapContentViewer drops unknown tags after
// this (a second line of defense, not sanitization). The disabled rules are
// the security property: a markdown link or image is a network request steered
// by injected posting content. Disabled means the URL stays as inert text.
const md = new MarkdownIt({ html: false, linkify: false, breaks: true });
md.disable(["image", "link", "autolink"]);

export function renderLetterMarkdown(text: string): string {
  return text ? md.render(text) : "";
}
