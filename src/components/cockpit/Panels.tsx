"use client";
import { useMemo, useState } from "react";
import { format, formatDistanceToNow } from "date-fns";
import {
  Check,
  CircleHelp,
  Download,
  ExternalLink,
  Info,
  TriangleAlert,
  X,
} from "lucide-react";
import { TipTapContentViewer } from "@/components/TipTapContentViewer";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Progress } from "@/components/ui/progress";
import { cn, formatUrl } from "@/lib/utils";
import {
  attemptView,
  fitKind,
  fitLabel,
  fitMax,
  fitScoreView,
  humanizeKey,
  splitHistory,
  type HistoryTone,
} from "./panelModels";
import { renderLetterMarkdown } from "@/lib/cockpit/markdown";
import type { getPackageDetail } from "@/actions/cockpit.actions";

export type PackageDetail = Extract<
  Awaited<ReturnType<typeof getPackageDetail>>,
  { success: true }
>["data"];

// Everything bot-produced (email, fit analysis, CV data, review notes) is
// rendered as text nodes or <pre>, never as HTML (SPEC §5). The letter is the
// only rich content, through the hardened renderer.

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function Panel({
  title,
  children,
  testId,
}: {
  title: string;
  children: React.ReactNode;
  testId: string;
}) {
  const headingId = `${testId}-heading`;
  return (
    <section
      aria-labelledby={headingId}
      data-testid={testId}
      className="min-w-0 rounded-lg border bg-card p-4"
    >
      <h2 id={headingId} className="mb-3 text-sm font-semibold">
        {title}
      </h2>
      {children}
    </section>
  );
}

// A scrollable box a keyboard user can focus and scroll. role=group, not
// region: these are not landmarks. Names must be unique on the page.
export function ScrollRegion({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      tabIndex={0}
      className="max-h-96 overflow-auto"
    >
      {children}
    </div>
  );
}

const Pre = ({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) => (
  <pre
    role="group"
    aria-label={label}
    tabIndex={0}
    className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded bg-muted p-2 text-xs"
  >
    {children}
  </pre>
);

// Open in a new tab helps where an inline PDF is poor (iOS Safari shows only
// page 1); Download keeps the file name.
function PdfLinks({
  href,
  download,
}: {
  href: string;
  download: string | true;
}) {
  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1 underline"
      >
        <ExternalLink className="h-3.5 w-3.5" />
        Open in new tab
      </a>
      <a
        href={href}
        download={download}
        className="inline-flex items-center gap-1 underline"
      >
        <Download className="h-3.5 w-3.5" />
        Download PDF
      </a>
    </div>
  );
}

export { humanizeKey };

export function PostingPanel({ pkg }: { pkg: PackageDetail["package"] }) {
  const { jobUrl, description } = pkg.job;
  return (
    <Panel title="Posting" testId="panel-posting">
      {jobUrl && (
        <p className="mb-2 break-all text-sm">
          <a
            href={formatUrl(jobUrl)}
            target="_blank"
            rel="noopener noreferrer"
            className="underline"
          >
            {jobUrl}
          </a>
        </p>
      )}
      <ScrollRegion label="Posting text">
        <TipTapContentViewer content={description} label="Job posting" />
      </ScrollRegion>
    </Panel>
  );
}

function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

export function CvPanel({ detail }: { detail: PackageDetail }) {
  const pkg = detail.package;
  const fileUrl = `/api/cockpit/files/${pkg.id}`;
  return (
    <Panel title="CV" testId="panel-cv">
      {pkg.cvPdfStale && (
        <p role="alert" className="mb-2 text-sm font-medium text-amber-700 dark:text-amber-400">
          PDF out of date: the CV data was edited after the PDF was rendered.
        </p>
      )}
      {detail.attachment ? (
        <>
          <iframe
            src={fileUrl}
            title="CV PDF"
            className="h-[480px] w-full rounded border"
          />
          <PdfLinks href={fileUrl} download />
        </>
      ) : (
        <p className="text-sm text-muted-foreground">No CV file attached.</p>
      )}
      {pkg.cvJson && (
        <Collapsible className="mt-3">
          <CollapsibleTrigger className="text-sm font-medium underline">
            CV data
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-2">
            <Pre label="CV data">{prettyJson(pkg.cvJson)}</Pre>
          </CollapsibleContent>
        </Collapsible>
      )}
    </Panel>
  );
}

function FitValue({ value, label }: { value: unknown; label: string }) {
  if (typeof value === "string" || typeof value === "number") {
    return <span className="whitespace-pre-wrap break-words">{String(value)}</span>;
  }
  if (Array.isArray(value) && value.every((v) => typeof v === "string")) {
    return (
      <ul className="list-disc pl-4">
        {value.map((v, i) => (
          <li key={i} className="break-words">
            {v}
          </li>
        ))}
      </ul>
    );
  }
  return <Pre label={label}>{JSON.stringify(value, null, 2)}</Pre>;
}

// "87 / 100" with a meter. The grade badge lives in the header and the queue
// row, not repeated here.
function FitScore({ view, label }: { view: { percent: number; text: string }; label: string }) {
  const value = view.percent;
  return (
    <div className="flex items-center gap-3">
      <span className="whitespace-nowrap font-semibold tabular-nums">
        {view.text}
      </span>
      <Progress
        value={value}
        aria-valuenow={value}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label}
        className="h-2 max-w-48 flex-1"
      />
    </div>
  );
}

// Strengths get a green check, gaps an amber warning; the icon is decoration,
// the heading above says which list it is.
function FitList({
  items,
  kind,
}: {
  items: string[];
  kind: "strengths" | "gaps";
}) {
  const Icon = kind === "strengths" ? Check : TriangleAlert;
  const tone =
    kind === "strengths"
      ? "text-green-700 dark:text-green-400"
      : "text-amber-700 dark:text-amber-400";
  return (
    <ul className="flex flex-col gap-1">
      {items.map((v, i) => (
        <li key={i} className="flex items-start gap-2 break-words">
          <Icon aria-hidden className={cn("mt-0.5 h-4 w-4 shrink-0", tone)} />
          <span className="min-w-0">{v}</span>
        </li>
      ))}
    </ul>
  );
}

export function FitPanel({ pkg }: { pkg: PackageDetail["package"] }) {
  let parsed: unknown = null;
  if (pkg.fitAnalysis) {
    try {
      parsed = JSON.parse(pkg.fitAnalysis);
    } catch {
      parsed = null;
    }
  }
  const isObject = !!parsed && typeof parsed === "object" && !Array.isArray(parsed);
  const max = isObject ? fitMax(parsed as Record<string, unknown>) : null;
  // The grade is in the detail header (and the queue row); not repeated here.
  return (
    <Panel title="Fit analysis" testId="panel-fit">
      {!pkg.fitAnalysis ? (
        <p className="text-sm text-muted-foreground">No fit analysis.</p>
      ) : isObject ? (
        <dl className="flex flex-col gap-3 text-sm">
          {Object.entries(parsed as Record<string, unknown>).map(([k, v]) => {
            const kind = fitKind(k, v, max);
            const label = fitLabel(k);
            return (
              <div key={k}>
                <dt className="font-medium">{label}</dt>
                <dd className="mt-0.5">
                  {kind === "score" ? (
                    <FitScore view={fitScoreView(v, max)!} label={label} />
                  ) : kind === "strengths" || kind === "gaps" ? (
                    <FitList items={v as string[]} kind={kind} />
                  ) : (
                    <FitValue value={v} label={`Fit analysis: ${label}`} />
                  )}
                </dd>
              </div>
            );
          })}
        </dl>
      ) : (
        <Pre label="Fit analysis">{prettyJson(pkg.fitAnalysis)}</Pre>
      )}
    </Panel>
  );
}

export function EmailPanel({ detail }: { detail: PackageDetail }) {
  const pkg = detail.package;
  return (
    <Panel title="Email preview" testId="panel-email">
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
        <dt className="text-muted-foreground">From</dt>
        <dd className="break-all">{detail.gmail?.email ?? "Not connected"}</dd>
        <dt className="text-muted-foreground">To</dt>
        <dd className="break-all">{pkg.emailTo?.trim() || "Apply via link"}</dd>
        <dt className="text-muted-foreground">Subject</dt>
        <dd className="[overflow-wrap:anywhere]">{pkg.emailSubject}</dd>
        <dt className="text-muted-foreground">Attachment</dt>
        <dd className="break-all">
          {detail.attachment
            ? `${detail.attachment.fileName} (${formatBytes(detail.attachment.size)})`
            : "None"}
        </dd>
      </dl>
      <div className="mt-3">
        <Pre label="Email body">{pkg.emailBody}</Pre>
      </div>
    </Panel>
  );
}

export function LetterPanel({
  pkg,
  fileName,
}: {
  pkg: PackageDetail["package"];
  fileName?: string;
}) {
  const html = useMemo(
    () => renderLetterMarkdown(pkg.letterMd ?? ""),
    [pkg.letterMd],
  );
  // The PDF is made from the saved letter text; the timestamp makes the
  // browser reload it after an edit.
  const pdfUrl = `/api/cockpit/letter/${pkg.id}?v=${new Date(pkg.updatedAt).getTime()}`;
  return (
    <Panel title="Cover letter" testId="panel-letter">
      {html ? (
        <>
          <p className="mb-1 text-xs text-muted-foreground">
            PDF as it will be attached to the email:
          </p>
          <iframe
            src={pdfUrl}
            title="Cover letter PDF"
            data-testid="letter-pdf-preview"
            className="h-[560px] w-full rounded border"
          />
          <PdfLinks href={pdfUrl} download={fileName ?? true} />
          {/* The PDF above is made from this text, so the text starts closed.
              forceMount keeps it in the DOM (hidden) for tests and find-in-page
              is not needed: it is the same content as the PDF. */}
          <Collapsible className="mt-3">
            <CollapsibleTrigger className="inline-flex min-h-11 items-center text-sm font-medium underline">
              Letter text
            </CollapsibleTrigger>
            <CollapsibleContent forceMount className="mt-1 data-[state=closed]:hidden">
              <ScrollRegion label="Letter text">
                <div className="[&_p]:my-2 [&_ul]:my-2 [&_ol]:my-2 [&_li]:my-0.5">
                  <TipTapContentViewer content={html} label="Cover letter" />
                </div>
              </ScrollRegion>
            </CollapsibleContent>
          </Collapsible>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">No cover letter.</p>
      )}
    </Panel>
  );
}

export function PreviousReviewInfo({ pkg }: { pkg: PackageDetail["package"] }) {
  if (!pkg.rejectReason && !pkg.changeRequest && !pkg.changeRequestResponse) {
    return null;
  }
  return (
    <Panel title="Previous review info" testId="panel-review-info">
      <dl className="flex flex-col gap-2 text-sm">
        {pkg.rejectReason && (
          <div>
            <dt className="font-medium">Reject reason</dt>
            <dd className="whitespace-pre-wrap break-words">{pkg.rejectReason}</dd>
          </div>
        )}
        {pkg.changeRequest && (
          <div>
            <dt className="font-medium">
              Change request
              {pkg.changeRequestedAt &&
                ` (${format(pkg.changeRequestedAt, "PP")})`}
            </dt>
            <dd className="whitespace-pre-wrap break-words">{pkg.changeRequest}</dd>
          </div>
        )}
        {pkg.changeRequestResponse && (
          <div>
            <dt className="font-medium">Bot response</dt>
            <dd className="whitespace-pre-wrap break-words">
              {pkg.changeRequestResponse}
            </dd>
          </div>
        )}
      </dl>
    </Panel>
  );
}

const TONE_ICON: Record<HistoryTone, { Icon: typeof Check; cls: string; word: string }> = {
  ok: { Icon: Check, cls: "text-green-600 dark:text-green-400", word: "Succeeded" },
  fail: { Icon: X, cls: "text-red-600 dark:text-red-400", word: "Failed" },
  unknown: { Icon: CircleHelp, cls: "text-amber-600 dark:text-amber-400", word: "Needs a check" },
  neutral: { Icon: Info, cls: "text-muted-foreground", word: "Info" },
};

const TONE_BADGE: Record<HistoryTone, string> = {
  ok: "border-transparent bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300",
  fail: "border-transparent bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
  unknown: "border-transparent bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-300",
  neutral: "border-transparent bg-muted text-muted-foreground",
};

// Read-only history of every send attempt on this package, oldest first
// (D-028). It backs the Mark as sent / Release lock decision. Each row has an
// outcome icon and badge, a relative time (absolute in the tooltip) and the
// reason as muted small text; past 3 rows the earlier ones collapse (D-040).
export function SendHistoryPanel({
  history,
}: {
  history: PackageDetail["sendHistory"];
}) {
  const [expanded, setExpanded] = useState(false);
  if (history.length === 0) return null;
  const { hidden, visible } = splitHistory(history, expanded);
  return (
    <Panel title="Send history" testId="panel-send-history">
      <p className="mb-2 text-xs text-muted-foreground">
        What was attempted and what happened, oldest first.
      </p>
      {hidden > 0 && (
        <Button
          variant="ghost"
          size="sm"
          className="mb-2 min-h-11 px-2 md:min-h-9"
          aria-expanded={false}
          onClick={() => setExpanded(true)}
        >
          {`Show ${hidden} earlier ${hidden === 1 ? "attempt" : "attempts"}`}
        </Button>
      )}
      <ol className="flex flex-col gap-3 text-sm">
        {visible.map((a) => {
          const v = attemptView(a.outcome);
          const { Icon, cls, word } = TONE_ICON[v.tone];
          const when = new Date(a.createdAt);
          return (
            <li key={a.id} data-testid="send-attempt" className="flex gap-2">
              <Icon aria-hidden className={cn("mt-0.5 h-4 w-4 shrink-0", cls)} />
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <Badge variant="outline" className={TONE_BADGE[v.tone]}>
                    <span className="sr-only">{`${word}: `}</span>
                    {v.badge}
                  </Badge>
                  {/* The relative text and the local-time title can differ
                      between the server render and the browser (clock, zone). */}
                  <time
                    suppressHydrationWarning
                    dateTime={when.toISOString()}
                    title={format(when, "PP p")}
                    className="text-xs text-muted-foreground"
                  >
                    {formatDistanceToNow(when, { addSuffix: true })}
                  </time>
                </p>
                {/* Visible absolute time: the title tooltip does not exist on touch. */}
                <p
                  suppressHydrationWarning
                  data-testid="send-attempt-abs"
                  className="text-xs text-muted-foreground"
                >
                  {format(when, "PP p")}
                </p>
                <p className="mt-0.5">{v.sentence}</p>
                {a.reason && (
                  <p className="break-words text-xs text-muted-foreground">
                    {a.reason}
                  </p>
                )}
                {a.gmailMessageId && (
                  <span className="block break-all text-xs text-muted-foreground">
                    Gmail message id: {a.gmailMessageId}
                  </span>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </Panel>
  );
}
