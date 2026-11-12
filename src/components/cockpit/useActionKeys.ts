"use client";
import { useEffect, useRef } from "react";
import { commandFromEvent } from "@/lib/cockpit/keys";

// a / e / x on the review page (D-041). The action bar owns the dialogs, so it
// registers the handlers; an undefined handler means "not available in this
// state" and the key does nothing. Same guards as j / k (lib/cockpit/keys.ts).
export function useActionKeys(handlers: {
  approve?: () => void;
  edit?: () => void;
  reject?: () => void;
}) {
  // Always the latest handlers without re-registering the listener.
  const ref = useRef(handlers);
  ref.current = handlers;
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.repeat) return;
      const cmd = commandFromEvent(e);
      if (cmd !== "approve" && cmd !== "edit" && cmd !== "reject") return;
      const fn = ref.current[cmd];
      if (!fn) return;
      e.preventDefault();
      fn();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);
}
