"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { formatDistanceToNow } from "date-fns";
import { MoreHorizontal } from "lucide-react";
import {
  approvePackage,
  markPackageAppliedManually,
  rejectPackage,
  reopenPackage,
  requestPackageChanges,
  unapprovePackage,
} from "@/actions/cockpit.actions";
import type { CockpitResult } from "@/lib/cockpit/errors";
import { advanceMessage, pickAdvanceTarget, type AdjacentIds } from "@/lib/cockpit/advance";
import { nextStep } from "@/lib/cockpit/nextStep";
import { sendBlockedReason } from "@/lib/cockpit/sendBlocked";
import { toastWithAction } from "@/lib/toast";
import { formatUrl } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { ChangeRequestsPromptButton } from "./ChangeRequestsPromptButton";
import EditRerender from "./EditRerender";
import type { PackageDetail } from "./Panels";
import RejectDialog from "./RejectDialog";
import SendDialog from "./SendDialog";
import SendOutcomePanel from "./SendOutcomePanel";
import { runAction } from "./runAction";
import TextDialog from "./TextDialog";
import { useActionKeys } from "./useActionKeys";

type DialogKind = "reject" | "changes" | "applied" | null;

// Kept here for existing importers; the rule lives in lib/cockpit/sendBlocked.ts.
export { sendBlockedReason };

const NO_ADJACENT: AdjacentIds = { previousId: null, nextId: null };

// Reject is a destructive action: red outline (dark-mode contrast included).
const REJECT_CLASS =
  "h-11 border-destructive/50 text-destructive hover:bg-destructive/10 hover:text-destructive dark:text-red-400 dark:border-red-400/50 @md/main:ml-auto";

// Sticky action bar (SPEC §5.3). Hidden entirely on non-active versions by the
// caller. One primary per stage (lib/cockpit/nextStep.ts), the rest secondary.
// Hosts the Send dialog, the send-outcome panel (when locked), and moves on to
// the next application after Send / Mark applied / Reject (D-041).
export default function ActionBar({
  detail,
  onEdit,
  focusEditOnMount,
  adjacent = NO_ADJACENT,
}: {
  detail: PackageDetail;
  onEdit?: () => void;
  // Set when the bar comes back after leaving edit mode: focus goes to Edit.
  focusEditOnMount?: boolean;
  // To do neighbours of this application, for auto-advance.
  adjacent?: AdjacentIds;
}) {
  const pkg = detail.package;
  const router = useRouter();
  const [dialog, setDialog] = useState<DialogKind>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sendOpen, setSendOpen] = useState(false);
  // "Approve and send...": the dialog opens once the approval is on the page,
  // so Send runs against the fresh updatedAt (the dialog reads `detail`).
  const [sendAfterApprove, setSendAfterApprove] = useState(false);

  const editRef = useRef<HTMLButtonElement>(null);
  const regionRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!focusEditOnMount) return;
    // Edit is not visible at narrow widths (it is in the sheet): fall back to
    // the region so focus is not left on <body>.
    editRef.current?.focus();
    if (document.activeElement !== editRef.current) regionRef.current?.focus();
  }, [focusEditOnMount]);

  useEffect(() => {
    if (!sendAfterApprove) return;
    if (pkg.status === "approved" && !pkg.sendStartedAt) {
      setSendAfterApprove(false);
      setSendOpen(true);
      return;
    }
    // The refreshed page never arrived: do not open a dialog out of the blue later.
    const t = setTimeout(() => setSendAfterApprove(false), 10_000);
    return () => clearTimeout(t);
  }, [sendAfterApprove, pkg.status, pkg.sendStartedAt]);

  const company = pkg.job.Company.label;
  const role = pkg.job.JobTitle.label;
  const jobUrl = pkg.job.jobUrl?.trim() || null;
  const isFollowUp = detail.kind === "follow_up";
  const noun = isFollowUp ? "Follow-up" : "Application";
  const rawStep = nextStep({
    status: pkg.status,
    sendStarted: !!pkg.sendStartedAt,
    // A follow-up is always an email (D-042): no link-apply path; a missing
    // recipient is a blocked reason instead.
    hasRecipient: isFollowUp || !!pkg.emailTo?.trim(),
    blockedReason: sendBlockedReason(detail),
    hasJobUrl: !!jobUrl,
  });
  // A rejected follow-up skipped its step and cannot be reopened (the server
  // refuses it): nothing left to do here.
  const step: typeof rawStep =
    isFollowUp && rawStep.kind === "reopen" ? { kind: "next" } : rawStep;
  const target = pickAdvanceTarget(adjacent);

  const run = (
    fn: () => Promise<CockpitResult<unknown>>,
    success: string,
    extra?: { onSuccess?: () => void; showSuccess?: () => void },
  ) =>
    runAction(fn, {
      success,
      setBusy,
      showSuccess: extra?.showSuccess,
      onSuccess: () => {
        setDialog(null);
        setSheetOpen(false);
        extra?.onSuccess?.();
      },
    });

  const pickDialog = (kind: Exclude<DialogKind, null>) => {
    setSheetOpen(false);
    setDialog(kind);
  };

  const approveAndSend = () =>
    run(() => approvePackage(pkg.id), `${noun} approved`, {
      onSuccess: () => setSendAfterApprove(true),
    });
  // Approve without sending: reachable from the menu, with a 6 s Undo.
  const approveOnly = () =>
    run(() => approvePackage(pkg.id), `${noun} approved`, {
      showSuccess: () =>
        toastWithAction(`${noun} approved`, {
          label: "Undo",
          onClick: () => void run(() => unapprovePackage(pkg.id), "Approval undone"),
        }),
    });
  const unapprove = () => run(() => unapprovePackage(pkg.id), "Approval undone");
  const reopen = () => run(() => reopenPackage(pkg.id), "Application reopened");

  const actionable =
    step.kind === "approve_and_send" ||
    step.kind === "approve_only" ||
    step.kind === "send" ||
    step.kind === "send_blocked" ||
    step.kind === "link_apply";

  // a / e / x (lib/cockpit/keys.ts): only while this bar offers the action.
  useActionKeys({
    approve:
      busy || !actionable
        ? undefined
        : step.kind === "approve_and_send"
          ? () => void approveAndSend()
          : step.kind === "approve_only"
            ? () => void approveOnly()
            : step.kind === "send"
              ? () => setSendOpen(true)
              : step.kind === "link_apply"
                ? () => setDialog("applied")
                : undefined,
    edit: busy || !actionable ? undefined : onEdit,
    reject: busy || !actionable ? undefined : () => setDialog("reject"),
  });

  if (step.kind === "locked") {
    return (
      <SendOutcomePanel
        packageId={pkg.id}
        sendStartedAt={pkg.sendStartedAt!}
        sendOutcome={pkg.sendOutcome}
      />
    );
  }
  if (step.kind === "none") return null;

  const barClass =
    "sticky bottom-0 z-10 flex flex-col gap-2 border-t bg-background pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] shadow-[0_-4px_8px_rgba(0,0,0,0.12)]";

  if (step.kind === "handle_changes") {
    return (
      <div role="region" aria-label="Actions" className={barClass}>
        <p className="text-sm text-muted-foreground">
          {`Waiting for Claude to answer your change request${
            pkg.changeRequestedAt
              ? ` (asked ${formatDistanceToNow(new Date(pkg.changeRequestedAt), { addSuffix: true })})`
              : ""
          }. Copy the prompt, paste it into Claude, and the new version appears in To do.`}
        </p>
        <div>
          <ChangeRequestsPromptButton className="h-11 gap-2" variant="default" />
        </div>
      </div>
    );
  }
  if (step.kind === "reopen") {
    return (
      <div role="region" aria-label="Actions" className={barClass}>
        <p className="text-sm text-muted-foreground">
          This application was rejected. Reopen it to review it again.
        </p>
        <div>
          <Button className="h-11" disabled={busy} onClick={() => void reopen()}>
            Reopen
          </Button>
        </div>
      </div>
    );
  }
  if (step.kind === "next") {
    return (
      <div role="region" aria-label="Actions" className={barClass}>
        <div>
          <Button asChild className="h-11">
            <Link href={target.href}>Next: back to To do</Link>
          </Button>
        </div>
      </div>
    );
  }

  let primary: React.ReactNode = null;
  let reason: React.ReactNode = null;
  switch (step.kind) {
    case "approve_and_send":
      primary = (
        <Button
          className="h-11 w-full @md/main:w-auto"
          disabled={busy}
          onClick={() => void approveAndSend()}
        >
          Approve and send…
        </Button>
      );
      break;
    case "approve_only":
      primary = (
        <Button
          className="h-11 w-full @md/main:w-auto"
          disabled={busy}
          onClick={() => void approveOnly()}
        >
          Approve
        </Button>
      );
      reason = <BlockedReason text={step.reason} detail={detail} />;
      break;
    case "send":
      primary = (
        <Button
          className="h-11 w-full @md/main:w-auto"
          disabled={busy}
          onClick={() => setSendOpen(true)}
        >
          Send…
        </Button>
      );
      break;
    case "send_blocked":
      reason = <BlockedReason text={step.reason} detail={detail} />;
      break;
    case "link_apply":
      primary = (
        <>
          {jobUrl && (
            <Button asChild className="h-11 flex-1 @md/main:flex-none">
              <a href={formatUrl(jobUrl)} target="_blank" rel="noopener noreferrer">
                Open job posting
              </a>
            </Button>
          )}
          <Button
            variant={jobUrl ? "outline" : "default"}
            className="h-11 flex-1 @md/main:flex-none"
            disabled={busy}
            onClick={() => setDialog("applied")}
          >
            I applied
          </Button>
        </>
      );
      break;
  }

  const approved = pkg.status === "approved";
  const canApproveOnly = step.kind === "approve_and_send";
  const hasMenu = approved || canApproveOnly;

  // Edit and Request changes: next to the primary on wide containers, in the
  // sheet on narrow ones.
  const editButton = onEdit && (
    <Button ref={editRef} variant="outline" className="h-11" disabled={busy} onClick={onEdit}>
      Edit
    </Button>
  );
  const changesButton = (
    <Button variant="outline" className="h-11" disabled={busy} onClick={() => pickDialog("changes")}>
      Request changes
    </Button>
  );
  const rejectButton = (
    <Button variant="outline" className={REJECT_CLASS} disabled={busy} onClick={() => pickDialog("reject")}>
      Reject
    </Button>
  );

  return (
    <div
      role="region"
      aria-label="Actions"
      ref={regionRef}
      tabIndex={-1}
      className={barClass}
    >
      {reason}
      {pkg.cvPdfStale && (
        <div>
          <EditRerender packageId={pkg.id} />
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {primary}
        {/* Wide containers: Edit and Request changes inline, Reject at the far
            end, the rest in the menu. `contents` keeps them in this flex row. */}
        <div className="hidden @md/main:contents">
          {editButton}
          {changesButton}
          {hasMenu && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="icon" className="h-11 w-11" aria-label="Overflow menu">
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                {canApproveOnly && (
                  <DropdownMenuItem onSelect={() => void approveOnly()}>
                    Approve only (send later)
                  </DropdownMenuItem>
                )}
                {approved && (
                  <DropdownMenuItem onSelect={() => void unapprove()}>Unapprove</DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          {rejectButton}
        </div>
        {/* Narrow containers: everything secondary goes into one sheet. */}
        <div className="@md/main:hidden">
          <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
            <SheetTrigger asChild>
              <Button variant="outline" className="h-11">
                More
              </Button>
            </SheetTrigger>
            <SheetContent side="bottom">
              <SheetHeader>
                <SheetTitle>More actions</SheetTitle>
                <SheetDescription className="sr-only">
                  Other actions for this application
                </SheetDescription>
              </SheetHeader>
              <div className="mt-4 flex flex-col gap-2 [&>button]:w-full">
                {editButton}
                {changesButton}
                {canApproveOnly && (
                  <Button variant="outline" className="h-11" disabled={busy} onClick={() => void approveOnly()}>
                    Approve only (send later)
                  </Button>
                )}
                {approved && (
                  <Button variant="outline" className="h-11" disabled={busy} onClick={() => void unapprove()}>
                    Unapprove
                  </Button>
                )}
                {rejectButton}
              </div>
            </SheetContent>
          </Sheet>
        </div>
      </div>

      <SendDialog
        detail={detail}
        open={sendOpen}
        onOpenChange={setSendOpen}
        sentMessage={advanceMessage("Email sent", target)}
        onSent={() => router.push(target.href)}
      />
      <RejectDialog
        open={dialog === "reject"}
        onOpenChange={(o) => !o && setDialog(null)}
        busy={busy}
        onSubmit={(reasonText) =>
          run(
            () => rejectPackage(pkg.id, reasonText || undefined),
            advanceMessage(isFollowUp ? "Follow-up rejected: step skipped" : "Application rejected", target),
            { onSuccess: () => router.push(target.href) },
          )
        }
      />
      <TextDialog
        open={dialog === "changes"}
        onOpenChange={(o) => !o && setDialog(null)}
        title="Request changes"
        description="Tell Claude what to change. It will send back a new version."
        label="Change request"
        submitLabel="Request changes"
        busy={busy}
        onSubmit={(instruction) =>
          run(
            () => requestPackageChanges(pkg.id, instruction),
            "Changes requested",
          )
        }
      />
      <AlertDialog
        open={dialog === "applied"}
        onOpenChange={(o) => !o && setDialog(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Mark as applied</AlertDialogTitle>
            <AlertDialogDescription>
              {`Mark your application to ${role} at ${company} (${jobUrl ?? "no posting URL"}) as applied? No email will be sent.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={(e) => {
                e.preventDefault();
                void run(
                  () => markPackageAppliedManually(pkg.id),
                  advanceMessage("Marked as applied", target),
                  { onSuccess: () => router.push(target.href) },
                );
              }}
            >
              Mark applied
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function BlockedReason({ text, detail }: { text: string; detail: PackageDetail }) {
  return (
    <p className="text-sm text-muted-foreground">
      {text}
      {(!detail.gmail || !detail.gmailSendAllowed) && (
        <>
          {" "}
          <Link href="/dashboard/review/settings" className="underline">
            Open settings
          </Link>
        </>
      )}
    </p>
  );
}
