import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// QueueView refreshes on focus (D-041): it needs a router.
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("@/actions/cockpit.actions", () => ({ getReviewQueue: vi.fn() }));
vi.mock("@/components/TipTapContentViewer", () => ({
  TipTapContentViewer: () => <div />,
}));

import {
  STATUS_CLASSES,
  STATUS_LABELS,
  statusClass,
} from "@/components/cockpit/statusLabels";
import StatusBadge from "@/components/cockpit/StatusBadge";
import QueueRow, { type QueueRowData } from "@/components/cockpit/QueueRow";
import QueueTabs from "@/components/cockpit/QueueTabs";
import QueueView from "@/components/cockpit/QueueView";
import TextDialog from "@/components/cockpit/TextDialog";
import { recipientParts } from "@/components/cockpit/SendDialog";
import { FitPanel, SendHistoryPanel, type PackageDetail } from "@/components/cockpit/Panels";
import {
  attemptView,
  fitKind,
  fitLabel,
  fitScore,
  splitHistory,
} from "@/components/cockpit/panelModels";
import {
  isSendUnknown,
  sortTodoRows,
  tabCounts,
} from "@/lib/cockpit/queueOrder";

// D-040: status colours, queue order and counts, history rows, fit panel,
// TextDialog, recipient wrapping. Synthetic data only.

const row = (over: Partial<QueueRowData> = {}): QueueRowData => ({
  id: "p1",
  jobId: "j1",
  version: 1,
  status: "pending",
  fitGrade: "A",
  emailTo: "jobs@acme.example",
  cvFileId: "f1",
  cvPdfStale: false,
  sendStartedAt: null,
  sendOutcome: null,
  createdAt: new Date(Date.now() - 3600_000),
  job: { id: "j1", JobTitle: { label: "Engineer" }, Company: { label: "Acme" } },
  ...over,
});

describe("status class map", () => {
  it("has one class per labelled status, all distinct for the five live ones", () => {
    for (const k of Object.keys(STATUS_LABELS)) expect(STATUS_CLASSES[k]).toBeTruthy();
    const live = ["pending", "approved", "sent", "rejected", "changes_requested"].map(
      statusClass,
    );
    expect(new Set(live).size).toBe(5);
  });

  it("maps the colours the owner asked for", () => {
    expect(statusClass("pending")).toMatch(/amber/);
    expect(statusClass("approved")).toMatch(/blue/);
    expect(statusClass("sent")).toMatch(/green/);
    expect(statusClass("rejected")).toMatch(/red/);
    expect(statusClass("changes_requested")).toMatch(/amber/);
    expect(statusClass("something_else")).toBe(statusClass("superseded"));
  });

  it("StatusBadge shows the plain label and exposes the status", () => {
    render(<StatusBadge status="changes_requested" />);
    const badge = screen.getByText("Changes requested");
    expect(badge).toHaveAttribute("data-status", "changes_requested");
    expect(badge.className).toContain(statusClass("changes_requested"));
  });
});

describe("queue order and counts", () => {
  it("isSendUnknown: unknown outcome or a stale lock (fresh locks: see uxVisualReview)", () => {
    expect(isSendUnknown({ sendOutcome: "unknown" })).toBe(true);
    expect(isSendUnknown({ sendStartedAt: new Date(Date.now() - 120_000) })).toBe(true);
    expect(isSendUnknown({ sendStartedAt: new Date() })).toBe(false);
    expect(isSendUnknown({ sendOutcome: null, sendStartedAt: null })).toBe(false);
    expect(isSendUnknown({})).toBe(false);
  });

  it("sorts send-unknown first, then approved, then pending, newest first inside", () => {
    const rows = [
      { id: "p-new", status: "pending" },
      { id: "a-new", status: "approved" },
      { id: "u", status: "approved", sendOutcome: "unknown" },
      { id: "a-old", status: "approved" },
      { id: "p-old", status: "pending" },
    ];
    expect(sortTodoRows(rows).map((r) => r.id)).toEqual([
      "u",
      "a-new",
      "a-old",
      "p-new",
      "p-old",
    ]);
    // Does not mutate its input.
    expect(rows[0].id).toBe("p-new");
  });

  it("tabCounts adds the statuses of each tab and defaults to 0", () => {
    const counts = tabCounts(
      [
        { status: "pending", count: 2 },
        { status: "approved", count: 3 },
        { status: "sent", count: 4 },
      ],
      { todo: ["pending", "approved"], changes: ["changes_requested"], sent: ["sent"] },
    );
    expect(counts).toEqual({ todo: 5, changes: 0, sent: 4 });
  });
});

describe("QueueRow", () => {
  it("shows a Send unknown chip for an ambiguous send and not for a normal row", () => {
    const { unmount } = render(
      <ul>
        <QueueRow row={row({ status: "approved", sendOutcome: "unknown" })} gmailConnected />
      </ul>,
    );
    expect(screen.getByTestId("send-unknown-chip")).toHaveTextContent("Send unknown");
    expect(screen.getByText("Approved")).toHaveAttribute("data-status", "approved");
    unmount();
    render(
      <ul>
        <QueueRow row={row()} gmailConnected />
      </ul>,
    );
    expect(screen.queryByTestId("send-unknown-chip")).toBeNull();
  });

  it("titles the truncated text and shows readiness chips with an icon", () => {
    render(
      <ul>
        <QueueRow row={row({ emailTo: null, cvPdfStale: true })} gmailConnected />
      </ul>,
    );
    expect(screen.getByText("Acme")).toHaveAttribute("title", "Acme");
    expect(screen.getByText("Engineer")).toHaveAttribute("title", "Engineer");
    const chips = screen.getAllByTestId("readiness-chip");
    expect(chips.map((c) => c.textContent)).toEqual(["PDF stale", "Link apply"]);
    for (const c of chips) expect(c.querySelector("svg")).not.toBeNull();
    expect(screen.getByRole("link").className).toMatch(/focus-visible:ring-2/);
  });
});

describe("QueueTabs", () => {
  it("adds the count to each tab and keeps 44px, nowrap, focus ring", () => {
    render(<QueueTabs tab="todo" counts={{ todo: 5, changes: 0, sent: 12, rejected: 1 }} />);
    const links = within(screen.getByRole("navigation")).getAllByRole("link");
    expect(links.map((l) => l.textContent)).toEqual([
      "To do5",
      "Changes requested0",
      "Sent12",
      "Rejected1",
    ]);
    for (const l of links) {
      expect(l.className).toMatch(/min-h-11/);
      expect(l.className).toMatch(/whitespace-nowrap/);
      expect(l.className).toMatch(/focus-visible:ring-2/);
    }
    expect(screen.getByRole("navigation").className).toMatch(/overflow-x-auto/);
    expect(screen.getByRole("navigation").className).toMatch(/flex-nowrap/);
  });

  it("shows only the label without counts", () => {
    render(<QueueTabs tab="sent" />);
    expect(screen.queryAllByTestId("tab-count")).toHaveLength(0);
  });
});

describe("QueueView To do sections", () => {
  const data = (rows: QueueRowData[]) =>
    ({
      rows,
      counts: { todo: rows.length, changes: 0, sent: 0, rejected: 0 },
      gmail: { email: "me@example.com" },
      gmailCalloutNeeded: false,
    }) as never;

  it("groups Ready to send before To review, with the Gmail dot", () => {
    render(
      <QueueView
        tab="todo"
        data={data([
          row({ id: "a", status: "approved" }),
          row({ id: "b", status: "pending" }),
        ])}
      />,
    );
    const headings = screen.getAllByRole("heading", { level: 2 });
    expect(headings.map((h) => h.textContent)).toEqual([
      "Ready to send (1)",
      "To review (1)",
    ]);
    expect(screen.getAllByRole("list")).toHaveLength(2);
    expect(screen.getByTestId("gmail-dot").className).toMatch(/green/);
    expect(screen.getByRole("link", { name: /Gmail: connected as/ }).className).toMatch(
      /min-h-11/,
    );
  });

  it("has no section headers on the other tabs", () => {
    render(<QueueView tab="sent" data={data([row({ status: "sent" })])} />);
    expect(screen.queryAllByRole("heading")).toHaveLength(0);
  });
});

describe("send history rows", () => {
  it("maps every outcome to a tone, a badge and a plain sentence", () => {
    expect(attemptView("sent")).toMatchObject({ tone: "ok", badge: "Sent" });
    expect(attemptView("failed")).toMatchObject({ tone: "fail", badge: "Not sent" });
    expect(attemptView("ambiguous")).toMatchObject({ tone: "unknown" });
    expect(attemptView("record_failed").tone).toBe("unknown");
    expect(attemptView("marked_sent").tone).toBe("ok");
    expect(attemptView("nonsense")).toMatchObject({ sentence: "Unrecognized entry" });
    // Prototype keys must not resolve to a row.
    expect(attemptView("constructor").sentence).toBe("Unrecognized entry");
  });

  it("splitHistory keeps the newest 3 and counts the hidden ones", () => {
    const rows = [1, 2, 3, 4, 5];
    expect(splitHistory(rows, false)).toEqual({ hidden: 2, visible: [3, 4, 5] });
    expect(splitHistory(rows, true)).toEqual({ hidden: 0, visible: rows });
    expect(splitHistory([1, 2, 3], false)).toEqual({ hidden: 0, visible: [1, 2, 3] });
    expect(splitHistory([1, 2, 3, 4], false)).toEqual({ hidden: 0, visible: [1, 2, 3, 4] });
  });

  const attempt = (i: number, outcome = "failed") => ({
    id: `a${i}`,
    outcome,
    reason: i === 5 ? "Gmail rejected the message" : null,
    gmailMessageId: null,
    createdAt: new Date(Date.UTC(2026, 10, 1, 8, i)),
  });

  it("renders icon, badge, <time> with the absolute time in the title, and collapses after 3", async () => {
    const history = [1, 2, 3, 4, 5].map((i) => attempt(i, i === 5 ? "sent" : "failed"));
    render(<SendHistoryPanel history={history as PackageDetail["sendHistory"]} />);
    expect(screen.getAllByTestId("send-attempt")).toHaveLength(3);
    const first = screen.getAllByTestId("send-attempt")[0];
    expect(first.querySelector("svg")).not.toBeNull();
    const time = first.querySelector("time")!;
    expect(time.getAttribute("datetime")).toMatch(/^2026-11-01T/);
    expect(time.getAttribute("title")).toBeTruthy();
    expect(time.textContent).toMatch(/ago/);
    expect(screen.getByText("Gmail rejected the message")).toHaveClass("text-xs");
    // The icon is aria-hidden; the outcome tone is spoken as sr-only text.
    expect(first.textContent).toMatch(/^Failed: Not sent/);
    expect(screen.getAllByTestId("send-attempt")[2].textContent).toMatch(/^Succeeded: Sent/);

    await userEvent.click(screen.getByRole("button", { name: "Show 2 earlier attempts" }));
    expect(screen.getAllByTestId("send-attempt")).toHaveLength(5);
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("fit panel", () => {
  const pkg = (fit: object) =>
    ({ fitGrade: "A", fitAnalysis: JSON.stringify(fit) }) as PackageDetail["package"];

  it("fitScore accepts 0..100 numbers and numeric strings only", () => {
    expect(fitScore(87)).toBe(87);
    expect(fitScore("42")).toBe(42);
    expect(fitScore(101)).toBeNull();
    expect(fitScore(-1)).toBeNull();
    expect(fitScore("high")).toBeNull();
    expect(fitScore("")).toBeNull();
  });

  it("labels and kinds", () => {
    expect(fitLabel("score")).toBe("Match score");
    expect(fitLabel("must_haves")).toBe("Must haves");
    expect(fitKind("strengths", ["a"])).toBe("strengths");
    expect(fitKind("gaps", ["a"])).toBe("gaps");
    expect(fitKind("gaps", "text")).toBe("other");
    expect(fitKind("score", "n/a")).toBe("other");
  });

  it("shows '87 / 100' with a meter and marks strengths and gaps", () => {
    render(
      <FitPanel
        pkg={pkg({ summary: "Good", score: 87, strengths: ["Go"], gaps: ["Rust"] })}
      />,
    );
    expect(screen.getByText("87 / 100")).toBeInTheDocument();
    const bar = screen.getByRole("progressbar", { name: "Match score" });
    expect(bar).toHaveAttribute("aria-valuenow", "87");
    const items = screen.getAllByRole("listitem");
    expect(items.map((l) => l.textContent)).toEqual(["Go", "Rust"]);
    expect(items[0].querySelector("svg")!.getAttribute("class")).toMatch(/green/);
    expect(items[1].querySelector("svg")!.getAttribute("class")).toMatch(/amber/);
  });

  it("a non-numeric score stays plain text, no meter", () => {
    render(<FitPanel pkg={pkg({ score: "n/a" })} />);
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(screen.getByText("n/a")).toBeInTheDocument();
  });
});

describe("TextDialog", () => {
  const base = {
    open: true,
    onOpenChange: () => {},
    title: "Reject",
    description: "Why?",
    label: "Reason",
    submitLabel: "Reject package",
    busy: false,
    onSubmit: () => {},
  };

  it("has a visible label tied to the textarea and a roomy field", () => {
    render(<TextDialog {...base} />);
    const field = screen.getByLabelText("Reason");
    expect(field.tagName).toBe("TEXTAREA");
    expect(field.className).toMatch(/min-h-32/);
    expect(screen.getByRole("dialog").className).toMatch(/max-h-\[85dvh\]/);
    expect(screen.getByRole("dialog").className).toMatch(/overflow-y-auto/);
  });

  it("destructive styles only the submit button", () => {
    const { rerender } = render(<TextDialog {...base} />);
    expect(screen.getByRole("button", { name: "Reject package" })).not.toHaveAttribute(
      "data-destructive",
    );
    expect(screen.getByRole("button", { name: "Reject package" }).className).not.toMatch(
      /bg-destructive/,
    );
    rerender(<TextDialog {...base} destructive />);
    const submit = screen.getByRole("button", { name: "Reject package" });
    expect(submit).toHaveAttribute("data-destructive", "true");
    expect(submit.className).toMatch(/bg-destructive/);
    expect(screen.getByRole("button", { name: "Cancel" }).className).not.toMatch(
      /bg-destructive/,
    );
  });
});

describe("recipientParts", () => {
  it("breaks after @ and dots and joins back to the address", () => {
    expect(recipientParts("jobs@approved.example.com")).toEqual([
      "jobs@",
      "approved.",
      "example.",
      "com",
    ]);
    expect(recipientParts("a@b.co").join("")).toBe("a@b.co");
    expect(recipientParts("")).toEqual([""]);
  });
});
