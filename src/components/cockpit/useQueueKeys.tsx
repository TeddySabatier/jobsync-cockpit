"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";

// j / k: next / previous package in the To do queue (SPEC §5.3). Ignored while
// focus is in a form field or contenteditable, with a modifier held, or while
// a dialog or menu is open. Both ids are null off the To do tab, so the keys
// do nothing there.
function isEditable(el: EventTarget | null) {
  if (!(el instanceof HTMLElement)) return false;
  return (
    el.isContentEditable ||
    el.getAttribute("contenteditable") === "true" ||
    ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName)
  );
}

export function useQueueKeys({
  previousId,
  nextId,
}: {
  previousId: string | null;
  nextId: string | null;
}) {
  const router = useRouter();
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "j" && e.key !== "k") return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (isEditable(e.target) || isEditable(document.activeElement)) return;
      if (document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"]')) {
        return;
      }
      const id = e.key === "j" ? nextId : previousId;
      if (id) router.push(`/dashboard/review/${id}`);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [router, previousId, nextId]);
}
