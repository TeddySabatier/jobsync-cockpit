"use client";
import { useEffect, useMemo } from "react";
import {
  draftKey,
  loadDraft,
  pruneDrafts,
  saveDraft,
  type EditDraft,
} from "@/lib/cockpit/editDraft";

export const DRAFT_SAVE_DELAY_MS = 500;

// The draft that an earlier visit left for this exact version of the package
// (key = id + updatedAt), read once. The form seeds its state from it and shows
// the "Restored unsaved edits" banner.
export function useRestoredDraft(packageId: string, updatedAt: Date | string | number) {
  const key = draftKey(packageId, updatedAt);
  const restored = useMemo(() => loadDraft(key), [key]);
  return { key, restored };
}

// Autosaves the edit form into localStorage while it is dirty (debounced). A
// clean form writes nothing. Drafts of older versions of the package are pruned.
export function useDraftAutosave(
  packageId: string,
  key: string,
  current: { values: EditDraft["values"]; cv: EditDraft["cv"]; dirty: boolean },
) {
  useEffect(() => {
    pruneDrafts(packageId, key);
  }, [packageId, key]);

  useEffect(() => {
    if (!current.dirty) return;
    const t = setTimeout(
      () => saveDraft(key, { values: current.values, cv: current.cv }),
      DRAFT_SAVE_DELAY_MS,
    );
    return () => clearTimeout(t);
  }, [key, current.dirty, current.values, current.cv]);
}
