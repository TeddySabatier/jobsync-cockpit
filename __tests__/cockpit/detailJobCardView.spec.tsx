import { render, screen } from "@testing-library/react";
import JobDetails from "@/components/myjobs/JobDetails";

// Same harness as __tests__/JobDetails.spec.tsx.
vi.mock("next/navigation", () => ({
  useRouter: vi.fn(() => ({ back: vi.fn(), push: vi.fn(), replace: vi.fn() })),
  useSearchParams: vi.fn(() => new URLSearchParams()),
  usePathname: vi.fn(() => "/dashboard/myjobs/job-1"),
}));
vi.mock("@/components/agent/AgentChatProvider", () => ({
  useAgentChat: () => ({
    open: vi.fn(),
    clear: vi.fn(),
    sendMessage: vi.fn(),
    approvalPending: false,
  }),
}));
vi.mock("@/components/myjobs/NotesSection", () => ({ NotesSection: () => null }));
vi.mock("@/components/TipTapContentViewer", () => ({ TipTapContentViewer: () => null }));
vi.mock("@/components/automations/MatchDetails", () => ({ MatchDetails: () => null }));
vi.mock("@/components/profile/DownloadFileButton", () => ({
  DownloadFileButton: () => null,
}));
vi.mock("@/components/CircularScore", () => ({ CircularScore: () => null }));

const job = {
  id: "job-1",
  userId: "u1",
  JobTitle: { id: "t", label: "Dev", value: "dev", createdBy: "u1" },
  Company: { id: "c", label: "Acme", value: "acme", createdBy: "u1" },
  Status: { id: "s", label: "Draft", value: "draft" },
  Location: { id: "l", label: "Remote", value: "remote", createdBy: "u1" },
  description: "<p>x</p>",
  jobType: "FT",
  tags: [],
} as never;

const base = {
  job,
  jobStatuses: [],
  companies: [],
  titles: [],
  locations: [],
  sources: [],
  tags: [],
};

describe("JobDetails application package card", () => {
  it("is absent without the prop (flag off)", () => {
    render(<JobDetails {...base} />);
    expect(screen.queryByText("Application package")).toBeNull();
    expect(screen.queryByTestId("job-details-package-link")).toBeNull();
  });

  it("is absent for a null package", () => {
    render(<JobDetails {...base} cockpitPackage={null} />);
    expect(screen.queryByText("Application package")).toBeNull();
  });

  it("links to the review page with version and status", () => {
    render(
      <JobDetails {...base} cockpitPackage={{ id: "p3", version: 3, status: "pending" }} />,
    );
    expect(screen.getByText("Application package")).toBeInTheDocument();
    const link = screen.getByTestId("job-details-package-link");
    expect(link).toHaveAttribute("href", "/dashboard/review/p3");
    expect(link).toHaveTextContent("v3 · pending");
  });
});
