import { cleanup, fireEvent, render, screen } from "@testing-library/react";

// The unsaved-edit click guard of EditForm (#59 finding 3): what it must NOT
// intercept, and that it does not leak. Synthetic data only.

vi.mock("@/actions/cockpit.actions", () => ({ updatePackageContent: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("@/lib/toast", () => ({ toastSuccess: vi.fn(), toastError: vi.fn() }));
vi.mock("@/components/TipTapContentViewer", () => ({ TipTapContentViewer: () => <div /> }));

import EditForm from "@/components/cockpit/EditForm";
import type { PackageDetail } from "@/components/cockpit/Panels";

const detail = (): PackageDetail =>
  ({
    package: {
      id: "p2",
      version: 2,
      status: "pending",
      emailTo: "jobs@acme.example",
      emailSubject: "Application",
      emailBody: "Hello,",
      letterMd: "Dear team,",
      cvJson: null,
      cvFileId: "f1",
      cvPdfStale: false,
      sendStartedAt: null,
      updatedAt: new Date("2026-11-01T10:00:00Z"),
      job: { id: "j1", jobUrl: null, description: "", JobTitle: { label: "X" }, Company: { label: "Acme" } },
    },
    versions: [],
    activePackageId: "p2",
    isActive: true,
    attachment: null,
    letterAttachment: null,
    gmail: null,
    gmailSendAllowed: true,
  }) as unknown as PackageDetail;

const makeDirty = () =>
  fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "S2" } });

// An anchor outside the form, like the sidebar. jsdom cannot navigate: a
// bubble-phase listener swallows the default action after the guard ran.
function link(attrs: Record<string, string>, inner = "go"): HTMLAnchorElement {
  const a = document.createElement("a");
  for (const [k, v] of Object.entries(attrs)) a.setAttribute(k, v);
  a.innerHTML = `<span>${inner}</span>`;
  document.body.appendChild(a);
  return a;
}
const swallow = (e: Event) => e.preventDefault();
beforeEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
  document.addEventListener("click", swallow);
});
afterEach(() => {
  document.removeEventListener("click", swallow);
});

describe("EditForm click guard", () => {
  it("asks once for a plain same-origin link, even when the click lands on a child", () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<EditForm detail={detail()} onClose={vi.fn()} />);
    makeDirty();
    const a = link({ href: "/dashboard/review" });
    expect(fireEvent.click(a.querySelector("span") as Element)).toBe(false);
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["target=_blank", { href: "/x", target: "_blank" }, {}],
    ["download", { href: "/x", download: "" }, {}],
    ["cross-origin", { href: "https://other.example/x" }, {}],
    ["mailto", { href: "mailto:a@b.example" }, {}],
    ["same page, other hash", { href: "#section" }, {}],
    ["same path and query", { href: window.location.pathname + window.location.search }, {}],
    ["ctrl+click", { href: "/x" }, { ctrlKey: true }],
    ["meta+click", { href: "/x" }, { metaKey: true }],
    ["shift+click", { href: "/x" }, { shiftKey: true }],
    ["alt+click", { href: "/x" }, { altKey: true }],
    ["middle click", { href: "/x" }, { button: 1 }],
    ["right click", { href: "/x" }, { button: 2 }],
    ["an anchor without href", {}, {}],
  ])("does not intercept: %s", (_n, attrs, init) => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<EditForm detail={detail()} onClose={vi.fn()} />);
    makeDirty();
    fireEvent.click(link(attrs), init);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("does not intercept a click another handler already cancelled", () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<EditForm detail={detail()} onClose={vi.fn()} />);
    makeDirty();
    const a = link({ href: "/x" });
    const pre = (e: Event) => e.preventDefault();
    window.addEventListener("click", pre, true); // before the document capture listener
    fireEvent.click(a);
    window.removeEventListener("click", pre, true);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("stops asking once the edits are reverted by hand", () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<EditForm detail={detail()} onClose={vi.fn()} />);
    makeDirty();
    fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "Application" } });
    fireEvent.click(link({ href: "/x" }));
    expect(confirm).not.toHaveBeenCalled();
  });

  it("leaks no listener after the form unmounts (dirty or not)", () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const add = vi.spyOn(document, "addEventListener");
    const remove = vi.spyOn(document, "removeEventListener");
    const view = render(<EditForm detail={detail()} onClose={vi.fn()} />);
    makeDirty();
    view.unmount();
    const added = add.mock.calls.filter(([t]) => t === "click").length;
    const removed = remove.mock.calls.filter(([t]) => t === "click").length;
    expect(added).toBeGreaterThan(0);
    expect(removed).toBeGreaterThanOrEqual(added);
    fireEvent.click(link({ href: "/x" }));
    expect(confirm).not.toHaveBeenCalled();
    cleanup();
  });

  it("a second dirty edit does not stack a second prompt", () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<EditForm detail={detail()} onClose={vi.fn()} />);
    makeDirty();
    fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "S3" } });
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "x@acme.example" } });
    fireEvent.click(link({ href: "/x" }));
    expect(confirm).toHaveBeenCalledTimes(1);
  });
});
