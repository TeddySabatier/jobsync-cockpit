// The name a downloaded file is saved under. A restored backup stores files as
// <id>.<ext> (D-017 a), so the display name (File.fileName) is preferred over
// the name on disk. Control characters, quotes and path separators are
// replaced; an empty result falls back to the given name.
export function safeDownloadName(
  displayName: string | null | undefined,
  fallback: string,
): string {
  // eslint-disable-next-line no-control-regex
  const clean = (displayName ?? "").replace(/[\u0000-\u001f\u007f"\\/]/g, "_").trim();
  return clean && clean !== "." && clean !== ".." ? clean : fallback;
}

// Content-Disposition for a download: an ASCII filename for old clients plus
// the UTF-8 name (RFC 6266 / 5987). Header values must be ByteStrings, so a
// raw non-Latin-1 name would throw.
export function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/[";\\]/g, "_");
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
