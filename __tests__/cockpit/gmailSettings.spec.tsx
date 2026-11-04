import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const h = vi.hoisted(() => ({
  disconnect: vi.fn(),
  refresh: vi.fn(),
  settings: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: h.refresh }),
  redirect: vi.fn(),
  notFound: vi.fn(),
}));
vi.mock("@/actions/cockpitGmail.actions", () => ({
  disconnectGmail: h.disconnect,
  getGmailSettings: h.settings,
}));
vi.mock("@/lib/toast", () => ({ toastSuccess: vi.fn(), toastError: vi.fn() }));
import GmailCard from "@/components/cockpit/GmailCard";
import ReviewSettingsPage from "@/app/dashboard/review/settings/page";

const SCOPES = "https://www.googleapis.com/auth/gmail.send openid email";

describe("GmailCard", () => {
  it("shows the connected address, scopes and Disconnect", async () => {
    h.disconnect.mockResolvedValue({ success: true, data: { disconnected: true } });
    render(
      <GmailCard
        account={{ email: "you@example.com", scopes: SCOPES }}
        missingEnv={[]}
        errorMessage={null}
        justConnected
      />,
    );
    expect(screen.getByText("you@example.com")).toBeInTheDocument();
    expect(screen.getByText("https://www.googleapis.com/auth/gmail.send")).toBeInTheDocument();
    expect(screen.getByText("Gmail connected.")).toBeInTheDocument();
    expect(screen.queryByText("Connect Gmail")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    await waitFor(() => expect(h.disconnect).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(h.refresh).toHaveBeenCalled());
  });

  it("disconnected: a Connect link to the connect route", () => {
    render(<GmailCard account={null} missingEnv={[]} errorMessage={null} justConnected={false} />);
    expect(screen.getByText("Gmail is not connected.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Connect Gmail" })).toHaveAttribute(
      "href",
      "/api/cockpit/gmail/connect",
    );
  });

  it("not configured: lists the env var names and disables Connect", () => {
    render(
      <GmailCard
        account={null}
        missingEnv={["GOOGLE_CLIENT_ID", "COCKPIT_GMAIL_ALLOWED_ADDRESS"]}
        errorMessage={null}
        justConnected={false}
      />,
    );
    expect(screen.getByText("Gmail is not configured")).toBeInTheDocument();
    expect(screen.getByText("GOOGLE_CLIENT_ID")).toBeInTheDocument();
    expect(screen.getByText("COCKPIT_GMAIL_ALLOWED_ADDRESS")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connect Gmail" })).toBeDisabled();
    expect(screen.queryByRole("link", { name: "Connect Gmail" })).not.toBeInTheDocument();
  });
});

describe("settings page (AC-43)", () => {
  it("passes only email and scopes to the card, and maps the error code to a fixed message", async () => {
    // Even if a (buggy) action leaked more, the page must not forward it.
    h.settings.mockResolvedValue({
      success: true,
      data: {
        missingEnv: [],
        account: { email: "you@example.com", scopes: SCOPES },
      },
    });
    const el = await ReviewSettingsPage({
      searchParams: Promise.resolve({ error: "address_not_allowed" }),
    });
    const text = JSON.stringify(el);
    expect(text).not.toMatch(/encryptedRefreshToken|"iv"/);
    render(el);
    expect(
      screen.getByText("This Google account is not the address allowed for the cockpit."),
    ).toBeInTheDocument();
  });

  it("an unknown error value shows a generic message and is never printed", async () => {
    h.settings.mockResolvedValue({
      success: true,
      data: { missingEnv: [], account: null },
    });
    render(
      await ReviewSettingsPage({
        searchParams: Promise.resolve({ error: "<script>alert(1)</script>" }),
      }),
    );
    expect(screen.getByText("Gmail could not be connected.")).toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain("alert(1)");
  });
});
