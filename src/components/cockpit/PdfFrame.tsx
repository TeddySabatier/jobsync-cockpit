import { FileText } from "lucide-react";
import { Button } from "@/components/ui/button";

// An inline PDF where it is usable (md and up, 70vh), and below md a card with
// an "Open PDF" button instead: a phone shows only page 1 of an iframe PDF and
// the frame traps touch scrolling (D-041). CSS only, so it renders the same on
// the server and the client.
export default function PdfFrame({
  src,
  title,
  testId,
  sizeLabel,
}: {
  src: string;
  title: string;
  testId?: string;
  sizeLabel?: string;
}) {
  return (
    <>
      <iframe
        src={src}
        title={title}
        data-testid={testId}
        className="hidden h-[70vh] w-full rounded border md:block"
      />
      <div
        data-testid={testId ? `${testId}-card` : undefined}
        className="flex flex-col items-start gap-3 rounded border bg-muted/40 p-3 md:hidden"
      >
        <p className="flex items-center gap-2 text-sm">
          <FileText className="h-4 w-4 shrink-0" aria-hidden />
          <span className="break-words">
            {title}
            {sizeLabel ? ` (${sizeLabel})` : ""}
          </span>
        </p>
        <Button asChild className="h-11 w-full">
          <a href={src} target="_blank" rel="noopener noreferrer">
            Open PDF
          </a>
        </Button>
      </div>
    </>
  );
}
