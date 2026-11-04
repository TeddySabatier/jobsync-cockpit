import { render, screen } from "@testing-library/react";

// The job page feeds the JobDetails card only with the flag on (SPEC §5.1).
const flag = vi.hoisted(() => ({ on: false }));
const listJobVersions = vi.hoisted(() => vi.fn());
const getCurrentUser = vi.hoisted(() => vi.fn());
const getJobDetails = vi.hoisted(() => vi.fn());

vi.mock("@/lib/cockpit/config", () => ({ isCockpitEnabled: () => flag.on }));
vi.mock("@/lib/cockpit/packages", () => ({ listJobVersions }));
vi.mock("@/utils/user.utils", () => ({ getCurrentUser }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
  useRouter: () => ({ back: vi.fn(), push: vi.fn() }),
}));
vi.mock("@/actions/job.actions", () => ({
  getJobDetails,
  getJobSourceList: vi.fn(async () => []),
  getStatusList: vi.fn(async () => []),
}));
vi.mock("@/actions/company.actions", () => ({ getAllCompanies: vi.fn(async () => []) }));
vi.mock("@/actions/jobtitle.actions", () => ({ getAllJobTitles: vi.fn(async () => []) }));
vi.mock("@/actions/jobLocation.actions", () => ({
  getAllJobLocations: vi.fn(async () => []),
}));
vi.mock("@/actions/tag.actions", () => ({ getAllTags: vi.fn(async () => []) }));
vi.mock("@/components/myjobs/JobDetails", () => ({
  default: (props: { cockpitPackage?: unknown }) => (
    <div data-testid="job-details" data-pkg={JSON.stringify(props.cockpitPackage ?? null)} />
  ),
}));

import JobDetailsPage from "@/app/dashboard/myjobs/[id]/page";

async function pagePkg() {
  const { unmount } = render(
    await JobDetailsPage({ params: Promise.resolve({ id: "job-1" }) }),
  );
  const pkg = JSON.parse(screen.getByTestId("job-details").getAttribute("data-pkg")!);
  unmount();
  return pkg;
}

describe("job page passes the active package only when the flag is on", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getJobDetails.mockResolvedValue({ job: { id: "job-1" }, success: true });
    getCurrentUser.mockResolvedValue({ id: "u1" });
    listJobVersions.mockResolvedValue([
      { id: "p3", version: 3, status: "pending" },
      { id: "p2", version: 2, status: "superseded" },
    ]);
  });

  it("flag off: no package and no cockpit query", async () => {
    flag.on = false;
    expect(await pagePkg()).toBeNull();
    expect(listJobVersions).not.toHaveBeenCalled();
    expect(getCurrentUser).not.toHaveBeenCalled();
  });

  it("flag on: the highest non-superseded version, scoped to the user", async () => {
    flag.on = true;
    expect(await pagePkg()).toEqual({ id: "p3", version: 3, status: "pending" });
    expect(listJobVersions).toHaveBeenCalledWith("u1", "job-1");
  });

  it("flag on, no package or no user: no card", async () => {
    flag.on = true;
    listJobVersions.mockResolvedValue([{ id: "p1", version: 1, status: "superseded" }]);
    expect(await pagePkg()).toBeNull();
    getCurrentUser.mockResolvedValue(null);
    listJobVersions.mockClear();
    expect(await pagePkg()).toBeNull();
    expect(listJobVersions).not.toHaveBeenCalled();
  });
});
