import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const sendPackage = vi.hoisted(() => vi.fn());
const markSendUnknownAsSent = vi.hoisted(() => vi.fn());
const releaseSendLock = vi.hoisted(() => vi.fn());
vi.mock("@/actions/cockpitSend.actions", () => ({
  sendPackage,
  markSendUnknownAsSent,
  releaseSendLock,
}));
vi.mock("@/actions/cockpit.actions", () => ({
  approvePackage: vi.fn(),
  unapprovePackage: vi.fn(),
  rejectPackage: vi.fn(),
  requestPackageChanges: vi.fn(),
  markPackageAppliedManually: vi.fn(),
}));
const refresh = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh, push: vi.fn() }) }));
const toast = vi.hoisted(() => ({ toastSuccess: vi.fn(), toastError: vi.fn() }));
vi.mock("@/lib/toast", () => toast);

import { approvePackage } from "@/actions/cockpit.actions";
import ActionBar from "@/components/cockpit/ActionBar";
import SendDialog, { recipientWarning } from "@/components/cockpit/SendDialog";
import type { PackageDetail } from "@/components/cockpit/Panels";

// AC-33 (component), AC-45 (component). Synthetic data only.
const UPDATED = new Date("2026-11-01T10:00:00Z");
const LONG_BODY =
  Array.from({ length: 80 }, (_, i) => `Line ${i + 1} of the email body.`).join("\n") +
  "\nTHE-VERY-LAST-LINE";

const detail = (over: Partial<PackageDetail["package"]> = {}): PackageDetail => ({
  package: {
    id: "p1",
    version: 1,
    status: "approved",
    emailTo: "jobs@acme.example",
    emailSubject: "Application – Staff Engineer",
    emailBody: LONG_BODY,
    letterMd: null,
    fitGrade: "A",
    fitAnalysis: null,
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
      jobUrl: "https://careers.acme.example/jobs/1",
      description: "<p>Build things</p>",
      JobTitle: { label: "Staff Engineer" },
      Company: { label: "Acme Corp" },
    },
    ...over,
  },
  versions: [{ id: "p1", version: 1, status: "approved" }],
  activePackageId: "p1",
  isActive: true,
  attachment: { fileName: "0000-uuid.pdf", size: 12288 },
  letterAttachment: { fileName: "Cover_Letter.pdf" },
  gmail: { email: "you@example.com", scopes: "gmail.send" },
  gmailSendAllowed: true,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("recipientWarning (AC-45)", () => {
  it.each([
    ["jobs@acme.example", "Acme Corp", "https://careers.acme.example/1"],
    ["jobs@acme.example", "Acme Corp", null],
    ["hr@example.com", "Example Corp", null],
    ["hr@jobs.acme.co.uk", "Acme", "https://acme.co.uk/x"],
  ])("no warning: %s / %s", (to, company, url) => {
    expect(recipientWarning(to, company, url)).toBeNull();
  });

  it("warns on a domain that matches neither the company nor the posting", () => {
    expect(recipientWarning("hr@evil.example", "Acme Corp", "https://acme.example/1")).toMatch(
      /does not match/,
    );
  });

  it("warns on a free-mail domain, even if the company name matches", () => {
    expect(recipientWarning("acme@gmail.com", "Gmail Inc", null)).toMatch(/free-mail/);
  });

  // Review 07 finding 2: the bot picks the recipient from untrusted postings,
  // so a subdomain or a generic word the attacker controls must not match.
  it.each([
    ["subdomain copied from the posting host", "hr@careers.evil.example", "Acme Corp", "https://careers.acme.example/1"],
    ["generic company suffix Inc as a subdomain", "hr@inc.evil.example", "Acme Inc", null],
    ["generic company suffix Corp as a subdomain", "hr@corp.evil.example", "Acme Corp", null],
    ["company name as a subdomain", "hr@acme.evil.example", "Acme Corp", "https://acme.example/1"],
    ["generic registrable label", "hr@careers.example", "Careers Inc", null],
    ["prefix of the company name", "hr@acm.example", "Acme Corp", null],
  ])("warns: %s", (_n, to, company, url) => {
    expect(recipientWarning(to, company, url)).toMatch(/does not match/);
  });

  it.each([
    "a@orange.fr",
    "a@wanadoo.fr",
    "a@free.fr",
    "a@sfr.fr",
    "a@laposte.net",
    "a@hotmail.fr",
    "a@yahoo.fr",
    "a@mail.gmail.com",
  ])("warns about a free-mail provider: %s", (to) => {
    expect(recipientWarning(to, "Acme", null)).toMatch(/free-mail/);
  });

  it("still accepts the real company domain with a subdomain mail host", () => {
    expect(recipientWarning("hr@mail.acme.example", "Acme Corp", null)).toBeNull();
  });
});

describe("Send button and dialog (AC-45)", () => {
  it("shows To large, From, Subject, attachment name and size, and the FULL scrollable body", async () => {
    render(<ActionBar detail={detail()} />);
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByTestId("send-to")).toHaveTextContent("jobs@acme.example");
    expect(within(dialog).getByTestId("send-to").className).toMatch(/text-2xl/);
    expect(within(dialog).getByText("you@example.com")).toBeInTheDocument();
    expect(within(dialog).getByText("Application – Staff Engineer")).toBeInTheDocument();
    expect(within(dialog).getByText("0000-uuid.pdf (12.0 KB)")).toBeInTheDocument();
    const body = within(dialog).getByTestId("send-body");
    expect(body.textContent).toBe(LONG_BODY);
    expect(body.className).toMatch(/overflow-y-auto/);
    expect(within(dialog).getByRole("button", { name: "Send now" })).toBeInTheDocument();
    // matching domain: no warning
    expect(within(dialog).queryByRole("alert")).toBeNull();
  });

  it("shows a warning for a domain mismatch", async () => {
    render(<ActionBar detail={detail({ emailTo: "hr@other.example" })} />);
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(within(screen.getByRole("dialog")).getByRole("alert")).toHaveTextContent(
      /does not match/,
    );
  });

  it("shows a warning for a free-mail recipient", async () => {
    render(<ActionBar detail={detail({ emailTo: "hr@gmail.com" })} />);
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(within(screen.getByRole("dialog")).getByRole("alert")).toHaveTextContent(
      /free-mail/,
    );
  });

  it("Send now calls sendPackage(id, updatedAt) once; disabled while pending (double-click safe)", async () => {
    let resolve: (v: unknown) => void = () => {};
    sendPackage.mockReturnValue(new Promise((r) => (resolve = r)));
    render(<ActionBar detail={detail()} />);
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    const confirm = screen.getByRole("button", { name: "Send now" });
    await userEvent.dblClick(confirm);
    expect(sendPackage).toHaveBeenCalledTimes(1);
    expect(sendPackage).toHaveBeenCalledWith("p1", UPDATED);
    expect(confirm).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();

    await act(async () => resolve({ success: true, data: {} }));
    expect(toast.toastSuccess).toHaveBeenCalledWith("Email sent");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("an unknown outcome toasts the fixed message and closes the dialog (the page shows the panel)", async () => {
    sendPackage.mockResolvedValue({
      success: false,
      code: "SEND_OUTCOME_UNKNOWN",
      message: "The send result is unknown; check your Gmail Sent folder",
    });
    render(<ActionBar detail={detail()} />);
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    await userEvent.click(screen.getByRole("button", { name: "Send now" }));
    expect(toast.toastError).toHaveBeenCalledWith(
      "The send result is unknown; check your Gmail Sent folder",
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  // Review 07 finding 4: a definitive failure must not vanish with a toast.
  it.each([
    ["GMAIL_RECONNECT_REQUIRED", "Reconnect Gmail in the cockpit settings"],
    ["GMAIL_SEND", "Gmail rejected the message"],
    ["GMAIL_TOKEN", "Could not get a Gmail access token"],
  ])("%s keeps the dialog open with an inline alert and Send enabled", async (code, message) => {
    sendPackage.mockResolvedValue({ success: false, code, message });
    render(<ActionBar detail={detail()} />);
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    await userEvent.click(screen.getByRole("button", { name: "Send now" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByTestId("send-failure")).toHaveTextContent(message);
    expect(within(dialog).getByTestId("send-failure")).toHaveAttribute("role", "alert");
    expect(within(dialog).getByRole("button", { name: "Send now" })).toBeEnabled();
    expect(toast.toastSuccess).not.toHaveBeenCalled();
    if (code === "GMAIL_RECONNECT_REQUIRED") {
      expect(within(dialog).getByRole("link", { name: "Reconnect Gmail in settings" })).toHaveAttribute(
        "href",
        "/dashboard/review/settings",
      );
    } else {
      expect(within(dialog).queryByRole("link", { name: "Reconnect Gmail in settings" })).toBeNull();
    }
    // closing and reopening clears the old failure
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(screen.queryByTestId("send-failure")).toBeNull();
  });

  it("VALIDATION tells the owner what to check and to use Edit", async () => {
    sendPackage.mockResolvedValue({ success: false, code: "VALIDATION", message: "The input is invalid" });
    render(<ActionBar detail={detail()} />);
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    await userEvent.click(screen.getByRole("button", { name: "Send now" }));
    expect(screen.getByTestId("send-failure")).toHaveTextContent(
      /Check the recipient, subject and body.*Edit/,
    );
  });

  it("a double click in the same tick sends once (the inFlight ref, not the disabled button)", async () => {
    let resolve: (v: unknown) => void = () => {};
    sendPackage.mockReturnValue(new Promise((r) => (resolve = r)));
    render(<ActionBar detail={detail()} />);
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    const confirm = screen.getByRole("button", { name: "Send now" });
    // Both clicks inside one act(): React has not re-rendered the button as
    // disabled in between, exactly like two clicks in one tick.
    act(() => {
      fireEvent.click(confirm);
      fireEvent.click(confirm);
    });
    expect(sendPackage).toHaveBeenCalledTimes(1);
    await act(async () => resolve({ success: true, data: {} }));
  });

  it.each([
    ["Gmail not connected", { gmail: null }, {}],
    ["stale PDF", {}, { cvPdfStale: true }],
    ["no CV file", { attachment: null }, { cvFileId: null }],
    ["no recipient", {}, { emailTo: "" }],
    ["pending", {}, { status: "pending" }],
  ])("no Send button: %s", (_n, extra, over) => {
    render(<ActionBar detail={{ ...detail(over), ...extra }} />);
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
  });
});

describe("send-outcome panel (AC-33)", () => {
  const unknown = () =>
    detail({ sendStartedAt: new Date(Date.now() - 5_000), sendOutcome: "unknown" });

  it("outcome unknown: Gmail Sent folder hint, both actions, nothing else offered", () => {
    render(<ActionBar detail={unknown()} />);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Check your Gmail Sent folder — the send result is unknown.",
    );
    expect(screen.getByRole("button", { name: "Mark as sent (manual)" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Release lock" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^(Send|Approve|Unapprove|Reject|Edit)/ })).toBeNull();
  });

  it("Mark as sent needs a confirm and then calls markSendUnknownAsSent", async () => {
    markSendUnknownAsSent.mockResolvedValue({ success: true, data: {} });
    render(<ActionBar detail={unknown()} />);
    await userEvent.click(screen.getByRole("button", { name: "Mark as sent (manual)" }));
    expect(markSendUnknownAsSent).not.toHaveBeenCalled();
    const dialog = screen.getByRole("alertdialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Mark as sent" }));
    expect(markSendUnknownAsSent).toHaveBeenCalledExactlyOnceWith("p1");
    expect(toast.toastSuccess).toHaveBeenCalledWith("Marked as sent");
  });

  it("Release lock needs a confirm and then calls releaseSendLock; Cancel does nothing", async () => {
    releaseSendLock.mockResolvedValue({ success: true, data: {} });
    render(<ActionBar detail={unknown()} />);
    await userEvent.click(screen.getByRole("button", { name: "Release lock" }));
    await userEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Cancel" }));
    expect(releaseSendLock).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Release lock" }));
    await userEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", { name: "Release lock" }),
    );
    expect(releaseSendLock).toHaveBeenCalledExactlyOnceWith("p1");
  });

  it("a fresh lock without outcome shows 'Sending…', no actions", () => {
    render(<ActionBar detail={detail({ sendStartedAt: new Date() })} />);
    expect(screen.getByRole("status")).toHaveTextContent(/Sending…/);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("a lock older than 60 s with no outcome shows the panel", () => {
    render(<ActionBar detail={detail({ sendStartedAt: new Date(Date.now() - 61_000) })} />);
    expect(screen.getByRole("button", { name: "Release lock" })).toBeInTheDocument();
  });

  it("a fresh lock turns into the panel once 60 s have passed", () => {
    vi.useFakeTimers();
    render(<ActionBar detail={detail({ sendStartedAt: new Date() })} />);
    expect(screen.queryByRole("button")).toBeNull();
    act(() => {
      vi.advanceTimersByTime(61_000);
    });
    expect(screen.getByRole("button", { name: "Mark as sent (manual)" })).toBeInTheDocument();
  });
});

describe("SendDialog is closed by default", () => {
  it("renders nothing when closed", () => {
    render(<SendDialog detail={detail()} open={false} onOpenChange={() => {}} />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

// QA L2-001: a rejected action promise (network drop, deploy mid-request) must
// surface a toast and re-enable the buttons instead of an unhandled rejection.
describe("rejected action requests show an error toast", () => {
  it("ActionBar: Approve rejects -> toast, button re-enabled", async () => {
    vi.mocked(approvePackage).mockRejectedValue(new Error("network"));
    render(<ActionBar detail={detail({ status: "pending" })} />);
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(toast.toastError).toHaveBeenCalledWith(
      "Request failed. Check your connection and try again.",
    );
    expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled();
  });

  it("SendDialog: sendPackage throws -> toast, dialog closed (no second Send click) and the page refreshed", async () => {
    sendPackage.mockRejectedValue(new Error("network"));
    render(<ActionBar detail={detail()} />);
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    await userEvent.click(screen.getByRole("button", { name: "Send now" }));
    expect(toast.toastError).toHaveBeenCalledWith(
      "Could not confirm the send. Reload and check the package state before retrying.",
    );
    expect(toast.toastSuccess).not.toHaveBeenCalled();
    expect(sendPackage).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("SendOutcomePanel: releaseSendLock rejects -> toast, button re-enabled", async () => {
    releaseSendLock.mockRejectedValue(new Error("network"));
    render(
      <ActionBar
        detail={detail({ sendStartedAt: new Date(Date.now() - 5_000), sendOutcome: "unknown" })}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Release lock" }));
    await userEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", { name: "Release lock" }),
    );
    expect(toast.toastError).toHaveBeenCalledWith(
      "Request failed. Check your connection and try again.",
    );
    expect(screen.getByRole("button", { name: "Release lock" })).toBeEnabled();
  });
});

// D-020 (f) / D-023: getPackageDetail says whether the connected address is the
// allowed one; the bar shows why Send is missing instead of a Send that fails.
describe("Gmail connected as a different address than the allowed one", () => {
  it("shows a dedicated reason with a settings link and no Send button", () => {
    render(<ActionBar detail={{ ...detail(), gmailSendAllowed: false }} />);
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
    expect(
      screen.getByText(/Sending is only allowed from the address configured for the cockpit\. Connect that address in settings\./),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open settings" })).toHaveAttribute(
      "href",
      "/dashboard/review/settings",
    );
  });

  it("allowed: no reason, Send is offered", () => {
    render(<ActionBar detail={detail()} />);
    expect(screen.getByRole("button", { name: "Send" })).toBeInTheDocument();
    expect(screen.queryByText(/only allowed from/)).toBeNull();
  });
});
