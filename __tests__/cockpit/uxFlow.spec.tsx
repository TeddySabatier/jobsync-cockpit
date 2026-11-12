import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// D-041: next-step button per stage, auto-advance, reopen, keyboard, summary.
// Synthetic data only.
const sendPackage = vi.hoisted(() => vi.fn());
vi.mock("@/actions/cockpitSend.actions", () => ({
  sendPackage,
  markSendUnknownAsSent: vi.fn(),
  releaseSendLock: vi.fn(),
}));
const actions = vi.hoisted(() => ({
  approvePackage: vi.fn(),
  unapprovePackage: vi.fn(),
  rejectPackage: vi.fn(),
  reopenPackage: vi.fn(),
  requestPackageChanges: vi.fn(),
  markPackageAppliedManually: vi.fn(),
}));
vi.mock("@/actions/cockpit.actions", () => actions);
const push = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push }) }));
const toast = vi.hoisted(() => ({
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  toastWithAction: vi.fn(),
}));
vi.mock("@/lib/toast", () => toast);
vi.mock("@/components/TipTapContentViewer", () => ({ TipTapContentViewer: () => <div /> }));

import ActionBar from "@/components/cockpit/ActionBar";
import SummaryStrip from "@/components/cockpit/SummaryStrip";
import type { PackageDetail } from "@/components/cockpit/Panels";

const UPDATED = new Date("2026-11-01T10:00:00Z");
const detail = (
  over: Partial<PackageDetail["package"]> = {},
  extra: Partial<Omit<PackageDetail, "package">> = {},
): PackageDetail => ({
  package: {
    id: "p1",
    version: 1,
    status: "pending",
    emailTo: "jobs@acme.example",
    contactSource: "https://acme.example/careers",
    emailSubject: "Application",
    emailBody: "Hello",
    letterMd: "Dear team",
    fitGrade: "A",
    fitAnalysis: JSON.stringify({ reasons: ["Go and SQL match", "Same city"] }),
    cvJson: null,
    cvFileId: "f1",
    cvPdfStale: false,
    rejectReason: null,
    changeRequest: null,
    changeRequestedAt: null,
    changeRequestResponse: null,
    sendStartedAt: null,
    sendOutcome: null,
    updatedAt: UPDATED,
    job: {
      id: "j1",
      jobUrl: "https://acme.example/jobs/1",
      description: "<p>x</p>",
      JobTitle: { label: "Staff Engineer" },
      Company: { label: "Acme Corp" },
    },
    ...over,
  },
  sendHistory: [],
  versions: [{ id: "p1", version: 1, status: "pending" }],
  activePackageId: "p1",
  isActive: true,
  attachment: { fileName: "cv.pdf", size: 1000 },
  letterAttachment: { fileName: "Letter.pdf" },
  gmail: { email: "you@example.com", scopes: "gmail.send" },
  gmailSendAllowed: true,
  ...extra,
});

const ok = (data: unknown = {}) => ({ success: true, data });
const adjacent = { previousId: "prev", nextId: "next", todoLeft: 3 };

beforeEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

describe("Approve and send…", () => {
  it("approves, then opens the Send dialog with the FRESH updatedAt; nothing is sent by the click", async () => {
    actions.approvePackage.mockResolvedValue(ok());
    const { rerender } = render(<ActionBar detail={detail()} adjacent={adjacent} />);
    await userEvent.click(screen.getByRole("button", { name: "Approve and send…" }));
    expect(actions.approvePackage).toHaveBeenCalledWith("p1");
    expect(sendPackage).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();

    const fresh = new Date("2026-11-01T10:05:00Z");
    rerender(
      <ActionBar detail={detail({ status: "approved", updatedAt: fresh })} adjacent={adjacent} />,
    );
    const dialog = await screen.findByRole("dialog");
    expect(sendPackage).not.toHaveBeenCalled(); // the dialog is still the confirmation
    sendPackage.mockResolvedValue(ok());
    await userEvent.click(within(dialog).getByRole("button", { name: "Send now" }));
    expect(sendPackage).toHaveBeenCalledWith("p1", fresh);
  });

  it("a failed approval opens no dialog", async () => {
    actions.approvePackage.mockResolvedValue({ success: false, code: "INVALID_STATE", message: "no" });
    render(<ActionBar detail={detail()} adjacent={adjacent} />);
    await userEvent.click(screen.getByRole("button", { name: "Approve and send…" }));
    expect(toast.toastError).toHaveBeenCalledWith("no");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("when Send is blocked the primary is a plain Approve with the reason, and Undo is offered", async () => {
    actions.approvePackage.mockResolvedValue(ok());
    actions.unapprovePackage.mockResolvedValue(ok());
    render(<ActionBar detail={detail({ cvPdfStale: true })} adjacent={adjacent} />);
    expect(screen.getByText(/The CV PDF is out of date/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));
    const [msg, action, ms] = toast.toastWithAction.mock.calls[0] ?? [];
    expect(msg).toBe("Application approved");
    expect(action.label).toBe("Undo");
    expect(ms).toBeUndefined(); // default 6 s
    await act(async () => action.onClick());
    expect(actions.unapprovePackage).toHaveBeenCalledWith("p1");
  });
});

describe("auto-advance", () => {
  const approved = () => detail({ status: "approved" });

  it("after a confirmed Send: toast with the count, then the next To do item", async () => {
    sendPackage.mockResolvedValue(ok());
    render(<ActionBar detail={approved()} adjacent={adjacent} />);
    await userEvent.click(screen.getByRole("button", { name: "Send…" }));
    await userEvent.click(screen.getByRole("button", { name: "Send now" }));
    expect(toast.toastSuccess).toHaveBeenCalledWith("Email sent. 3 left to review.");
    expect(push).toHaveBeenCalledWith("/dashboard/review/next");
  });

  it("no next: falls back to the previous one, and to the queue when none is left", async () => {
    sendPackage.mockResolvedValue(ok());
    const { unmount } = render(
      <ActionBar detail={approved()} adjacent={{ previousId: "prev", nextId: null, todoLeft: 1 }} />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Send…" }));
    await userEvent.click(screen.getByRole("button", { name: "Send now" }));
    expect(push).toHaveBeenLastCalledWith("/dashboard/review/prev");
    unmount();
    render(<ActionBar detail={approved()} adjacent={{ previousId: null, nextId: null, todoLeft: 0 }} />);
    await userEvent.click(screen.getByRole("button", { name: "Send…" }));
    await userEvent.click(screen.getByRole("button", { name: "Send now" }));
    expect(push).toHaveBeenLastCalledWith("/dashboard/review");
    expect(toast.toastSuccess).toHaveBeenLastCalledWith("Email sent. All done: nothing left to review.");
  });

  it.each([
    ["a definitive failure", { success: false, code: "GMAIL_SEND", message: "refused" }],
    ["an unknown outcome", { success: false, code: "SEND_OUTCOME_UNKNOWN", message: "unknown" }],
    ["a conflict", { success: false, code: "CONFLICT", message: "changed" }],
  ])("never advances after %s", async (_n, result) => {
    sendPackage.mockResolvedValue(result);
    render(<ActionBar detail={approved()} adjacent={adjacent} />);
    await userEvent.click(screen.getByRole("button", { name: "Send…" }));
    await userEvent.click(screen.getByRole("button", { name: "Send now" }));
    expect(push).not.toHaveBeenCalled();
  });

  it("never advances when the send request throws (unknown outcome)", async () => {
    sendPackage.mockRejectedValue(new Error("network"));
    render(<ActionBar detail={approved()} adjacent={adjacent} />);
    await userEvent.click(screen.getByRole("button", { name: "Send…" }));
    await userEvent.click(screen.getByRole("button", { name: "Send now" }));
    expect(push).not.toHaveBeenCalled();
  });

  it("Reject advances on success only", async () => {
    actions.rejectPackage.mockResolvedValueOnce({ success: false, code: "INVALID_STATE", message: "x" });
    render(<ActionBar detail={detail()} adjacent={adjacent} />);
    await userEvent.click(screen.getByRole("button", { name: "Reject" }));
    await userEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Reject" }));
    expect(push).not.toHaveBeenCalled();
    actions.rejectPackage.mockResolvedValueOnce(ok());
    await userEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Reject" }));
    expect(actions.rejectPackage).toHaveBeenLastCalledWith("p1", undefined);
    expect(push).toHaveBeenCalledWith("/dashboard/review/next");
    expect(toast.toastSuccess).toHaveBeenCalledWith("Application rejected. 3 left to review.");
  });

  it("Mark applied advances on success, from a pending link application", async () => {
    actions.markPackageAppliedManually.mockResolvedValue(ok());
    render(<ActionBar detail={detail({ emailTo: null })} adjacent={adjacent} />);
    await userEvent.click(screen.getByRole("button", { name: "I applied" }));
    await userEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Mark applied" }),
    );
    expect(actions.markPackageAppliedManually).toHaveBeenCalledWith("p1");
    expect(push).toHaveBeenCalledWith("/dashboard/review/next");
  });
});

describe("stages", () => {
  it("changes requested: copy-prompt button, no Send or Approve", () => {
    render(<ActionBar detail={detail({ status: "changes_requested", changeRequest: "Shorter" })} />);
    expect(screen.getByTestId("change-requests-prompt-btn")).toHaveTextContent(
      "Copy prompt: handle change requests",
    );
    expect(screen.queryByRole("button", { name: /send|approve/i })).toBeNull();
  });

  it("rejected: Reopen calls the action and stays on the page", async () => {
    actions.reopenPackage.mockResolvedValue(ok());
    render(<ActionBar detail={detail({ status: "rejected" })} adjacent={adjacent} />);
    await userEvent.click(screen.getByRole("button", { name: "Reopen" }));
    expect(actions.reopenPackage).toHaveBeenCalledWith("p1");
    expect(push).not.toHaveBeenCalled();
  });

  it("sent: nothing to send, a Next link", () => {
    render(<ActionBar detail={detail({ status: "sent" })} />);
    expect(screen.queryByRole("button", { name: /send|approve|reject/i })).toBeNull();
    expect(screen.getByRole("link", { name: /Next/ })).toHaveAttribute("href", "/dashboard/review");
  });

  it("Unapprove is in the menu, not beside Send", () => {
    render(<ActionBar detail={detail({ status: "approved" })} />);
    expect(screen.queryByRole("button", { name: "Unapprove" })).toBeNull();
    expect(screen.getByRole("button", { name: "Overflow menu" })).toBeInTheDocument();
  });
});

describe("keyboard a / e / x", () => {
  const press = (key: string, target: Element = document.body, extra = {}) =>
    fireEvent.keyDown(target, { key, ...extra });

  it("a on an approved application opens the Send dialog (never sends)", async () => {
    render(<ActionBar detail={detail({ status: "approved" })} />);
    press("a");
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(sendPackage).not.toHaveBeenCalled();
  });

  it("a on a pending one approves; x opens Reject; e calls onEdit", async () => {
    actions.approvePackage.mockResolvedValue(ok());
    const onEdit = vi.fn();
    render(<ActionBar detail={detail()} onEdit={onEdit} />);
    press("e");
    expect(onEdit).toHaveBeenCalledTimes(1);
    press("x");
    expect(await screen.findByRole("dialog")).toHaveTextContent("Reject this application");
  });

  it("a approves from pending", async () => {
    actions.approvePackage.mockResolvedValue(ok());
    render(<ActionBar detail={detail()} />);
    press("a");
    expect(actions.approvePackage).toHaveBeenCalledWith("p1");
  });

  it("ignored in a form field, with a modifier, and while a dialog is open", async () => {
    const onEdit = vi.fn();
    render(
      <>
        <textarea aria-label="t" />
        <ActionBar detail={detail({ status: "approved" })} onEdit={onEdit} />
      </>,
    );
    press("a", screen.getByLabelText("t"));
    press("e", screen.getByLabelText("t"));
    press("a", document.body, { ctrlKey: true });
    press("a", document.body, { metaKey: true });
    expect(onEdit).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
    press("a");
    await screen.findByRole("dialog");
    press("e");
    expect(onEdit).not.toHaveBeenCalled();
  });

  it("does nothing on a locked application", () => {
    render(<ActionBar detail={detail({ status: "approved", sendStartedAt: new Date() })} />);
    press("a");
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("send-path guards (review of PR #95)", () => {
  const press = (key: string, extra = {}) => fireEvent.keyDown(document.body, { key, ...extra });

  it("a pressed twice (or held) while the approval is in flight approves once", async () => {
    let resolve!: (v: unknown) => void;
    actions.approvePackage.mockImplementation(() => new Promise((r) => (resolve = r)));
    render(<ActionBar detail={detail()} />);
    press("a");
    press("a");
    press("a", { repeat: true });
    expect(actions.approvePackage).toHaveBeenCalledTimes(1);
    await act(async () => resolve(ok()));
  });

  it("a held down (auto-repeat) never acts", () => {
    render(<ActionBar detail={detail()} />);
    press("a", { repeat: true });
    expect(actions.approvePackage).not.toHaveBeenCalled();
  });

  it("approved but the refreshed page is locked: no Send dialog", async () => {
    actions.approvePackage.mockResolvedValue(ok());
    const { rerender } = render(<ActionBar detail={detail()} />);
    await userEvent.click(screen.getByRole("button", { name: "Approve and send…" }));
    vi.useFakeTimers();
    try {
      rerender(<ActionBar detail={detail({ status: "approved", sendStartedAt: new Date() })} />);
      act(() => {
        vi.advanceTimersByTime(10_001);
      });
      // Lock released much later (Release lock): no Send dialog out of the blue.
      rerender(<ActionBar detail={detail({ status: "approved", sendStartedAt: null, sendOutcome: null })} />);
      expect(screen.queryByRole("dialog")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("approval confirmed but the page still shows pending: no dialog until it shows approved", async () => {
    actions.approvePackage.mockResolvedValue(ok());
    const { rerender } = render(<ActionBar detail={detail()} />);
    await userEvent.click(screen.getByRole("button", { name: "Approve and send…" }));
    rerender(<ActionBar detail={detail({ updatedAt: new Date("2026-11-01T10:01:00Z") })} />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("the refreshed page arrives after 10 s: no dialog out of the blue", async () => {
    actions.approvePackage.mockResolvedValue(ok());
    vi.useFakeTimers();
    try {
      const { rerender } = render(<ActionBar detail={detail()} />);
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Approve and send…" }));
      });
      expect(actions.approvePackage).toHaveBeenCalledTimes(1);
      act(() => {
        vi.advanceTimersByTime(10_001);
      });
      rerender(<ActionBar detail={detail({ status: "approved" })} />);
      expect(screen.queryByRole("dialog")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("e and x do nothing on a locked application", () => {
    const onEdit = vi.fn();
    render(<ActionBar detail={detail({ status: "approved", sendStartedAt: new Date() })} onEdit={onEdit} />);
    press("e");
    press("x");
    expect(onEdit).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("Escape cannot close the Send dialog while the send is in flight", async () => {
    let resolve!: (v: unknown) => void;
    sendPackage.mockImplementation(() => new Promise((r) => (resolve = r)));
    render(<ActionBar detail={detail({ status: "approved" })} adjacent={adjacent} />);
    await userEvent.click(screen.getByRole("button", { name: "Send…" }));
    await userEvent.click(screen.getByRole("button", { name: "Send now" }));
    await userEvent.keyboard("{Escape}");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await act(async () => resolve(ok()));
    expect(push).toHaveBeenCalledWith("/dashboard/review/next");
  });

  it("a source does not hide a domain mismatch: the amber note says the domain differs", async () => {
    render(
      <ActionBar
        detail={detail({
          status: "approved",
          emailTo: "hr@recruit-other.example",
          contactSource: "https://recruit-other.example/team",
        })}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Send…" }));
    const note = screen.getByTestId("send-contact-source");
    expect(note).toHaveTextContent("The recipient domain differs from the company and the job posting.");
    expect(note).toHaveTextContent("Found on recruit-other.example (same domain as the address).");
  });
});

describe("SummaryStrip", () => {
  it("shows grade, why, recipient, source, readiness and what to check", () => {
    render(<SummaryStrip detail={detail()} />);
    expect(screen.getByTestId("summary-why")).toHaveTextContent("Go and SQL match; Same city");
    expect(screen.getByTestId("summary-to")).toHaveTextContent("jobs@acme.example");
    expect(screen.getByTestId("summary-source")).toHaveTextContent("https://acme.example/careers");
    expect(screen.getByRole("list", { name: "Readiness" })).toHaveTextContent("Can send");
    expect(screen.queryByTestId("summary-checks")).toBeNull();
  });

  it("flags a missing source and a stale PDF", () => {
    render(<SummaryStrip detail={detail({ contactSource: null, cvPdfStale: true })} />);
    expect(screen.getByTestId("summary-source")).toHaveTextContent("No source recorded");
    const checks = screen.getByTestId("summary-checks");
    expect(checks).toHaveTextContent(/No source was recorded/);
    expect(checks).toHaveTextContent(/re-render/);
    expect(screen.getByRole("list", { name: "Readiness" })).toHaveTextContent("Cannot send yet");
  });
});
