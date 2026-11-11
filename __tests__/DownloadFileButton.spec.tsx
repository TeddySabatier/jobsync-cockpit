import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DownloadFileButton } from "@/components/profile/DownloadFileButton";

// Issue #60 review (S2): a restored backup names resume files <id>.<ext> on
// disk; the saved file must carry the display name instead.

function Harness(props: { filePath: string; fileName: string }) {
  return DownloadFileButton(props.filePath, "My CV", props.fileName);
}

describe("DownloadFileButton", () => {
  let clicked: HTMLAnchorElement[];

  beforeEach(() => {
    clicked = [];
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      blob: async () => new Blob(["%PDF"]),
    }) as unknown as typeof fetch;
    window.URL.createObjectURL = vi.fn(() => "blob:x");
    window.URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push(this);
    });
  });

  afterEach(() => vi.restoreAllMocks());

  it("saves a restored resume under its display name, not the id on disk", async () => {
    render(
      <Harness
        filePath="/data/files/resumes/0f8b5c1e-3a1d-4c55-9a52-5d0c6b1e2f77.pdf"
        fileName="Jane_Doe_CV.pdf"
      />,
    );
    await userEvent.click(screen.getByRole("button"));
    await waitFor(() => expect(clicked).toHaveLength(1));
    expect(clicked[0].download).toBe("Jane_Doe_CV.pdf");
  });

  it("falls back to the name on disk when there is no display name", async () => {
    render(<Harness filePath="/data/files/resumes/abc.pdf" fileName="" />);
    await userEvent.click(screen.getByRole("button"));
    await waitFor(() => expect(clicked).toHaveLength(1));
    expect(clicked[0].download).toBe("abc.pdf");
  });
});
