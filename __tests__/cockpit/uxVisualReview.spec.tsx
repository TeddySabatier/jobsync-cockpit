import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach } from "vitest";

vi.mock("@/actions/cockpit.actions", () => ({ getReviewQueue: vi.fn() }));
vi.mock("@/actions/cockpitSend.actions", () => ({
  markSendUnknownAsSent: vi.fn(),
  releaseSendLock: vi.fn(),
}));
vi.mock("@/components/TipTapContentViewer", () => ({
  TipTapContentViewer: () => <div />,
}));

import QueueRow, { type QueueRowData } from "@/components/cockpit/QueueRow";
import TextDialog from "@/components/cockpit/TextDialog";
import SendOutcomePanel from "@/components/cockpit/SendOutcomePanel";
import { FitPanel, SendHistoryPanel, type PackageDetail } from "@/components/cockpit/Panels";
import { fitKind, fitMax, fitScore, fitScoreView } from "@/components/cockpit/panelModels";
import {
  DESTRUCTIVE_CONFIRM_COLORS,
  destructiveConfirmClass,
} from "@/components/cockpit/destructiveConfirm";
import { isSendUnknown, sendState, sortTodoRows } from "@/lib/cockpit/queueOrder";
import { STALE_LOCK_MS } from "@/lib/cockpit/constants";

// D-040 review follow-ups. Synthetic data only.

const NOW = new Date("2026-11-12T10:00:00Z").getTime();

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

const row = (over: Partial<QueueRowData> = {}): QueueRowData => ({
  kind: "application",
  followUpStep: null,
  followUp: null,
  id: "p1",
  jobId: "j1",
  version: 1,
  status: "approved",
  fitGrade: "A",
  emailTo: "jobs@acme.example",
  cvFileId: "f1",
  cvPdfStale: false,
  sendStartedAt: null,
  sendOutcome: null,
  createdAt: new Date(NOW - 3600_000),
  job: { id: "j1", JobTitle: { label: "Engineer" }, Company: { label: "Acme" } },
  ...over,
});

describe("send state with a frozen clock", () => {
  const ago = (ms: number) => new Date(NOW - ms);
  it("fresh lock is sending, not unknown", () => {
    expect(sendState({ sendStartedAt: ago(5_000) })).toBe("sending");
    expect(isSendUnknown({ sendStartedAt: ago(STALE_LOCK_MS - 1) })).toBe(false);
  });
  it("stale lock or unknown outcome is unknown", () => {
    expect(sendState({ sendStartedAt: ago(STALE_LOCK_MS) })).toBe("unknown");
    expect(sendState({ sendStartedAt: ago(STALE_LOCK_MS + 1).toISOString() })).toBe("unknown");
    expect(sendState({ sendOutcome: "unknown" })).toBe("unknown");
    expect(sendState({ sendOutcome: "unknown", sendStartedAt: ago(1) })).toBe("unknown");
  });
  it("no lock, or a recorded outcome, is nothing", () => {
    expect(sendState({})).toBeNull();
    expect(sendState({ sendOutcome: null, sendStartedAt: null })).toBeNull();
    expect(sendState({ sendOutcome: "sent", sendStartedAt: ago(5_000) })).toBeNull();
  });
  it("only unknown sorts first; a sending row keeps its normal place", () => {
    const rows = [
      { id: "a", status: "approved" },
      { id: "s", status: "pending", sendStartedAt: ago(1_000) },
      { id: "u", status: "approved", sendStartedAt: ago(STALE_LOCK_MS + 5_000) },
    ];
    expect(sortTodoRows(rows).map((r) => r.id)).toEqual(["u", "a", "s"]);
  });
  it("QueueRow: Sending chip for a fresh lock, amber Send unknown for a stale one", () => {
    const { unmount } = render(
      <ul>
        <QueueRow row={row({ sendStartedAt: ago(2_000) })} gmailConnected />
      </ul>,
    );
    expect(screen.getByTestId("sending-chip")).toHaveTextContent("Sending");
    expect(screen.queryByTestId("send-unknown-chip")).toBeNull();
    unmount();
    render(
      <ul>
        <QueueRow row={row({ sendStartedAt: ago(STALE_LOCK_MS + 1) })} gmailConnected />
      </ul>,
    );
    expect(screen.getByTestId("send-unknown-chip")).toHaveTextContent("Send unknown");
    expect(screen.queryByTestId("sending-chip")).toBeNull();
  });
});

describe("fit score parsing", () => {
  it("percentages, fractions and numeric strings", () => {
    expect(fitScore(87)).toBe(87);
    expect(fitScore("87%")).toBe(87);
    expect(fitScore(0.87)).toBe(87);
    expect(fitScore("0.5")).toBe(50);
    expect(fitScore(0)).toBe(0);
    expect(fitScoreView(0.87)).toEqual({ percent: 87, text: "87 / 100" });
  });
  it("0..10 only when the maximum is stated", () => {
    expect(fitScore(8)).toBeNull();
    expect(fitScore(1)).toBeNull();
    expect(fitScore(8, 10)).toBe(80);
    expect(fitScoreView(8, 10)).toEqual({ percent: 80, text: "8 / 10" });
    expect(fitScoreView("7/10")).toEqual({ percent: 70, text: "7 / 10" });
    expect(fitScore(11, 10)).toBeNull();
    expect(fitScore(101)).toBeNull();
    expect(fitScore(-3)).toBeNull();
    expect(fitScore("high")).toBeNull();
  });
  it("fit_score alias and a stated max key", () => {
    expect(fitKind("fit_score", 87)).toBe("score");
    expect(fitKind("fitScore", 87)).toBe("score");
    expect(fitKind("fit_score", 8)).toBe("other");
    expect(fitMax({ score: 8, max_score: 10 })).toBe(10);
    expect(fitMax({ score: 8 })).toBeNull();
    expect(fitKind("score", 8, 10)).toBe("score");
  });

  const pkg = (fit: object) =>
    ({ fitGrade: "A", fitAnalysis: JSON.stringify(fit) }) as PackageDetail["package"];

  it("panel: fit_score fraction gets a meter; a 0..10 score without a max is plain text", () => {
    const { unmount } = render(<FitPanel pkg={pkg({ fit_score: 0.87 })} />);
    expect(screen.getByText("87 / 100")).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "87");
    unmount();
    const second = render(<FitPanel pkg={pkg({ score: 8 })} />);
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(screen.getByText("8")).toBeInTheDocument();
    second.unmount();
    render(<FitPanel pkg={pkg({ score: 8, max_score: 10 })} />);
    expect(screen.getByText("8 / 10")).toBeInTheDocument();
    expect(screen.getAllByRole("progressbar")[0]).toHaveAttribute("aria-valuenow", "80");
  });

  it("panel does not repeat the grade shown in the header", () => {
    render(<FitPanel pkg={pkg({ score: 87 })} />);
    expect(screen.getByTestId("panel-fit")).not.toHaveTextContent(/Grade/);
    expect(screen.queryByText("A")).toBeNull();
  });
});

describe("send history absolute time", () => {
  it("shows the absolute time as visible text next to the relative <time>", () => {
    const createdAt = new Date("2026-11-01T08:05:00Z");
    render(
      <SendHistoryPanel
        history={
          [
            { id: "a1", outcome: "failed", reason: null, gmailMessageId: null, createdAt },
          ] as PackageDetail["sendHistory"]
        }
      />,
    );
    const li = screen.getByTestId("send-attempt");
    expect(li.querySelector("time")!.textContent).toMatch(/ago/);
    const abs = within(li).getByTestId("send-attempt-abs");
    expect(abs.textContent).toMatch(/2026/);
    expect(abs.getAttribute("class")).toMatch(/text-xs/);
  });
});

// WCAG relative luminance contrast.
function lum(hex: string): number {
  const c = [1, 3, 5].map((i) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
const contrast = (a: string, b: string) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

describe("destructive confirm buttons (light contrast)", () => {
  it("the local override reaches 4.5:1 for rest and hover", () => {
    const { background, hoverBackground, text } = DESTRUCTIVE_CONFIRM_COLORS;
    expect(contrast(text, background)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(text, hoverBackground)).toBeGreaterThanOrEqual(4.5);
    // The global light token (0 84.2% 60.2% = #ef4444) is the ~3.6:1 case.
    expect(contrast("#ffffff", "#ef4444")).toBeLessThan(4.5);
    expect(destructiveConfirmClass).toMatch(/(^|\s)bg-red-700(\s|$)/);
    expect(destructiveConfirmClass).toMatch(/hover:bg-red-800/);
    expect(destructiveConfirmClass).not.toMatch(/(^|\s)bg-destructive(\s|$)/);
    expect(destructiveConfirmClass).toMatch(/dark:bg-destructive/);
  });

  it("TextDialog destructive submit uses it; the default one does not", () => {
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
    const { rerender } = render(<TextDialog {...base} destructive />);
    expect(screen.getByRole("button", { name: "Reject package" }).className).toMatch(/bg-red-700/);
    rerender(<TextDialog {...base} />);
    expect(screen.getByRole("button", { name: "Reject package" }).className).not.toMatch(
      /bg-red-700/,
    );
  });

  it("Unblock confirm uses it and explains late Gmail and the return to Approved", async () => {
    render(
      <SendOutcomePanel packageId="p1" sendStartedAt={new Date(NOW)} sendOutcome="unknown" />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Not sent: unblock" }));
    const dialog = screen.getByRole("alertdialog");
    expect(within(dialog).getByRole("button", { name: "Unblock sending" }).className).toMatch(
      /bg-red-700/,
    );
    expect(dialog).toHaveTextContent(/Gmail can show a message late/);
    expect(dialog).toHaveTextContent(/wait a minute and check again/);
    expect(dialog).toHaveTextContent(/back to Approved and can be sent again/);
    expect(dialog).toHaveTextContent(/apply twice/);
  });
});
