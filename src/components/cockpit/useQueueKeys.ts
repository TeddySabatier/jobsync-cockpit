"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { commandFromEvent } from "@/lib/cockpit/keys";

// j / k: next / previous package in the To do queue (SPEC §5.3); ? shows the
// shortcut help. Ignored while focus is in a form field or contenteditable,
// with a modifier held, or while a dialog or menu is open (lib/cockpit/keys.ts).
// Both ids are null off the To do tab, so j / k do nothing there.
export function useQueueKeys(
  {
    previousId,
    nextId,
  }: {
    previousId: string | null;
    nextId: string | null;
  },
  onHelp?: () => void,
) {
  const router = useRouter();
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const cmd = commandFromEvent(e);
      if (cmd === "help") {
        onHelp?.();
        return;
      }
      if (cmd !== "next" && cmd !== "prev") return;
      const id = cmd === "next" ? nextId : previousId;
      if (id) router.push(`/dashboard/review/${id}`);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [router, previousId, nextId, onHelp]);
}
