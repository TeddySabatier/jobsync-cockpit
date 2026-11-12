// Keyboard shortcuts of the review page (SPEC §5.3, D-041). Pure: the hooks feed
// it what the DOM says, the tests pin the rules.

export type KeyCommand = "next" | "prev" | "approve" | "edit" | "reject" | "help";

const KEYS: Record<string, KeyCommand> = {
  j: "next",
  k: "prev",
  a: "approve",
  e: "edit",
  x: "reject",
  "?": "help",
};

export type KeyEventLike = {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
};

// Nothing fires while typing, while a dialog or menu is open, or with a
// modifier held (Ctrl+A is select-all, not Approve). Object.hasOwn: a key named
// "constructor" must not match the prototype.
export function keyCommand(
  e: KeyEventLike,
  ctx: { editable: boolean; dialogOpen: boolean },
): KeyCommand | null {
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  if (ctx.editable || ctx.dialogOpen) return null;
  return Object.hasOwn(KEYS, e.key) ? KEYS[e.key] : null;
}

export function isEditableTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  return (
    el.isContentEditable ||
    el.getAttribute("contenteditable") === "true" ||
    ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName)
  );
}

export function isDialogOpen(): boolean {
  return !!document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"]');
}

// Reads the context from the live document.
export function commandFromEvent(e: KeyboardEvent): KeyCommand | null {
  return keyCommand(e, {
    editable: isEditableTarget(e.target) || isEditableTarget(document.activeElement),
    dialogOpen: isDialogOpen(),
  });
}
