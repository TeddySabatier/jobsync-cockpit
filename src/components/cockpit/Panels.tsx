"use client";
import { useMemo } from "react";
import { format } from "date-fns";
import { Download } from "lucide-react";
import { TipTapContentViewer } from "@/components/TipTapContentViewer";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Badge } from "@/components/ui/badge";
import { formatUrl } from "@/lib/utils";
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
  return (
    <section
      aria-label={title}
      data-testid={testId}
      className="min-w-0 rounded-lg border bg-card p-4"
    >
      <h2 className="mb-3 text-sm font-semibold">{title}</h2>
      {children}
    </section>
  );
}

const Pre = ({ children }: { children: React.ReactNode }) => (
  <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded bg-muted p-2 text-xs">
    {children}
  </pre>
);

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
      <div className="max-h-96 overflow-auto">
        <TipTapContentViewer content={description} />
      </div>
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
          <a
            href={fileUrl}
            download
            className="mt-2 inline-flex items-center gap-1 text-sm underline"
          >
            <Download className="h-3.5 w-3.5" />
            Download PDF
          </a>
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
            <Pre>{prettyJson(pkg.cvJson)}</Pre>
          </CollapsibleContent>
        </Collapsible>
      )}
    </Panel>
  );
}

function FitValue({ value }: { value: unknown }) {
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
  return <Pre>{JSON.stringify(value, null, 2)}</Pre>;
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
  return (
    <Panel title="Fit analysis" testId="panel-fit">
      {pkg.fitGrade && (
        <p className="mb-2 text-sm">
          Grade: <Badge variant="outline">{pkg.fitGrade}</Badge>
        </p>
      )}
      {!pkg.fitAnalysis ? (
        <p className="text-sm text-muted-foreground">No fit analysis.</p>
      ) : isObject ? (
        <dl className="flex flex-col gap-2 text-sm">
          {Object.entries(parsed as Record<string, unknown>).map(([k, v]) => (
            <div key={k}>
              <dt className="font-medium">{k}</dt>
              <dd className="mt-0.5">
                <FitValue value={v} />
              </dd>
            </div>
          ))}
        </dl>
      ) : (
        <Pre>{prettyJson(pkg.fitAnalysis)}</Pre>
      )}
    </Panel>
  );
}

export function EmailPanel({ detail }: { detail: PackageDetail }) {
  const pkg = detail.package;
  return (
    <Panel title="Email preview" testId="panel-email">
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
        <dt className="text-muted-foreground">From</dt>
        <dd className="break-all">{detail.gmail?.email ?? "not connected"}</dd>
        <dt className="text-muted-foreground">To</dt>
        <dd className="break-all">{pkg.emailTo?.trim() || "Apply via link"}</dd>
        <dt className="text-muted-foreground">Subject</dt>
        <dd className="break-words">{pkg.emailSubject}</dd>
        <dt className="text-muted-foreground">Attachment</dt>
        <dd className="break-all">
          {detail.attachment
            ? `${detail.attachment.fileName} (${formatBytes(detail.attachment.size)})`
            : "None"}
        </dd>
      </dl>
      <div className="mt-3">
        <Pre>{pkg.emailBody}</Pre>
      </div>
    </Panel>
  );
}

export function LetterPanel({ pkg }: { pkg: PackageDetail["package"] }) {
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
          <a
            href={pdfUrl}
            download
            className="mt-2 inline-flex items-center gap-1 text-sm underline"
          >
            <Download className="h-3.5 w-3.5" />
            Download PDF
          </a>
          <p className="mb-1 mt-4 text-xs text-muted-foreground">Letter text:</p>
          <div className="max-h-96 overflow-auto">
            <TipTapContentViewer content={html} />
          </div>
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
