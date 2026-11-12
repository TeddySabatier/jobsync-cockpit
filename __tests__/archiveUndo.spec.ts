import { toast } from "sonner";
import { toastArchived } from "@/components/myjobs/archiveUndo";
import { restoreJobStatus } from "@/actions/job.actions";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/actions/job.actions", () => ({ restoreJobStatus: vi.fn() }));

const m = (f: unknown) => f as ReturnType<typeof vi.fn>;

beforeEach(() => vi.clearAllMocks());

describe("toastArchived", () => {
  it("offers Undo that restores the previous status and refreshes", async () => {
    m(restoreJobStatus).mockResolvedValue({ success: true });
    const after = vi.fn();
    toastArchived({ id: "s1", label: "Draft" }, "job-1", after);
    const opts = m(toast.success).mock.calls[0][1];
    expect(opts.action.label).toBe("Undo");
    await opts.action.onClick();
    expect(restoreJobStatus).toHaveBeenCalledWith("job-1", "s1");
    expect(after).toHaveBeenCalled();
  });

  it("shows the error and does not refresh when Undo is refused", async () => {
    m(restoreJobStatus).mockResolvedValue({ success: false, message: "nope" });
    const after = vi.fn();
    toastArchived({ id: "s1", label: "Draft" }, "job-1", after);
    await m(toast.success).mock.calls[0][1].action.onClick();
    expect(toast.error).toHaveBeenCalledWith("nope");
    expect(after).not.toHaveBeenCalled();
  });

  it("has no Undo when there is no previous status", () => {
    toastArchived(null, "job-1", vi.fn());
    expect(m(toast.success).mock.calls[0][1]).toBeUndefined();
  });
});
