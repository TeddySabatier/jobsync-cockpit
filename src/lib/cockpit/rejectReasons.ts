// Quick reasons offered when rejecting an application (D-041). Plain strings:
// what is stored is the text, so the chips are only a shortcut for typing.
export const REJECT_REASON_CHIPS = [
  "Not a fit",
  "Wrong location",
  "Salary",
  "Already applied",
  "Other",
] as const;

// Same bound as the server schema (RejectPackageInputShape).
export const TEXT_MAX = 2000;
