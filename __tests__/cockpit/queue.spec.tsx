import { render, screen, within } from "@testing-library/react";

const getReviewQueue = vi.hoisted(() => vi.fn());
vi.mock("@/actions/cockpit.actions", () => ({ getReviewQueue }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((to: string) => {
    throw new Error(`REDIRECT:${to}`);
  }),
  notFound: vi.fn(() => {
    throw new Error("NOT_FOUND");
  }),
}));

import ReviewQueuePage from "@/app/dashboard/review/page";
import ReviewLoading from "@/app/dashboard/review/loading";
import ReviewLayout from "@/app/dashboard/review/layout";
import { readinessChips, type QueueRowData } from "@/components/cockpit/QueueRow";
import { parseQueueTab } from "@/components/cockpit/queueTabs";

const row = (over: Partial<QueueRowData> = {}): QueueRowData => ({
  id: "p1",
  jobId: "j1",
  version: 2,
  status: "pending",
  fitGrade: "A",
  emailTo: "jobs@acme.example",
  cvFileId: "f1",
  cvPdfStale: false,
  sendStartedAt: null,
  sendOutcome: null,
  createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
  job: {
    id: "j1",
    JobTitle: { label: "Staff Engineer" },
    Company: { label: "Acme Corp" },
  },
  ...over,
});

const ok = (
  rows: QueueRowData[],
  extra: { gmail?: { email: string } | null; gmailCalloutNeeded?: boolean } = {},
) => ({
  success: true,
  data: {
    rows,
    gmail: extra.gmail ?? null,
    gmailCalloutNeeded: extra.gmailCalloutNeeded ?? false,
  },
});

async function renderPage(tab?: string) {
  const ui = await ReviewQueuePage({
    searchParams: Promise.resolve(tab ? { tab } : {}),
  });
  return render(ui);
}

describe("review queue page", () => {
  beforeEach(() => getReviewQueue.mockReset());

  it("renders the four tabs and marks the default one current", async () => {
    getReviewQueue.mockResolvedValue(ok([row()]));
    await renderPage();
    const nav = screen.getByRole("navigation", { name: /filters/i });
    const links = within(nav).getAllByRole("link");
    expect(links.map((l) => l.textContent)).toEqual([
      "To do",
      "Changes requested",
      "Sent",
      "Rejected",
    ]);
    expect(links[1]).toHaveAttribute("href", "/dashboard/review?tab=changes");
    expect(links[0]).toHaveAttribute("aria-current", "page");
    expect(getReviewQueue).toHaveBeenCalledWith("todo");
  });

  it("passes a valid ?tab= and falls back to todo for junk", async () => {
    getReviewQueue.mockResolvedValue(ok([]));
    await renderPage("sent");
    expect(getReviewQueue).toHaveBeenLastCalledWith("sent");
    expect(parseQueueTab("nope")).toBe("todo");
    expect(parseQueueTab(["sent"])).toBe("todo");
  });

  it("renders a row with company, role, grade, version, status, recipient, link", async () => {
    getReviewQueue.mockResolvedValue(
      ok([row()], { gmail: { email: "me@example.com" } }),
    );
    await renderPage();
    const link = screen.getByRole("link", { name: /Acme Corp/ });
    expect(link).toHaveAttribute("href", "/dashboard/review/p1");
    expect(within(link).getByText("Staff Engineer")).toBeInTheDocument();
    expect(within(link).getByText("Fit grade")).toBeInTheDocument();
    expect(link).toHaveTextContent("Fit grade A");
    expect(within(link).getByText("v2")).toBeInTheDocument();
    expect(within(link).getByText("Pending")).toBeInTheDocument();
    expect(within(link).getByText("jobs@acme.example")).toBeInTheDocument();
    expect(within(link).getByText(/ago/)).toBeInTheDocument();
    expect(within(link).queryAllByTestId("readiness-chip")).toHaveLength(0);
    expect(
      screen.getByText("Gmail: connected as me@example.com"),
    ).toBeInTheDocument();
  });

  it("shows 'Apply via link' and the Link apply chip without a recipient", async () => {
    getReviewQueue.mockResolvedValue(
      ok([row({ emailTo: null })], { gmail: { email: "me@example.com" } }),
    );
    await renderPage();
    expect(screen.getByText("Apply via link")).toBeInTheDocument();
    expect(screen.getByText("Link apply")).toBeInTheDocument();
  });

  it.each([
    ["todo", /Nothing to review/],
    ["changes", /No packages are waiting/],
    ["sent", /Nothing sent yet/],
    ["rejected", /No rejected packages/],
  ])("shows the %s empty state with no list and no j / k hint", async (tab, msg) => {
    getReviewQueue.mockResolvedValue(ok([]));
    await renderPage(tab);
    expect(screen.getByText(msg)).toBeInTheDocument();
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
    // j / k only work on the detail page, so the queue must not advertise them.
    expect(screen.queryByText(/j \/ k/)).toBeNull();
  });

  it("lists rows on the Sent tab and never shows the j / k hint on the queue", async () => {
    getReviewQueue.mockResolvedValue(
      ok([row({ status: "sent" }), row({ id: "p9", status: "changes_requested" })]),
    );
    await renderPage("sent");
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    const list = within(screen.getByRole("list"));
    expect(list.getByText("Sent")).toBeInTheDocument();
    expect(list.getByText("Changes requested")).toBeInTheDocument();
    expect(screen.queryByText(/j \/ k/)).toBeNull();
  });

  it("shows the Gmail callout only when the action says it is needed", async () => {
    getReviewQueue.mockResolvedValue(ok([row()], { gmailCalloutNeeded: true }));
    const { unmount } = await renderPage();
    const callout = screen.getByRole("alert");
    expect(
      within(callout).getByRole("link", { name: /Connect Gmail/ }),
    ).toHaveAttribute("href", "/dashboard/review/settings");
    expect(screen.getByText("Gmail: not connected")).toBeInTheDocument();
    unmount();

    getReviewQueue.mockResolvedValue(ok([row()]));
    await renderPage();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("redirects when unauthenticated and 404s when the flag is off", async () => {
    getReviewQueue.mockResolvedValue({
      success: false,
      code: "UNAUTHENTICATED",
      message: "Not authenticated",
    });
    await expect(renderPage()).rejects.toThrow("REDIRECT:/signin");
    getReviewQueue.mockResolvedValue({
      success: false,
      code: "COCKPIT_DISABLED",
      message: "Cockpit is disabled",
    });
    await expect(renderPage()).rejects.toThrow("NOT_FOUND");
  });

  it("shows the fixed message for other failures", async () => {
    getReviewQueue.mockResolvedValue({
      success: false,
      code: "INTERNAL",
      message: "Something went wrong",
    });
    await renderPage();
    expect(screen.getByRole("alert")).toHaveTextContent("Something went wrong");
  });
});

describe("readiness chips (AC-47)", () => {
  it("Gmail chip: emailTo set and Gmail not connected", () => {
    expect(readinessChips(row(), false)).toEqual(["Gmail"]);
    expect(readinessChips(row(), true)).toEqual([]);
  });

  it("PDF stale and No CV", () => {
    expect(readinessChips(row({ cvPdfStale: true }), true)).toEqual([
      "PDF stale",
    ]);
    expect(readinessChips(row({ cvFileId: null }), true)).toEqual(["No CV"]);
  });

  it("Link apply for empty or blank emailTo, never combined with Gmail", () => {
    expect(readinessChips(row({ emailTo: "" }), false)).toEqual(["Link apply"]);
    expect(readinessChips(row({ emailTo: "  " }), true)).toEqual([
      "Link apply",
    ]);
  });
});

describe("review route files", () => {
  it("has a loading skeleton", () => {
    render(<ReviewLoading />);
    expect(
      screen.getByRole("status", { name: /loading review queue/i }),
    ).toBeInTheDocument();
  });

  it("layout wraps children in a full-width col-span-3 box", () => {
    render(
      <ReviewLayout>
        <span>child</span>
      </ReviewLayout>,
    );
    expect(screen.getByText("child").parentElement).toHaveClass("col-span-3");
  });
});
