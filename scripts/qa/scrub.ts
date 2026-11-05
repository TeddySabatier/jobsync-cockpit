const ALLOWED_PREFIXES = [
  "src/",
  "__tests__/",
  "prisma/migrations/",
  "cockpit/",
  "docs/",
  "e2e/",
];
const ALLOWED_EXACT = ["prisma/schema.prisma", "next.config.mjs", "package.json"];
const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY/,
  /ghp_[A-Za-z0-9]{20,}/,
  /sk-[A-Za-z0-9]{20,}/,
];

/** Throws unless this file may leave the machine inside an LLM prompt. */
export function assertSendable(relPath: string, content: string): void {
  const p = relPath.replace(/\\/g, "/");
  if (p.startsWith("/") || p.includes("\0") || /(^|\/)\.\.(\/|$)/.test(p)) {
    throw new Error(`scrub: bad path ${JSON.stringify(relPath)}`);
  }
  if (p.split("/").some((s) => s.startsWith(".env"))) {
    throw new Error(`scrub: env file refused: ${relPath}`);
  }
  if (/\.(db|sqlite|sqlite3)$/i.test(p)) {
    throw new Error(`scrub: database file refused: ${relPath}`);
  }
  if (/secrets/i.test(p)) {
    throw new Error(`scrub: secrets path refused: ${relPath}`);
  }
  if (
    !ALLOWED_EXACT.includes(p) &&
    !ALLOWED_PREFIXES.some((pre) => p.startsWith(pre))
  ) {
    throw new Error(`scrub: path not in allowlist: ${relPath}`);
  }
  for (const re of SECRET_PATTERNS) {
    if (re.test(content)) {
      throw new Error(`scrub: secret-like content in ${relPath} (${re.source})`);
    }
  }
}
