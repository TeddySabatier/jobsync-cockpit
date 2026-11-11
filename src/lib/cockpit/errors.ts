import { log } from "@/lib/telemetry";

// Cockpit result shape and fixed error messages (cockpit/SPEC.md §1 P6).
// `message` always comes from COCKPIT_ERROR_MESSAGES, never from error.message,
// so Prisma or Google error text cannot reach a client.

export const COCKPIT_ERROR_MESSAGES = {
  // MCP tool and domain codes
  UNAUTHORIZED_SCOPE: "The token is missing the scope required for this tool",
  VALIDATION: "The input is invalid",
  NOT_FOUND: "Not found",
  FILE_NOT_FOUND: "The attached file was not found",
  ALREADY_SENT: "An application for this job was already sent",
  JOB_REJECTED: "This job was rejected and no longer accepts packages",
  INVALID_STATE: "The package is not in a state that allows this action",
  CONFLICT: "The package or job changed, or a send is in progress; fetch the current state and retry the whole request",
  TOO_LARGE: "The content is too large",
  RATE_LIMITED: "Too many requests; try again later",
  // Action-side codes
  UNAUTHENTICATED: "Not authenticated",
  COCKPIT_DISABLED: "Cockpit is disabled",
  INTERNAL: "Something went wrong",
  SEND_OUTCOME_UNKNOWN:
    "The send result is unknown; check your Gmail Sent folder",
  GMAIL_TOKEN: "Could not get a Gmail access token",
  GMAIL_SEND: "Gmail rejected the message",
  GMAIL_RECONNECT_REQUIRED: "Reconnect Gmail in the cockpit settings",
  GMAIL_TIMEOUT: "Gmail did not answer in time",
} as const;

export type CockpitErrorCode = keyof typeof COCKPIT_ERROR_MESSAGES;

export type CockpitResult<T> =
  | { success: true; data: T }
  | { success: false; code: CockpitErrorCode; message: string };

export class CockpitError extends Error {
  readonly code: CockpitErrorCode;
  // HTTP status of a failed Google call (never the body).
  readonly status?: number;
  // Gmail errors only: true = nothing was sent, false = the message may have
  // been sent (SPEC §6.4).
  readonly definitive?: boolean;

  constructor(
    code: CockpitErrorCode,
    opts?: { status?: number; definitive?: boolean },
  ) {
    super(COCKPIT_ERROR_MESSAGES[code]);
    this.name = "CockpitError";
    this.code = code;
    this.status = opts?.status;
    this.definitive = opts?.definitive;
  }
}

// requireUser() throws exactly this message for an anonymous caller.
const NOT_AUTHENTICATED = "Not authenticated";

export function toActionResult(err: unknown): CockpitResult<never> {
  let code: CockpitErrorCode;
  if (err instanceof CockpitError) {
    code = err.code;
  } else if (err instanceof Error && err.message === NOT_AUTHENTICATED) {
    code = "UNAUTHENTICATED";
  } else {
    code = "INTERNAL";
    // Code only: the error text may carry Prisma or user data.
    log.error("cockpit: unexpected error", { code });
  }
  return { success: false, code, message: COCKPIT_ERROR_MESSAGES[code] };
}
