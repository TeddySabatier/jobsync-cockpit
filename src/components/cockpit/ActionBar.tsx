"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { MoreHorizontal } from "lucide-react";
import {
  approvePackage,
  markPackageAppliedManually,
  rejectPackage,
  requestPackageChanges,
  unapprovePackage,
} from "@/actions/cockpit.actions";
import type { CockpitResult } from "@/lib/cockpit/errors";
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
import EditRerender from "./EditRerender";
import type { PackageDetail } from "./Panels";
import SendDialog from "./SendDialog";
import SendOutcomePanel from "./SendOutcomePanel";
import { runAction } from "./runAction";
import TextDialog from "./TextDialog";

type DialogKind = "reject" | "changes" | "applied" | null;

// Why an approved package cannot be sent yet (SPEC §5.3), in priority order.
export function sendBlockedReason(detail: PackageDetail): string | null {
  const pkg = detail.package;
  if (pkg.cvPdfStale) return "The CV PDF is out of date. Ask the bot to re-render.";
  if (!pkg.cvFileId || !detail.attachment) return "No CV file is attached.";
  if (!detail.gmail) return "Gmail is not connected. Connect it in settings.";
  // Send would refuse with "Reconnect Gmail" for this (D-023): say why instead.
  if (!detail.gmailSendAllowed) {
    return "Sending is only allowed from the address configured for the cockpit. Connect that address in settings.";
  }
  return null;
}

// Sticky action bar (SPEC §5.3). Hidden entirely on non-active versions by the
// caller. One primary CTA per state; the rest are secondary. Hosts the Send
// button, its dialog and (when locked) the send-outcome panel.
export default function ActionBar({
  detail,
  onEdit,
  focusEditOnMount,
}: {
  detail: PackageDetail;
  onEdit?: () => void;
  // Set when the bar comes back after leaving edit mode: focus goes to Edit.
  focusEditOnMount?: boolean;
}) {
  const pkg = detail.package;
  const [dialog, setDialog] = useState<DialogKind>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sendOpen, setSendOpen] = useState(false);

  const editRef = useRef<HTMLButtonElement>(null);
  const regionRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!focusEditOnMount) return;
    // Edit is not visible at narrow widths (it is in the sheet): fall back to
    // the region so focus is not left on <body>.
    editRef.current?.focus();
    if (document.activeElement !== editRef.current) regionRef.current?.focus();
  }, [focusEditOnMount]);

  const isOpenStatus = pkg.status === "pending" || pkg.status === "approved";

  if (pkg.status === "changes_requested") {
    return (
      <p className="py-3 text-sm text-muted-foreground">
        Waiting for the bot to resubmit with your requested changes.
      </p>
    );
  }
  if (!isOpenStatus) return null;
  if (pkg.sendStartedAt) {
    return (
      <SendOutcomePanel
        packageId={pkg.id}
        sendStartedAt={pkg.sendStartedAt}
        sendOutcome={pkg.sendOutcome}
      />
    );
  }

  const company = pkg.job.Company.label;
  const role = pkg.job.JobTitle.label;
  const jobUrl = pkg.job.jobUrl?.trim() || null;
  const linkApply = !pkg.emailTo?.trim();

  const run = (fn: () => Promise<CockpitResult<unknown>>, success: string) =>
    runAction(fn, {
      success,
      setBusy,
      onSuccess: () => {
        setDialog(null);
        setSheetOpen(false);
      },
    });

  const pickDialog = (kind: Exclude<DialogKind, null>) => {
    setSheetOpen(false);
    setDialog(kind);
  };

  let primary: React.ReactNode = null;
  let reason: React.ReactNode = null;
  if (pkg.status === "pending") {
    primary = (
      <Button
        disabled={busy}
        onClick={() => run(() => approvePackage(pkg.id), "Package approved")}
      >
        Approve
      </Button>
    );
  } else if (linkApply) {
    if (jobUrl) {
      primary = (
        <Button asChild>
          <a href={formatUrl(jobUrl)} target="_blank" rel="noopener noreferrer">
            Open job posting
          </a>
        </Button>
      );
    }
  } else {
    const blocked = sendBlockedReason(detail);
    if (blocked) {
      reason = (
        <p className="text-sm text-muted-foreground">
          {blocked}
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
    } else {
      primary = (
        <Button className="w-full @md/main:w-auto" disabled={busy} onClick={() => setSendOpen(true)}>
          Send
        </Button>
      );
    }
  }

  const secondary = (
    <>
      {pkg.status === "approved" && (
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => run(() => unapprovePackage(pkg.id), "Package unapproved")}
        >
          Unapprove
        </Button>
      )}
      {onEdit && (
        <Button ref={editRef} variant="outline" disabled={busy} onClick={onEdit}>
          Edit
        </Button>
      )}
      <Button variant="outline" disabled={busy} onClick={() => pickDialog("reject")}>
        Reject
      </Button>
      <Button variant="outline" disabled={busy} onClick={() => pickDialog("changes")}>
        Request changes
      </Button>
    </>
  );

  return (
    <div
      role="region"
      aria-label="Actions"
      ref={regionRef}
      tabIndex={-1}
      className="sticky bottom-0 z-10 flex flex-col gap-2 border-t bg-background py-3"
    >
      {reason}
      {pkg.cvPdfStale && (
        <div>
          <EditRerender packageId={pkg.id} />
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {primary}
        {/* Wide containers: secondary buttons inline, Mark applied in the overflow menu. */}
        <div className="hidden items-center gap-2 @md/main:flex">{secondary}</div>
        {linkApply && (
          <div className="hidden @md/main:block">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="icon" aria-label="Overflow menu">
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuItem onSelect={() => setDialog("applied")}>
                  Mark applied manually
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )}
        {/* Narrow containers: everything secondary goes into one sheet. */}
        <div className="@md/main:hidden">
          <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
            <SheetTrigger asChild>
              <Button variant="outline">More</Button>
            </SheetTrigger>
            <SheetContent side="bottom">
              <SheetHeader>
                <SheetTitle>More actions</SheetTitle>
                <SheetDescription className="sr-only">
                  Other actions for this package
                </SheetDescription>
              </SheetHeader>
              <div className="mt-4 flex flex-col gap-2 [&>button]:w-full">
                {secondary}
                {linkApply && (
                  <Button variant="outline" onClick={() => pickDialog("applied")}>
                    Mark applied manually
                  </Button>
                )}
              </div>
            </SheetContent>
          </Sheet>
        </div>
      </div>

      <SendDialog detail={detail} open={sendOpen} onOpenChange={setSendOpen} />
      <TextDialog
        open={dialog === "reject"}
        onOpenChange={(o) => !o && setDialog(null)}
        title="Reject this package"
        description="Say why. The reason is kept with the package and the job stays rejected."
        label="Reject reason"
        submitLabel="Reject"
        busy={busy}
        onSubmit={(reasonText) =>
          run(() => rejectPackage(pkg.id, reasonText), "Package rejected")
        }
      />
      <TextDialog
        open={dialog === "changes"}
        onOpenChange={(o) => !o && setDialog(null)}
        title="Request changes"
        description="Tell the bot what to change. It will resubmit a new version."
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
            <AlertDialogTitle>Mark applied manually</AlertDialogTitle>
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
                  "Marked as applied",
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
