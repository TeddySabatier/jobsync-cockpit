"use client";
import { useEffect, useRef, useState } from "react";
import { sendPackage } from "@/actions/cockpitSend.actions";
import { toastError, toastSuccess } from "@/lib/toast";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { formatBytes, type PackageDetail } from "./Panels";

const FREE_MAIL = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "yahoo.com",
  "icloud.com",
  "me.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "gmx.com",
  "gmx.net",
  "mail.com",
  "yandex.com",
  "zoho.com",
]);

const GENERIC_LABELS = new Set(["co", "com", "org", "net", "ac", "gov", "www"]);

// Name labels of a host without its TLD: "jobs.acme.co.uk" -> ["jobs", "acme"].
function nameLabels(host: string): string[] {
  const labels = host.toLowerCase().split(".").slice(0, -1);
  return labels.filter((l) => l.length >= 3 && !GENERIC_LABELS.has(l));
}

function hostOf(url: string | null): string | null {
  if (!url?.trim()) return null;
  try {
    const u = url.trim();
    return new URL(/^https?:\/\//i.test(u) ? u : `https://${u}`).hostname;
  } catch {
    return null;
  }
}

// SPEC §5.3: warn when the recipient is a free-mail address, or its domain
// matches neither the company name nor the posting's domain. The bot picks the
// recipient from untrusted postings, so this is a hint, not a proof.
// shortcut: name-substring heuristic; false warnings are possible (ATS
// domains) and are acceptable, since the user confirms anyway.
export function recipientWarning(
  to: string,
  company: string,
  jobUrl: string | null,
): string | null {
  const domain = to.split("@").pop()?.trim().toLowerCase() ?? "";
  if (!domain) return null;
  if (FREE_MAIL.has(domain)) {
    return `${domain} is a free-mail domain. Check that this is the right recipient.`;
  }
  const mine = nameLabels(domain);
  const companyKey = company.toLowerCase().replace(/[^a-z0-9]/g, "");
  const postingHost = hostOf(jobUrl);
  const theirs = postingHost ? nameLabels(postingHost) : [];
  const matches = mine.some(
    (l) => theirs.includes(l) || (companyKey.length >= 3 && companyKey.includes(l)),
  );
  return matches
    ? null
    : `The recipient domain (${domain}) does not match the company (${company}) or the job posting. Check that this is the right recipient.`;
}

export default function SendDialog({
  detail,
  open,
  onOpenChange,
}: {
  detail: PackageDetail;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const pkg = detail.package;
  const [busy, setBusy] = useState(false);
  // A ref too: two clicks in the same tick both see busy === false.
  const inFlight = useRef(false);
  useEffect(() => {
    if (!open) setBusy(false);
  }, [open]);

  const to = pkg.emailTo?.trim() ?? "";
  const warning = recipientWarning(to, pkg.job.Company.label, pkg.job.jobUrl);

  async function send() {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      const r = await sendPackage(pkg.id, pkg.updatedAt);
      if (r.success) toastSuccess("Email sent");
      else toastError(r.message);
      // On success the package is sent; on an unknown outcome the page now
      // shows the send-outcome panel; on a conflict the user must reopen.
      onOpenChange(false);
    } catch {
      toastError("Could not confirm the send. Reload and check the package state before retrying.");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Send this application</DialogTitle>
          <DialogDescription>
            This sends a real email from your Gmail account.
          </DialogDescription>
        </DialogHeader>

        <p className="break-all text-2xl font-semibold" data-testid="send-to">
          {to}
        </p>
        {warning && (
          <p
            role="alert"
            className="rounded border border-amber-500 p-2 text-sm font-medium text-amber-700 dark:text-amber-400"
          >
            {warning}
          </p>
        )}
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
          <dt className="text-muted-foreground">From</dt>
          <dd className="break-all">{detail.gmail?.email ?? "not connected"}</dd>
          <dt className="text-muted-foreground">Subject</dt>
          <dd className="break-words">{pkg.emailSubject}</dd>
          <dt className="text-muted-foreground">Attachment</dt>
          <dd className="break-all">
            {detail.attachment
              ? `${detail.attachment.fileName} (${formatBytes(detail.attachment.size)})`
              : "None"}
          </dd>
          {detail.letterAttachment && (
            <>
              <dt className="text-muted-foreground">Cover letter</dt>
              <dd className="break-all" data-testid="send-letter-attachment">
                {detail.letterAttachment.fileName} (made from the letter text)
              </dd>
            </>
          )}
        </dl>
        <pre
          data-testid="send-body"
          className="max-h-64 overflow-y-auto whitespace-pre-wrap break-words rounded bg-muted p-2 text-xs"
        >
          {pkg.emailBody}
        </pre>

        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={busy} onClick={() => void send()}>
            Send now
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
