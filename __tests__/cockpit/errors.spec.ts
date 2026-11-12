// @vitest-environment node
import { log } from "@/lib/telemetry";
import { RequireUserError } from "@/lib/authError";
import {
  CockpitError,
  COCKPIT_ERROR_MESSAGES,
  toActionResult,
  type CockpitErrorCode,
} from "@/lib/cockpit/errors";

vi.mock("@/lib/telemetry", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const SPEC_CODES: CockpitErrorCode[] = [
  "UNAUTHORIZED_SCOPE",
  "VALIDATION",
  "NOT_FOUND",
  "FILE_NOT_FOUND",
  "ALREADY_SENT",
  "JOB_REJECTED",
  "INVALID_STATE",
  "CONFLICT",
  "FOLLOW_UP_NOT_DUE",
  "TOO_LARGE",
  "RATE_LIMITED",
  "UNAUTHENTICATED",
  "COCKPIT_DISABLED",
  "INTERNAL",
  "SEND_OUTCOME_UNKNOWN",
  "GMAIL_TOKEN",
  "GMAIL_SEND",
  "GMAIL_RECONNECT_REQUIRED",
  "GMAIL_TIMEOUT",
  "HISTORY_NOT_RECORDED",
];

describe("cockpit errors", () => {
  it("defines every code of the spec with a non-empty message", () => {
    expect(Object.keys(COCKPIT_ERROR_MESSAGES).sort()).toEqual(
      [...SPEC_CODES].sort(),
    );
    for (const code of SPEC_CODES) {
      expect(COCKPIT_ERROR_MESSAGES[code].length).toBeGreaterThan(0);
    }
    expect(COCKPIT_ERROR_MESSAGES.COCKPIT_DISABLED).toBe("Cockpit is disabled");
  });

  it("TOO_LARGE does not mention a quota (D-013); CONFLICT suits the bot and the owner", () => {
    expect(COCKPIT_ERROR_MESSAGES.TOO_LARGE).not.toMatch(/quota/i);
    expect(COCKPIT_ERROR_MESSAGES.CONFLICT).not.toMatch(/replay/i);
    expect(COCKPIT_ERROR_MESSAGES.CONFLICT).toMatch(/fetch the current state and retry the whole request/);
  });

  it("CockpitError carries the code, the fixed message, status and definitive", () => {
    const e = new CockpitError("GMAIL_SEND", {
      status: 503,
      definitive: false,
    });
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe("GMAIL_SEND");
    expect(e.message).toBe(COCKPIT_ERROR_MESSAGES.GMAIL_SEND);
    expect(e.status).toBe(503);
    expect(e.definitive).toBe(false);
  });

  it("maps a CockpitError to its code and fixed message without logging", () => {
    expect(toActionResult(new CockpitError("CONFLICT"))).toEqual({
      success: false,
      code: "CONFLICT",
      message: COCKPIT_ERROR_MESSAGES.CONFLICT,
    });
    expect(log.error).not.toHaveBeenCalled();
  });

  it("maps the RequireUserError of requireUser to UNAUTHENTICATED", () => {
    expect(toActionResult(new RequireUserError())).toEqual({
      success: false,
      code: "UNAUTHENTICATED",
      message: COCKPIT_ERROR_MESSAGES.UNAUTHENTICATED,
    });
  });

  it("recognises an RequireUserError from a duplicated module by its name", () => {
    const foreign = new Error("anything");
    foreign.name = "RequireUserError";
    expect(toActionResult(foreign)).toMatchObject({ code: "INTERNAL" });
    foreign.message = "Not authenticated";
    expect(toActionResult(foreign)).toMatchObject({ code: "UNAUTHENTICATED" });
  });

  it("does not take next-auth's AuthError (same old name) for an anonymous caller", () => {
    const nextAuth = new Error("Not authenticated");
    nextAuth.name = "AuthError";
    expect(toActionResult(nextAuth)).toMatchObject({ code: "INTERNAL" });
  });

  it("does not recognise the anonymous caller by message text", () => {
    expect(toActionResult(new Error("Not authenticated"))).toMatchObject({
      code: "INTERNAL",
    });
  });

  it("maps an unknown error to INTERNAL; its text is in neither result nor log", () => {
    const secret = "Invalid `prisma.job.findFirst()` invocation SECRET-TEXT";
    const result = toActionResult(new Error(secret));
    expect(result).toEqual({
      success: false,
      code: "INTERNAL",
      message: COCKPIT_ERROR_MESSAGES.INTERNAL,
    });
    expect(JSON.stringify(result)).not.toContain("SECRET-TEXT");
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(vi.mocked(log.error).mock.calls)).not.toContain(
      "SECRET-TEXT",
    );
  });

  it("maps a non-Error throw to INTERNAL", () => {
    expect(toActionResult("boom")).toMatchObject({
      success: false,
      code: "INTERNAL",
    });
  });
});
