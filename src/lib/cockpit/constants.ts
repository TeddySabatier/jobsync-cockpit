// Client-safe cockpit constants (send.ts is server-only, so a component cannot
// import from it).

// A send lock older than this, with no outcome, is treated as stale: 20 s Gmail
// timeout + margin (SPEC §6.4 "Stale lock"). A test keeps it equal to the
// STALE_LOCK_MS of send.ts.
export const STALE_LOCK_MS = 60_000;
