"use client";
import { useCallback, useEffect, useState } from "react";
import { useFocusRefresh } from "./useFocusRefresh";

// The To do count shown next to "Review" in the sidebar (D-041). `initial` comes
// from the server render; it is re-counted when the owner returns to the tab
// (the bot may have submitted meanwhile) and when the route changes (an action
// just moved an item). A failed or unsuccessful call keeps the last number.
export function useReviewCount(
  initial: number | undefined,
  action: (() => Promise<{ success: boolean; data?: number }>) | undefined,
  pathname?: string,
): number | undefined {
  const [count, setCount] = useState<number | undefined>(initial);
  useEffect(() => setCount(initial), [initial]);

  const refresh = useCallback(() => {
    if (!action) return;
    action()
      .then((r) => {
        if (r.success && typeof r.data === "number") setCount(r.data);
      })
      .catch(() => {});
  }, [action]);

  useFocusRefresh(refresh);
  useEffect(() => {
    if (action && pathname) refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);
  return count;
}
