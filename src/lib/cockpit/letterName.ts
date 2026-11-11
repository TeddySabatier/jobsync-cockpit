// Display name of the cover-letter PDF that is attached next to the CV. Pure and
// client-safe. Derived from the CV file name so the two read as a pair:
// "Jane_Doe_CV_Acme.pdf" -> "Jane_Doe_Cover_Letter_Acme.pdf".
export function letterPdfName(cvFileName: string | null | undefined): string {
  const base = (cvFileName ?? "").replace(/\.pdf$/i, "").trim();
  if (!base) return "Cover_Letter.pdf";
  const swapped = base.replace(/(^|[_\- ])CV($|[_\- ])/i, "$1Cover_Letter$2");
  return `${swapped === base ? `${base}_Cover_Letter` : swapped}.pdf`;
}
