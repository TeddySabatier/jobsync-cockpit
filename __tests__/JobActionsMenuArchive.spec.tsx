import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { JobActionsMenu } from "@/components/myjobs/JobActionsMenu";
import type { JobResponse } from "@/models/job.model";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

function makeJob(over: Partial<JobResponse> = {}): JobResponse {
  return {
    id: "job-1",
    Status: { id: "1", label: "Applied", value: "applied" },
    ...over,
  } as JobResponse;
}

async function open(job: JobResponse, onArchiveJob = vi.fn()) {
  const user = userEvent.setup();
  render(
    <JobActionsMenu
      job={job}
      jobStatuses={[]}
      editJob={vi.fn()}
      onChangeJobStatus={vi.fn()}
      onAddNote={vi.fn()}
      onDeleteJob={vi.fn()}
      onArchiveJob={onArchiveJob}
    />,
  );
  await user.click(screen.getByTestId("job-actions-menu-btn"));
  return { user, onArchiveJob };
}

describe("JobActionsMenu archive (issue #75)", () => {
  it("offers Archive and Delete for a job without packages", async () => {
    const { user, onArchiveJob } = await open(makeJob());
    expect(screen.getByText("Delete")).toBeInTheDocument();
    await user.click(screen.getByText("Archive"));
    expect(onArchiveJob).toHaveBeenCalledWith("job-1");
  });

  it("offers only Archive for a job with packages", async () => {
    await open(makeJob({ _count: { Notes: 0, applicationPackages: 2 } }));
    expect(screen.getByText("Archive")).toBeInTheDocument();
    expect(screen.queryByText("Delete")).not.toBeInTheDocument();
  });

  it("does not offer Archive for an already archived job", async () => {
    await open(
      makeJob({ Status: { id: "9", label: "Archived", value: "archived" } }),
    );
    expect(screen.queryByText("Archive")).not.toBeInTheDocument();
  });
});
