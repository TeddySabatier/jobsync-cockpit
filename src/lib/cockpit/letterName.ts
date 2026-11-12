// Display names of the PDFs attached to the email. Pure and client-safe.

// A file name that is safe to show and to put in a header: [A-Za-z0-9._-] only,
// no leading dots, at most 100 characters before ".pdf". Shown to the user and
// the recipient; never used as a path.
export function sanitizePdfName(fileName: string): string {
  const base = fileName
    .replace(/\.pdf$/i, "")
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 100);
  return `${base || "attachment"}.pdf`;
}

// Display name of the cover-letter PDF that is attached next to the CV. The one
// function behind the dialog, the preview download and Send, so the owner sees
// the name the recipient gets. Derived from the CV file name so the two read as
// a pair: "Jane_Doe_CV_Acme.pdf" -> "Jane_Doe_Cover_Letter_Acme.pdf". The inner
// sanitize turns the CV name into plain characters so the "CV" token is found
// between underscores; the outer one guards the final name.
export function letterPdfName(cvFileName: string | null | undefined): string {
  const base = sanitizePdfName(cvFileName ?? "").replace(/\.pdf$/i, "");
  const swapped = base.replace(/(^|[_\- ])CV($|[_\- ])/i, "$1Cover_Letter$2");
  return sanitizePdfName(`${swapped === base ? `${base}_Cover_Letter` : swapped}.pdf`);
}
