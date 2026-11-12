"use client";
import { useEffect, useRef } from "react";
import { createThrottle, FOCUS_REFRESH_MIN_MS } from "@/lib/cockpit/focusRefresh";

// Runs `onRefresh` when the window regains focus or the tab becomes visible,
// at most once per `minMs`. The callback must be cheap and safe to repeat.
export function useFocusRefresh(onRefresh: () => void, minMs: number = FOCUS_REFRESH_MIN_MS) {
  const ref = useRef(onRefresh);
  ref.current = onRefresh;
  useEffect(() => {
    const run = createThrottle(() => ref.current(), minMs);
    const onFocus = () => {
      run();
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") run();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [minMs]);
}
