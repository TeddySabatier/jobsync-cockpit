"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
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

// Free-mail providers (international and the common French ones). Matched on
// the registrable domain, so mail.gmail.com is caught as well.
const FREE_MAIL = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "outlook.fr",
  "hotmail.com",
  "hotmail.fr",
  "live.com",
  "live.fr",
  "msn.com",
  "yahoo.com",
  "yahoo.fr",
  "icloud.com",
  "me.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "protonmail.ch",
  "pm.me",
  "gmx.com",
  "gmx.net",
  "gmx.fr",
  "mail.com",
  "yandex.com",
  "zoho.com",
  "orange.fr",
  "wanadoo.fr",
  "free.fr",
  "sfr.fr",
  "neuf.fr",
  "laposte.net",
  "bbox.fr",
  "numericable.fr",
  "club-internet.fr",
  "aliceadsl.fr",
  "voila.fr",
]);

// Second-level labels that are part of the public suffix: acme.co.uk.
// Only honoured under a two-letter country TLD: co.com, net.com, org.com are
// ordinary registrable domains whose subdomains someone else can sell.
const SUFFIX_LABELS = new Set([
  "co", "com", "org", "net", "ac", "gov", "edu", "gouv", "asso", "nom", "mil",
  "ne", "or", "go", "gob", "sch", "ltd", "plc",
]);

// Words of a company name that many companies share (Acme Technologies ->
// technologies.com): never a match on their own, only inside the joined name.
const WEAK_WORDS = new Set([
  "technologies", "technology", "tech", "solutions", "systems", "software",
  "consulting", "services", "global", "international", "digital", "labs",
  "partners", "holdings", "industries", "studio", "studios", "media", "data",
  "france", "europe", "groupe", "network", "networks", "online", "web",
]);

// Labels that say nothing about who owns the domain: never a match on their own.
const GENERIC_LABELS = new Set([
  "www", "jobs", "job", "careers", "career", "mail", "hr", "recruiting",
  "recruitment", "talent", "apply", "inc", "corp", "corporation", "llc", "ltd",
  "gmbh", "sas", "sarl", "group", "company", "the",
]);

// Registrable part of a host: "careers.acme.co.uk" -> { label: "acme", domain: "acme.co.uk" }.
// Subdomains are never part of it: the owner of evil.example controls
// careers.evil.example, so those labels prove nothing.
function registrable(host: string): { label: string; domain: string } {
  const labels = host.toLowerCase().split(".").filter(Boolean);
  if (labels.length < 2) return { label: labels[0] ?? "", domain: labels[0] ?? "" };
  const n =
    labels.length >= 3 &&
    labels[labels.length - 1].length === 2 &&
    SUFFIX_LABELS.has(labels[labels.length - 2])
      ? 3
      : 2;
  const tail = labels.slice(-n);
  return { label: tail[0], domain: tail.join(".") };
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

// SPEC §5.3: warn when the recipient is a free-mail address, or when its
// registrable domain matches neither the company name nor the posting's
// registrable domain. The bot picks the recipient from untrusted postings, so
// this is a hint, not a proof; the comparison therefore ignores subdomains and
// generic words (careers.evil.example, inc.evil.example), which an attacker
// controls. False warnings are possible (ATS domains) and are acceptable:
// the user confirms anyway.
export function recipientWarning(
  to: string,
  company: string,
  jobUrl: string | null,
): string | null {
  const domain = to.split("@").pop()?.trim().toLowerCase() ?? "";
  if (!to.trim()) return null;
  // "hr@" or "hr@.": not an address the server would accept; do not stay silent.
  if (!domain.replace(/\./g, "")) {
    return "The recipient address looks incomplete. Check that this is the right recipient.";
  }
  const mine = registrable(domain);
  if (FREE_MAIL.has(domain) || FREE_MAIL.has(mine.domain)) {
    return `${domain} is a free-mail domain. Check that this is the right recipient.`;
  }
  // Accents and apostrophes dropped: "Crédit Agricole", "L'Oréal" must still
  // match credit-agricole.fr / loreal.com (a false warning is trained away).
  const words = company
    .normalize("NFD")
    .replace(/[̀-ͯ'’]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !GENERIC_LABELS.has(w));
  const companyKey = words.join("");
  const companyKeyDashed = words.join("-");
  const postingHost = hostOf(jobUrl);
  const posting = postingHost ? registrable(postingHost).label : null;
  const label = mine.label;
  const usable = label.length >= 3 && !GENERIC_LABELS.has(label);
  const matches =
    usable &&
    (label === posting ||
      (words.includes(label) && !WEAK_WORDS.has(label)) ||
      label === companyKey ||
      label === companyKeyDashed);
  return matches
    ? null
    : `The recipient domain (${domain}) does not match the company (${company}) or the job posting. Check that this is the right recipient.`;
}

// Failure codes after which the page state changed: close the dialog.
const CLOSE_ON = new Set<string>(["SEND_OUTCOME_UNKNOWN", "CONFLICT", "INVALID_STATE", "NOT_FOUND"]);

export default function SendDialog({
  detail,
  open,
  onOpenChange,
}: {
  detail: PackageDetail;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const pkg = detail.package;
  const [busy, setBusy] = useState(false);
  // A ref too: two clicks in the same tick both see busy === false.
  const inFlight = useRef(false);
  // Persistent explanation of a definitive failure (a toast alone vanishes).
  const [failure, setFailure] = useState<string | null>(null);
  useEffect(() => {
    if (!open) {
      setBusy(false);
      setFailure(null);
    }
  }, [open]);

  const to = pkg.emailTo?.trim() ?? "";
  const warning = recipientWarning(to, pkg.job.Company.label, pkg.job.jobUrl);

  async function send() {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setFailure(null);
    try {
      const r = await sendPackage(pkg.id, pkg.updatedAt);
      if (r.success) {
        toastSuccess("Email sent");
        onOpenChange(false);
      } else if (CLOSE_ON.has(r.code)) {
        // The page now shows the new state (send-outcome panel, a changed or
        // locked package): the dialog has nothing left to offer.
        toastError(r.message);
        onOpenChange(false);
      } else {
        // Nothing was sent (Gmail refused, token, validation): keep the dialog
        // open with the reason; the user can fix it or retry.
        setFailure(r.message);
      }
    } catch {
      // Unknown outcome: close, so a second click cannot send twice, and
      // refresh to show what the server recorded (the lock or the sent state).
      toastError("Could not confirm the send. Reload and check the package state before retrying.");
      onOpenChange(false);
      router.refresh();
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
        {failure && (
          <p
            role="alert"
            data-testid="send-failure"
            className="rounded border border-destructive p-2 text-sm font-medium text-destructive"
          >
            {`Not sent: ${failure}`}
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
