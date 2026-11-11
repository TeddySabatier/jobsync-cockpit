import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

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
  getPackageDetail: vi.fn(),
  getAdjacentPackageIds: vi.fn(),
}));

const push = vi.hoisted(() => vi.fn());
const refresh = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, refresh }),
}));
const toastError = vi.hoisted(() => vi.fn());
vi.mock("@/lib/toast", () => ({ toastSuccess: vi.fn(), toastError }));
vi.mock("@/components/TipTapContentViewer", () => ({
  TipTapContentViewer: ({ content }: { content: string }) => (
    <div data-testid="tiptap" data-html={content} />
  ),
}));

import DetailView from "@/components/cockpit/DetailView";
import EditForm, {
  canEditPackage,
  validateEditValues,
} from "@/components/cockpit/EditForm";
import { RERENDER_INSTRUCTION } from "@/components/cockpit/EditRerender";
import type { PackageDetail } from "@/components/cockpit/Panels";

const CV = {
  name: "Jane Doe",
  years: 7,
  experience: [{ role: "Engineer", bullets: ["Built A", "Built B"] }],
};

const fixture = (
  over: Partial<PackageDetail["package"]> = {},
  extra: Partial<Omit<PackageDetail, "package">> = {},
): PackageDetail => ({
  package: {
    id: "p2",
    version: 2,
    status: "pending",
    emailTo: "jobs@acme.example",
    emailSubject: "Application: Staff Engineer",
    emailBody: "Hello,\n\nPlease find my CV.",
    letterMd: "Dear team,",
    fitGrade: "A",
    fitAnalysis: null,
    cvJson: JSON.stringify(CV),
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

const ok = { success: true, data: {} };
const noAdjacent = { previousId: null, nextId: null };

beforeEach(() => {
  vi.clearAllMocks();
  updatePackageContent.mockResolvedValue(ok);
  requestPackageChanges.mockResolvedValue(ok);
});

describe("edit mode: gating (SPEC §2.1, §5.4)", () => {
  it.each([
    ["pending", {}, true],
    ["approved", {}, true],
    ["sent", {}, false],
    ["rejected", {}, false],
    ["superseded", {}, false],
    ["changes_requested", {}, false],
    ["approved", { sendStartedAt: new Date() }, false],
  ])("canEditPackage(%s, %j) = %s", (status, over, expected) => {
    expect(canEditPackage(fixture({ status, ...over }))).toBe(expected);
  });

  it("is not editable on a non-active version", () => {
    expect(canEditPackage(fixture({}, { isActive: false }))).toBe(false);
  });

  it("offers Edit on an open, unlocked, active package", () => {
    render(<DetailView detail={fixture()} adjacent={noAdjacent} />);
    expect(screen.getAllByRole("button", { name: "Edit" }).length).toBeGreaterThan(0);
  });

  it.each([
    ["sent", {}],
    ["rejected", {}],
    ["superseded", {}],
    ["approved", { sendStartedAt: new Date() }],
  ])("offers no Edit for %s %j", (status, over) => {
    render(<DetailView detail={fixture({ status, ...over })} adjacent={noAdjacent} />);
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
  });

  it("offers no Edit on a non-active version", () => {
    render(
      <DetailView
        detail={fixture({ status: "superseded" }, { isActive: false })}
        adjacent={noAdjacent}
      />,
    );
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.queryByRole("form", { name: "Edit package" })).toBeNull();
  });

  it("switches to the form on Edit and back on Cancel", async () => {
    render(<DetailView detail={fixture()} adjacent={noAdjacent} />);
    await userEvent.click(screen.getAllByRole("button", { name: "Edit" })[0]);
    expect(screen.getByRole("form", { name: "Edit package" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Actions" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("form", { name: "Edit package" })).toBeNull();
  });
});

describe("edit form: save through updatePackageContent", () => {
  it("sends only the changed fields", async () => {
    const onClose = vi.fn();
    render(<EditForm detail={fixture()} onClose={onClose} />);
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Subject"), {
      target: { value: "New subject" },
    });
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "" } });
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(updatePackageContent).toHaveBeenCalledTimes(1);
    expect(updatePackageContent).toHaveBeenCalledWith("p2", {
      emailTo: "",
      emailSubject: "New subject",
    });
  });

  it("sends letterMd and the whole cvJson when a CV leaf changes", async () => {
    render(<EditForm detail={fixture()} onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("experience[0].bullets[1]"), {
      target: { value: "Built B, better" },
    });
    expect(screen.getByText("PDF will be marked stale")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Letter (Markdown)"), {
      target: { value: "Dear Acme," },
    });
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(updatePackageContent).toHaveBeenCalled());
    expect(updatePackageContent).toHaveBeenCalledWith("p2", {
      letterMd: "Dear Acme,",
      cvJson: {
        ...CV,
        experience: [{ role: "Engineer", bullets: ["Built A", "Built B, better"] }],
      },
    });
  });

  it("labels CV string leaves with their path and skips non-strings", () => {
    render(<EditForm detail={fixture()} onClose={vi.fn()} />);
    for (const path of [
      "name",
      "experience[0].role",
      "experience[0].bullets[0]",
      "experience[0].bullets[1]",
    ]) {
      expect(screen.getByLabelText(path)).toBeInTheDocument();
    }
    expect(screen.queryByLabelText("years")).toBeNull();
  });

  it("shows a reload message on CONFLICT and does not close", async () => {
    updatePackageContent.mockResolvedValue({
      success: false,
      code: "CONFLICT",
      message: "x",
    });
    const onClose = vi.fn();
    render(<EditForm detail={fixture()} onClose={onClose} />);
    fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "S2" } });
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    const box = await screen.findByTestId("edit-conflict");
    expect(box).toHaveTextContent(/changed since you opened it/i);
    expect(onClose).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(refresh).toHaveBeenCalled();
  });

  it("treats INVALID_STATE (locked, sent, superseded) as a reload case", async () => {
    updatePackageContent.mockResolvedValue({
      success: false,
      code: "INVALID_STATE",
      message: "x",
    });
    render(<EditForm detail={fixture()} onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "S2" } });
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByTestId("edit-conflict")).toBeInTheDocument();
  });

  it("toasts other failures with the fixed message", async () => {
    updatePackageContent.mockResolvedValue({
      success: false,
      code: "INTERNAL",
      message: "Something went wrong",
    });
    render(<EditForm detail={fixture()} onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "S2" } });
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("Something went wrong"));
  });

  it("asks before discarding unsaved changes", async () => {
    const onClose = vi.fn();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<EditForm detail={fixture()} onClose={onClose} />);
    fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "S2" } });
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(confirm).toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalled();
    confirm.mockRestore();
  });
});

describe("edit form: client validation mirrors the zod rules", () => {
  const base = {
    emailTo: "a@b.example",
    emailSubject: "S",
    emailBody: "B",
    letterMd: "",
  };

  it("accepts an address or empty", () => {
    expect(validateEditValues(base)).toEqual({});
    expect(validateEditValues({ ...base, emailTo: "" })).toEqual({});
  });

  it("rejects CR/LF in To and Subject", () => {
    const e = validateEditValues({
      ...base,
      emailTo: "a@b.example\r\nBcc: x@y.example",
      emailSubject: "hi\nBcc: x",
    });
    expect(e.emailTo).toBe("No line break allowed");
    expect(e.emailSubject).toBe("No line break allowed");
  });

  it("rejects a bad address, a comma list, an empty subject and body", () => {
    expect(validateEditValues({ ...base, emailTo: "nope" }).emailTo).toBeDefined();
    expect(
      validateEditValues({ ...base, emailTo: "a@b.example,c@d.example" }).emailTo,
    ).toBeDefined();
    const e = validateEditValues({ ...base, emailSubject: "", emailBody: "" });
    expect(e.emailSubject).toBe("Required");
    expect(e.emailBody).toBe("Required");
  });

  it("says 'Must not be blank' for a whitespace-only subject and body (D-018 c)", () => {
    const e = validateEditValues({ ...base, emailSubject: "  ", emailBody: " \n" });
    expect(e.emailSubject).toBe("Must not be blank");
    expect(e.emailBody).toBe("Must not be blank");
  });

  it("blocks Save and shows the error", async () => {
    render(<EditForm detail={fixture()} onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "not-an-email" } });
    expect(screen.getByRole("alert")).toHaveTextContent(/valid email/i);
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(updatePackageContent).not.toHaveBeenCalled();
  });
});

describe("edit form: letter preview", () => {
  it("renders through the hardened renderer: no <a>, no <img>", () => {
    render(<EditForm detail={fixture()} onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Letter (Markdown)"), {
      target: {
        value: "Hi\n\n![x](http://a.example/b.png)\n\n[y](javascript:alert(1))",
      },
    });
    const html = screen.getByTestId("tiptap").getAttribute("data-html") ?? "";
    expect(html).toContain("Hi");
    expect(html).not.toMatch(/<img/i);
    expect(html).not.toMatch(/<a[\s>]/i);
  });
});

describe("stale PDF flow", () => {
  it("shows the stale badge and warning when cvPdfStale", () => {
    render(
      <DetailView detail={fixture({ cvPdfStale: true })} adjacent={noAdjacent} />,
    );
    expect(screen.getByText("PDF stale")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(/PDF out of date/);
    expect(
      screen.getByRole("button", { name: "Ask the bot to re-render" }),
    ).toBeInTheDocument();
  });

  it("shows no re-render button when the PDF is current", () => {
    render(<DetailView detail={fixture()} adjacent={noAdjacent} />);
    expect(screen.queryByText("PDF stale")).toBeNull();
    expect(screen.queryByRole("button", { name: "Ask the bot to re-render" })).toBeNull();
  });

  it("calls requestPackageChanges with the prefilled instruction", async () => {
    render(
      <DetailView detail={fixture({ cvPdfStale: true })} adjacent={noAdjacent} />,
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Ask the bot to re-render" }),
    );
    const box = screen.getByLabelText("Instruction");
    expect(box).toHaveValue(RERENDER_INSTRUCTION);
    await userEvent.click(screen.getByRole("button", { name: "Request re-render" }));
    await waitFor(() =>
      expect(requestPackageChanges).toHaveBeenCalledWith("p2", RERENDER_INSTRUCTION),
    );
  });

  it("lets the user edit the instruction first", async () => {
    render(
      <DetailView detail={fixture({ cvPdfStale: true })} adjacent={noAdjacent} />,
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Ask the bot to re-render" }),
    );
    const box = screen.getByLabelText("Instruction");
    await userEvent.clear(box);
    await userEvent.type(box, "Please re-render with the new bullets.");
    await userEvent.click(screen.getByRole("button", { name: "Request re-render" }));
    await waitFor(() =>
      expect(requestPackageChanges).toHaveBeenCalledWith(
        "p2",
        "Please re-render with the new bullets.",
      ),
    );
  });
});
