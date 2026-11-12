"use client";
import { Fragment, useEffect, useRef, useState } from "react";
import Link from "next/link";
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

// Recruiting platforms and staffing agencies: an address there is a third
// party's mailbox, not the employer's. Matched on the registrable domain, or on
// its label for the agencies that own many country domains (D-041).
const ATS_AGENCY_DOMAINS = new Set([
  "greenhouse.io", "lever.co", "workday.com", "myworkdayjobs.com", "smartrecruiters.com",
  "ashbyhq.com", "recruitee.com", "teamtailor.com", "jobvite.com", "icims.com", "taleo.net",
  "bamboohr.com", "personio.com", "personio.de", "workable.com", "breezy.hr", "join.com",
  "welcometothejungle.com", "hellowork.com", "indeed.com", "linkedin.com", "monster.com",
  "glassdoor.com", "apec.fr", "pole-emploi.fr", "francetravail.fr",
]);
const AGENCY_LABELS = new Set([
  "randstad", "adecco", "manpower", "hays", "michaelpage", "roberthalf", "robertwalters",
  "kellyservices", "gigroup", "synergie", "crit", "proman", "supplay", "page-personnel",
  "pagepersonnel", "expectra", "spring",
]);

function isAtsOrAgency(host: string): boolean {
  const r = registrable(host);
  return ATS_AGENCY_DOMAINS.has(r.domain) || AGENCY_LABELS.has(r.label);
}

// Where the bot said it found the address: a URL (-> its host) or a short note.
function sourceHost(source: string | null | undefined): string | null {
  const s = source?.trim();
  if (!s || /\s/.test(s)) return null;
  const host = hostOf(s);
  return host && host.includes(".") ? host : null;
}

// SPEC §5.3: warn when the recipient is a free-mail address, or when its
// registrable domain matches neither the company name nor the posting's
// registrable domain. The bot picks the recipient from untrusted postings, so
// this is a hint, not a proof; the comparison therefore ignores subdomains and
// generic words (careers.evil.example, inc.evil.example), which an attacker
// controls. False warnings are possible (ATS domains) and are acceptable:
// the user confirms anyway.
//
// D-041: `contactSource` is where the bot says it found the address. Omitted
// (undefined) = the old behaviour, unchanged. Given (a string or null): free
// mail, a platform / agency address and an incomplete address always warn; a
// plain domain mismatch warns only when there is NO source (with a source it
// becomes the neutral recipientNote, so a real recruiter address is not
// drowned in false alarms).
export function recipientWarning(
  to: string,
  company: string,
  jobUrl: string | null,
  contactSource?: string | null,
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
  if (contactSource !== undefined && isAtsOrAgency(domain)) {
    return `${domain} is a recruiting platform or agency, not the employer. Check that this is the right recipient.`;
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
  if (matches) return null;
  // A recorded source is evidence the owner can read: no strong warning.
  if (contactSource?.trim()) return null;
  return `The recipient domain (${domain}) does not match the company (${company}) or the job posting. ${
    contactSource === undefined ? "" : "No source was recorded for this address. "
  }Check that this is the right recipient.`;
}

// The neutral line under the recipient (D-041): where the address came from.
// Null when there is nothing to say.
export function recipientNote(
  to: string,
  contactSource: string | null | undefined,
): string | null {
  const source = contactSource?.trim();
  if (!to.trim() || !source) return null;
  const domain = to.split("@").pop()?.trim().toLowerCase() ?? "";
  const host = sourceHost(source);
  if (host && domain && registrable(host).domain === registrable(domain).domain) {
    // Same domain as the address, which says nothing about who owns it: no
    // reassuring wording (the bot's source is as untrusted as the address).
    return `Found on ${host} (same domain as the address).`;
  }
  if (host) return `Found at ${source}. Its site differs from the address domain: open it to confirm.`;
  return `Source: ${source}.`;
}

// The address in chunks that may wrap: a break opportunity after "@" and each
// ".", so a narrow phone breaks at a natural place, not mid-word. The chunks
// joined give back the address.
export function recipientParts(to: string): string[] {
  return to.split(/(?<=[@.])/);
}

// Failure codes after which the page state changed: close the dialog.
const CLOSE_ON = new Set<string>(["SEND_OUTCOME_UNKNOWN", "CONFLICT", "INVALID_STATE", "NOT_FOUND"]);

export default function SendDialog({
  detail,
  open,
  onOpenChange,
  onSent,
  sentMessage = "Email sent",
}: {
  detail: PackageDetail;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  // Called once, after a CONFIRMED send only (never on a failure or an
  // unknown outcome): the caller moves to the next application (D-041).
  onSent?: () => void;
  sentMessage?: string;
}) {
  const router = useRouter();
  const pkg = detail.package;
  const [busy, setBusy] = useState(false);
  // A ref too: two clicks in the same tick both see busy === false.
  const inFlight = useRef(false);
  // Persistent explanation of a definitive failure (a toast alone vanishes).
  const [failure, setFailure] = useState<{ code: string; message: string } | null>(null);
  useEffect(() => {
    if (!open) {
      setBusy(false);
      setFailure(null);
    }
  }, [open]);

  const to = pkg.emailTo?.trim() ?? "";
  const contactSource = pkg.contactSource?.trim() || null;
  const warning = recipientWarning(to, pkg.job.Company.label, pkg.job.jobUrl, contactSource);
  const note = recipientNote(to, contactSource);
  // A source softens a plain domain mismatch, never hides it (D-041): the
  // owner still reads that the domain differs, next to where the bot found it.
  const mismatch =
    !warning && contactSource
      ? recipientWarning(to, pkg.job.Company.label, pkg.job.jobUrl)
      : null;

  async function send() {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setFailure(null);
    try {
      const r = await sendPackage(pkg.id, pkg.updatedAt);
      if (r.success) {
        toastSuccess(sentMessage);
        onOpenChange(false);
        onSent?.();
      } else if (CLOSE_ON.has(r.code)) {
        // The page now shows the new state (send-outcome panel, a changed or
        // locked package): the dialog has nothing left to offer.
        toastError(r.message);
        onOpenChange(false);
      } else {
        // Nothing was sent (Gmail refused, token, validation): keep the dialog
        // open with the reason; the user can fix it or retry.
        setFailure({ code: r.code, message: r.message });
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
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Send this application</DialogTitle>
          <DialogDescription>
            This sends a real email from your Gmail account.
          </DialogDescription>
        </DialogHeader>

        {warning && (
          <p
            role="alert"
            className="rounded border border-amber-500 p-2 text-sm font-medium text-amber-700 dark:text-amber-400"
          >
            {warning}
            {contactSource && (
              <span className="block font-normal" data-testid="send-contact-source">
                {`The bot says it found this address here: ${contactSource}`}
              </span>
            )}
          </p>
        )}
        <p
          className="[overflow-wrap:anywhere] text-xl font-semibold"
          data-testid="send-to"
        >
          {recipientParts(to).map((part, i) => (
            <Fragment key={i}>
              {part}
              <wbr />
            </Fragment>
          ))}
        </p>
        {note && !warning && (
          <p
            className={
              mismatch
                ? "rounded border border-amber-500 p-2 text-sm text-amber-700 dark:text-amber-400"
                : "text-sm text-muted-foreground"
            }
            data-testid="send-contact-source"
          >
            {mismatch && (
              <span className="block font-medium">
                The recipient domain differs from the company and the job posting.
              </span>
            )}
            {note}
          </p>
        )}
        {failure && (
          <p
            role="alert"
            data-testid="send-failure"
            className="rounded border border-destructive p-2 text-sm font-medium text-destructive dark:text-red-400"
          >
            {`Not sent: ${failure.message}`}
            {failure.code === "VALIDATION" && (
              <span className="block font-normal">
                Check the recipient, subject and body: close this dialog and use Edit.
              </span>
            )}
            {failure.code === "GMAIL_RECONNECT_REQUIRED" && (
              <span className="block font-normal">
                <Link href="/dashboard/review/settings" className="underline">
                  Reconnect Gmail in settings
                </Link>
              </span>
            )}
          </p>
        )}
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
          <dt className="text-muted-foreground">From</dt>
          <dd className="[overflow-wrap:anywhere]">{detail.gmail?.email ?? "not connected"}</dd>
          <dt className="text-muted-foreground">Subject</dt>
          <dd className="break-words">{pkg.emailSubject}</dd>
          <dt className="text-muted-foreground">Attachment</dt>
          <dd className="[overflow-wrap:anywhere]">
            {detail.attachment
              ? `${detail.attachment.fileName} (${formatBytes(detail.attachment.size)})`
              : "None"}
          </dd>
          {detail.letterAttachment && (
            <>
              <dt className="text-muted-foreground">Cover letter</dt>
              <dd className="[overflow-wrap:anywhere]" data-testid="send-letter-attachment">
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
