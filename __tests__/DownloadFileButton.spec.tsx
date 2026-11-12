import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DownloadFileButton } from "@/components/profile/DownloadFileButton";

// Issue #60 review (S2): a restored backup names resume files <id>.<ext> on
// disk; the saved file must carry the display name instead.
// Issue #78: the button asks for the file by id; no path goes in the URL.

function Harness(props: { fileId: string; fileName: string }) {
  return DownloadFileButton(props.fileId, "My CV", props.fileName);
}

const FILE_ID = "0f8b5c1e-3a1d-4c55-9a52-5d0c6b1e2f77";

describe("DownloadFileButton", () => {
  let clicked: HTMLAnchorElement[];
  let fetchMock: ReturnType<typeof vi.fn>;

  const respond = (disposition: string | null, ok = true) =>
    fetchMock.mockResolvedValue({
      ok,
      headers: new Headers(disposition ? { "Content-Disposition": disposition } : {}),
      blob: async () => new Blob(["%PDF"]),
    });

  beforeEach(() => {
    clicked = [];
    fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    respond(`attachment; filename="${FILE_ID}.pdf"; filename*=UTF-8''${FILE_ID}.pdf`);
    window.URL.createObjectURL = vi.fn(() => "blob:x");
    window.URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push(this);
    });
  });

  afterEach(() => vi.restoreAllMocks());

  it("requests the file by its id, never by a path", async () => {
    render(<Harness fileId={FILE_ID} fileName="Jane_Doe_CV.pdf" />);
    await userEvent.click(screen.getByRole("button"));
    await waitFor(() => expect(clicked).toHaveLength(1));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toBe(`/api/profile/resume?fileId=${FILE_ID}`);
    expect(url).not.toContain("filePath");
  });

  it("encodes the id in the query string", async () => {
    render(<Harness fileId="a&filePath=/etc/passwd" fileName="x.pdf" />);
    await userEvent.click(screen.getByRole("button"));
    await waitFor(() => expect(clicked).toHaveLength(1));
    const url = new URL(String(fetchMock.mock.calls[0][0]), "http://localhost");
    expect(url.searchParams.get("fileId")).toBe("a&filePath=/etc/passwd");
    expect(url.searchParams.has("filePath")).toBe(false);
  });

  it("saves a restored resume under its display name, not the id on disk", async () => {
    render(<Harness fileId={FILE_ID} fileName="Jane_Doe_CV.pdf" />);
    await userEvent.click(screen.getByRole("button"));
    await waitFor(() => expect(clicked).toHaveLength(1));
    expect(clicked[0].download).toBe("Jane_Doe_CV.pdf");
  });

  it("falls back to the name the server sent when there is no display name", async () => {
    respond(`attachment; filename="abc.pdf"; filename*=UTF-8''abc.pdf`);
    render(<Harness fileId={FILE_ID} fileName="" />);
    await userEvent.click(screen.getByRole("button"));
    await waitFor(() => expect(clicked).toHaveLength(1));
    expect(clicked[0].download).toBe("abc.pdf");
  });

  it("falls back to a generic name without a display name or header", async () => {
    respond(null);
    render(<Harness fileId={FILE_ID} fileName="" />);
    await userEvent.click(screen.getByRole("button"));
    await waitFor(() => expect(clicked).toHaveLength(1));
    expect(clicked[0].download).toBe("resume");
  });

  it("saves nothing when the server refuses (404)", async () => {
    respond(null, false);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<Harness fileId={FILE_ID} fileName="x.pdf" />);
    await userEvent.click(screen.getByRole("button"));
    await waitFor(() => expect(err).toHaveBeenCalled());
    expect(clicked).toHaveLength(0);
  });
});
