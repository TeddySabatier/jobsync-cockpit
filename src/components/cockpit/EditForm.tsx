"use client";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { updatePackageContent } from "@/actions/cockpit.actions";
import { TipTapContentViewer } from "@/components/TipTapContentViewer";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { collectCvLeaves, setCvLeaf } from "@/lib/cockpit/cvLeaves";
import { renderLetterMarkdown } from "@/lib/cockpit/markdown";
import { UpdatePackageContentInputShape as Shape } from "@/lib/cockpit/schemas";
import type { UpdatePackageContentInput } from "@/lib/cockpit/schemas";
import { toastError, toastSuccess } from "@/lib/toast";
import type { PackageDetail } from "./Panels";

// Edit mode (cockpit/SPEC.md §5.4). Manual edits only, saved through the
// updatePackageContent action; nothing here generates or fills in content.

// Editable only on the active version, in pending/approved, while unlocked
// (SPEC §2.1). The server enforces the same rule; this keeps the UI read-only.
export function canEditPackage(detail: PackageDetail): boolean {
  const { status, sendStartedAt } = detail.package;
  return (
    detail.isActive &&
    !sendStartedAt &&
    (status === "pending" || status === "approved")
  );
}

export type EditValues = {
  emailTo: string;
  emailSubject: string;
  emailBody: string;
  letterMd: string;
};
export type EditErrors = Partial<Record<keyof EditValues, string>>;

// Mirrors the §2.3 zod rules by parsing with the same field schemas.
export function validateEditValues(v: EditValues): EditErrors {
  const errors: EditErrors = {};
  if (!Shape.emailTo.safeParse(v.emailTo).success) {
    errors.emailTo = /[\r\n]/.test(v.emailTo)
      ? "No line break allowed"
      : v.emailTo.includes(",")
        ? "A single address, no comma"
        : "Enter a valid email address, or leave empty to apply via link";
  }
  if (!Shape.emailSubject.safeParse(v.emailSubject).success) {
    errors.emailSubject = !v.emailSubject
      ? "Required"
      : /[\r\n]/.test(v.emailSubject)
        ? "No line break allowed"
        : !v.emailSubject.trim()
          ? "Must not be blank"
          : "At most 300 characters";
  }
  if (!Shape.emailBody.safeParse(v.emailBody).success) {
    errors.emailBody = !v.emailBody
      ? "Required"
      : !v.emailBody.trim()
        ? "Must not be blank"
        : "At most 20,000 characters";
  }
  if (!Shape.letterMd.safeParse(v.letterMd).success) {
    errors.letterMd = "At most 20,000 characters";
  }
  return errors;
}

function parseObject(text: string | null): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const v: unknown = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

const RELOAD_MESSAGE =
  "This package changed since you opened it. Reload to see the latest version; your edits were not saved.";

function Field({
  id,
  label,
  error,
  children,
}: {
  id: string;
  label: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {error && (
        <p id={`${id}-error`} role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

export default function EditForm({
  detail,
  onClose,
}: {
  detail: PackageDetail;
  onClose: () => void;
}) {
  const router = useRouter();
  const pkg = detail.package;
  const original = useMemo<EditValues>(
    () => ({
      emailTo: pkg.emailTo ?? "",
      emailSubject: pkg.emailSubject,
      emailBody: pkg.emailBody,
      letterMd: pkg.letterMd ?? "",
    }),
    [pkg.emailTo, pkg.emailSubject, pkg.emailBody, pkg.letterMd],
  );
  const originalCv = useMemo(() => parseObject(pkg.cvJson), [pkg.cvJson]);

  const [values, setValues] = useState<EditValues>(original);
  const [cv, setCv] = useState<Record<string, unknown> | null>(originalCv);
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(false);

  const leaves = useMemo(() => (cv ? collectCvLeaves(cv) : []), [cv]);
  const cvChanged =
    cv !== originalCv &&
    JSON.stringify(cv) !== JSON.stringify(originalCv);
  const changed = (Object.keys(values) as (keyof EditValues)[]).filter(
    (k) => values[k] !== original[k],
  );
  const dirty = changed.length > 0 || cvChanged;
  const errors = validateEditValues(values);
  const hasErrors = Object.keys(errors).length > 0;
  const letterHtml = useMemo(
    () => renderLetterMarkdown(values.letterMd),
    [values.letterMd],
  );

  // Browser-level guard for reload / tab close; Cancel asks below.
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  const set = (k: keyof EditValues) => (v: string) =>
    setValues((s) => ({ ...s, [k]: v }));

  function cancel() {
    if (dirty && !window.confirm("Discard your unsaved changes?")) return;
    onClose();
  }

  async function save() {
    if (!dirty || hasErrors || busy) return;
    const patch: UpdatePackageContentInput = {};
    for (const k of changed) patch[k] = values[k];
    if (cvChanged && cv) patch.cvJson = cv;
    setBusy(true);
    try {
      // The action has no expectedUpdatedAt; a package that changed under us
      // (superseded, locked, status moved) comes back as INVALID_STATE/CONFLICT.
      const r = await updatePackageContent(pkg.id, patch);
      if (r.success) {
        toastSuccess("Changes saved");
        onClose();
      } else if (r.code === "CONFLICT" || r.code === "INVALID_STATE") {
        setConflict(true);
      } else {
        toastError(r.message);
      }
    } catch {
      toastError("Request failed. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      aria-label="Edit package"
      className="flex flex-col gap-4 py-4"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      {conflict && (
        <div
          role="alert"
          data-testid="edit-conflict"
          className="flex flex-wrap items-center gap-2 rounded-md border border-destructive p-3 text-sm"
        >
          <span>{RELOAD_MESSAGE}</span>
          <Button type="button" variant="outline" onClick={() => router.refresh()}>
            Reload
          </Button>
        </div>
      )}

      <section className="flex flex-col gap-3 rounded-lg border bg-card p-4">
        <h2 className="text-sm font-semibold">Email</h2>
        <Field id="edit-emailTo" label="To" error={errors.emailTo}>
          <Input
            id="edit-emailTo"
            value={values.emailTo}
            maxLength={254}
            placeholder="Empty means apply via link"
            aria-invalid={!!errors.emailTo}
            onChange={(e) => set("emailTo")(e.target.value)}
          />
        </Field>
        <Field id="edit-emailSubject" label="Subject" error={errors.emailSubject}>
          <Input
            id="edit-emailSubject"
            value={values.emailSubject}
            maxLength={300}
            aria-invalid={!!errors.emailSubject}
            onChange={(e) => set("emailSubject")(e.target.value)}
          />
        </Field>
        <Field id="edit-emailBody" label="Body (plain text)" error={errors.emailBody}>
          <Textarea
            id="edit-emailBody"
            rows={10}
            value={values.emailBody}
            aria-invalid={!!errors.emailBody}
            onChange={(e) => set("emailBody")(e.target.value)}
          />
        </Field>
      </section>

      <section className="flex flex-col gap-3 rounded-lg border bg-card p-4">
        <h2 className="text-sm font-semibold">Cover letter</h2>
        <div className="grid grid-cols-1 gap-4 @3xl/main:grid-cols-2">
          <Field id="edit-letterMd" label="Letter (Markdown)" error={errors.letterMd}>
            <Textarea
              id="edit-letterMd"
              rows={14}
              value={values.letterMd}
              aria-invalid={!!errors.letterMd}
              onChange={(e) => set("letterMd")(e.target.value)}
            />
          </Field>
          <div className="flex min-w-0 flex-col gap-1">
            <span className="text-sm font-medium">Preview</span>
            <div
              data-testid="letter-preview"
              className="max-h-96 min-h-24 overflow-auto rounded-md border p-2"
            >
              {letterHtml ? (
                <TipTapContentViewer content={letterHtml} />
              ) : (
                <p className="text-sm text-muted-foreground">No cover letter.</p>
              )}
            </div>
          </div>
        </div>
      </section>

      {cv && leaves.length > 0 && (
        <section
          aria-label="CV data"
          className="flex flex-col gap-3 rounded-lg border bg-card p-4"
        >
          <h2 className="text-sm font-semibold">CV data</h2>
          <p className="text-sm text-muted-foreground">
            Only text can be edited. Saving a change marks the CV PDF out of
            date until the bot re-renders it.
          </p>
          {cvChanged && <Badge variant="outline">PDF will be marked stale</Badge>}
          {leaves.map((leaf) => (
            <div key={leaf.path} className="flex flex-col gap-1">
              <Label htmlFor={`cv-${leaf.path}`} className="font-mono text-xs">
                {leaf.path}
              </Label>
              <Textarea
                id={`cv-${leaf.path}`}
                rows={Math.min(6, Math.max(1, leaf.value.split("\n").length))}
                value={leaf.value}
                onChange={(e) =>
                  setCv(
                    (c) =>
                      setCvLeaf(c, leaf.segments, e.target.value) as Record<
                        string,
                        unknown
                      >,
                  )
                }
              />
            </div>
          ))}
        </section>
      )}

      <div className="sticky bottom-0 z-10 flex gap-2 border-t bg-background py-3">
        <Button type="submit" disabled={!dirty || hasErrors || busy}>
          Save
        </Button>
        <Button type="button" variant="outline" disabled={busy} onClick={cancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
