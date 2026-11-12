import { render, screen, within, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const getPackageDetail = vi.hoisted(() => vi.fn());
const getAdjacentPackageIds = vi.hoisted(() => vi.fn());
const approvePackage = vi.hoisted(() => vi.fn());
const unapprovePackage = vi.hoisted(() => vi.fn());
const rejectPackage = vi.hoisted(() => vi.fn());
const requestPackageChanges = vi.hoisted(() => vi.fn());
const markPackageAppliedManually = vi.hoisted(() => vi.fn());
vi.mock("@/actions/cockpit.actions", () => ({
  getPackageDetail,
  getAdjacentPackageIds,
  approvePackage,
  unapprovePackage,
  rejectPackage,
  requestPackageChanges,
  markPackageAppliedManually,
}));

vi.mock("@/actions/cockpitSend.actions", () => ({
  sendPackage: vi.fn(),
  markSendUnknownAsSent: vi.fn(),
  releaseSendLock: vi.fn(),
}));

const push = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
  redirect: vi.fn((to: string) => {
    throw new Error(`REDIRECT:${to}`);
  }),
  notFound: vi.fn(() => {
    throw new Error("NOT_FOUND");
  }),
}));
vi.mock("@/lib/toast", () => ({ toastSuccess: vi.fn(), toastError: vi.fn() }));
// The viewer is exercised against the real TipTap in letterRender.spec.tsx.
vi.mock("@/components/TipTapContentViewer", () => ({
  TipTapContentViewer: ({ content }: { content: string }) => (
    <div data-testid="tiptap" data-html={content} />
  ),
}));

import ReviewDetailPage from "@/app/dashboard/review/[packageId]/page";
import DetailView from "@/components/cockpit/DetailView";
import type { PackageDetail } from "@/components/cockpit/Panels";

type Overrides = Partial<PackageDetail["package"]>;

const detailFixture = (
  over: Overrides = {},
  extra: Partial<Omit<PackageDetail, "package">> = {},
): PackageDetail => ({
  package: {
    id: "p2",
    version: 2,
    status: "pending",
    emailTo: "jobs@acme.example",
    contactSource: null,
    emailSubject: "Application: Staff Engineer",
    emailBody: "Hello,\n\nPlease find my CV.\n<script>alert(1)</script>",
    letterMd: "Dear team,\n\n![x](http://a.example/b.png)",
    fitGrade: "A",
    fitAnalysis: JSON.stringify({
      summary: "Strong match",
      score: 87,
      strengths: ["Go", "SQL"],
      nested: { a: 1 },
      html: "<img src=x onerror=alert(1)>",
    }),
    cvJson: JSON.stringify({ name: "Jane Doe" }),
    cvFileId: "f1",
    cvPdfStale: false,
    rejectReason: null,
    changeRequest: null,
    changeRequestedAt: null,
    changeRequestResponse: null,
    sendStartedAt: null,
    sendOutcome: null,
    updatedAt: new Date("2026-11-01T10:00:00Z"),
    job: {
      id: "j1",
      jobUrl: "https://acme.example/jobs/1",
      description: "<p>Build things</p>",
      JobTitle: { label: "Staff Engineer" },
      Company: { label: "Acme Corp" },
    },
    ...over,
  },
  sendHistory: [],
  versions: [
    { id: "p2", version: 2, status: over.status ?? "pending" },
    { id: "p1", version: 1, status: "superseded" },
  ],
  activePackageId: "p2",
  isActive: true,
  attachment: { fileName: "0000-uuid.pdf", size: 12288 },
  letterAttachment: { fileName: "Cover_Letter.pdf" },
  gmail: { email: "you@example.com", scopes: "gmail.send" },
  gmailSendAllowed: true,
  ...extra,
});

const ok = (data: unknown) => ({ success: true, data });
const fail = (code: string) => ({ success: false, code, message: `msg ${code}` });

async function renderPage(id = "p2") {
  const ui = await ReviewDetailPage({ params: Promise.resolve({ packageId: id }) });
  return render(ui);
}

beforeEach(() => {
  vi.clearAllMocks();
  getAdjacentPackageIds.mockResolvedValue(ok({ previousId: null, nextId: null }));
  for (const m of [
    approvePackage,
    unapprovePackage,
    rejectPackage,
    requestPackageChanges,
    markPackageAppliedManually,
  ]) {
    m.mockResolvedValue(ok({}));
  }
});

describe("review detail page: auth and errors (AC-40)", () => {
  it("redirects an unauthenticated caller to /signin", async () => {
    getPackageDetail.mockResolvedValue(fail("UNAUTHENTICATED"));
    await expect(renderPage()).rejects.toThrow("REDIRECT:/signin");
  });

  it("gives notFound when the cockpit is disabled", async () => {
    getPackageDetail.mockResolvedValue(fail("COCKPIT_DISABLED"));
    await expect(renderPage()).rejects.toThrow("NOT_FOUND");
  });

  it("gives notFound for a package that is not found or not owned", async () => {
    getPackageDetail.mockResolvedValue(fail("NOT_FOUND"));
    await expect(renderPage()).rejects.toThrow("NOT_FOUND");
  });

  it("shows the fixed message for any other failure", async () => {
    getPackageDetail.mockResolvedValue(fail("INTERNAL"));
    await renderPage();
    expect(screen.getByRole("alert")).toHaveTextContent("msg INTERNAL");
  });
});

describe("review detail page: panels (AC-18, AC-41)", () => {
  beforeEach(() => getPackageDetail.mockResolvedValue(ok(detailFixture())));

  it("renders the five panels from getPackageDetail", async () => {
    await renderPage();
    for (const id of [
      "panel-posting",
      "panel-cv",
      "panel-fit",
      "panel-email",
      "panel-letter",
    ]) {
      expect(screen.getByTestId(id)).toBeInTheDocument();
    }
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Acme Corp");
  });

  it("serves the CV from the file route, without a sandbox attribute", async () => {
    await renderPage();
    const frame = screen.getByTitle("CV PDF");
    expect(frame).toHaveAttribute("src", "/api/cockpit/files/p2");
    expect(frame).not.toHaveAttribute("sandbox");
    expect(
      within(screen.getByTestId("panel-cv")).getByRole("link", { name: /download pdf/i }),
    ).toHaveAttribute("href", "/api/cockpit/files/p2");
  });

  it("previews the cover letter as the PDF that will be attached (D-015)", async () => {
    await renderPage();
    const panel = screen.getByTestId("panel-letter");
    const frame = within(panel).getByTestId("letter-pdf-preview");
    expect(frame.getAttribute("src")).toMatch(/^\/api\/cockpit\/letter\/p2\?v=\d+$/);
    expect(frame).not.toHaveAttribute("sandbox");
    expect(within(panel).getByRole("link", { name: /download pdf/i })).toHaveAttribute(
      "href",
      frame.getAttribute("src")!,
    );
  });

  it("shows the attachment name and size in the email preview", async () => {
    await renderPage();
    const email = screen.getByTestId("panel-email");
    expect(email).toHaveTextContent("0000-uuid.pdf (12.0 KB)");
    expect(email).toHaveTextContent("you@example.com");
    expect(email).toHaveTextContent("jobs@acme.example");
    expect(email).toHaveTextContent("Application: Staff Engineer");
  });

  it("renders the email body as text in a <pre>, never as HTML", async () => {
    await renderPage();
    const email = screen.getByTestId("panel-email");
    expect(email.querySelector("pre")).toHaveTextContent("<script>alert(1)</script>");
    expect(email.querySelector("script")).toBeNull();
  });

  it("renders fit analysis as text, bullet lists and <pre> JSON", async () => {
    await renderPage();
    const fit = screen.getByTestId("panel-fit");
    expect(within(fit).getByText("Strong match")).toBeInTheDocument();
    expect(within(fit).getByText("87 / 100")).toBeInTheDocument();
    expect(within(fit).getByRole("progressbar", { name: "Match score" })).toBeInTheDocument();
    expect(within(fit).getByText("Strengths")).toBeInTheDocument();
    expect(within(fit).getAllByRole("listitem").map((l) => l.textContent)).toEqual([
      "Go",
      "SQL",
    ]);
    expect(fit.querySelector("pre")).toHaveTextContent('"a": 1');
    // A string value that looks like HTML stays text.
    expect(fit).toHaveTextContent("<img src=x onerror=alert(1)>");
    expect(fit.querySelector("img")).toBeNull();
  });

  it("passes the letter through the hardened renderer (no <a>, no <img>)", async () => {
    await renderPage();
    const letter = screen.getByTestId("panel-letter").querySelector("[data-html]");
    const html = letter!.getAttribute("data-html")!;
    expect(html).toContain("Dear team,");
    expect(html).not.toMatch(/<img|<a[\s>]/i);
  });

  it("warns when the PDF is stale and shows 'No CV' without an attachment", async () => {
    getPackageDetail.mockResolvedValue(
      ok(detailFixture({ cvPdfStale: true }, { attachment: null })),
    );
    await renderPage();
    expect(screen.getByTestId("panel-cv")).toHaveTextContent(/PDF out of date/);
    expect(screen.getByTestId("panel-cv")).toHaveTextContent("No CV file attached.");
    expect(screen.queryByTitle("CV PDF")).toBeNull();
    expect(screen.getByTestId("panel-email")).toHaveTextContent("None");
  });

  it("shows previous review info as text", async () => {
    getPackageDetail.mockResolvedValue(
      ok(
        detailFixture({
          changeRequest: "Shorten the letter",
          changeRequestedAt: new Date("2026-10-30T10:00:00Z"),
          changeRequestResponse: "Done, shorter",
          rejectReason: "<b>no</b>",
        }),
      ),
    );
    await renderPage();
    const info = screen.getByTestId("panel-review-info");
    expect(info).toHaveTextContent("Shorten the letter");
    expect(info).toHaveTextContent("Done, shorter");
    expect(info).toHaveTextContent("<b>no</b>");
    expect(info.querySelector("b")).toBeNull();
  });

  it("lists every version in the selector and navigates on change", async () => {
    await renderPage();
    const select = screen.getByLabelText("Version");
    expect(within(select).getAllByRole("option").map((o) => o.textContent)).toEqual([
      "v2 · Pending",
      "v1 · Superseded",
    ]);
    fireEvent.change(select, { target: { value: "p1" } });
    expect(push).toHaveBeenCalledWith("/dashboard/review/p1");
  });
});

describe("non-active version (AC-48)", () => {
  it("shows a banner linking to the active version and hides the action bar", async () => {
    getPackageDetail.mockResolvedValue(
      ok(
        detailFixture(
          { id: "p1", version: 1, status: "superseded" },
          {
            versions: [
              { id: "p2", version: 2, status: "pending" },
              { id: "p1", version: 1, status: "superseded" },
            ],
            activePackageId: "p2",
            isActive: false,
          },
        ),
      ),
    );
    await renderPage("p1");
    const banner = screen.getByTestId("version-banner");
    expect(banner).toHaveTextContent("Viewing v1, which a newer version replaced.");
    expect(within(banner).getByRole("link", { name: "Open v2" })).toHaveAttribute(
      "href",
      "/dashboard/review/p2",
    );
    expect(screen.queryByRole("region", { name: "Actions" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reject" })).toBeNull();
  });

  it("shows no banner on the active version", async () => {
    getPackageDetail.mockResolvedValue(ok(detailFixture()));
    await renderPage();
    expect(screen.queryByTestId("version-banner")).toBeNull();
  });
});

describe("status wording (no raw status values)", () => {
  const nonActive = (status: string) =>
    ok(
      detailFixture(
        { id: "p1", version: 1, status },
        {
          versions: [{ id: "p1", version: 1, status }],
          activePackageId: null,
          isActive: false,
        },
      ),
    );

  it.each([
    ["sent", "Viewing v1, which was sent.", "Sent"],
    ["rejected", "Viewing v1, which was rejected.", "Rejected"],
  ])("%s: own sentence, label in the header and selector", async (status, sentence, label) => {
    getPackageDetail.mockResolvedValue(nonActive(status));
    await renderPage("p1");
    const banner = screen.getByTestId("version-banner");
    expect(banner).toHaveTextContent(sentence);
    expect(banner).toHaveTextContent("There is no active version.");
    expect(banner).not.toHaveTextContent(status === "sent" ? "— sent" : "— rejected");
    expect(
      within(screen.getByLabelText("Version")).getAllByRole("option")[0],
    ).toHaveTextContent(`v1 · ${label}`);
  });

  it("the banner is informational, not a destructive alert", async () => {
    getPackageDetail.mockResolvedValue(nonActive("superseded"));
    await renderPage("p1");
    expect(screen.getByTestId("version-banner").className).not.toMatch(/destructive/);
  });

  it("changes_requested reads 'Changes requested' in the selector and header", async () => {
    getPackageDetail.mockResolvedValue(
      ok(
        detailFixture(
          { status: "changes_requested" },
          { versions: [{ id: "p2", version: 2, status: "changes_requested" }] },
        ),
      ),
    );
    await renderPage();
    expect(
      within(screen.getByLabelText("Version")).getAllByRole("option")[0],
    ).toHaveTextContent("v2 · Changes requested");
    expect(screen.queryByText(/changes_requested/)).toBeNull();
  });
});

describe("action bar: one primary CTA per state (AC-48)", () => {
  const bar = () => screen.getByRole("region", { name: "Actions" });
  const names = () =>
    within(bar())
      .getAllByRole("button")
      .map((b) => b.textContent);

  it("pending: Approve is the primary CTA, others are secondary", async () => {
    getPackageDetail.mockResolvedValue(ok(detailFixture()));
    await renderPage();
    const approve = within(bar()).getByRole("button", { name: "Approve and send…" });
    expect(approve).toBeInTheDocument();
    expect(names()).toEqual(
      expect.arrayContaining(["Approve and send…", "Reject", "Request changes", "More"]),
    );
    expect(names()).not.toContain("Unapprove");
    expect(names()).not.toContain("Send…");
    await userEvent.click(approve);
    expect(approvePackage).toHaveBeenCalledWith("p2");
  });

  it("approved and send-ready: Send is the primary CTA", async () => {
    getPackageDetail.mockResolvedValue(ok(detailFixture({ status: "approved" })));
    await renderPage();
    expect(
      within(bar()).getByRole("button", { name: "Send…" }),
    ).toBeInTheDocument();
    // Unapprove is a menu item, away from Send (D-041).
    expect(names()).toEqual(
      expect.arrayContaining(["Send…", "Reject", "Request changes"]),
    );
    expect(names()).not.toContain("Unapprove");
    expect(names()).not.toContain("Approve");
    expect(screen.queryByRole("link", { name: "Open job posting" })).toBeNull();
  });

  it("approved with a stale PDF: no CTA, one-line reason", async () => {
    getPackageDetail.mockResolvedValue(
      ok(detailFixture({ status: "approved", cvPdfStale: true })),
    );
    await renderPage();
    expect(within(bar()).getByText(/The CV PDF is out of date/)).toBeInTheDocument();
    expect(names()).not.toContain("Approve");
  });

  it("approved without Gmail: reason with a settings link", async () => {
    getPackageDetail.mockResolvedValue(
      ok(detailFixture({ status: "approved" }, { gmail: null })),
    );
    await renderPage();
    expect(within(bar()).getByText(/Gmail is not connected/)).toBeInTheDocument();
    expect(within(bar()).getByRole("link", { name: "Open settings" })).toHaveAttribute(
      "href",
      "/dashboard/review/settings",
    );
  });

  it("approved with an empty emailTo: 'Open job posting' is the primary CTA", async () => {
    getPackageDetail.mockResolvedValue(
      ok(detailFixture({ status: "approved", emailTo: "" })),
    );
    await renderPage();
    const link = within(bar()).getByRole("link", { name: "Open job posting" });
    expect(link).toHaveAttribute("href", "https://acme.example/jobs/1");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("freshly locked package: no actions, only a 'Sending…' status line", async () => {
    getPackageDetail.mockResolvedValue(
      ok(detailFixture({ status: "approved", sendStartedAt: new Date() })),
    );
    await renderPage();
    expect(screen.queryByRole("region", { name: "Actions" })).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent(/Sending….*locked/);
    expect(screen.queryByRole("button", { name: /approve|reject/i })).toBeNull();
  });

  it.each(["changes_requested", "sent", "rejected"])(
    "%s: no action buttons",
    async (status) => {
      getPackageDetail.mockResolvedValue(ok(detailFixture({ status })));
      await renderPage();
      expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Reject" })).toBeNull();
    },
  );

  it("reject asks for a reason and calls the action with it", async () => {
    getPackageDetail.mockResolvedValue(ok(detailFixture()));
    await renderPage();
    await userEvent.click(within(bar()).getByRole("button", { name: "Reject" }));
    const dialog = await screen.findByRole("dialog");
    const submit = within(dialog).getByRole("button", { name: "Reject" });
    // The reason is optional (D-041): the submit is enabled, chips fill it.
    expect(submit).toBeEnabled();
    await userEvent.click(within(dialog).getByRole("button", { name: "Not a fit" }));
    await userEvent.click(submit);
    expect(rejectPackage).toHaveBeenCalledWith("p2", "Not a fit");
  });

  it("reject without a reason calls the action with none", async () => {
    getPackageDetail.mockResolvedValue(ok(detailFixture()));
    await renderPage();
    await userEvent.click(within(bar()).getByRole("button", { name: "Reject" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Reject" }));
    expect(rejectPackage).toHaveBeenCalledWith("p2", undefined);
  });

  it("request changes passes the instruction", async () => {
    getPackageDetail.mockResolvedValue(ok(detailFixture()));
    await renderPage();
    await userEvent.click(
      within(bar()).getByRole("button", { name: "Request changes" }),
    );
    const dialog = await screen.findByRole("dialog");
    await userEvent.type(within(dialog).getByLabelText("Change request"), "Shorter");
    await userEvent.click(within(dialog).getByRole("button", { name: "Request changes" }));
    expect(requestPackageChanges).toHaveBeenCalledWith("p2", "Shorter");
  });

  it("the narrow-width 'More' sheet holds the secondary actions", async () => {
    getPackageDetail.mockResolvedValue(ok(detailFixture({ emailTo: null })));
    await renderPage();
    await userEvent.click(within(bar()).getByRole("button", { name: "More" }));
    const sheet = await screen.findByRole("dialog");
    expect(
      within(sheet).getAllByRole("button").map((b) => b.textContent),
    ).toEqual(expect.arrayContaining(["Reject", "Request changes"]));
  });
});

describe("mark applied manually (AC-29, AC-48, D-041)", () => {
  it("'I applied' is a direct button, from pending, only when emailTo is empty", async () => {
    getPackageDetail.mockResolvedValue(ok(detailFixture()));
    const { unmount } = await renderPage();
    expect(screen.queryByRole("button", { name: "I applied" })).toBeNull();
    unmount();

    getPackageDetail.mockResolvedValue(ok(detailFixture({ emailTo: "  " })));
    await renderPage();
    expect(screen.getByRole("button", { name: "I applied" })).toBeInTheDocument();
    // No Approve step for a link application.
    expect(screen.queryByRole("button", { name: /^Approve/ })).toBeNull();
    expect(screen.getByRole("link", { name: "Open job posting" })).toBeInTheDocument();
  });

  it("confirm text names the company, the role and the URL, then calls the action", async () => {
    getPackageDetail.mockResolvedValue(ok(detailFixture({ emailTo: null })));
    await renderPage();
    await userEvent.click(screen.getByRole("button", { name: "I applied" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent(
      "Mark your application to Staff Engineer at Acme Corp (https://acme.example/jobs/1) as applied? No email will be sent.",
    );
    expect(markPackageAppliedManually).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole("button", { name: "Mark applied" }));
    await waitFor(() =>
      expect(markPackageAppliedManually).toHaveBeenCalledWith("p2"),
    );
  });
});

describe("j / k navigation (AC-19)", () => {
  const press = (key: string, target: Element = document.body) =>
    fireEvent.keyDown(target, { key });

  it("moves to the adjacent todo packages given by the page", async () => {
    getPackageDetail.mockResolvedValue(ok(detailFixture()));
    getAdjacentPackageIds.mockResolvedValue(
      ok({ previousId: "prev-1", nextId: "next-1" }),
    );
    await renderPage();
    press("j");
    expect(push).toHaveBeenLastCalledWith("/dashboard/review/next-1");
    press("k");
    expect(push).toHaveBeenLastCalledWith("/dashboard/review/prev-1");
  });

  it("does nothing when there is no neighbour (not in todo, or at an end)", async () => {
    getPackageDetail.mockResolvedValue(ok(detailFixture()));
    await renderPage();
    press("j");
    press("k");
    expect(push).not.toHaveBeenCalled();
  });

  it("ignores keys typed in a form field, with modifiers, and other keys", async () => {
    getPackageDetail.mockResolvedValue(ok(detailFixture()));
    getAdjacentPackageIds.mockResolvedValue(ok({ previousId: "a", nextId: "b" }));
    await renderPage();
    const field = document.createElement("textarea");
    document.body.appendChild(field);
    field.focus();
    press("j", field);
    fireEvent.keyDown(document.body, { key: "j", ctrlKey: true });
    press("x");
    expect(push).not.toHaveBeenCalled();
    field.remove();
  });

  it("is ignored while a dialog is open", async () => {
    getPackageDetail.mockResolvedValue(ok(detailFixture()));
    getAdjacentPackageIds.mockResolvedValue(ok({ previousId: "a", nextId: "b" }));
    await renderPage();
    await userEvent.click(screen.getByRole("button", { name: "Reject" }));
    await screen.findByRole("dialog");
    press("j");
    expect(push).not.toHaveBeenCalled();
  });

  it.each([["ctrlKey"], ["metaKey"], ["altKey"]])(
    "ignores j / k with %s held while focus is on the page",
    async (mod) => {
      getPackageDetail.mockResolvedValue(ok(detailFixture()));
      getAdjacentPackageIds.mockResolvedValue(ok({ previousId: "a", nextId: "b" }));
      await renderPage();
      (document.activeElement as HTMLElement | null)?.blur();
      fireEvent.keyDown(document.body, { key: "j", [mod]: true });
      fireEvent.keyDown(document.body, { key: "k", [mod]: true });
      expect(push).not.toHaveBeenCalled();
    },
  );

  it.each(["input", "textarea", "select"])(
    "ignores keys while a %s has focus, even when the event targets the page",
    async (tag) => {
      getPackageDetail.mockResolvedValue(ok(detailFixture()));
      getAdjacentPackageIds.mockResolvedValue(ok({ previousId: "a", nextId: "b" }));
      await renderPage();
      const field = document.createElement(tag);
      document.body.appendChild(field);
      field.focus();
      expect(document.activeElement).toBe(field);
      press("j");
      press("k");
      expect(push).not.toHaveBeenCalled();
      field.remove();
    },
  );

  it("ignores keys while a contenteditable element has focus (empty or plaintext-only value)", async () => {
    getPackageDetail.mockResolvedValue(ok(detailFixture()));
    getAdjacentPackageIds.mockResolvedValue(ok({ previousId: "a", nextId: "b" }));
    await renderPage();
    for (const value of ["", "plaintext-only"]) {
      const box = document.createElement("div");
      box.setAttribute("contenteditable", value);
      box.tabIndex = 0;
      // jsdom does not implement isContentEditable: mirror what a browser reports.
      Object.defineProperty(box, "isContentEditable", { value: true });
      document.body.appendChild(box);
      press("j", box);
      box.focus();
      press("k");
      expect(push).not.toHaveBeenCalled();
      box.remove();
    }
  });

  it.each(["dialog", "alertdialog"])(
    "is ignored while a bare role=%s is present",
    async (role) => {
      getPackageDetail.mockResolvedValue(ok(detailFixture()));
      getAdjacentPackageIds.mockResolvedValue(ok({ previousId: "a", nextId: "b" }));
      await renderPage();
      const el = document.createElement("div");
      el.setAttribute("role", role);
      document.body.appendChild(el);
      press("j");
      press("k");
      expect(push).not.toHaveBeenCalled();
      el.remove();
      press("j");
      expect(push).toHaveBeenCalledWith("/dashboard/review/b");
    },
  );

  it("is ignored while a menu is open", async () => {
    getPackageDetail.mockResolvedValue(ok(detailFixture()));
    getAdjacentPackageIds.mockResolvedValue(ok({ previousId: "a", nextId: "b" }));
    await renderPage();
    const menu = document.createElement("div");
    menu.setAttribute("role", "menu");
    document.body.appendChild(menu);
    press("j");
    expect(push).not.toHaveBeenCalled();
    menu.remove();
    press("j");
    expect(push).toHaveBeenCalledWith("/dashboard/review/b");
  });

  it("ignores a keydown whose target is contenteditable", async () => {
    getPackageDetail.mockResolvedValue(ok(detailFixture()));
    getAdjacentPackageIds.mockResolvedValue(ok({ previousId: "a", nextId: "b" }));
    await renderPage();
    const box = document.createElement("div");
    box.setAttribute("contenteditable", "true");
    document.body.appendChild(box);
    press("j", box);
    expect(push).not.toHaveBeenCalled();
    box.remove();
  });

  it("is disabled while the edit form is open", async () => {
    getPackageDetail.mockResolvedValue(ok(detailFixture()));
    getAdjacentPackageIds.mockResolvedValue(ok({ previousId: "a", nextId: "b" }));
    await renderPage();
    await userEvent.click(screen.getByRole("button", { name: "Edit" }));
    await screen.findByRole("form", { name: "Edit package" });
    press("j");
    press("k");
    expect(push).not.toHaveBeenCalled();
  });

  it("shows the key hint on the detail page only when there is a neighbour", async () => {
    getPackageDetail.mockResolvedValue(ok(detailFixture()));
    getAdjacentPackageIds.mockResolvedValue(ok({ previousId: null, nextId: "b" }));
    const { unmount } = await renderPage();
    const hint = screen.getByText("j / k: next / previous in To do");
    expect(hint).toBeInTheDocument();
    // No keyboard on a phone: hidden below md (jsdom has no media queries).
    expect(hint).toHaveClass("hidden", "md:block");
    unmount();
    getAdjacentPackageIds.mockResolvedValue(ok({ previousId: null, nextId: null }));
    await renderPage();
    expect(screen.queryByText(/j \/ k/)).toBeNull();
  });

  it("a failed adjacent lookup disables the keys instead of failing the page", async () => {
    getPackageDetail.mockResolvedValue(ok(detailFixture()));
    getAdjacentPackageIds.mockResolvedValue(fail("INTERNAL"));
    await renderPage();
    press("j");
    expect(push).not.toHaveBeenCalled();
  });
});

describe("DetailView direct render", () => {
  it("renders without a router error", () => {
    render(
      <DetailView
        detail={detailFixture()}
        adjacent={{ previousId: null, nextId: null }}
      />,
    );
    expect(screen.getByTestId("panel-posting")).toBeInTheDocument();
  });
});
