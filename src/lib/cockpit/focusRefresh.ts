// Refresh on return to the tab (D-041): the owner pastes a prompt into Claude,
// switches back, and the queue should already show what the bot submitted.
// Pure throttle: the hook wires it to focus / visibilitychange.

export const FOCUS_REFRESH_MIN_MS = 15_000;

// Returns a function that runs `fn` at most once per `minMs`. The page was just
// loaded, so the first window counts from creation. `true` = it ran.
export function createThrottle(
  fn: () => void,
  minMs: number = FOCUS_REFRESH_MIN_MS,
  now: () => number = Date.now,
): () => boolean {
  let last = now();
  return () => {
    const t = now();
    if (t - last < minMs) return false;
    last = t;
    fn();
    return true;
  };
}
