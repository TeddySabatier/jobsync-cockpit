import MarkdownIt from "markdown-it";

// Cover-letter renderer (cockpit/SPEC.md §5.3, AC-41). Same flags as
// src/lib/agent/markdown.ts, but deliberately a separate instance: that one
// runs stripThinking, which would alter a letter. Isomorphic, no server-only.
//
// html:false escapes raw HTML; TipTapContentViewer drops unknown tags after
// this (a second line of defense, not sanitization). The disabled rules are
// the security property: a markdown link or image is a network request steered
// by injected posting content. Disabled means the URL stays as inert text.
//
// The ONE letter parser: the HTML preview below and the PDF (letterPdf.tsx)
// both use it, so the two never disagree on what a line means (D-015 (c)).
export const letterMarkdown = new MarkdownIt({
  html: false,
  linkify: false,
  breaks: true,
});
// "reference" too: with links off it would still swallow a definition line
// such as "[1]: https://example.com", so the line vanished from the letter.
letterMarkdown.disable(["image", "link", "autolink", "reference"]);

export function renderLetterMarkdown(text: string): string {
  return text ? letterMarkdown.render(text) : "";
}
