import { render, screen, waitFor, within } from "@testing-library/react";

import {
  CvPanel,
  EmailPanel,
  FitPanel,
  LetterPanel,
  PostingPanel,
  humanizeKey,
  type PackageDetail,
} from "@/components/cockpit/Panels";
import { TipTapContentViewer } from "@/components/TipTapContentViewer";
import { STATUS_LABELS, statusLabel } from "@/components/cockpit/statusLabels";

// Review UI read side (issue #58): wording, a11y names, overflow, PDF links.
// Real TipTap on purpose (the accessible name comes from the component).

type Pkg = PackageDetail["package"];

const pkgFixture = (over: Partial<Pkg> = {}): Pkg =>
  ({
    id: "p1",
    version: 1,
    status: "pending",
    emailTo: "jobs@acme.example",
    emailSubject: "Application",
    emailBody: "Body text",
    letterMd: "Dear team,\n\nHello.",
    fitGrade: "A",
    fitAnalysis: JSON.stringify({ must_haves: ["Go"], summary: "ok" }),
    cvJson: JSON.stringify({ name: "Jane Doe" }),
    cvPdfStale: false,
    changeRequestedAt: null,
    updatedAt: new Date("2026-11-01T10:00:00Z"),
    job: {
      id: "j1",
      jobUrl: "https://acme.example/jobs/1",
      description: "<p>Build things</p>",
      JobTitle: { label: "Engineer" },
      Company: { label: "Acme" },
    },
    ...over,
  }) as Pkg;

const detailFixture = (
  over: Partial<Pkg> = {},
  extra: Partial<Omit<PackageDetail, "package">> = {},
): PackageDetail =>
  ({
    package: pkgFixture(over),
    versions: [],
    activePackageId: "p1",
    isActive: true,
    attachment: { fileName: "cv.pdf", size: 1024 },
    letterAttachment: { fileName: "Cover_Letter.pdf" },
    gmail: { email: "you@example.com", scopes: "gmail.send" },
    ...extra,
  }) as PackageDetail;

describe("status labels", () => {
  it("has one human label per status and falls back to the raw value", () => {
    expect(STATUS_LABELS.changes_requested).toBe("Changes requested");
    expect(statusLabel("superseded")).toBe("Superseded");
    expect(statusLabel("weird")).toBe("weird");
  });
});

describe("Email preview overflow and wording", () => {
  it("lets the value column shrink and wraps an unbroken subject", () => {
    render(<EmailPanel detail={detailFixture({ emailSubject: "S".repeat(120) })} />);
    const subject = screen.getByText("S".repeat(120));
    expect(subject.parentElement?.className).toContain("minmax(0,1fr)");
    expect(subject.className).toContain("[overflow-wrap:anywhere]");
  });

  it("uses sentence case for the missing sender and recipient", () => {
    render(<EmailPanel detail={detailFixture({ emailTo: null }, { gmail: null })} />);
    expect(screen.getByText("Not connected")).toBeInTheDocument();
    expect(screen.getByText("Apply via link")).toBeInTheDocument();
  });
});

describe("PDF panels: Open in new tab next to Download", () => {
  it("CV panel keeps the iframe and offers both links", () => {
    render(<CvPanel detail={detailFixture()} />);
    expect(screen.getByTitle("CV PDF")).toHaveAttribute("src", "/api/cockpit/files/p1");
    const open = screen.getByRole("link", { name: "Open in new tab" });
    expect(open).toHaveAttribute("href", "/api/cockpit/files/p1");
    expect(open).toHaveAttribute("target", "_blank");
    expect(open).toHaveAttribute("rel", expect.stringContaining("noopener"));
    expect(screen.getByRole("link", { name: "Download PDF" })).toHaveAttribute(
      "download",
    );
  });

  it("Letter panel keeps the iframe and offers both links", () => {
    render(<LetterPanel pkg={pkgFixture()} fileName="Cover_Letter.pdf" />);
    expect(screen.getByTestId("letter-pdf-preview")).toBeInTheDocument();
    const open = screen.getByRole("link", { name: "Open in new tab" });
    expect(open.getAttribute("href")).toMatch(/^\/api\/cockpit\/letter\/p1\?v=/);
    expect(open).toHaveAttribute("target", "_blank");
    expect(screen.getByRole("link", { name: "Download PDF" })).toHaveAttribute(
      "download",
      "Cover_Letter.pdf",
    );
  });
});

describe("accessible names", () => {
  it("TipTap viewer is a named document, not an unnamed textbox", async () => {
    render(<TipTapContentViewer content="<p>Hello</p>" label="Job posting" />);
    await waitFor(() =>
      expect(screen.getByRole("document", { name: "Job posting" })).toBeInTheDocument(),
    );
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("Posting and Letter panels name their viewers", async () => {
    render(
      <>
        <PostingPanel pkg={pkgFixture()} />
        <LetterPanel pkg={pkgFixture()} />
      </>,
    );
    await waitFor(() => {
      expect(screen.getByRole("document", { name: "Job posting" })).toBeInTheDocument();
      expect(screen.getByRole("document", { name: "Cover letter" })).toBeInTheDocument();
    });
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("scrollable regions are focusable and named", () => {
    render(
      <>
        <PostingPanel pkg={pkgFixture()} />
        <EmailPanel detail={detailFixture()} />
        <LetterPanel pkg={pkgFixture()} />
      </>,
    );
    for (const name of ["Posting text", "Email body", "Letter text"]) {
      expect(screen.getByRole("group", { name })).toHaveAttribute("tabindex", "0");
    }
  });

  it("the CV data block is a focusable named region", async () => {
    render(<CvPanel detail={detailFixture()} />);
    screen.getByRole("button", { name: "CV data" }).click();
    expect(await screen.findByRole("group", { name: "CV data" })).toHaveAttribute(
      "tabindex",
      "0",
    );
  });

  it("each panel section is named by its visible heading", () => {
    render(<EmailPanel detail={detailFixture()} />);
    const section = screen.getByTestId("panel-email");
    expect(section).not.toHaveAttribute("aria-label");
    const heading = within(section).getByRole("heading", { name: "Email preview" });
    expect(section).toHaveAttribute("aria-labelledby", heading.id);
    expect(screen.getByRole("region", { name: "Email preview" })).toBe(section);
  });
});

describe("TipTap viewer default is neutral", () => {
  it("renders without role or aria-label when no label is passed", async () => {
    const { container } = render(<TipTapContentViewer content="<p>Hello</p>" />);
    await waitFor(() =>
      expect(container.querySelector(".ProseMirror")).not.toBeNull(),
    );
    const pm = container.querySelector(".ProseMirror") as HTMLElement;
    expect(pm).not.toHaveAttribute("aria-label");
    expect(pm.getAttribute("role")).not.toBe("document");
    expect(screen.queryByRole("document")).toBeNull();
  });
});

describe("fit analysis scroll regions have unique names", () => {
  it("names each structured value by its key", () => {
    render(
      <FitPanel
        pkg={pkgFixture({
          fitAnalysis: JSON.stringify({ mustHaves: { a: 1 }, nice_to_have: { b: 2 } }),
        })}
      />,
    );
    expect(screen.getByRole("group", { name: "Fit analysis: Must haves" })).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("group", { name: "Fit analysis: Nice to have" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: /Fit analysis:/ })).toBeNull();
  });
});

describe("fit analysis", () => {
  it("humanizes snake_case keys and keeps the grade announced", () => {
    expect(humanizeKey("must_haves")).toBe("Must haves");
    expect(humanizeKey("mustHaves")).toBe("Must haves");
    render(<FitPanel pkg={pkgFixture()} />);
    expect(screen.getByText("Must haves")).toBeInTheDocument();
    expect(screen.queryByText("must_haves")).toBeNull();
    expect(screen.getByTestId("panel-fit")).toHaveTextContent("Grade: Fit grade A");
  });
});
