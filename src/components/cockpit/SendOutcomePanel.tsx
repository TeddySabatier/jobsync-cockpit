"use client";
import { useEffect, useState } from "react";
import { ExternalLink } from "lucide-react";
import {
  markSendUnknownAsSent,
  releaseSendLock,
} from "@/actions/cockpitSend.actions";
import type { CockpitResult } from "@/lib/cockpit/errors";
import { STALE_LOCK_MS } from "@/lib/cockpit/constants";
import { cn } from "@/lib/utils";
import { Button, buttonVariants } from "@/components/ui/button";
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
import { runAction } from "./runAction";

type Confirm = "sent" | "release" | null;

// The Gmail Sent folder of the account that is signed in in the browser.
export const GMAIL_SENT_URL = "https://mail.google.com/mail/u/0/#sent";

// Locked approved package (SPEC §5.3): "Sending…" for the first 60 s, then the
// recovery panel. `sendOutcome === "unknown"` shows the panel immediately.
export default function SendOutcomePanel({
  packageId,
  sendStartedAt,
  sendOutcome,
}: {
  packageId: string;
  sendStartedAt: Date | string;
  sendOutcome: string | null;
}) {
  const staleAt = new Date(sendStartedAt).getTime() + STALE_LOCK_MS;
  const [now, setNow] = useState(() => Date.now());
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [busy, setBusy] = useState(false);
  // Phone: the explanation sits behind a "Why?" toggle (the bar is sticky and
  // tall); from md up it is always shown.
  const [why, setWhy] = useState(false);

  const unresolved = sendOutcome === "unknown" || now > staleAt;
  useEffect(() => {
    if (unresolved) return;
    const t = setTimeout(() => setNow(Date.now()), Math.max(staleAt - Date.now(), 0) + 50);
    return () => clearTimeout(t);
  }, [unresolved, staleAt]);

  if (!unresolved) {
    return (
      <p role="status" className="py-3 text-sm text-muted-foreground">
        Sending… This package is locked until the send finishes.
      </p>
    );
  }

  const run = (fn: () => Promise<CockpitResult<unknown>>, success: string) =>
    runAction(fn, { success, setBusy, onSettled: () => setConfirm(null) });

  return (
    <div
      role="region"
      aria-label="Send outcome"
      className="sticky bottom-0 z-10 flex flex-col gap-2 border-t bg-background py-3"
    >
      {/* role=status, not alert: this message is static and is on screen at
          every visit of a locked package. Alert is for post-action failures. */}
      <p role="status" className="text-sm font-medium">
        Check your Gmail Sent folder — the send result is unknown.
      </p>
      <p
        id="send-outcome-why"
        className={cn("text-sm text-muted-foreground", !why && "hidden md:block")}
      >
        If the email is there, mark it as sent. If it is not, unblock it
        (the email was not sent) so the package is approved again. The package
        stays locked until you choose.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          className="min-h-11 md:min-h-9"
          disabled={busy}
          onClick={() => setConfirm("sent")}
        >
          Mark as sent (manual)
        </Button>
        <Button
          variant="outline"
          className="min-h-11 md:min-h-9"
          disabled={busy}
          onClick={() => setConfirm("release")}
        >
          Not sent: unblock
        </Button>
        <a
          href={GMAIL_SENT_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex min-h-11 items-center gap-1 text-sm underline md:min-h-9"
        >
          <ExternalLink aria-hidden className="h-3.5 w-3.5" />
          Open Gmail Sent
        </a>
        <button
          type="button"
          aria-expanded={why}
          aria-controls="send-outcome-why"
          onClick={() => setWhy((w) => !w)}
          className="inline-flex min-h-11 items-center text-sm underline md:hidden"
        >
          {why ? "Hide" : "Why?"}
        </button>
      </div>

      <AlertDialog open={confirm !== null} onOpenChange={(o) => !o && !busy && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirm === "sent" ? "Mark as sent (manual)" : "Unblock sending"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirm === "sent"
                ? "Only do this if the email is in your Gmail Sent folder. The package becomes sent and the job becomes applied."
                : "Only do this if the email is NOT in your Gmail Sent folder. Sending again would otherwise apply twice."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              className={cn(
                confirm === "release" && buttonVariants({ variant: "destructive" }),
              )}
              onClick={(e) => {
                e.preventDefault();
                if (confirm === "sent") {
                  void run(() => markSendUnknownAsSent(packageId), "Marked as sent");
                } else {
                  void run(() => releaseSendLock(packageId), "Lock released");
                }
              }}
            >
              {confirm === "sent" ? "Mark as sent" : "Unblock sending"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
