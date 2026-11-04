import { render, screen } from "@testing-library/react";
import { renderLetterMarkdown } from "@/lib/cockpit/markdown";
import { TipTapContentViewer } from "@/components/TipTapContentViewer";

// AC-41: the primary assertions are on the markdown-it HTML string.
describe("renderLetterMarkdown (AC-41)", () => {
  it("emits no <img> or <a> for markdown images and links", () => {
    const html = renderLetterMarkdown(
      "![x](http://a.example/b.png)\n\n[click](javascript:alert(1))\n\n<http://auto.example>",
    );
    expect(html).not.toMatch(/<img/i);
    expect(html).not.toMatch(/<a[\s>]/i);
    expect(html).not.toMatch(/href=/i);
    expect(html).not.toMatch(/src=/i);
  });

  it("keeps javascript: inert (text only, never an attribute)", () => {
    const html = renderLetterMarkdown("[x](javascript:alert(1))");
    expect(html).toContain("javascript:alert(1)");
    expect(html).not.toMatch(/(href|src)\s*=/i);
  });

  it("escapes raw HTML", () => {
    const html = renderLetterMarkdown(
      '<script>alert(1)</script><img src=x onerror=alert(1)><a href="http://evil.example">x</a>',
    );
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<img/i);
    expect(html).not.toMatch(/<a[\s>]/i);
    expect(html).toContain("&lt;script&gt;");
  });

  it("does not strip thinking-like text (no stripThinking)", () => {
    const html = renderLetterMarkdown("I think <think>deeply</think> about it.");
    expect(html).toContain("&lt;think&gt;deeply&lt;/think&gt;");
  });

  it("renders paragraphs, line breaks and emphasis", () => {
    const html = renderLetterMarkdown("Dear team,\nHello **you**.\n\n- a\n- b");
    expect(html).toContain("<p>Dear team,<br>\nHello <strong>you</strong>.</p>");
    expect(html).toContain("<li>a</li>");
  });

  it("returns an empty string for an empty letter", () => {
    expect(renderLetterMarkdown("")).toBe("");
  });

  it("the TipTap output has no link or image either", async () => {
    const { container } = render(
      <TipTapContentViewer
        content={renderLetterMarkdown("![x](http://a/b.png) [y](javascript:alert(1))")}
      />,
    );
    await screen.findByText(/javascript:alert\(1\)/);
    expect(container.querySelector("a, img, script")).toBeNull();
  });
});
