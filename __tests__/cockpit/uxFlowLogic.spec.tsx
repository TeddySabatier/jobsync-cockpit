import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { advanceMessage, pickAdvanceTarget } from "@/lib/cockpit/advance";
import { nextStep } from "@/lib/cockpit/nextStep";
import { keyCommand } from "@/lib/cockpit/keys";
import { createThrottle } from "@/lib/cockpit/focusRefresh";
import {
  draftKey, loadDraft, saveDraft, clearDraft, pruneDrafts, DRAFT_MAX_AGE_MS,
} from "@/lib/cockpit/editDraft";
import { botChecks, fitWhy, readinessChips, whatToCheck } from "@/lib/cockpit/summary";
import {
  buildChangeRequestsPrompt, buildClaudePrompt, buildRefreshAndPreparePrompt,
  REFRESH_AND_PREPARE_CAP, reviewPointer,
} from "@/lib/cockpit/claudePrompt";
import { recipientNote, recipientWarning } from "@/components/cockpit/SendDialog";
import { useNavGuard } from "@/components/cockpit/navGuard";
import { useFocusRefresh } from "@/components/cockpit/useFocusRefresh";

vi.mock("@/actions/cockpitSend.actions", () => ({ sendPackage: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));

describe("nextStep mapping per stage", () => {
  const base = { sendStarted: false, hasRecipient: true, blockedReason: null, hasJobUrl: true };
  it.each([
    [{ status: "pending" }, "approve_and_send"],
    [{ status: "pending", blockedReason: "x" }, "approve_only"],
    [{ status: "approved" }, "send"],
    [{ status: "approved", blockedReason: "x" }, "send_blocked"],
    [{ status: "pending", hasRecipient: false }, "link_apply"],
    [{ status: "approved", hasRecipient: false }, "link_apply"],
    [{ status: "changes_requested" }, "handle_changes"],
    [{ status: "rejected" }, "reopen"],
    [{ status: "sent" }, "next"],
    [{ status: "superseded" }, "none"],
    [{ status: "approved", sendStarted: true }, "locked"],
    [{ status: "pending", sendStarted: true }, "locked"],
  ])("%j -> %s", (over, kind) => {
    expect(nextStep({ ...base, ...over }).kind).toBe(kind);
  });
  it("a link application never needs Approve first, even with a blocked Send", () => {
    expect(nextStep({ ...base, status: "pending", hasRecipient: false, blockedReason: "x" }).kind).toBe(
      "link_apply",
    );
  });
});

describe("auto-advance target", () => {
  it("prefers next, then previous, then the queue", () => {
    expect(pickAdvanceTarget({ previousId: "a", nextId: "b", todoLeft: 4 })).toEqual({
      href: "/dashboard/review/b", left: 4, done: false,
    });
    expect(pickAdvanceTarget({ previousId: "a", nextId: null, todoLeft: 1 }).href).toBe("/dashboard/review/a");
    expect(pickAdvanceTarget({ previousId: null, nextId: null })).toEqual({
      href: "/dashboard/review", left: 0, done: true,
    });
  });
  it("messages", () => {
    expect(advanceMessage("Sent", { href: "x", left: 2, done: false })).toBe("Sent. 2 left to review.");
    expect(advanceMessage("Sent", { href: "x", left: 0, done: true })).toMatch(/All done/);
  });
});

describe("keyCommand", () => {
  const e = (key: string, over = {}) => ({ key, ctrlKey: false, metaKey: false, altKey: false, ...over });
  const free = { editable: false, dialogOpen: false };
  it("maps the keys", () => {
    expect(["j", "k", "a", "e", "x", "?"].map((k) => keyCommand(e(k), free))).toEqual([
      "next", "prev", "approve", "edit", "reject", "help",
    ]);
  });
  it("ignores typing, dialogs, modifiers, other keys and prototype names", () => {
    expect(keyCommand(e("a"), { editable: true, dialogOpen: false })).toBeNull();
    expect(keyCommand(e("a"), { editable: false, dialogOpen: true })).toBeNull();
    expect(keyCommand(e("a", { ctrlKey: true }), free)).toBeNull();
    expect(keyCommand(e("A"), free)).toBeNull();
    expect(keyCommand(e("constructor"), free)).toBeNull();
  });
});

describe("focus refresh", () => {
  it("throttles: not at once, then at most once per window", () => {
    let t = 1000;
    const fn = vi.fn();
    const run = createThrottle(fn, 15000, () => t);
    expect(run()).toBe(false);
    t += 14999;
    expect(run()).toBe(false);
    t += 1;
    expect(run()).toBe(true);
    t += 100;
    expect(run()).toBe(false);
    t += 15000;
    expect(run()).toBe(true);
    expect(fn).toHaveBeenCalledTimes(2);
  });
  it("the hook refreshes on focus and when the tab becomes visible, throttled", () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const { unmount } = renderHook(() => useFocusRefresh(fn, 1000));
    window.dispatchEvent(new Event("focus"));
    expect(fn).not.toHaveBeenCalled();
    vi.setSystemTime(Date.now() + 1500);
    window.dispatchEvent(new Event("focus"));
    expect(fn).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 1500);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(fn).toHaveBeenCalledTimes(2);
    unmount();
    vi.setSystemTime(Date.now() + 5000);
    window.dispatchEvent(new Event("focus"));
    expect(fn).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});

describe("edit draft storage", () => {
  const draft = {
    values: { emailTo: "a@b.co", emailSubject: "s", emailBody: "b", letterMd: "l" },
    cv: { name: "x" },
  };
  beforeEach(() => localStorage.clear());
  it("round-trips per package + updatedAt; another updatedAt finds nothing", () => {
    const k = draftKey("p1", new Date(1000));
    expect(saveDraft(k, draft, 5)).toBe(true);
    expect(loadDraft(k, 6)).toEqual({ ...draft, savedAt: 5 });
    expect(loadDraft(draftKey("p1", new Date(2000)))).toBeNull();
    clearDraft(k);
    expect(loadDraft(k)).toBeNull();
  });
  it("drops expired, malformed and oversized drafts", () => {
    const k = draftKey("p1", 1);
    saveDraft(k, draft, 0);
    expect(loadDraft(k, DRAFT_MAX_AGE_MS + 1)).toBeNull();
    localStorage.setItem(k, "{not json");
    expect(loadDraft(k)).toBeNull();
    localStorage.setItem(k, JSON.stringify({ values: { emailTo: 1 }, cv: null, savedAt: 1 }));
    expect(loadDraft(k)).toBeNull();
    expect(saveDraft(k, { ...draft, cv: { big: "x".repeat(700_000) } })).toBe(false);
  });
  it("never throws when storage is unavailable", () => {
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    expect(saveDraft("k", draft)).toBe(false);
    spy.mockRestore();
    const get = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    expect(loadDraft("k")).toBeNull();
    get.mockRestore();
  });
  it("prunes older drafts of the same package but keeps the current one", () => {
    const keep = draftKey("p1", 2);
    saveDraft(draftKey("p1", 1), draft);
    saveDraft(keep, draft);
    saveDraft(draftKey("p2", 1), draft);
    pruneDrafts("p1", keep);
    expect(loadDraft(draftKey("p1", 1))).toBeNull();
    expect(loadDraft(keep)).not.toBeNull();
    expect(loadDraft(draftKey("p2", 1))).not.toBeNull();
  });
});

describe("summary helpers", () => {
  it("fitWhy reads reasons, falls back to summary, never raw JSON", () => {
    expect(fitWhy(JSON.stringify({ reasons: ["a", "b", "c", "d"] }))).toBe("a; b; c");
    expect(fitWhy(JSON.stringify({ summary: "Strong" }))).toBe("Strong");
    expect(fitWhy("not json")).toBeNull();
    expect(fitWhy(null)).toBeNull();
    expect(fitWhy(JSON.stringify({ nested: { a: 1 } }))).toBeNull();
  });
  it("botChecks reads an optional bot-supplied list", () => {
    expect(botChecks(JSON.stringify({ whatToCheck: ["Salary band"] }))).toEqual(["Salary band"]);
  });
  const input = {
    status: "pending", emailTo: "a@b.co", contactSource: "posting", fitAnalysis: null,
    cvPdfStale: false, hasCvFile: true, hasLetter: true, gmailConnected: true, sendBlockedReason: null,
  };
  it("chips and checks", () => {
    expect(readinessChips(input).map((c) => c.label)).toEqual(["Email", "CV PDF ready", "Cover letter", "Can send"]);
    expect(whatToCheck(input)).toEqual([]);
    expect(whatToCheck({ ...input, emailTo: null }).join()).toMatch(/No recipient/);
    expect(readinessChips({ ...input, emailTo: null }).map((c) => c.label)).not.toContain("Can send");
  });
  it("never says Can send on a locked, rejected or sent application (review of PR #95)", () => {
    const labels = (o: object) => readinessChips({ ...input, ...o }).map((c) => c.label);
    expect(labels({ status: "approved", sendLocked: true })).toContain("Send result unknown");
    expect(labels({ status: "approved", sendLocked: true })).not.toContain("Can send");
    for (const status of ["rejected", "sent", "changes_requested", "superseded"]) {
      expect(labels({ status })).not.toContain("Can send");
    }
    expect(labels({ status: "approved" })).toContain("Can send");
  });
});

describe("recipient rules (D-041)", () => {
  const U = "https://acme.example/jobs/1";
  it("legacy 3-argument behaviour is unchanged", () => {
    expect(recipientWarning("hr@evil.example", "Acme Corp", U)).toMatch(/does not match/);
    expect(recipientWarning("hr@acme.example", "Acme Corp", U)).toBeNull();
    expect(recipientWarning("x@gmail.com", "Acme Corp", U)).toMatch(/free-mail/);
  });
  it("no source + mismatch: strong warning that says there is no source", () => {
    expect(recipientWarning("hr@evil.example", "Acme Corp", U, null)).toMatch(/No source was recorded/);
  });
  it("a source softens a plain mismatch (no strong warning)", () => {
    expect(recipientWarning("hr@recruit.example", "Acme Corp", U, "https://recruit.example/team")).toBeNull();
  });
  it("free-mail, ATS and agency domains always warn, even with a source", () => {
    expect(recipientWarning("x@gmail.com", "Acme Corp", U, "posting")).toMatch(/free-mail/);
    expect(recipientWarning("jobs@greenhouse.io", "Acme Corp", U, "posting")).toMatch(/platform or agency/);
    expect(recipientWarning("a@randstad.fr", "Acme Corp", U, "posting")).toMatch(/platform or agency/);
    expect(recipientWarning("hr@", "Acme Corp", U, "posting")).toMatch(/incomplete/);
  });
  it("recipientNote: own site, other site, plain note, none", () => {
    expect(recipientNote("hr@acme.example", "https://careers.acme.example/x")).toMatch(/Found on careers.acme.example/);
    expect(recipientNote("hr@acme.example", "https://other.example/x")).toMatch(/differs/);
    expect(recipientNote("hr@acme.example", "the job posting")).toBe("Source: the job posting.");
    expect(recipientNote("hr@acme.example", null)).toBeNull();
  });
});

describe("prompts (D-041)", () => {
  it("per-job prompt tells the bot to pass contact_source and where to review", () => {
    const p = buildClaudePrompt({ jobId: "j" });
    expect(p).toContain("contact_source");
    expect(p).toContain("open Review in the app");
    expect(buildClaudePrompt({ jobId: "j", appUrl: "https://app.example/" })).toContain(
      "Review it at https://app.example/dashboard/review.",
    );
  });
  it("reviewPointer never invents a URL", () => {
    expect(reviewPointer("  ")).toBe("Then open Review in the app.");
  });
  it("change-requests prompt: uses the tool, never sends", () => {
    const p = buildChangeRequestsPrompt();
    expect(p).toContain("list_change_requests");
    expect(p).toContain("--revision");
    expect(p).toMatch(/never send email/i);
    expect(p).not.toMatch(/send the email/i);
  });
  it("refresh-and-prepare: capped, grades A/B, reports a table, never sends", () => {
    const p = buildRefreshAndPreparePrompt();
    expect(p).toContain(`at most ${REFRESH_AND_PREPARE_CAP}`);
    expect(REFRESH_AND_PREPARE_CAP).toBe(5);
    expect(p).toContain("A or B");
    expect(p).toContain("table");
    expect(p).toContain("contact_source");
    expect(p).toMatch(/Do NOT send any email/);
    expect(buildRefreshAndPreparePrompt({ max: 3 })).toContain("at most 3");
    expect(buildRefreshAndPreparePrompt({ max: 0 })).toContain("at most 1");
  });
});

describe("navGuard (reload, links, Back)", () => {
  function Host({ dirty }: { dirty: boolean }) {
    useNavGuard(dirty, "Discard?");
    return <a href="/elsewhere">go</a>;
  }
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("does nothing while clean", () => {
    const push = vi.spyOn(window.history, "pushState");
    render(<Host dirty={false} />);
    expect(push).not.toHaveBeenCalled();
  });

  it("Back with unsaved edits asks; declining stays (sentinel pushed again), confirming goes back", () => {
    const push = vi.spyOn(window.history, "pushState");
    const back = vi.spyOn(window.history, "back").mockImplementation(() => {});
    const confirm = vi.spyOn(window, "confirm");
    render(<Host dirty />);
    expect(push).toHaveBeenCalledTimes(1);

    confirm.mockReturnValueOnce(false);
    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(confirm).toHaveBeenCalledWith("Discard?");
    expect(push).toHaveBeenCalledTimes(2);
    expect(back).not.toHaveBeenCalled();

    confirm.mockReturnValueOnce(true);
    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(back).toHaveBeenCalledTimes(1);
  });

  it("reload / tab close is blocked while dirty and not after", () => {
    const { rerender } = render(<Host dirty />);
    const ev = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    rerender(<Host dirty={false} />);
    const ev2 = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(ev2);
    expect(ev2.defaultPrevented).toBe(false);
  });

  it("saved (clean again) while the sentinel is current: it is removed, so Back needs no extra press", () => {
    const back = vi.spyOn(window.history, "back").mockImplementation(() => {});
    const { rerender } = render(<Host dirty />);
    rerender(<Host dirty={false} />);
    expect(back).toHaveBeenCalledTimes(1);
  });

  it("after a confirmed Back, the guard's own history.back() does not ask a second time", () => {
    const back = vi.spyOn(window.history, "back").mockImplementation(() => {});
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<Host dirty />);
    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    // The popstate of the guard's own back() arrives while it is still mounted.
    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(back).toHaveBeenCalledTimes(1);
  });

  it("an in-app link asks first", () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<Host dirty />);
    const swallow = (e: Event) => e.preventDefault();
    document.addEventListener("click", swallow);
    const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
    screen.getByText("go").dispatchEvent(ev);
    document.removeEventListener("click", swallow);
    expect(window.confirm).toHaveBeenCalledWith("Discard?");
    expect(ev.defaultPrevented).toBe(true);
  });
});

void fireEvent;
