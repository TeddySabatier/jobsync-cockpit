"use client";
import { useEffect, useState } from "react";
import {
  markSendUnknownAsSent,
  releaseSendLock,
} from "@/actions/cockpitSend.actions";
import type { CockpitResult } from "@/lib/cockpit/errors";
import { toastError, toastSuccess } from "@/lib/toast";
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

// Same value as STALE_LOCK_MS in send.ts (server-only, so not importable here).
const STALE_LOCK_MS = 60_000;

type Confirm = "sent" | "release" | null;

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

  async function run(fn: () => Promise<CockpitResult<unknown>>, success: string) {
    setBusy(true);
    try {
      const r = await fn();
      if (r.success) toastSuccess(success);
      else toastError(r.message);
      setConfirm(null);
    } catch {
      toastError("Request failed. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      role="region"
      aria-label="Send outcome"
      className="sticky bottom-0 z-10 flex flex-col gap-2 border-t bg-background py-3"
    >
      <p role="alert" className="text-sm font-medium">
        Check your Gmail Sent folder — the send result is unknown.
      </p>
      <p className="text-sm text-muted-foreground">
        If the email is there, mark it as sent. If it is not, release the lock to
        make the package approved again. The package stays locked until you choose.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button disabled={busy} onClick={() => setConfirm("sent")}>
          Mark as sent (manual)
        </Button>
        <Button variant="outline" disabled={busy} onClick={() => setConfirm("release")}>
          Release lock
        </Button>
      </div>

      <AlertDialog open={confirm !== null} onOpenChange={(o) => !o && !busy && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirm === "sent" ? "Mark as sent (manual)" : "Release lock"}
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
              onClick={(e) => {
                e.preventDefault();
                if (confirm === "sent") {
                  void run(() => markSendUnknownAsSent(packageId), "Marked as sent");
                } else {
                  void run(() => releaseSendLock(packageId), "Lock released");
                }
              }}
            >
              {confirm === "sent" ? "Mark as sent" : "Release lock"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
