import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Sidebar from "@/components/Sidebar";
import Header from "@/components/Header";
import { SidebarProvider } from "@/context/SidebarContext";
import { SIDEBAR_LINKS } from "@/lib/constants";

vi.mock("next/navigation", () => ({
  usePathname: vi.fn().mockReturnValue("/dashboard/review/p1"),
}));
vi.mock("@/components/SidebarToggle", () => ({ default: () => null }));
vi.mock("@/components/AgentChatTrigger", () => ({
  AgentChatTrigger: () => null,
}));

const user = { id: "1", name: "Test User", email: "test@example.com" };

const renderSidebar = (cockpitEnabled?: boolean) =>
  render(
    <SidebarProvider initialExpanded>
      <Sidebar
        user={user}
        signOutAction={() => {}}
        {...(cockpitEnabled === undefined ? {} : { cockpitEnabled })}
      />
    </SidebarProvider>,
  );

async function renderHeaderMenu(cockpitEnabled?: boolean) {
  const ui = await Header(
    cockpitEnabled === undefined ? {} : { cockpitEnabled },
  );
  render(ui);
  await userEvent.click(screen.getByRole("button", { name: /toggle menu/i }));
}

describe("cockpit nav entry", () => {
  it("is a cockpitOnly link right after Jobs", () => {
    const i = SIDEBAR_LINKS.findIndex((l) => l.label === "Review");
    expect(SIDEBAR_LINKS[i - 1].label).toBe("Jobs");
    expect(SIDEBAR_LINKS[i]).toMatchObject({
      route: "/dashboard/review",
      cockpitOnly: true,
    });
  });

  describe("Sidebar", () => {
    it("shows Review when cockpitEnabled, active on a detail route", () => {
      renderSidebar(true);
      const link = screen.getByRole("link", { name: /review/i });
      expect(link).toHaveAttribute("href", "/dashboard/review");
      expect(link).toHaveAttribute("aria-current", "page");
    });

    it("hides Review when the prop is false or omitted", () => {
      const { unmount } = renderSidebar(false);
      expect(screen.queryByRole("link", { name: /review/i })).toBeNull();
      expect(screen.getByRole("link", { name: "Jobs" })).toBeInTheDocument();
      unmount();
      renderSidebar();
      expect(screen.queryByRole("link", { name: /review/i })).toBeNull();
    });
  });

  describe("Header mobile nav", () => {
    it("shows Review when cockpitEnabled", async () => {
      await renderHeaderMenu(true);
      expect(screen.getByRole("link", { name: /review/i })).toHaveAttribute(
        "href",
        "/dashboard/review",
      );
    });

    it("hides Review when the prop is false or omitted", async () => {
      await renderHeaderMenu(false);
      expect(screen.getByRole("link", { name: "Jobs" })).toBeInTheDocument();
      expect(screen.queryByRole("link", { name: /review/i })).toBeNull();
    });

    it("hides Review when the prop is omitted", async () => {
      await renderHeaderMenu();
      expect(screen.queryByRole("link", { name: /review/i })).toBeNull();
    });
  });
});
