"use client";
import { useEffect } from "react";

// Guards unsaved edits against every way of leaving the page (D-041):
//  - reload / tab close: beforeunload;
//  - in-app links (back link, sidebar, "Open vN"): a capture-phase click
//    listener asks before a same-origin link is followed;
//  - the browser Back button / Android back gesture: while dirty, one sentinel
//    history entry sits on top of the page; Back pops it (same URL), popstate
//    asks, and declining pushes the sentinel again so the user stays.
// Confirming lets Back go through: the guard removes its own listener and goes
// back once more.
const SENTINEL = "__cockpitEditGuard";

type Guarded = { [SENTINEL]?: true };

export function useNavGuard(dirty: boolean, message: string) {
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0) return;
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.("a[href]");
      if (!(a instanceof HTMLAnchorElement)) return;
      if (a.target && a.target !== "_self") return;
      if (a.hasAttribute("download") || a.origin !== window.location.origin) return;
      if (a.pathname === window.location.pathname && a.search === window.location.search) return;
      if (!window.confirm(message)) {
        e.preventDefault();
        e.stopPropagation();
      }
    };

    let pushed = false;
    try {
      const state: unknown = window.history.state;
      const next = { ...(state && typeof state === "object" ? state : {}), [SENTINEL]: true };
      window.history.pushState(next, "", window.location.href);
      pushed = true;
    } catch {
      // No history API (or it refused): the other guards still apply.
    }
    let leaving = false;
    const onPopState = () => {
      if (leaving) return;
      if (window.confirm(message)) {
        leaving = true;
        window.history.back();
        return;
      }
      try {
        window.history.pushState(
          { ...(window.history.state ?? {}), [SENTINEL]: true },
          "",
          window.location.href,
        );
      } catch {
        // ignore
      }
    };

    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("click", onClick, true);
    if (pushed) window.addEventListener("popstate", onPopState);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("click", onClick, true);
      window.removeEventListener("popstate", onPopState);
      // Saved or cancelled while the sentinel is still the current entry:
      // remove it, so Back needs no extra press. When the user left through a
      // confirmed link, the state is no longer ours and nothing happens.
      if (pushed && !leaving && (window.history.state as Guarded | null)?.[SENTINEL]) {
        window.history.back();
      }
    };
  }, [dirty, message]);
}
