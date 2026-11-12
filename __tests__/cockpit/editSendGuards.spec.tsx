import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import fs from "fs";
import path from "path";

// Review 07 (#59): unsaved-edit guards, focus handling, field a11y, the shared
// lock constant and the TextDialog counter. Synthetic data only.

const updatePackageContent = vi.hoisted(() => vi.fn());
const requestPackageChanges = vi.hoisted(() => vi.fn());
vi.mock("@/actions/cockpitSend.actions", () => ({
  sendPackage: vi.fn(),
  markSendUnknownAsSent: vi.fn(),
  releaseSendLock: vi.fn(),
}));
vi.mock("@/actions/cockpit.actions", () => ({
  updatePackageContent,
  requestPackageChanges,
  approvePackage: vi.fn(),
  unapprovePackage: vi.fn(),
  rejectPackage: vi.fn(),
  markPackageAppliedManually: vi.fn(),
}));
const push = vi.hoisted(() => vi.fn());
const refresh = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, refresh }) }));
vi.mock("@/lib/toast", () => ({ toastSuccess: vi.fn(), toastError: vi.fn() }));
vi.mock("@/components/TipTapContentViewer", () => ({
  TipTapContentViewer: () => <div />,
}));

import DetailView from "@/components/cockpit/DetailView";
import EditForm from "@/components/cockpit/EditForm";
import type { PackageDetail } from "@/components/cockpit/Panels";
import TextDialog from "@/components/cockpit/TextDialog";
import { STALE_LOCK_MS } from "@/lib/cockpit/constants";

const fixture = (over: Partial<PackageDetail["package"]> = {}): PackageDetail => ({
  kind: "application",
  followUp: null,
  followUpStep: null,
  replyTo: null,
  package: {
    id: "p2",
    version: 2,
    status: "pending",
    emailTo: "jobs@acme.example",
    contactSource: null,
    emailSubject: "Application: Staff Engineer",
    emailBody: "Hello,",
    letterMd: "Dear team,",
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
});

const noAdjacent = { previousId: null, nextId: null };

async function openEdit() {
  render(<DetailView detail={fixture()} adjacent={noAdjacent} />);
  await userEvent.click(screen.getAllByRole("button", { name: "Edit" })[0]);
}
const makeDirty = () =>
  fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "S2" } });

beforeEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("unsaved edits are guarded on in-app navigation (finding 3)", () => {
  it("the version selector asks first and stays put when declined", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    await openEdit();
    makeDirty();
    fireEvent.change(screen.getByLabelText("Version"), { target: { value: "p1" } });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(push).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    fireEvent.change(screen.getByLabelText("Version"), { target: { value: "p1" } });
    expect(push).toHaveBeenCalledWith("/dashboard/review/p1");
  });

  it("the version selector does not ask when nothing was changed", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    await openEdit();
    fireEvent.change(screen.getByLabelText("Version"), { target: { value: "p1" } });
    expect(confirm).not.toHaveBeenCalled();
    expect(push).toHaveBeenCalledWith("/dashboard/review/p1");
  });

  it("a click on the back link asks first and is cancelled when declined", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    await openEdit();
    makeDirty();
    const link = screen.getByRole("link", { name: /Review queue/ });
    const notPrevented = fireEvent.click(link);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(notPrevented).toBe(false);
  });

  it("an accepted discard lets the link through; a clean form never asks", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const stop = (e: Event) => e.preventDefault(); // jsdom cannot navigate
    document.addEventListener("click", stop);
    try {
      await openEdit();
      const link = screen.getByRole("link", { name: /Review queue/ });
      fireEvent.click(link);
      expect(confirm).not.toHaveBeenCalled();
      makeDirty();
      fireEvent.click(link);
      expect(confirm).toHaveBeenCalledTimes(1);
    } finally {
      document.removeEventListener("click", stop);
    }
  });

  it("links that open elsewhere (target=_blank) are not guarded", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    await openEdit();
    makeDirty();
    const link = screen.getByRole("link", { name: "Job posting" });
    const stop = (e: Event) => e.preventDefault();
    document.addEventListener("click", stop);
    fireEvent.click(link);
    document.removeEventListener("click", stop);
    expect(confirm).not.toHaveBeenCalled();
  });
});

describe("focus handling (finding 8)", () => {
  it("Edit moves focus to the first field of the form", async () => {
    await openEdit();
    expect(screen.getByLabelText("To")).toHaveFocus();
  });

  it("Cancel returns focus to the Edit button", async () => {
    await openEdit();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getAllByRole("button", { name: "Edit" })[0]).toHaveFocus();
  });

  it("a later ActionBar remount does not take focus back to Edit", async () => {
    const view = render(<DetailView detail={fixture()} adjacent={noAdjacent} />);
    await userEvent.click(screen.getAllByRole("button", { name: "Edit" })[0]);
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getAllByRole("button", { name: "Edit" })[0]).toHaveFocus();
    // Viewing another version unmounts the bar; coming back remounts it.
    view.rerender(<DetailView detail={{ ...fixture(), isActive: false }} adjacent={noAdjacent} />);
    expect(screen.queryByRole("region", { name: "Actions" })).toBeNull();
    view.rerender(<DetailView detail={fixture()} adjacent={noAdjacent} />);
    expect(screen.getAllByRole("button", { name: "Edit" })[0]).not.toHaveFocus();
  });

  it("after a Send the page heading takes focus (the action bar is gone)", () => {
    const view = render(
      <DetailView detail={fixture({ status: "approved" })} adjacent={noAdjacent} />,
    );
    expect(screen.getByRole("heading", { level: 1 })).not.toHaveFocus();
    view.rerender(<DetailView detail={fixture({ status: "sent" })} adjacent={noAdjacent} />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveFocus();
  });
});

describe("edit form conflict banner (finding 9)", () => {
  it("Reload leaves edit mode, so the stale values and the banner do not stay", async () => {
    updatePackageContent.mockResolvedValue({ success: false, code: "CONFLICT", message: "x" });
    const onClose = vi.fn();
    render(<EditForm detail={fixture()} onClose={onClose} />);
    makeDirty();
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await userEvent.click(await screen.findByRole("button", { name: "Reload" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("through DetailView: after Reload the form and the banner are gone", async () => {
    updatePackageContent.mockResolvedValue({ success: false, code: "CONFLICT", message: "x" });
    await openEdit();
    makeDirty();
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await userEvent.click(await screen.findByRole("button", { name: "Reload" }));
    expect(screen.queryByTestId("edit-conflict")).toBeNull();
    expect(screen.queryByRole("form", { name: "Edit package" })).toBeNull();
  });
});

describe("field errors are announced with the field (a11y nit)", () => {
  it("an invalid field points at its error with aria-describedby", () => {
    render(<EditForm detail={fixture()} onClose={vi.fn()} />);
    const to = screen.getByLabelText("To");
    expect(to).not.toHaveAttribute("aria-describedby");
    fireEvent.change(to, { target: { value: "not-an-address" } });
    const id = to.getAttribute("aria-describedby");
    expect(id).toBe("edit-emailTo-error");
    expect(document.getElementById(id as string)).toHaveTextContent(/valid email/i);
  });
});

describe("TextDialog", () => {
  it("shows a character counter, keeps initialValue, and disables Cancel while busy", () => {
    const { rerender } = render(
      <TextDialog
        open
        onOpenChange={vi.fn()}
        title="T"
        description="D"
        label="Reason"
        submitLabel="Go"
        initialValue="abc"
        busy={false}
        onSubmit={vi.fn()}
      />,
    );
    expect(screen.getByLabelText("Reason")).toHaveValue("abc");
    expect(screen.getByText("3 / 2000")).toBeInTheDocument();
    expect(screen.getByLabelText("Reason")).toHaveAccessibleDescription("3 / 2000");
    rerender(
      <TextDialog
        open
        onOpenChange={vi.fn()}
        title="T"
        description="D"
        label="Reason"
        submitLabel="Go"
        initialValue="abc"
        busy
        onSubmit={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
  });
});

describe("STALE_LOCK_MS is one value", () => {
  it("the client constant equals the one send.ts uses", () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, "../../src/lib/cockpit/send.ts"),
      "utf8",
    );
    const m = /export const STALE_LOCK_MS = ([\d_]+);/.exec(src);
    expect(m).not.toBeNull();
    expect(Number((m as RegExpExecArray)[1].replace(/_/g, ""))).toBe(STALE_LOCK_MS);
  });
});
