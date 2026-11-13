"use client";
import { useState } from "react";
import { ExternalLink, MoreHorizontal, Reply } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  setApplicationOutcome,
  skipFollowUpStep,
  snoozeFollowUp,
  stopFollowUps,
} from "@/actions/cockpitFollowUps.actions";
import type { CockpitResult } from "@/lib/cockpit/errors";
import {
  canSkipOrSnooze,
  followUpLabel,
  followUpStatusText,
  hasFollowUpMenu,
  type FollowUpSummary,
} from "@/lib/cockpit/followUpView";
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
import { runAction } from "./runAction";

// Follow-up controls (D-042). Nothing here sends: snooze, skip and stop change
// the follow-up state of the job; the outcome toggles record a reply or a
// rejection. Server actions are session-only and not reachable from MCP.

type Run = (fn: () => Promise<CockpitResult<unknown>>, success: string) => Promise<void>;

function useRun(): [boolean, Run] {
  const [busy, setBusy] = useState(false);
  const run: Run = (fn, success) => runAction(fn, { success, setBusy });
  return [busy, run];
}

// "Remind me in 3 / 7 days", "Skip this follow-up" (only for a due or snoozed
// step, D-034 a), "Stop follow-ups".
export function FollowUpMenu({
  summary,
  className = "h-11 w-11",
}: {
  summary: FollowUpSummary;
  className?: string;
}) {
  const [busy, run] = useRun();
  if (!hasFollowUpMenu(summary)) return null;
  const label = followUpLabel(summary.step);
  const snoozable = canSkipOrSnooze(summary);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="icon"
          className={className}
          disabled={busy}
          aria-label="Follow-up options"
          data-testid="follow-up-menu"
        >
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {snoozable && (
          <>
            <DropdownMenuItem
              onSelect={() =>
                void run(() => snoozeFollowUp(summary.jobId, 3), "Reminder set for 3 days")
              }
            >
              Remind me in 3 days
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() =>
                void run(() => snoozeFollowUp(summary.jobId, 7), "Reminder set for 7 days")
              }
            >
              Remind me in 7 days
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => void run(() => skipFollowUpStep(summary.jobId), `${label} skipped`)}
            >
              {`Skip ${label.toLowerCase()}`}
            </DropdownMenuItem>
          </>
        )}
        {!summary.stopped && !summary.outcome && (
          <DropdownMenuItem
            onSelect={() => void run(() => stopFollowUps(summary.jobId), "Follow-ups stopped")}
          >
            Stop follow-ups
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// "Follow-up 1" / "Follow-up 2" on a follow-up row and detail header.
export function FollowUpChip({ step }: { step: number | null | undefined }) {
  return (
    <Badge
      variant="outline"
      data-testid="follow-up-chip"
      className="gap-1 border-sky-500/60 bg-sky-50 text-sky-900 dark:bg-sky-950/40 dark:text-sky-300"
    >
      <Reply aria-hidden className="h-3 w-3" />
      {followUpLabel(step)}
    </Badge>
  );
}

export function GmailThreadLink({ url }: { url: string | null }) {
  if (!url) return null;
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex min-h-11 items-center gap-1 text-sm underline md:min-h-0"
      data-testid="gmail-thread-link"
    >
      Open thread in Gmail
      <ExternalLink aria-hidden className="h-3.5 w-3.5" />
    </a>
  );
}

// The follow-up card of a sent application or a follow-up draft: where things
// stand, the two outcome toggles, the options menu and the Gmail thread link.
export function FollowUpPanel({
  summary,
  showOutcomes = true,
}: {
  summary: FollowUpSummary;
  showOutcomes?: boolean;
}) {
  const [busy, run] = useRun();
  const [confirmReject, setConfirmReject] = useState(false);
  const replied = summary.outcome === "replied";
  const rejected = summary.outcome === "rejected";
  const canOutcome = showOutcomes && summary.reason !== "no_sent_application";
  const text = followUpStatusText(summary);

  const toggle = (outcome: "replied" | "rejected", on: boolean) =>
    run(
      () => setApplicationOutcome(summary.jobId, on ? outcome : null),
      on
        ? outcome === "replied"
          ? "Reply recorded: follow-ups stopped"
          : "Marked rejected or closed"
        : "Outcome cleared",
    );

  return (
    <section
      aria-label="Follow-ups"
      data-testid="follow-up-panel"
      className="flex min-w-0 flex-col gap-3 rounded-lg border bg-card p-4"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">Follow-ups</h2>
          {text && (
            <p className="text-sm text-muted-foreground" data-testid="follow-up-status">
              {text}
            </p>
          )}
        </div>
        <FollowUpMenu summary={summary} />
      </div>
      {canOutcome && (
        <div className="flex flex-wrap gap-2" role="group" aria-label="Outcome">
          <Button
            variant={replied ? "secondary" : "outline"}
            aria-pressed={replied}
            className="h-11"
            disabled={busy}
            data-testid="outcome-replied"
            onClick={() => void toggle("replied", !replied)}
          >
            {replied ? "✓ Got a reply" : "Got a reply"}
          </Button>
          <Button
            variant={rejected ? "secondary" : "outline"}
            aria-pressed={rejected}
            className="h-11"
            disabled={busy}
            data-testid="outcome-rejected"
            onClick={() => (rejected ? void toggle("rejected", false) : setConfirmReject(true))}
          >
            {rejected ? "✓ Rejected / closed" : "Rejected / closed"}
          </Button>
        </div>
      )}
      <GmailThreadLink url={summary.threadUrl} />

      <AlertDialog open={confirmReject} onOpenChange={setConfirmReject}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Rejected or closed?</AlertDialogTitle>
            <AlertDialogDescription>
              This stops follow-ups for this job, removes any follow-up draft, and sets the job
              status to Rejected. Press the button again later to undo: the status goes back to
              Applied.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={(e) => {
                e.preventDefault();
                void toggle("rejected", true).then(() => setConfirmReject(false));
              }}
            >
              Mark rejected
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
