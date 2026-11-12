import { render, screen, within } from "@testing-library/react";

vi.mock("@/actions/cockpit.actions", () => ({
  approvePackage: vi.fn(),
  unapprovePackage: vi.fn(),
  rejectPackage: vi.fn(),
  requestPackageChanges: vi.fn(),
  markPackageAppliedManually: vi.fn(),
}));
vi.mock("@/actions/cockpitSend.actions", () => ({
  sendPackage: vi.fn(),
  markSendUnknownAsSent: vi.fn(),
  releaseSendLock: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("@/lib/toast", () => ({ toastSuccess: vi.fn(), toastError: vi.fn() }));
vi.mock("@/components/TipTapContentViewer", () => ({
  TipTapContentViewer: () => <div />,
}));

import DetailView from "@/components/cockpit/DetailView";
import type { PackageDetail } from "@/components/cockpit/Panels";

// Issue #77 / D-028: the read-only send history in the Review detail.
// Synthetic data only.
const UPDATED = new Date("2026-11-01T10:00:00Z");

const detail = (
  history: PackageDetail["sendHistory"],
  over: Partial<PackageDetail["package"]> = {},
): PackageDetail => ({
  package: {
    id: "p1",
    version: 1,
    status: "approved",
    emailTo: "jobs@acme.example",
    contactSource: null,
    emailSubject: "Application",
    emailBody: "Hello",
    letterMd: null,
    fitGrade: "A",
    fitAnalysis: null,
    cvJson: null,
    cvFileId: null,
    cvPdfStale: false,
    rejectReason: null,
    changeRequest: null,
    changeRequestedAt: null,
    changeRequestResponse: null,
    sendStartedAt: new Date("2026-11-01T09:00:00Z"),
    sendOutcome: "unknown",
    updatedAt: UPDATED,
    job: {
      id: "j1",
      jobUrl: null,
      description: "A job",
      JobTitle: { label: "Engineer" },
      Company: { label: "Acme" },
    },
    ...over,
  },
  sendHistory: history,
  versions: [{ id: "p1", version: 1, status: "approved" }],
  activePackageId: "p1",
  isActive: true,
  attachment: null,
  letterAttachment: null,
  gmail: { email: "you@example.com", scopes: "gmail.send" },
  gmailSendAllowed: true,
});

const noAdjacent = { previousId: null, nextId: null };

describe("Send history panel", () => {
  it("is absent when nothing was ever attempted", () => {
    render(<DetailView detail={detail([])} adjacent={noAdjacent} />);
    expect(screen.queryByTestId("panel-send-history")).toBeNull();
  });

  it("lists what was attempted and what happened, oldest first, next to the recovery actions", () => {
    render(
      <DetailView
        detail={detail([
          {
            id: "a1",
            outcome: "failed",
            reason: "Gmail rejected the message",
            gmailMessageId: null,
            createdAt: new Date("2026-11-01T08:00:00Z"),
          },
          {
            id: "a2",
            outcome: "sent",
            reason: null,
            gmailMessageId: "18c0ffee",
            createdAt: new Date("2026-11-01T09:00:00Z"),
          },
          {
            id: "a3",
            outcome: "record_failed",
            reason: null,
            gmailMessageId: "18c0ffee",
            createdAt: new Date("2026-11-01T09:00:01Z"),
          },
        ])}
        adjacent={noAdjacent}
      />,
    );
    const panel = screen.getByTestId("panel-send-history");
    expect(within(panel).getByRole("heading", { name: "Send history" })).toBeInTheDocument();
    const items = within(panel).getAllByTestId("send-attempt");
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveTextContent("Not sent");
    expect(items[0]).toHaveTextContent("Gmail rejected the message");
    expect(items[1]).toHaveTextContent("Gmail accepted the message");
    expect(items[1]).toHaveTextContent("Gmail message id: 18c0ffee");
    expect(items[2]).toHaveTextContent("could not record it");
    // The raw outcome keys are never shown.
    expect(panel.textContent).not.toMatch(/record_failed|failed\b.*_/);
    // The recovery panel is still there: the history informs it, it does not replace it.
    expect(screen.getByRole("region", { name: "Send outcome" })).toBeInTheDocument();
    // Read only: the panel has no buttons or inputs.
    expect(within(panel).queryByRole("button")).toBeNull();
    expect(within(panel).queryByRole("textbox")).toBeNull();
  });

  it("an unknown outcome string is shown as a neutral label, never raw", () => {
    render(
      <DetailView
        detail={detail([
          {
            id: "a1",
            outcome: "Bearer abc.def",
            reason: null,
            gmailMessageId: null,
            createdAt: new Date("2026-11-01T08:00:00Z"),
          },
        ])}
        adjacent={noAdjacent}
      />,
    );
    const panel = screen.getByTestId("panel-send-history");
    expect(panel).toHaveTextContent("Unrecognized entry");
    expect(panel.textContent).not.toContain("Bearer");
  });
});
