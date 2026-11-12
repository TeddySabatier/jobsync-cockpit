import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import DataSettings from "@/components/settings/DataSettings";

vi.mock("@/lib/toast", () => ({
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

const preflight = {
  manifest: {
    formatVersion: 1,
    appVersion: "1.1.16",
    exportedAt: "2026-08-14T10:00:00.000Z",
    sourceEmail: "owner@example.com",
    counts: { Job: 12, Resume: 2 },
  },
  emailMatches: true,
  targetIsEmpty: false,
  targetCounts: { Job: 4, Resume: 1, Profile: 1, Task: 0, Activity: 0, Note: 0, Question: 0, Automation: 0, CoverLetter: 0 },
};

function mockFetch(body: unknown, ok = true) {
  const fn = vi.fn().mockResolvedValue({
    ok,
    json: async () => body,
  });
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

function pickFile(name = "backup.zip") {
  return new File(["zip-bytes"], name, { type: "application/zip" });
}

describe("DataSettings", () => {
  it("warns that the export holds no credentials but does hold full text", () => {
    render(<DataSettings />);
    expect(screen.getByText(/no API keys/i)).toBeInTheDocument();
    expect(screen.getByText(/full text/i)).toBeInTheDocument();
  });

  it("shows the backup preview after a preflight, without importing", async () => {
    const fetchMock = mockFetch(preflight);
    render(<DataSettings />);

    await userEvent.upload(
      screen.getByLabelText(/backup file/i),
      pickFile(),
    );

    await waitFor(() => expect(screen.getByText("12")).toBeInTheDocument());
    const preflightCall = fetchMock.mock.calls.find(
      (c) => c[0] === "/api/backup/import/preflight",
    );
    expect(preflightCall).toBeTruthy();
  });

  // Issue #60 review (N4): the "Backup contains" grid uses readable labels too.
  it("labels the backup contents grid in words, not model names", async () => {
    mockFetch({
      ...preflight,
      manifest: {
        ...preflight.manifest,
        counts: { Job: 12, ApplicationPackage: 3, SentEmail: 2, File: 1, _JobToTag: 4 },
      },
    });
    render(<DataSettings />);
    await userEvent.upload(screen.getByLabelText(/backup file/i), pickFile());
    await waitFor(() => expect(screen.getByText("12")).toBeInTheDocument());

    expect(screen.getByText("jobs")).toBeInTheDocument();
    expect(screen.getByText("application packages")).toBeInTheDocument();
    expect(screen.getByText("sent email records")).toBeInTheDocument();
    expect(screen.getByText("uploaded files (resumes and CV PDFs)")).toBeInTheDocument();
    expect(screen.getByText("job to tag")).toBeInTheDocument();
    expect(screen.queryByText("ApplicationPackage")).toBeNull();
    expect(screen.queryByText("SentEmail")).toBeNull();
  });

  it("reads naturally for a single uploaded file in the confirmation", async () => {
    mockFetch({ ...preflight, targetCounts: { ...preflight.targetCounts, File: 1 } });
    render(<DataSettings />);
    await userEvent.upload(screen.getByLabelText(/backup file/i), pickFile());
    await waitFor(() => screen.getByRole("button", { name: /replace my data/i }));
    await userEvent.click(screen.getByRole("button", { name: /replace my data/i }));
    expect(await screen.findByText("1 uploaded file (resume or CV PDF)")).toBeInTheDocument();
  });

  it("surfaces a source-email mismatch prominently", async () => {
    mockFetch({ ...preflight, emailMatches: false });
    render(<DataSettings />);
    await userEvent.upload(screen.getByLabelText(/backup file/i), pickFile());
    await waitFor(() =>
      expect(screen.getByText(/different account/i)).toBeInTheDocument(),
    );
  });

  it("states what will be destroyed before the import runs", async () => {
    mockFetch(preflight);
    render(<DataSettings />);
    await userEvent.upload(screen.getByLabelText(/backup file/i), pickFile());
    await waitFor(() => screen.getByRole("button", { name: /replace my data/i }));

    await userEvent.click(screen.getByRole("button", { name: /replace my data/i }));

    expect(await screen.findByText(/4 jobs/i)).toBeInTheDocument();
  });

  // Issue #60 findings 3 and 5: cockpit data is named as replaced, and every
  // model reads as words with a correct plural.
  it("names cockpit data in the confirmation with readable labels", async () => {
    mockFetch({
      ...preflight,
      targetCounts: {
        ...preflight.targetCounts,
        CoverLetter: 1,
        Activity: 2,
        ApplicationPackage: 2,
        SentEmail: 1,
        File: 3,
      },
    });
    render(<DataSettings />);
    await userEvent.upload(screen.getByLabelText(/backup file/i), pickFile());
    await waitFor(() => screen.getByRole("button", { name: /replace my data/i }));
    await userEvent.click(screen.getByRole("button", { name: /replace my data/i }));

    expect(await screen.findByText("1 cover letter")).toBeInTheDocument();
    expect(screen.getByText("2 activities")).toBeInTheDocument();
    expect(screen.getByText("2 application packages")).toBeInTheDocument();
    expect(screen.getByText("1 sent email record")).toBeInTheDocument();
    expect(screen.getByText("3 uploaded files (resumes and CV PDFs)")).toBeInTheDocument();
    expect(screen.getByText("1 profile")).toBeInTheDocument();
  });

  // Issue #60 finding 4: the copy matches what a backup carries (D-012).
  it("says the export carries packages, sent emails and CV PDFs", () => {
    render(<DataSettings />);
    expect(screen.getByText(/application packages and sent-email records/i)).toBeInTheDocument();
    expect(screen.getByText(/CV PDFs/i)).toBeInTheDocument();
  });

  it("tells the user to reconnect Gmail after an import", async () => {
    const fetchMock = mockFetch(preflight);
    render(<DataSettings />);
    await userEvent.upload(screen.getByLabelText(/backup file/i), pickFile());
    await waitFor(() => screen.getByRole("button", { name: /replace my data/i }));
    await userEvent.click(screen.getByRole("button", { name: /replace my data/i }));
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ counts: { Job: 12 }, filesWritten: 2, snapshotPath: null }),
    });
    const { toastSuccess } = await import("@/lib/toast");
    await userEvent.click(
      screen.getByRole("button", { name: /delete everything and import/i }),
    );
    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith(
        expect.stringMatching(/reconnect Gmail/),
        "Import complete",
      ),
    );
  });

  it("sends confirmWipe only after the confirmation is accepted", async () => {
    const fetchMock = mockFetch(preflight);
    render(<DataSettings />);
    await userEvent.upload(screen.getByLabelText(/backup file/i), pickFile());
    await waitFor(() => screen.getByRole("button", { name: /replace my data/i }));
    await userEvent.click(screen.getByRole("button", { name: /replace my data/i }));

    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ counts: { Job: 12 }, filesWritten: 2 }),
    });
    await userEvent.click(
      screen.getByRole("button", { name: /delete everything and import/i }),
    );

    await waitFor(() => {
      const importCall = fetchMock.mock.calls.find((c) => c[0] === "/api/backup/import");
      expect(importCall).toBeTruthy();
    });
    const importCall = fetchMock.mock.calls.find((c) => c[0] === "/api/backup/import")!;
    const body = importCall[1].body as FormData;
    expect(body.get("confirmWipe")).toBe("true");
  });

  it("shows the error message the route returned", async () => {
    mockFetch({ error: "This backup was made by a different version of JobSync." }, false);
    render(<DataSettings />);
    await userEvent.upload(screen.getByLabelText(/backup file/i), pickFile());
    const { toastError } = await import("@/lib/toast");
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        "This backup was made by a different version of JobSync.",
        expect.anything(),
      ),
    );
  });

  // The recovery surface. It only helps if it is visible and says which
  // snapshot is which, so both are asserted.
  it("lists snapshots with their date and contents", async () => {
    mockFetch([
      {
        id: "pre-import-2026-08-14T10-32-00-000Z.zip",
        exportedAt: "2026-08-14T10:32:00.000Z",
        appVersion: "1.1.16",
        counts: { Job: 47, Resume: 3 },
        sizeBytes: 2_400_000,
      },
    ]);
    render(<DataSettings />);
    expect(await screen.findByText(/undo an import/i)).toBeInTheDocument();
    expect(screen.getByText(/47 jobs, 3 resumes/i)).toBeInTheDocument();
  });

  it("posts the snapshot id only after the rollback is confirmed", async () => {
    const fetchMock = mockFetch([
      {
        id: "pre-import-2026-08-14T10-32-00-000Z.zip",
        exportedAt: "2026-08-14T10:32:00.000Z",
        appVersion: "1.1.16",
        counts: { Job: 47, Resume: 3 },
        sizeBytes: 2_400_000,
      },
    ]);
    render(<DataSettings />);
    await userEvent.click(await screen.findByRole("button", { name: /restore/i }));

    const rollbackCallBefore = fetchMock.mock.calls.find(
      (c) => c[0] === "/api/backup/rollback",
    );
    expect(rollbackCallBefore).toBeFalsy();

    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ counts: { Job: 47 }, filesWritten: 3, snapshotPath: "x" }),
    });
    await userEvent.click(screen.getByRole("button", { name: /^roll back$/i }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/backup/rollback",
        expect.objectContaining({ method: "POST" }),
      ),
    );
    const body = JSON.parse(
      fetchMock.mock.calls.find((c) => c[0] === "/api/backup/rollback")![1].body,
    );
    expect(body.snapshotId).toBe("pre-import-2026-08-14T10-32-00-000Z.zip");
  });
});
