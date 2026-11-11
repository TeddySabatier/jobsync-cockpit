import fs from "fs";
import path from "path";

// Test-side control of e2e/support/fake-google.cjs (runs inside the dev
// server). Both sides share two files under .cockpit-tmp/.
const tmp = path.join(process.cwd(), ".cockpit-tmp");
const modeFile = path.join(tmp, "fake-google.mode");
const logFile = path.join(tmp, "fake-google.log");

export type SendMode =
  | "ok"
  | "400"
  | "401"
  | "403"
  | "429"
  | "500"
  | "timeout"
  | "network"
  | "badbody";

export type FakeMode = {
  send?: SendMode;
  token?: "ok" | "invalid_grant";
  revoke?: "ok" | "500";
  delayMs?: number;
};

export type FakeLogEntry = {
  ts: string;
  kind: "token" | "revoke" | "send" | "blocked";
  mode?: string;
  grant?: string;
  status?: number;
  outcome?: string;
  host?: string;
  from?: string | null;
  to?: string | null;
  subject?: string | null;
  attachmentName?: string | null;
  attachmentBytes?: number | null;
  // Every attachment of a send, in order (attachmentName/Bytes = the first).
  attachments?: Array<{ name: string; bytes: number }>;
  // Names of the form fields the app posted to the token endpoint.
  fields?: string[];
  // Set when the fake refused the request (missing PKCE verifier, wrong secret...).
  rejected?: string;
};

export function setFakeMode(mode: FakeMode): void {
  fs.mkdirSync(tmp, { recursive: true });
  fs.writeFileSync(modeFile, JSON.stringify(mode));
}

export function resetFake(): void {
  fs.mkdirSync(tmp, { recursive: true });
  fs.rmSync(modeFile, { force: true });
  fs.writeFileSync(logFile, "");
}

export function fakeLog(): FakeLogEntry[] {
  if (!fs.existsSync(logFile)) return [];
  return fs
    .readFileSync(logFile, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as FakeLogEntry);
}

export const fakeSends = () => fakeLog().filter((e) => e.kind === "send");
