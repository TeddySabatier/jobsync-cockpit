"use client";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Info, Reply } from "lucide-react";
import { followUpLabel, formatFollowUpDay } from "@/lib/cockpit/followUpView";
import { FollowUpChip, FollowUpPanel, GmailThreadLink } from "./FollowUpControls";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
  SendHistoryPanel,
  type PackageDetail,
} from "./Panels";
import { statusLabel } from "./statusLabels";
import SummaryStrip from "./SummaryStrip";
import { useQueueKeys } from "./useQueueKeys";
import type { AdjacentIds } from "@/lib/cockpit/advance";

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

export type Adjacent = AdjacentIds;

const SHORTCUTS: [string, string][] = [
  ["j / k", "Next / previous application in To do"],
  ["a", "The main action: Approve and send, Send or I applied (never sends by itself)"],
  ["e", "Edit"],
  ["x", "Reject"],
  ["?", "This help"],
];

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
  const [helpOpen, setHelpOpen] = useState(false);
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
  const showHelp = useCallback(() => setHelpOpen(true), []);
  useQueueKeys(editing ? { previousId: null, nextId: null } : adjacent, editing ? undefined : showHelp);

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

  const company = pkg.job.Company.label;
  const title = pkg.job.JobTitle.label;
  const isFollowUp = detail.kind === "follow_up";
  // The follow-up card: on a follow-up, and on a sent application that has a
  // follow-up state to show (D-042).
  const showFollowUpPanel =
    !!detail.followUp && detail.followUp.reason !== "no_sent_application";

  return (
    <div className="flex flex-col gap-4 py-4">
      <header className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <Link
            href="/dashboard/review"
            className="inline-flex min-h-11 items-center text-sm text-muted-foreground hover:text-foreground md:min-h-0"
          >
            ← Review queue
          </Link>
          {/* Phone: labelled prev / next, since j / k need a keyboard (D-041). */}
          {!editing && (adjacent.previousId || adjacent.nextId) && (
            <div className="flex gap-2 md:hidden">
              {adjacent.previousId ? (
                <Button asChild variant="outline" className="h-11">
                  <Link href={`/dashboard/review/${adjacent.previousId}`}>Previous</Link>
                </Button>
              ) : null}
              {adjacent.nextId ? (
                <Button asChild variant="outline" className="h-11">
                  <Link href={`/dashboard/review/${adjacent.nextId}`}>Next</Link>
                </Button>
              ) : null}
            </div>
          )}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <h1
              ref={headingRef}
              tabIndex={-1}
              title={company}
              className="line-clamp-2 break-words text-xl font-semibold outline-none"
            >
              {company}
            </h1>
            <p title={title} className="line-clamp-2 break-words text-sm text-muted-foreground">
              {title}
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
            {isFollowUp && <FollowUpChip step={detail.followUpStep} />}
            <Badge variant="secondary">{statusLabel(pkg.status)}</Badge>
            {!isFollowUp && pkg.cvPdfStale && <Badge variant="outline">PDF stale</Badge>}
          </div>
        </div>
        <select
          aria-label="Version"
          value={pkg.id}
          onChange={(e) => {
            // A controlled select: declining keeps the current version.
            if (editing && dirtyRef.current && !window.confirm(DISCARD_MESSAGE)) return;
            router.push(`/dashboard/review/${e.target.value}`);
          }}
          className="h-11 w-full rounded-md border bg-background px-2 text-sm sm:h-9 sm:w-auto sm:self-start"
        >
          {versions.map((v) => (
            <option key={v.id} value={v.id}>
              {`v${v.version} · ${statusLabel(v.status)}`}
            </option>
          ))}
        </select>
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

      {isFollowUp && (
        <Alert data-testid="follow-up-banner">
          <Reply />
          <AlertDescription className="flex flex-col gap-1">
            <span className="font-medium">
              {`${followUpLabel(detail.followUpStep)} · Replies to your email of ${
                detail.replyTo?.sentAt ? formatFollowUpDay(detail.replyTo.sentAt) : "an earlier date"
              }`}
            </span>
            {detail.replyTo?.emailSubject && (
              <span className="text-muted-foreground [overflow-wrap:anywhere]">
                {`Original subject: ${detail.replyTo.emailSubject}`}
              </span>
            )}
            <span className="flex flex-wrap items-center gap-x-4">
              <GmailThreadLink url={detail.followUp?.threadUrl ?? null} />
              {detail.replyTo && (
                <Link
                  href={`/dashboard/review/${detail.replyTo.id}`}
                  className="inline-flex min-h-11 items-center text-sm underline md:min-h-0"
                >
                  View the application
                </Link>
              )}
            </span>
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
          {/* Reading order = DOM order: Summary, Email, Letter, CV, Fit, Posting. */}
          {isFollowUp ? (
            // A follow-up is an email only: no CV, letter or fit (D-042).
            <div className="grid grid-cols-1 gap-4 @3xl/main:grid-cols-2">
              <EmailPanel detail={detail} />
              {showFollowUpPanel && detail.followUp && <FollowUpPanel summary={detail.followUp} />}
              <div className="@3xl/main:col-span-2">
                <PostingPanel pkg={pkg} />
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 @3xl/main:grid-cols-2">
              <div className="@3xl/main:col-span-2">
                <SummaryStrip detail={detail} />
              </div>
              {showFollowUpPanel && detail.followUp && (
                <div className="@3xl/main:col-span-2">
                  <FollowUpPanel summary={detail.followUp} />
                </div>
              )}
              <EmailPanel detail={detail} />
              <LetterPanel pkg={pkg} fileName={detail.letterAttachment?.fileName} />
              <CvPanel detail={detail} />
              <FitPanel pkg={pkg} />
              <div className="@3xl/main:col-span-2">
                <PostingPanel pkg={pkg} />
              </div>
            </div>
          )}

          {(adjacent.previousId || adjacent.nextId) && (
            <p className="hidden text-xs text-muted-foreground md:block">
              j / k: next / previous in To do
            </p>
          )}
          <p className="hidden text-xs text-muted-foreground md:block" data-testid="keys-hint">
            {isActive ? "a: main action, e: edit, x: reject, " : ""}?: all shortcuts
          </p>

          <SendHistoryPanel history={detail.sendHistory} />

          {isActive && (
            <ActionBar
              detail={detail}
              onEdit={canEdit ? () => setEditing(true) : undefined}
              focusEditOnMount={wasEditing}
              adjacent={adjacent}
            />
          )}
        </>
      )}

      <Dialog open={helpOpen} onOpenChange={setHelpOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Keyboard shortcuts</DialogTitle>
            <DialogDescription>
              They do nothing while you type in a field or while a dialog is open.
            </DialogDescription>
          </DialogHeader>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
            {SHORTCUTS.map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="font-mono font-medium">{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
        </DialogContent>
      </Dialog>
    </div>
  );
}
