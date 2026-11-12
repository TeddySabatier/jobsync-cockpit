// Local autosave of an edit in progress (D-041). Browser storage only: a phone
// that kills the tab, or a Back gesture, must not lose a letter. Every access
// is in try/catch (private windows, blocked or full storage): the form works
// without it. The key carries the package id AND its updatedAt, so a draft made
// against an older version of the package is never restored over newer content.

export type EditDraft = {
  values: { emailTo: string; emailSubject: string; emailBody: string; letterMd: string };
  cv: Record<string, unknown> | null;
  savedAt: number;
};

const PREFIX = "cockpit-edit-draft:";
// A draft is a convenience, not an archive.
export const DRAFT_MAX_CHARS = 600_000;
export const DRAFT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export const draftKey = (packageId: string, updatedAt: Date | string | number) =>
  `${PREFIX}${packageId}:${new Date(updatedAt).getTime()}`;

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;

function store(): Store | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

const isStr = (v: unknown): v is string => typeof v === "string";

function valid(v: unknown): v is EditDraft {
  if (!v || typeof v !== "object") return false;
  const d = v as Record<string, unknown>;
  const val = d.values as Record<string, unknown> | undefined;
  return (
    !!val &&
    isStr(val.emailTo) &&
    isStr(val.emailSubject) &&
    isStr(val.emailBody) &&
    isStr(val.letterMd) &&
    (d.cv === null || (typeof d.cv === "object" && !Array.isArray(d.cv))) &&
    typeof d.savedAt === "number"
  );
}

export function loadDraft(key: string, now: number = Date.now()): EditDraft | null {
  const s = store();
  if (!s) return null;
  try {
    const raw = s.getItem(key);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!valid(parsed) || now - parsed.savedAt > DRAFT_MAX_AGE_MS) {
      s.removeItem(key);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

// Returns whether it was stored (false: storage refused or too large).
export function saveDraft(key: string, draft: Omit<EditDraft, "savedAt">, now: number = Date.now()): boolean {
  const s = store();
  if (!s) return false;
  try {
    const text = JSON.stringify({ ...draft, savedAt: now });
    if (text.length > DRAFT_MAX_CHARS) return false;
    s.setItem(key, text);
    return true;
  } catch {
    return false;
  }
}

export function clearDraft(key: string): void {
  try {
    store()?.removeItem(key);
  } catch {
    // ignore
  }
}

// Drops the drafts of the same package made against other versions of it
// (the package was saved or changed since), and expired ones.
export function pruneDrafts(packageId: string, keepKey: string, now: number = Date.now()): void {
  const s = store();
  if (!s) return;
  try {
    const stale: string[] = [];
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i);
      if (!k || !k.startsWith(PREFIX) || k === keepKey) continue;
      if (k.startsWith(`${PREFIX}${packageId}:`)) {
        stale.push(k);
        continue;
      }
      try {
        const parsed: unknown = JSON.parse(s.getItem(k) ?? "null");
        if (!valid(parsed) || now - parsed.savedAt > DRAFT_MAX_AGE_MS) stale.push(k);
      } catch {
        stale.push(k);
      }
    }
    for (const k of stale) s.removeItem(k);
  } catch {
    // ignore
  }
}
