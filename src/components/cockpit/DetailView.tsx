"use client";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Info } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { formatUrl } from "@/lib/utils";
import ActionBar from "./ActionBar";
import EditForm, { canEditPackage, DISCARD_MESSAGE } from "./EditForm";
import {
  CvPanel,
  EmailPanel,
  FitPanel,
  LetterPanel,
  PostingPanel,
  PreviousReviewInfo,
  type PackageDetail,
} from "./Panels";
import FitGradeBadge from "./FitGradeBadge";
import { statusLabel } from "./statusLabels";
import { useQueueKeys } from "./useQueueKeys";

// Plain sentence for a version that is not the active one. Never the raw status.
function versionNote(version: number, status: string): string {
  switch (status) {
    case "superseded":
      return `Viewing v${version}, which a newer version replaced.`;
    case "sent":
      return `Viewing v${version}, which was sent.`;
    case "rejected":
      return `Viewing v${version}, which was rejected.`;
    default:
      return `Viewing v${version} (${statusLabel(status)}).`;
  }
}

export type Adjacent = { previousId: string | null; nextId: string | null };

export default function DetailView({
  detail,
  adjacent,
}: {
  detail: PackageDetail;
  adjacent: Adjacent;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [wasEditing, setWasEditing] = useState(false);
  const dirtyRef = useRef(false);
  const onDirtyChange = useCallback((d: boolean) => {
    dirtyRef.current = d;
  }, []);
  const headingRef = useRef<HTMLHeadingElement>(null);
  // The remounted ActionBar has taken focus (its effect runs before this one):
  // later remounts must not take it again.
  useEffect(() => {
    if (wasEditing && !editing) setWasEditing(false);
  }, [wasEditing, editing]);
  // j / k must not navigate away from unsaved edits.
  useQueueKeys(editing ? { previousId: null, nextId: null } : adjacent);

  const { package: pkg, versions, activePackageId, isActive } = detail;
  const canEdit = canEditPackage(detail);
  const activeVersion = versions.find((v) => v.id === activePackageId);

  // After a successful Send the action bar disappears (status sent) and the
  // focused Send button with it: move focus to the page heading.
  const prevStatus = useRef(pkg.status);
  useEffect(() => {
    if (prevStatus.current !== "sent" && pkg.status === "sent") headingRef.current?.focus();
    prevStatus.current = pkg.status;
  }, [pkg.status]);

  return (
    <div className="flex flex-col gap-4 py-4">
      <header className="flex flex-col gap-2">
        <Link
          href="/dashboard/review"
          className="text-sm text-muted-foreground hover:text-foreground"
        >
          ← Review queue
        </Link>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <h1 ref={headingRef} tabIndex={-1} className="truncate text-xl font-semibold outline-none">
              {pkg.job.Company.label}
            </h1>
            <p className="truncate text-sm text-muted-foreground">
              {pkg.job.JobTitle.label}
              {pkg.job.jobUrl && (
                <>
                  {" · "}
                  <a
                    href={formatUrl(pkg.job.jobUrl)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline"
                  >
                    Job posting
                  </a>
                </>
              )}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {pkg.fitGrade && <FitGradeBadge grade={pkg.fitGrade} />}
            <Badge variant="secondary">{statusLabel(pkg.status)}</Badge>
            {pkg.cvPdfStale && <Badge variant="outline">PDF stale</Badge>}
            <select
              aria-label="Version"
              value={pkg.id}
              onChange={(e) => {
                // A controlled select: declining keeps the current version.
                if (editing && dirtyRef.current && !window.confirm(DISCARD_MESSAGE)) return;
                router.push(`/dashboard/review/${e.target.value}`);
              }}
              className="h-9 rounded-md border bg-background px-2 text-sm"
            >
              {versions.map((v) => (
                <option key={v.id} value={v.id}>
                  {`v${v.version} · ${statusLabel(v.status)}`}
                </option>
              ))}
            </select>
          </div>
        </div>
      </header>

      {!isActive && (
        <Alert data-testid="version-banner">
          <Info />
          <AlertDescription className="font-medium">
            {`${versionNote(pkg.version, pkg.status)} `}
            {activeVersion && activePackageId ? (
              <>
                <Link
                  href={`/dashboard/review/${activePackageId}`}
                  className="underline"
                >
                  {`Open v${activeVersion.version}`}
                </Link>
                {" to act."}
              </>
            ) : (
              "There is no active version."
            )}
          </AlertDescription>
        </Alert>
      )}

      <PreviousReviewInfo pkg={pkg} />

      {editing && canEdit ? (
        <EditForm
          detail={detail}
          onClose={() => {
            setEditing(false);
            setWasEditing(true);
          }}
          onDirtyChange={onDirtyChange}
        />
      ) : (
        <>
          <div className="grid grid-cols-1 gap-4 @3xl/main:grid-cols-2">
            <PostingPanel pkg={pkg} />
            <CvPanel detail={detail} />
            <FitPanel pkg={pkg} />
            <EmailPanel detail={detail} />
            <div className="@3xl/main:col-span-2">
              <LetterPanel pkg={pkg} fileName={detail.letterAttachment?.fileName} />
            </div>
          </div>

          {(adjacent.previousId || adjacent.nextId) && (
            <p className="hidden text-xs text-muted-foreground md:block">
              j / k: next / previous in To do
            </p>
          )}

          {isActive && (
            <ActionBar
              detail={detail}
              onEdit={canEdit ? () => setEditing(true) : undefined}
              focusEditOnMount={wasEditing}
            />
          )}
        </>
      )}
    </div>
  );
}
