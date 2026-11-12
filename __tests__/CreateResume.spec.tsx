import CreateResume from "@/components/profile/CreateResume";
import { Resume } from "@/models/profile.model";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/",
}));

vi.mock("@/actions/userSettings.actions", () => ({
  getUserSettings: vi.fn().mockResolvedValue({ success: false }),
}));

describe("CreateResume Component", () => {
  const mockReloadResumes = vi.fn();
  const mockSetResumeDialogOpen = vi.fn();
  const mockSetNewResumeId = vi.fn();
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });
  const renderComponent = (resumeToEdit?: Resume) => {
    render(
      <CreateResume
        resumeDialogOpen={true}
        setResumeDialogOpen={mockSetResumeDialogOpen}
        resumeToEdit={resumeToEdit}
        reloadResumes={mockReloadResumes}
        setNewResumeId={mockSetNewResumeId}
      />
    );
  };
  it("should render the dialog when resumeDialogOpen is true", () => {
    renderComponent();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText(/create resume/i)).toBeInTheDocument();
  });

  it("should display the correct title when editing a resume", () => {
    const mockResumeToEdit = {
      id: "resume-id",
      title: "Test Resume",
      FileId: "file-id",
    } as Resume;

    renderComponent(mockResumeToEdit);

    expect(screen.getByText(/edit resume title/i)).toBeInTheDocument();

    const titleInput = screen.getByTestId("resume-title-input");
    expect(titleInput).toHaveValue("Test Resume");
  });

  it("should display the correct title when creating a new resume", () => {
    renderComponent();

    expect(screen.getByText(/create resume/i)).toBeInTheDocument();

    const titleInput = screen.getByTestId("resume-title-input");
    expect(titleInput).toHaveValue("");
  });

  it("should call setResumeDialogOpen with false when cancel button is clicked", () => {
    renderComponent();

    const cancelButton = screen.getByRole("button", { name: /cancel/i });

    fireEvent.click(cancelButton);

    expect(mockSetResumeDialogOpen).toHaveBeenCalledWith(false);
  });

  it("should display validation errors when form is invalid", async () => {
    renderComponent();

    const titleInput = screen.getByTestId("resume-title-input");
    fireEvent.change(titleInput, { target: { value: "Temporary Title" } });
    fireEvent.change(titleInput, { target: { value: "" } });

    const saveButton = screen.getByRole("button", { name: /save/i });
    expect(saveButton).toBeDisabled();
    fireEvent.click(saveButton);

    await waitFor(() => {
      expect(screen.getByText(/resume title is required/i)).toBeInTheDocument();
    });
  });
});

describe("CreateResume: created but default not set", () => {
  const post = (body: unknown) => {
    global.fetch = vi.fn().mockResolvedValue({ json: async () => body }) as never;
  };
  const submit = async () => {
    const reload = vi.fn();
    const close = vi.fn();
    render(
      <CreateResume
        resumeDialogOpen={true}
        setResumeDialogOpen={close}
        reloadResumes={reload}
        setNewResumeId={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByTestId("resume-title-input"), { target: { value: "My CV" } });
    await waitFor(() => expect(screen.getByRole("button", { name: /save/i })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    return { reload, close };
  };

  it("closes the dialog and reloads the list so a retry cannot duplicate", async () => {
    post({ success: false, created: true, message: "Resume created, but x" });
    const { reload, close } = await submit();
    await waitFor(() => expect(reload).toHaveBeenCalled());
    expect(close).toHaveBeenCalledWith(false);
  });

  it("a plain failure keeps the dialog open", async () => {
    post({ success: false, message: "Failed to create resume." });
    const { reload, close } = await submit();
    await new Promise((r) => setTimeout(r, 50));
    expect(reload).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });
});
