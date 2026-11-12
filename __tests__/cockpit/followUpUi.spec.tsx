import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// D-042: the follow-up review UI. A follow-up draft is a To do row with a chip,
// its detail has the "Replies to your email of" banner, the Send dialog shows
// the reply nature and no attachment, the outcome toggles and the row menu
// call only their own actions. Nothing here can send by itself.
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
const fu = vi.hoisted(() => ({
  snoozeFollowUp: vi.fn(),
  skipFollowUpStep: vi.fn(),
  stopFollowUps: vi.fn(),
  setFollowUpOutcome: vi.fn(),
  undoFollowUpOutcome: vi.fn(),
  setApplicationOutcome: vi.fn(),
}));
vi.mock("@/actions/cockpitFollowUps.actions", () => fu);
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("@/lib/toast", () => ({
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  toastWithAction: vi.fn(),
}));
vi.mock("@/components/TipTapContentViewer", () => ({ TipTapContentViewer: () => <div /> }));

import ActionBar from "@/components/cockpit/ActionBar";
import DetailView from "@/components/cockpit/DetailView";
import SendDialog from "@/components/cockpit/SendDialog";
import { FollowUpPanel } from "@/components/cockpit/FollowUpControls";
import QueueRow, { readinessChips, type QueueRowData } from "@/components/cockpit/QueueRow";
import type { PackageDetail } from "@/components/cockpit/Panels";
import { sendBlockedReason } from "@/lib/cockpit/sendBlocked";
import {
  canSkipOrSnooze,
  followUpStatusText,
  gmailThreadUrl,
  replySubject,
  type FollowUpSummary,
} from "@/lib/cockpit/followUpView";

const UPDATED = new Date("2026-11-01T10:00:00Z");
const SENT = new Date("2026-10-20T09:00:00Z");

const summary = (over: Partial<FollowUpSummary> = {}): FollowUpSummary => ({
  jobId: "j1",
  outcome: null,
  stopped: false,
  step: 1,
  status: "due",
  reason: null,
  dueAt: new Date("2026-10-27T00:00:00Z"),
  snoozedUntil: null,
  threadUrl: "https://mail.google.com/mail/u/0/#all/18c0ffee",
  applicationSentAt: SENT,
  applicationPackageId: "app1",
  ...over,
});

const followUpDetail = (
  over: Partial<PackageDetail["package"]> = {},
  extra: Partial<Omit<PackageDetail, "package">> = {},
): PackageDetail => ({
  kind: "follow_up",
  followUp: summary(),
  followUpStep: 1,
  replyTo: { id: "app1", sentAt: SENT, emailSubject: "Application – Engineer" },
  package: {
    id: "f1",
    version: 1,
    status: "approved",
    emailTo: "jobs@gmail.com",
    contactSource: null,
    emailSubject: "Application – Engineer",
    emailBody: "Hello again",
    letterMd: null,
    fitGrade: null,
    fitAnalysis: null,
    cvJson: null,
    cvFileId: null,
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
  versions: [{ id: "f1", version: 1, status: "approved" }],
  activePackageId: "f1",
  isActive: true,
  attachment: null,
  letterAttachment: null,
  gmail: { email: "you@example.com", scopes: "gmail.send" },
  gmailSendAllowed: true,
  ...extra,
});

const ok = (data: unknown = {}) => ({ success: true, data });

beforeEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

describe("pure helpers", () => {
  it("replySubject adds Re: once and keeps the 300 limit", () => {
    expect(replySubject("Application")).toBe("Re: Application");
    expect(replySubject("RE: Application")).toBe("RE: Application");
    expect(replySubject("x".repeat(400))).toHaveLength(300);
  });

  it("gmailThreadUrl only for an opaque id", () => {
    expect(gmailThreadUrl("18c0ffee")).toBe("https://mail.google.com/mail/u/0/#all/18c0ffee");
    expect(gmailThreadUrl("a/b")).toBeNull();
    expect(gmailThreadUrl("javascript:alert(1)")).toBeNull();
    expect(gmailThreadUrl(null)).toBeNull();
  });

  it("skip and snooze only for a due or snoozed step", () => {
    expect(canSkipOrSnooze({ status: "due" })).toBe(true);
    expect(canSkipOrSnooze({ status: "snoozed" })).toBe(true);
    expect(canSkipOrSnooze({ status: "scheduled" })).toBe(false);
    expect(canSkipOrSnooze({ status: "expired" })).toBe(false);
    expect(canSkipOrSnooze({ status: null })).toBe(false);
  });

  it("status text", () => {
    expect(followUpStatusText(summary())).toBe("Follow-up 1 is due.");
    expect(followUpStatusText(summary({ outcome: "replied", status: null, reason: "outcome" }))).toMatch(/reply/);
    expect(followUpStatusText(summary({ stopped: true, status: null, reason: "stopped" }))).toBe("Follow-ups stopped.");
  });

  it("a follow-up is never blocked for a missing CV; it is for a missing recipient", () => {
    const d = followUpDetail();
    expect(sendBlockedReason(d)).toBeNull();
    expect(sendBlockedReason(followUpDetail({ emailTo: "" }))).toMatch(/no recipient/);
    expect(sendBlockedReason({ ...d, kind: "application" })).toBe("No CV file is attached.");
  });

  it("queue readiness chips: no 'No CV' or 'Link apply' on a follow-up", () => {
    expect(readinessChips({ emailTo: "a@b.c", cvPdfStale: false, cvFileId: null, kind: "follow_up" }, true)).toEqual([]);
    expect(readinessChips({ emailTo: "a@b.c", cvPdfStale: false, cvFileId: null, kind: "follow_up" }, false)).toEqual(["Gmail"]);
  });
});

describe("queue row", () => {
  const row = (over: Partial<QueueRowData> = {}): QueueRowData => ({
    kind: "follow_up",
    followUpStep: 2,
    followUp: summary({ step: 2 }),
    id: "f1",
    jobId: "j1",
    version: 1,
    status: "pending",
    fitGrade: null,
    emailTo: "jobs@acme.example",
    cvFileId: null,
    cvPdfStale: false,
    sendOutcome: null,
    sendStartedAt: null,
    createdAt: new Date(),
    job: { id: "j1", JobTitle: { label: "Engineer" }, Company: { label: "Acme" } },
    ...over,
  });

  it("shows the Follow-up chip and the row menu (outside the link)", () => {
    render(<ul><QueueRow row={row()} gmailConnected /></ul>);
    expect(screen.getByTestId("follow-up-chip")).toHaveTextContent("Follow-up 2");
    const menu = screen.getByRole("button", { name: "Follow-up options" });
    expect(menu.closest("a")).toBeNull();
    expect(screen.queryByText("No CV")).toBeNull();
  });

  it("no menu on a locked or sent follow-up, nor on an application", () => {
    const { rerender } = render(<ul><QueueRow row={row({ sendStartedAt: new Date() })} gmailConnected /></ul>);
    expect(screen.queryByRole("button", { name: "Follow-up options" })).toBeNull();
    rerender(<ul><QueueRow row={row({ status: "sent" })} gmailConnected /></ul>);
    expect(screen.queryByRole("button", { name: "Follow-up options" })).toBeNull();
    rerender(<ul><QueueRow row={row({ kind: "application", followUp: null, followUpStep: null, cvFileId: "c" })} gmailConnected /></ul>);
    expect(screen.queryByTestId("follow-up-chip")).toBeNull();
  });

  it("the menu snoozes 7 days and skips; Skip is absent for a scheduled step", async () => {
    fu.snoozeFollowUp.mockResolvedValue(ok());
    render(<ul><QueueRow row={row()} gmailConnected /></ul>);
    await userEvent.click(screen.getByRole("button", { name: "Follow-up options" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Remind me in 7 days" }));
    expect(fu.snoozeFollowUp).toHaveBeenCalledWith("j1", 7);
    expect(sendPackage).not.toHaveBeenCalled();

    document.body.innerHTML = "";
    render(<ul><QueueRow row={row({ followUp: summary({ status: "scheduled" }) })} gmailConnected /></ul>);
    await userEvent.click(screen.getByRole("button", { name: "Follow-up options" }));
    expect(await screen.findByRole("menuitem", { name: "Stop follow-ups" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /Skip/ })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: /Remind me/ })).toBeNull();
  });
});

describe("follow-up detail", () => {
  it("banner: replies to your email of <date>, thread link, link to the application; no CV, letter or fit panes", () => {
    render(<DetailView detail={followUpDetail()} adjacent={{ previousId: null, nextId: null }} />);
    const banner = screen.getByTestId("follow-up-banner");
    expect(banner).toHaveTextContent(/Follow-up 1 · Replies to your email of/);
    expect(within(banner).getByRole("link", { name: /Open thread in Gmail/ })).toHaveAttribute(
      "href",
      "https://mail.google.com/mail/u/0/#all/18c0ffee",
    );
    expect(within(banner).getByRole("link", { name: "View the application" })).toHaveAttribute(
      "href",
      "/dashboard/review/app1",
    );
    expect(screen.queryByTestId("summary-strip")).toBeNull();
    expect(screen.getByTestId("follow-up-panel")).toBeInTheDocument();
  });

  it("one primary: Send… on an approved follow-up; the dialog says reply in thread, no attachment, Re: subject, and keeps the recipient warning", async () => {
    render(<ActionBar detail={followUpDetail()} />);
    await userEvent.click(screen.getByRole("button", { name: "Send…" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("heading", { name: "Send this follow-up" })).toBeInTheDocument();
    expect(within(dialog).getByTestId("send-subject")).toHaveTextContent("Re: Application – Engineer");
    expect(within(dialog).getByTestId("send-thread")).toHaveTextContent(/Yes: in the Gmail thread/);
    expect(within(dialog).getByTestId("send-attachment")).toHaveTextContent(/None \(a follow-up has no attachment\)/);
    // gmail.com recipient: the free-mail warning is still there.
    expect(within(dialog).getByRole("alert")).toHaveTextContent(/free-mail/);
    expect(sendPackage).not.toHaveBeenCalled();
    sendPackage.mockResolvedValue(ok());
    await userEvent.click(within(dialog).getByRole("button", { name: "Send now" }));
    expect(sendPackage).toHaveBeenCalledWith("f1", UPDATED);
  });

  it("no thread recorded: the dialog says so", async () => {
    render(<SendDialog detail={followUpDetail({}, { followUp: summary({ threadUrl: null }) })} open onOpenChange={() => {}} />);
    expect(screen.getByTestId("send-thread")).toHaveTextContent(/No Gmail thread is recorded/);
  });

  it("pending follow-up: Approve and send… (no CV needed)", () => {
    render(<ActionBar detail={followUpDetail({ status: "pending" })} />);
    expect(screen.getByRole("button", { name: "Approve and send…" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "I applied" })).toBeNull();
  });

  it("a rejected follow-up offers no Reopen", () => {
    render(<ActionBar detail={followUpDetail({ status: "rejected" })} />);
    expect(screen.queryByRole("button", { name: "Reopen" })).toBeNull();
  });
});

describe("outcome toggles", () => {
  it("Got a reply sets, pressed again clears (aria-pressed)", async () => {
    fu.setApplicationOutcome.mockResolvedValue(ok());
    const { rerender } = render(<FollowUpPanel summary={summary()} />);
    const btn = screen.getByTestId("outcome-replied");
    expect(btn).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(btn);
    expect(fu.setApplicationOutcome).toHaveBeenLastCalledWith("j1", "replied");

    rerender(<FollowUpPanel summary={summary({ outcome: "replied", status: null, reason: "outcome" })} />);
    expect(screen.getByTestId("outcome-replied")).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(screen.getByTestId("outcome-replied"));
    expect(fu.setApplicationOutcome).toHaveBeenLastCalledWith("j1", null);
  });

  it("Rejected / closed asks first, then sets; nothing without the confirm", async () => {
    fu.setApplicationOutcome.mockResolvedValue(ok());
    render(<FollowUpPanel summary={summary()} />);
    await userEvent.click(screen.getByTestId("outcome-rejected"));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent(/sets the job status to Rejected/);
    expect(fu.setApplicationOutcome).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole("button", { name: "Mark rejected" }));
    expect(fu.setApplicationOutcome).toHaveBeenCalledWith("j1", "rejected");
  });
});
