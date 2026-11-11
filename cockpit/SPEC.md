# Cockpit V0: specification

Status: **v2 — FROZEN (2026-11-04). Changes require a DECISIONS.md entry.** The Security, Data, UX and Next.js review rulings are logged in `DECISIONS.md` (D-004..D-007).

**Amended after the freeze.** The text below is the V0 wording; later decisions amend it. Each affected section or AC carries an *Amended by* line. Index: D-008 (§2.2 step 2), D-010 (§6.2), D-011 (§4, §6.4, AC-16, AC-25, AC-33), D-012 (§6.2 backup, §11, AC-39), D-013 (§3 quota, AC-38), D-014 (job-page Claude prompt button, no section of its own), D-015 (§3 file serving, §5.3, §6.3, §6.4). When the text and a DECISIONS entry disagree, the DECISIONS entry wins.

A review cockpit inside JobSync. An external bot submits **application packages** (tailored CV PDF + CV JSON, cover letter, draft email, fit analysis) through MCP. The single user reviews, edits, approves and sends each one from the UI. V0 scope only. V1/V2 items from the design are out of scope.

All examples use synthetic data (`Jane Doe`, `example.com`, `you@example.com`).

---

## 1. Principles
- **P1. No send path outside a UI session.** Sending is a server action that calls `requireUser()` (NextAuth session). No MCP tool, API key or token-authenticated route can send. MCP tools can never change a package to `approved` or `sent`. This is enforced by an import-graph test (§3, AC-35), not by a tool-name regex alone.
- **P2. Display, don't generate.** The cockpit shows and stores what the bot produced, plus the user's manual edits. It never calls an LLM and never writes CV content by itself.
- **P3. Additive fork.** New code lives in `src/lib/cockpit/*`, `src/app/dashboard/review/*`, `src/app/api/cockpit/*`, `src/components/cockpit/*`, `src/lib/mcp/tools/cockpit*.ts`, `src/actions/cockpit*.actions.ts`, `__tests__/cockpit*`. Core edits are limited to the list in §9.
- **P4. Feature flag.** Everything is gated by `COCKPIT_ENABLED === "true"` (read in `src/lib/cockpit/config.ts` as `isCockpitEnabled()`). When the flag is off:
  - the sidebar and mobile-nav entry are hidden and `/dashboard/review/**` calls `notFound()` (after the page's own auth check, P5);
  - `/api/cockpit/**` returns 404 (the flag is checked before `auth()`: the middleware already gates anonymous API access, so this only makes the 404 uniform);
  - the cockpit MCP tools are not registered (`registerCockpitTools` is not called);
  - cockpit server actions and queries return `{ success: false, code: "COCKPIT_DISABLED", message: "Cockpit is disabled" }`, **after** `requireUser()` succeeded (an anonymous caller cannot probe the flag).
- **P5. Every entry point authenticates itself.** Do not rely on the middleware or the dashboard layout for authorization: server actions can be invoked by action id from any path, and layouts are not re-run on every client navigation. Every cockpit page (RSC), query (`getReviewQueue`, `getPackageDetail`, `getAdjacentPackageIds`), server action and route handler authenticates itself **first**, before the flag check and before any DB access (AC-40). `serverActions.allowedOrigins` is not set (Next's Origin/Host check stays on).
- **P6. `requireUser()` throws; one result shape.** `requireUser()` (`src/actions/shared.ts`) **throws** `Error("Not authenticated")`; it does not return null. Every action and query body is `try { const user = await requireUser(); if (!isCockpitEnabled()) throw new CockpitError("COCKPIT_DISABLED"); ...; return { success: true, data } } catch (e) { return toActionResult(e) }`, with `requireUser()` **inside** the `try`, so an anonymous call returns a failure result (no thrown 500, no DB write). `handleError` (`src/lib/utils.ts`) is **not used**: it forwards `error.message` (Prisma messages included) to the client and carries no code. Cockpit results are `{ success: true, data } | { success: false, code: CockpitErrorCode, message }`. `message` always comes from a fixed code → message map, **never** from `error.message`. Both live in `src/lib/cockpit/errors.ts` (`CockpitErrorCode`, `COCKPIT_ERROR_MESSAGES`, `CockpitError`, `CockpitResult<T>`, `toActionResult(err)`). An unknown error maps to `INTERNAL` with a generic message and is logged with `log` from `@/lib/telemetry` (code and status only). The UI switches on `code`, never on message text. Route handlers use `auth()` and the same map for their JSON error bodies. Pages call `getCurrentUser()` themselves (null → redirect to sign-in as existing pages do).

## 2. Data model (Prisma, SQLite)
IDs follow the existing convention of the schema (`String @id @default(uuid())`, or whatever `Job` uses). Status is a `String` validated by zod, since the codebase stores statuses as strings and lookup rows, not Prisma enums.

```prisma
model ApplicationPackage {
  id               String    @id @default(uuid())
  userId           String
  user             User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  jobId            String
  job              Job       @relation(fields: [jobId], references: [id], onDelete: Cascade)
  version          Int                       // 1, 2, 3 ... per job
  status           String    @default("pending") // pending|approved|rejected|changes_requested|sent|superseded
  emailTo          String?                   // null/empty = "apply via link"
  emailSubject     String
  emailBody        String
  letterMd         String?
  fitGrade         String?                   // "A" | "B"
  fitAnalysis      String?                   // JSON text (object)
  cvJson           String?                   // JSON text (object)
  cvFileId         String?
  cvFile           File?     @relation(fields: [cvFileId], references: [id], onDelete: SetNull)
  cvPdfStale       Boolean   @default(false) // true after a manual cvJson edit, until a new version arrives
  sourceFolder     String?                   // bot's local folder name, informational
  idempotencyKey   String?
  rejectReason     String?
  changeRequest    String?
  changeRequestedAt DateTime?
  changeRequestHandledAt DateTime?
  changeRequestResponse  String?            // note from the bot via mark_change_request_done
  editedAt         DateTime?                 // last manual edit in the UI
  approvedAt       DateTime?
  rejectedAt       DateTime?
  sendStartedAt    DateTime?                 // send lock; while set, the package is frozen (§6.4)
  sendOutcome      String?                   // null | "unknown" (Gmail result ambiguous, §6.4)
  sentAt           DateTime?
  sentVia          String?                   // "gmail" | "manual"
  createdAt        DateTime  @default(now())
  updatedAt        DateTime  @updatedAt
  sentEmail        SentEmail?

  @@unique([jobId, version])
  @@unique([userId, idempotencyKey])
  @@index([userId, status, createdAt])
}

model GmailAccount {
  id                    String   @id @default(uuid())
  userId                String   @unique
  user                  User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  email                 String
  encryptedRefreshToken String
  iv                    String
  scopes                String   // space-separated, as granted by Google
  createdAt             DateTime @default(now())
  updatedAt             DateTime @updatedAt
}

model SentEmail {
  id             String   @id @default(uuid())
  userId         String
  user           User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  packageId      String   @unique
  package        ApplicationPackage @relation(fields: [packageId], references: [id], onDelete: Cascade)
  fromAddress    String
  toAddress      String
  gmailMessageId String
  threadId       String
  sentAt         DateTime @default(now())
}
```
Back-relation fields are added to `User` (`applicationPackages`, `gmailAccount`, `sentEmails`), `Job` (`applicationPackages`) and `File` (`applicationPackages`). These are schema-only lines; the migration changes no existing table.

Notes:
- `@@index([userId, status, createdAt])` serves the queue (tab filter on `status`, newest first). `@@unique([jobId, version])` serves the max-version lookup. Per-job "active package" dedupe is done in the query, not by an index.
- `@@unique([userId, idempotencyKey])` with a nullable key: SQLite treats each NULL as distinct, so any number of packages without a key is allowed (intended).
- **Ownership:** `ApplicationPackage.userId` is set only from the session / token user, never from input, and `submitPackage` loads the job with `{ id, userId }` in the same transaction. There is no DB constraint tying `userId` to `Job.userId`. `File` has no owner column, so `cvFileId` ownership is path-based (`resolveCockpitFile`, §4). An FK alone is not an ownership proof.
- **Cascades (V0):** the cockpit models cascade on `User` and `Job` delete, so deleting a job deletes its package history. Accepted for V0. Existing tables are not changed to match.

Migration: one folder, `prisma/migrations/20261104120000_cockpit_v0/migration.sql`, **pure DDL** (`CREATE TABLE` and `CREATE INDEX` only, no `ALTER` on existing tables, no data statements), with a comment header like the upstream migrations. Its timestamp is later than the latest upstream migration (`20260904120000`).

### 2.1 Package lifecycle
Statuses: `pending → approved → sent`, plus `rejected`, `changes_requested` and `superseded`.

| From | Action (actor) | To |
|---|---|---|
| — | `submit_application_package` (bot) | `pending` (version n+1) |
| pending | approve (UI) | approved |
| approved | unapprove (UI) | pending |
| pending, approved | reject with reason (UI) | rejected |
| pending, approved | request changes with instruction (UI) | changes_requested |
| changes_requested | `mark_change_request_done` (bot) | pending (with `changeRequestResponse`) |
| pending, approved, changes_requested | new version submitted for the same job | superseded |
| approved | send (UI, Gmail) | sent (`sentVia="gmail"`) |
| pending, approved, with empty `emailTo` | mark applied manually (UI) | sent (`sentVia="manual"`) |
| approved, locked with `sendOutcome="unknown"` (or a stale lock, §6.4) | Mark as sent (manual) (UI) | sent (`sentVia="manual"`) |
| approved, locked (same condition) | Release lock (UI) | approved (lock and outcome cleared) |

- **The lock freezes the package.** Every transition, edit and supersede above applies **only when `sendStartedAt` is null**: each conditional `updateMany` `where` includes `sendStartedAt: null`. The only operations that act on a locked package are the send flow itself and the two recovery actions in the last two rows.
- **Terminal statuses:** `rejected`, `sent`, `superseded`. A package in a terminal status is read-only.
- **Active package of a job:** its highest version whose status is not `superseded`.
- **Editable:** only `pending` and `approved`, and only while unlocked. An edit keeps the status.
- **Change-request history:** on `changes_requested → pending`, `changeRequest`, `changeRequestedAt` and the bot's `changeRequestResponse` are kept as history (shown under "Previous review info", §5.3). A later `requestPackageChanges` overwrites `changeRequest` / `changeRequestedAt` and resets `changeRequestHandledAt` and `changeRequestResponse` to null.

### 2.2 Submission rules (domain service `src/lib/cockpit/packages.ts`)
> *Amended by D-008:* a key that matches a package of the same user but a different job is `CONFLICT`, not a replay (step 2 and the `P2002` race path).

`submitPackage(userId, input)` runs in one `prisma.$transaction`:
1. The job must exist with `job.userId === userId`; otherwise `NOT_FOUND`.
2. If `idempotencyKey` is given and a package with `(userId, idempotencyKey)` exists, return that package unchanged with `idempotent: true`. No new version.
3. If the job already has a package with status `sent`, error `ALREADY_SENT`. This is deliberate: **any** past `sent` package blocks every later submit for the job (no double apply), not only the active one.
4. If the job's active package is `rejected`, error `JOB_REJECTED`. The user has said no to this job; the bot must not resurrect it.
5. If any package of the job is locked (`sendStartedAt` not null), error `CONFLICT`: a send is in progress or unresolved and must be resolved in the UI first.
6. If `cvFileId` is given, it must have been created by `attach_file` for this user: `resolveCockpitFile(userId, file)` (§4) must succeed. Otherwise `FILE_NOT_FOUND`.
7. `version = (max version for job, else 0) + 1`.
8. Every package of that job in `pending`, `approved` or `changes_requested` **with `sendStartedAt: null`** becomes `superseded`. A `changes_requested` one also gets `changeRequestHandledAt = now`.
9. Create the new package with `status = "pending"` and return `{ package, supersededIds, idempotent: false }`.

Concurrency (SQLite serializes writers):
- **Idempotency race:** two concurrent submits with the same key can both pass step 2. The loser hits the `(userId, idempotencyKey)` unique constraint (Prisma `P2002` with that target). `submitPackage` catches it, reads the existing package by `(userId, idempotencyKey)` and returns it with `idempotent: true`.
- **Version race:** a `P2002` on `(jobId, version)` is reported as `CONFLICT`. `CONFLICT` means **the caller replays the whole submit** (steps 1–9, including the idempotency, `ALREADY_SENT` and lock checks), not just a version bump.

### 2.3 Field limits (zod, shared in `src/lib/cockpit/schemas.ts`)
| Field | Rule |
|---|---|
| `emailTo` | optional; empty string → null; otherwise a single address (`z.string().email()`, max 254, no CR/LF, no comma) |
| `emailSubject` | 1–300 chars, no CR/LF |
| `emailBody` | 1–20,000 chars |
| `letterMd` | ≤ 20,000 chars |
| `fitGrade` | `"A"` or `"B"` |
| `fitAnalysis` | JSON object; serialized ≤ 20,000 chars |
| `cvJson` | JSON object; serialized ≤ 200,000 chars |
| `sourceFolder` | ≤ 300 chars |
| `idempotencyKey` | 1–100 chars `[A-Za-z0-9._:-]` |
| `rejectReason`, `changeRequest`, `changeRequestResponse` | 1–2,000 chars, trimmed |
| `contentBase64` (`attach_file`) | string, **max 7,000,000 chars** (≈ 5 MB decoded) |

`schemas.ts` exports each rule set twice, as `XInputShape` (field-level rules) and `XSchema` (§3). Zod is v4: `z.string().email()` is deprecated but works and is used elsewhere in the repo; keep it.

## 3. MCP tools
All six tools are registered by one function, `registerCockpitTools(server, ctx)`, in `src/lib/mcp/tools/cockpit.ts` (`ctx` is the `{ userId, tokenName, scopes }` that `route.ts` already derives from the token; it uses `server.tool(name, description, shape, handler)`). `src/app/api/mcp/route.ts` gets **one** guarded call before `server.connect`: `if (isCockpitEnabled()) registerCockpitTools(server, ctx)`. The `McpServer` is built per request, so the flag is read per request. Domain logic lives in `src/lib/cockpit/*`, schemas in `src/lib/cockpit/schemas.ts`. Descriptions live in a new `src/lib/mcp/tools/cockpitDescriptions.ts` (a separate `as const` map); `src/lib/mcp/toolDescriptions.ts` (shared with `evals/mcp-tools`) is **not** edited, so the flag-off tool list is identical to upstream. Each description states the contract, because descriptions are prompt surface: call `attach_file` first, then `submit_application_package` with the returned `fileId` as `cvFileId`; `CONFLICT` means replay the whole submit; there is no approve or send tool. **Every cockpit tool checks its scope** (the unscoped pattern of `review_resume` / `save_resume_review` is not copied). Order in every handler: scope check → rate limit → re-parse the input with `XSchema` → DB.

**Schemas.** For each tool, `schemas.ts` exports both `XInputShape` (raw zod shape, field-level rules only, e.g. the `contentBase64` max; this is what `server.tool` takes, as in `src/models/mcp.schema.ts`) and `XSchema` (`z.object(XInputShape)` plus cross-field `.refine`s). The handler re-parses with `XSchema`. Shape violations are rejected by the SDK before the handler runs, with the SDK's own error text; only post-shape failures reach the handler's `VALIDATION`. Tests therefore assert that an error result (`isError: true`) is returned for shape violations, not its exact text.

**Rate limit.** `checkMcpRateLimit(userId, opts?: { bucket?: string; max?: number; windowMs?: number })` in `src/lib/mcp/rate-limit.ts` is extended in a backward-compatible way: without `opts` the key, the limit (60 per hour) and the window are unchanged, so existing tools and their mocks keep working; with `opts.bucket` the key is `<userId>:<bucket>`. Cockpit buckets (values in `src/lib/cockpit/config.ts`): `cockpit`, **120 per hour**, for every cockpit tool (the general 60/h bucket is not used by cockpit tools, so a bot loop of `list_jobs` / `get_job` / `attach_file` / `submit` is not starved); `cockpit-attach`, **30 per hour**, for `attach_file` on top of `cockpit` (a denied second check has already consumed one `cockpit` token; accepted). The store is per-process memory: it resets on restart and is not shared across replicas (fine for the single-container target). A denied call returns `isError: true` with `RATE_LIMITED`.

New scopes:
- `jobs:read`: read jobs and packages.
- `package:write`: submit packages, attach files, close change requests.

The scope strings are defined once, as `COCKPIT_SCOPES = ["jobs:read", "package:write"] as const` in `src/lib/cockpit/config.ts`, and spread into the default array in `src/actions/mcpToken.actions.ts` (now five scopes) **always**, whatever the flag: the tools are only registered when the flag is on, so with the flag off the extra scopes grant nothing. The existing token test is updated to the five-element default. Existing tokens are unchanged: the user must create a new token. Because the defaults apply to every new token, the handoff recommends a **dedicated token for the bot** so other tokens are not widened by habit. `find_job` stays on `jobs:write` (it predates `jobs:read`; do not "fix" it).

| Tool | Scope | Input | Output |
|---|---|---|---|
| `attach_file` | package:write | `{ fileName: string ≤120, mimeType: "application/pdf", contentBase64: string ≤ 7,000,000 }` | `{ fileId, fileName, sizeBytes }` |
| `submit_application_package` | package:write | `{ jobId, emailTo?, emailSubject, emailBody, letterMd?, fitGrade, fitAnalysis?, cvJson?, cvFileId?, sourceFolder?, idempotencyKey? }` | `{ packageId, version, status, supersededIds, idempotent }` |
| `list_jobs` | jobs:read | `{ status?: string (JobStatus value), hasPackage?: boolean, limit?: 1–100 (default 50), offset?: ≥0 }` | `{ total, jobs: [{ id, title, company, status, jobUrl, createdAt, appliedDate, activePackage: { id, version, status } \| null }] }` |
| `get_job` | jobs:read | `{ jobId }` | job fields (title, company, location, status, jobUrl, description, matchScore, applied, appliedDate) + `packages: [all versions, newest first, every package field except `cvFileId`; `cvFile: { id, fileName } \| null`]` |
| `list_change_requests` | jobs:read | `{ limit?: 1–100 }` | `[{ packageId, jobId, jobTitle, company, version, changeRequest, changeRequestedAt, emailTo, emailSubject, emailBody, letterMd, cvJson, fitAnalysis, sourceFolder }]` for packages in `changes_requested`, oldest first |
| `mark_change_request_done` | package:write | `{ packageId, response: string 1–2000 }` | `{ packageId, status: "pending" }`. Only from `changes_requested`; otherwise error `INVALID_STATE` |

`attach_file` rules:
- `contentBase64` is capped in `AttachFileInputShape` (7,000,000 chars) before decoding. Decoded size ≤ `APP_CONSTANTS.MAX_RESUME_FILE_SIZE_BYTES` (5 MB; reused, not redefined).
- Content must start with `PDF_MAGIC` (imported from `@/lib/ai/import/extract-text`, reused).
- The file name is sanitized to `[A-Za-z0-9._-]`, ends in `.pdf`, and is shown to the user.
- Stored at `<UPLOADS_DIR>/files/cockpit/<userId>/<uuid>.pdf`, with a `File` row (`fileType: "application/pdf"`) created by `prisma.file.create` directly in `src/lib/cockpit/attachments.ts` (not through the resume helpers). The stored path never comes from input. The directory comes from `cockpitUserDir(userId)` in `files.ts`, a **function evaluated at call time**, never an import-time constant (`UPLOADS_DIR` is the relative `"data"` in dev and `/data` in production; relative values resolve against `process.cwd()`). Tests point `APP_CONSTANTS.UPLOADS_DIR` at a temp dir. The directory is created with `mkdir -p` at write time.
- ~~**Per-user quota:**~~ **Superseded by D-013: the 200 files / 500 MB quota was removed;** unreferenced uploads older than `COCKPIT_ORPHAN_DAYS` are deleted instead. The original V0 text was: at most 200 files and 500 MB in `<UPLOADS_DIR>/files/cockpit/<userId>/` (one `readdir` + `stat` per call; at most 200 entries); beyond that `TOO_LARGE`.
- **Stricter rate bucket:** `attach_file` also consumes the `cockpit-attach` bucket (30 per hour), after the `cockpit` bucket (see **Rate limit** above).
- No sha256 dedupe in V0 (YAGNI).
- Unreferenced files are not cleaned up in V0 (logged as a follow-up).

**Error style (new, explicit):** cockpit tools return `isError: true` with a text `"<CODE>: <message>"`, so the bot can tell a rejected call from a success. The message comes from the same fixed map as the actions (`COCKPIT_ERROR_MESSAGES`, §1 P6), built by one shared helper `cockpitToolResult(code)` in `cockpit.ts`. The existing handlers in `route.ts` return plain text without `isError`; the cockpit does not follow them. Codes (all defined in `errors.ts`): `UNAUTHORIZED_SCOPE`, `VALIDATION`, `NOT_FOUND`, `FILE_NOT_FOUND`, `ALREADY_SENT`, `JOB_REJECTED`, `INVALID_STATE`, `CONFLICT`, `TOO_LARGE`, `RATE_LIMITED`. The action-side codes (`UNAUTHENTICATED`, `COCKPIT_DISABLED`, `INTERNAL`, `SEND_OUTCOME_UNKNOWN`, `GMAIL_TOKEN`, `GMAIL_SEND`, `GMAIL_RECONNECT_REQUIRED`, `GMAIL_TIMEOUT`) are in the same enum.

There is **no MCP tool for approve, send, edit or reject.** Two checks:
1. A test asserts the registered tool list contains no name matching `/send|approve|reject/`.
2. A static **import-graph test** fails if anything under `src/lib/mcp/**` or `src/app/api/mcp/**` (transitively) imports `@/lib/cockpit/send` or `@/lib/cockpit/gmail/client`. `send.ts` and `gmail/client.ts` both start with `import "server-only"` (Vitest already aliases `server-only` to a mock, so tests need no stub). The test is `// @vitest-environment node` and resolves `@/` aliases, relative paths and `import()` expressions.

## 4. File serving

> *Amended by D-011(a):* with no session, `/api/cockpit/files/**` answers with the middleware's 307 redirect to `/signin`, not a 401 (access is still denied). *Amended by D-015:* `GET /api/cockpit/letter/[packageId]` serves the cover-letter PDF with the same guards and headers.
**`resolveCockpitFile(userId, file)`** (`src/lib/cockpit/files.ts`) is the single helper for path confinement. It runs `path.resolve` / `fs.realpath` on both the file path and `cockpitUserDir(userId)` (= `<UPLOADS_DIR>/files/cockpit/<userId>`, resolved at call time), and requires `resolved.startsWith(base + path.sep)` (so `cockpit/u1` never matches `cockpit/u10`). Stored `File.filePath` values may be relative (`UPLOADS_DIR` is the relative string `"data"` in dev); relative paths resolve against `process.cwd()` (`/app` in the standalone build, where `UPLOADS_DIR` is `/data`). It returns the absolute path or `null`. It is used by submit (§2.2 step 6), send (§6.4) and the file route.

`GET /api/cockpit/files/[packageId]`:
- Checks the flag first (off → 404), then requires a session with `auth()`: **no session → 401** JSON. The middleware also covers `/api/cockpit/**` and may answer anonymous callers first; Phase 4 checks the real behavior with `curl`.
- Loads the package with `{ id: packageId, userId }` and its `cvFile`; a single query on `userId` is the ownership join. The file must pass `resolveCockpitFile`.
- Responds with `Content-Type: application/pdf`, `Content-Disposition: inline; filename="<generated stored name>"` (the generated `<uuid>.pdf`, never the stored `fileName`), `X-Content-Type-Options: nosniff`, and **one** `Content-Security-Policy: sandbox; frame-ancestors 'self'` value, set only by the handler (`sandbox` isolates any JavaScript inside the PDF from the app origin; `frame-ancestors 'self'` allows our own `<iframe>`).
- **Authenticated but missing, not owned, file outside the cockpit dir or unreadable → 404**, always the same empty body. The Gmail `connect` / `callback` routes follow the same rule (flag off → 404, no session → 401).

**Framing headers.** `next.config.mjs` sets a global `X-Frame-Options: DENY` (source `/(.*)`), which also blocks same-origin framing and would break the `<iframe>`. The global rule is **not** narrowed or loosened. A second entry scoped to `/api/cockpit/files/:packageId`, with `X-Frame-Options: SAMEORIGIN` only, is **appended after** the global entry in the `headers()` array (Next applies the last matching entry per header key; this comes from the Next docs and is not yet verified in this repo). C-05 adds a unit test on the `headers()` output asserting order and values; the real response (exactly one `X-Frame-Options: SAMEORIGIN`) is checked with `curl -I` in Phase 4, and the real-browser render stays AC-30. The CSP is not in the config (the handler sets it, above). `next.config.mjs` is added to §9.

The upstream `/api/profile/resume?filePath=` route is not used (it has no path confinement; upstream gap, logged in §11, not fixed here).

## 5. UI
Everything is under the dashboard layout, but **every page and query authenticates itself** (P5, AC-40): the layout is not a guard. It uses the existing shadcn components, react-hook-form + zod, and the `@/lib/toast` helpers. UI strings are hard-coded English literals, as in the rest of the app; there are no locale files and no message catalog.

**Layout.** The dashboard puts `children` in a `@3xl/main:grid-cols-3` grid inside an `@container/main` box (`src/app/dashboard/layout.tsx`), and an optional docked chat panel narrows that box. So responsive rules use container variants (`@md/main:`, `@3xl/main:`), not viewport breakpoints, and `src/app/dashboard/review/layout.tsx` wraps every review page (queue, detail, settings) in a full-width `col-span-3` wrapper, so the pages are not squeezed into one third of the width.

Rendering rules for bot-produced content (it derives from untrusted job postings):
- `emailBody`, `emailSubject`, `fitAnalysis` values and `sourceFolder` are text only (`<pre>` / text nodes), never `innerHTML`.
- The letter is the only rich content (§5.3 panel 5).

### 5.1 Navigation
- `SIDEBAR_LINKS` gets `{ icon: Inbox, route: "/dashboard/review", label: "Review", cockpitOnly: true }` after "Jobs" (`Inbox` is added to the lucide import in `constants.ts`; `cockpitOnly` mirrors the existing `devOnly` property). `dashboard/layout.tsx` (a server component) reads `isCockpitEnabled()` and passes an optional `cockpitEnabled` prop (default `false`, so existing tests need no change) to **both** `Sidebar.tsx` (a client component, which cannot read `COCKPIT_ENABLED` itself) and `Header.tsx` (the mobile-nav sheet, built from the same `SIDEBAR_LINKS`). Both filter out `cockpitOnly` links when it is false. No `NEXT_PUBLIC_*`. The coder checks that `NavLink` marks the entry active on `/dashboard/review/[packageId]`.
- The job detail view (`JobDetails.tsx`) gets a small "Application package" card linking to the active package (`v<n> · <status>`). It only shows when the flag is on and a package exists.

### 5.2 Queue: `/dashboard/review`
- One row per job with an active package, newest `createdAt` first.
- Filter tabs (query param `?tab=`):
  - `todo` (default): `pending` + `approved`;
  - `changes`: `changes_requested`;
  - `sent`;
  - `rejected`.
- Each row shows company, role, fit grade badge, version, status badge, submitted time (relative) and recipient (or "apply via link").
- **Readiness chips** on each row, shown only when the condition is a problem or a mode: `Gmail` (package has an `emailTo` and Gmail is not connected / not configured), `PDF stale`, `No CV`, `Link apply` (empty `emailTo`). There is no extra "ready to send" sort or filter.
- **Gmail callout:** a persistent callout at the top of the queue when Gmail is not connected and at least one approved package has an `emailTo`; it links to settings.
- Below the `@md/main` container width the rows render as stacked cards; there is no horizontal scroll at 375 px.
- Empty state per tab, with one sentence explaining where packages come from. Loading state is a `loading.tsx` skeleton.
- A "Gmail: connected as x / not connected" indicator links to `/dashboard/review/settings`.
- A small hint explains the keys: "j / k: next / previous in To do".

### 5.3 Review detail: `/dashboard/review/[packageId]`
> *Amended by D-015:* the Cover letter panel shows the exact PDF that is sent (iframe on `/api/cockpit/letter/[packageId]`) instead of rendered text only.
- **Header:** company, role, job link (opens the posting in a new tab, `rel="noopener noreferrer"`), fit grade, status, and a version selector listing every version (`v3 · pending`, `v2 · superseded` ...).
- **Non-active versions:** a strong banner ("Viewing v2 — superseded. Open v3 to act.") with a link to the active version, and the **action bar is hidden entirely**. Deep links to a package show that package; the banner makes the state obvious.
- **Panels** (two columns at ≥ `@3xl/main`, stacked below):
  1. **Posting:** the job description (rendered the way `JobDetails` renders it) and the URL.
  2. **CV:** the PDF in an `<iframe>` from §4, with a download link. A collapsible "CV data" view shows `cvJson`. A "PDF out of date" warning appears when `cvPdfStale`.
  3. **Fit analysis:** grade, plus `fitAnalysis` rendered as a definition list:
     - string or number values as text;
     - arrays of strings as bullet lists;
     - anything else as pretty JSON in a `<pre>`.
  4. **Email preview:** From (the connected Gmail address, or "not connected"), To (or "Apply via link"), Subject, Body (plain text, whitespace preserved), Attachment (file name **and file size**, read from disk by `getPackageDetail`).
  5. **Cover letter:** `letterMd` rendered by `renderLetterMarkdown` in a new `src/lib/cockpit/markdown.ts`: its own `MarkdownIt` with the same flags as `src/lib/agent/markdown.ts` (`html: false`, `linkify: false`, `breaks: true`, and `image`, `link`, `autolink` disabled, because markdown links and images are network requests steered by injected posting content). It does **not** call `renderAgentMarkdown` (that one runs `stripThinking`, which would alter a letter). The HTML string then goes through `TipTapContentViewer` like `JobDetails` does (TipTap v2 drops unknown tags, which is a second line of defense, not sanitization). The primary test asserts on the markdown-it HTML string: `![x](http://a/b.png)` and `[x](javascript:alert(1))` produce no `<img>` and no `<a>`, and raw HTML is escaped (AC-41).
- **Previous review info:** the reject reason, the change request with its date, and the bot's change-request response, when present (kept as history, §2.1).
- **Send-outcome panel** (only for a locked `approved` package: `sendOutcome="unknown"`, or a lock older than 60 s, see §6.4): "Check your Gmail Sent folder — the send result is unknown", with two actions: **Mark as sent (manual)** and **Release lock**. Within 60 s of the lock without an outcome the UI shows "Sending…". While locked, no other action is offered (the package is frozen).
- **Action bar** (sticky at the bottom on mobile; hidden on non-active versions). Each button appears only in the statuses where its action is allowed (§2.1) and while unlocked. **One primary CTA per state:**

  | State | Primary CTA |
  |---|---|
  | `pending` | Approve |
  | `approved`, send-ready (Gmail connected, `emailTo`, CV file, `!cvPdfStale`) | **Send** (full width) |
  | `approved`, not send-ready | none; a one-line reason explains why (stale PDF → "Ask the bot to re-render") |
  | `approved`, empty `emailTo` | "Open job posting" (external link) |
  | locked | the send-outcome panel actions |

  The other actions (Unapprove, Reject, Request changes, Edit) are secondary. **On mobile they go into a "More" menu sheet.** **Mark applied manually** (only with empty `emailTo`) lives in an overflow menu at every width; its confirm dialog names the company, the role and the posting URL ("Mark Jane Doe's application to <role> at <company> (<url>) as applied? No email will be sent."). No type-to-confirm.
- **Send dialog** (opens from Send). It shows: **To** in large text, From, Subject, the Attachment name and size, and the **full email body, scrollable, plain text**. If the recipient's domain does not match the job's company or posting-URL domain, or is a free-mail domain, a warning is shown. The confirm button reads "Send now". The dialog passes the package's `updatedAt` to `sendPackage` (§6.4).
- **Keyboard:** `j` / `k` move to the next or previous package in the `todo` queue order. They work on the detail page of a `todo` package only (a deliberate V0 limit, with a hint, §5.2). They are ignored while focus is in an input, textarea, select or contenteditable, or while a dialog is open.

### 5.4 Edit mode (same page)
- Editable fields: `emailTo`, `emailSubject`, `emailBody`, `letterMd` (textarea), and the CV fields. Edit is available only while the package is unlocked.
- **CV fields:** every *string leaf* of `cvJson` is rendered as a labelled textarea, with its JSON path as the label (e.g. `experience[0].bullets[2]`). Structure (keys, array length, non-string values) is not editable in V0. The server rejects a payload whose shape differs from the stored `cvJson`.
- Save calls the edit action (§6.1), which validates with the §2.3 schemas.
  - Changing any CV string sets `cvPdfStale = true`. The PDF was rendered by the bot, so the attachment no longer matches.
  - While stale, Send is blocked and the UI offers **"Ask the bot to re-render"**, which is a request-changes call with the prefilled instruction `Re-render the CV PDF from the edited cvJson and resubmit.` Stale packages show a `PDF stale` chip in the queue (§5.2). No 24 h warning before editing.
- Cancel discards. Leaving with unsaved changes asks for confirmation.

### 5.5 Settings: `/dashboard/review/settings`
- Gmail card. When not connected: "Connect Gmail", which goes to `/api/cockpit/gmail/connect`. When connected: the address, the granted scopes, and "Disconnect".
- The `GmailAccount` is always read with an explicit `select` (`email`, `scopes`). `encryptedRefreshToken` and `iv` never reach a server-component prop passed to a client component, and never appear in `getPackageDetail` (AC-43).
- If `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` or `COCKPIT_GMAIL_ALLOWED_ADDRESS` is missing, the card shows "Gmail is not configured" and lists the env vars to set (the connect button is disabled).
- A `?error=<code>` banner is rendered from a fixed code → message map (§6.2). An unknown value shows a generic message. The raw query value is never printed.

## 6. Server actions and send
### 6.1 Review actions: `src/actions/cockpit.actions.ts`
Each action:
- runs inside `try`, calls `requireUser()` **first**, then checks the flag (§1 P4–P6); a throw becomes a failure result and no DB write happens;
- loads the package with `{ id, userId }` (else `NOT_FOUND`);
- checks the §2.1 transition with a conditional `updateMany({ where: { id, userId, status: { in: allowed }, sendStartedAt: null } })`, where a count of 0 means `INVALID_STATE`;
- calls `revalidatePath("/dashboard/review")` and `revalidatePath("/dashboard/review/<id>")`;
- returns `{ success: true, data }` or `{ success: false, code, message }` (§1 P6), never through `handleError`.

Actions:
- `approvePackage(id)`, `unapprovePackage(id)`
- `rejectPackage(id, reason)`
- `requestPackageChanges(id, instruction)`
- `updatePackageContent(id, { emailTo?, emailSubject?, emailBody?, letterMd?, cvJson? })`
- `markPackageAppliedManually(id)`. Only when `emailTo` is empty and the package is unlocked. Sets `sent`, `sentVia="manual"`, `sentAt`, and job → `applied` (same job update as §6.4 step 5). No `SentEmail` row.
- `getReviewQueue(tab)`, `getPackageDetail(id)`, `getAdjacentPackageIds(id)`

**`"use server"` rules:** every exported async function in a `"use server"` file is a public POST endpoint. (a) `cockpit*.actions.ts` start with `"use server"` and export only `async function`s (plus erased `export type`s): no zod schemas, constants, classes or `CockpitError` (a non-function export fails the Next build). They export only the intended actions listed in §6.1, §6.4 and §6.2 (`disconnectGmail`). (b) Helpers (`sendApplicationPackage`, `buildMimeMessage`, `resolveCockpitFile`, `toActionResult`, schemas, constants) live in non-`"use server"` modules; `requireUser` is imported from `@/actions/shared`. (c) `server-only` modules (`gmail/client.ts`, `send.ts`) are imported only from these action files and other server code, never from client components. A static test checks each file's export list (AC-44).

### 6.2 Gmail OAuth (`src/lib/cockpit/gmail/oauth.ts`, `src/app/api/cockpit/gmail/{connect,callback}/route.ts`)
> *Amended by D-010:* a reconnect with the same account does not revoke the old token (they share one grant). *Amended by D-012:* cockpit packages, sent-email rows and their CV files are now part of backups; `GmailAccount` is still never exported (see the Backup bullet).
- **Config (env):**
  - `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`;
  - `GOOGLE_REDIRECT_URI`, default `http://localhost:3737/api/cockpit/gmail/callback`;
  - **`COCKPIT_GMAIL_ALLOWED_ADDRESS`, required to enable Send:** the connected address must equal it (case-insensitive). If unset, the settings card says so and Send is unavailable.
- **Origin:** the scheme and base URL come from `GOOGLE_REDIRECT_URI`, never from `req.url` or `Host` / `X-Forwarded-*` headers (behind a TLS proxy `req.url` is the internal address). Every redirect is `new URL(path, <origin of GOOGLE_REDIRECT_URI>)`.
- **Client type:** both route handlers work with either a Google "Web application" client (with that redirect URI registered) or a "Desktop app" client (Google accepts loopback redirects for those). Which one to use is a handoff decision for the user.
- **Scopes requested:** `https://www.googleapis.com/auth/gmail.send openid email`. `gmail.send` cannot read the profile; `openid email` only identifies the account, and grants no mailbox access. Also `access_type=offline` and `prompt=consent`, so a refresh token is always returned.
- **Pre-check:** before the code exchange, `ENCRYPTION_KEY` must be set (so a refresh token is never left unstored at Google). Otherwise `?error=encryption_unavailable`.
- **`connect` (GET, session required):**
  - creates `state` (32 random bytes, base64url), a PKCE `code_verifier` and a `nonce`;
  - stores `{ state, verifier, userId, nonce }` in an httpOnly cookie: `SameSite=Lax`, `Path=/api/cockpit/gmail`, `Max-Age=600`, `Secure` iff `GOOGLE_REDIRECT_URI` is https;
  - redirects to Google's auth URL with `code_challenge_method=S256` and the `nonce`.
- **`callback` (GET, session required):**
  - **the cookie is deleted on every exit path, including errors;**
  - checks `state` against the cookie (constant-time compare) **first**, and that the cookie `userId` equals the session user (`?error=session_mismatch` otherwise); only then handles Google's `?error=`;
  - exchanges the code with the verifier at `https://oauth2.googleapis.com/token`;
  - **requires `refresh_token`** in the response (`?error=no_refresh_token` otherwise; nothing is stored);
  - reads the `id_token` claims. Signature verification is not needed because the token came directly from Google's token endpoint over TLS (record this in a code comment), but the callback checks `aud === GOOGLE_CLIENT_ID`, `iss ∈ {accounts.google.com, https://accounts.google.com}`, `exp` in the future, and `nonce` equal to the cookie's;
  - requires `email_verified` (accepting boolean `true` or the string `"true"`), `scope` containing `gmail.send`, and the allowed-address match;
  - if a `GmailAccount` already exists, **revokes the old refresh token** (best effort) before replacing it;
  - encrypts the refresh token with `encrypt()` from `src/lib/encryption.ts` and upserts the `GmailAccount` for the user;
  - redirects to `/dashboard/review/settings?connected=1`, or `?error=<code>` on failure.
- **Error codes** are a fixed enum defined in `oauth.ts`, with a code → message map used by the settings banner: `invalid_state`, `session_mismatch`, `access_denied`, `no_refresh_token`, `bad_id_token`, `email_unverified`, `missing_scope`, `address_not_allowed`, `not_configured`, `encryption_unavailable`, `token_exchange_failed`. Errors never echo tokens or Google's raw response.
- **Disconnect** (server action `disconnectGmail`): best-effort revoke at `https://oauth2.googleapis.com/revoke`, then delete the row.
- **Typed Google errors and logging:** every token-endpoint, revoke and Gmail call goes through a wrapper in `gmail/client.ts` that maps any failure to a fixed typed `CockpitError` (codes in `errors.ts`) with the HTTP status code only: `GMAIL_TOKEN`, `GMAIL_SEND`, `GMAIL_RECONNECT_REQUIRED`, `GMAIL_TIMEOUT` (each carries a `definitive` flag, §6.4). The response body, request body and headers are never logged or put in an error message. Tokens, codes and secrets are never logged. A test feeds a mock `fetch` that returns `refresh_token=SECRET` and asserts that no logged value contains `SECRET` (AC-36).
- **Decrypt failures:** `decrypt()` throws when `ENCRYPTION_KEY` is missing or changed. Send maps this to `GMAIL_RECONNECT_REQUIRED`, never a 500.
- **Backup:** V0 does not add the cockpit tables to the backup. The requirement is that the backup export **never includes `GmailAccount`** (AC-39). C-09 reads the backup implementation (and `backupRoundTrip.spec.ts`) first: if it dumps tables generically, it excludes `GmailAccount` (and `SentEmail` / `ApplicationPackage` only if that is needed to keep `backupRoundTrip.spec.ts` green) and logs what it found in `DECISIONS.md`. Including packages in backups is a V1 hook (§11).

### 6.3 MIME (`src/lib/cockpit/gmail/mime.ts`)
> *Amended by D-015:* `buildMimeMessage` takes extra attachments; with letter text the email carries a second PDF (the cover letter) after the CV.
`buildMimeMessage({ from, to, subject, bodyText, attachment: { fileName, content: Buffer } })` returns RFC 5322 text:
- **Headers:**
  - `From`, `To`, `Subject` (RFC 2047 `=?UTF-8?B?...?=` when not ASCII, e.g. the en dash in "Application – Role");
  - `MIME-Version: 1.0`, `Date`, `Message-ID`;
  - `Content-Type: multipart/mixed` with a random boundary.
- **Part 1:** `text/plain; charset=UTF-8`, `Content-Transfer-Encoding: base64` (lines ≤ 76).
- **Part 2:** `application/pdf; name="<file>"`, `Content-Disposition: attachment; filename="<file>"`, base64 (lines ≤ 76).
- Throws if any header value contains CR or LF, **including `To` and the attachment file name**. CRLF line endings throughout.
- Output is base64url-encoded for the Gmail API `raw` field.

### 6.4 Send (`src/lib/cockpit/send.ts`, actions in `src/actions/cockpitSend.actions.ts`)
> *Amended by D-011(b):* a locked, not-approved, stale or non-active package returns `CONFLICT` (the lock case is not `INVALID_STATE`). *Amended by D-015:* the letter PDF is rendered before the send lock is taken and attached after the CV.
`sendPackage(packageId, expectedUpdatedAt)` is a server action. It is the **only** caller of `sendApplicationPackage(userId, packageId, gmailClient)`. `expectedUpdatedAt` is the package `updatedAt` the user saw in the Send dialog.
1. `requireUser()` + flag (inside `try`, §6.1). Load the package for the user. Require:
   - `updatedAt` equal to `expectedUpdatedAt` (else `CONFLICT`: the package changed since the dialog opened);
   - `status === "approved"` and `sendStartedAt === null`;
   - `emailTo` valid, and the §2.3 schemas pass for `emailTo` and `emailSubject` (defense in depth against rows from older code paths);
   - `cvFile` present and resolvable by `resolveCockpitFile`;
   - `!cvPdfStale`;
   - a `GmailAccount` for the user, and `COCKPIT_GMAIL_ALLOWED_ADDRESS` set and equal to the account's address.

   Any failure gives a typed error, with no side effects.
2. **Lock:** `updateMany({ where: { id, userId, status: "approved", sendStartedAt: null }, data: { sendStartedAt: now } })`. A count of 0 gives `INVALID_STATE` ("already sending or sent"), which prevents a double send from two clicks or tabs.
3. **Re-read** the package after the lock (step 1 read before it) and re-run the content checks on the re-read row. The MIME is built from the re-read content. A failure here is a definitive pre-send failure (step 5a).
4. Decrypt the refresh token, get an access token, build the MIME (§6.3), and call Gmail `POST https://gmail.googleapis.com/gmail/v1/users/me/messages/send` with `{ raw }`, with a **20 s timeout**.
5. **On Gmail failure**, classify it:
   - **5a. Definitive (nothing was sent):** token-endpoint failure, `invalid_grant`, decrypt failure, a Gmail 400 / 401 / 403, or a MIME / content-check failure. Clear `sendStartedAt` (the package stays `approved`) and return the typed error without the response body. `invalid_grant` and decrypt failures return `GMAIL_RECONNECT_REQUIRED`.
   - **5b. Ambiguous (the message may have been sent):** timeout, network error, a 5xx, or a 429. **Keep the lock** and set `sendOutcome = "unknown"`. Return `SEND_OUTCOME_UNKNOWN`. The UI shows the send-outcome panel (§5.3): "Check your Gmail Sent folder", with **Mark as sent (manual)** and **Release lock**.
6. **On success,** in one transaction:
   - package → `sent`, `sentAt`, `sentVia="gmail"`, `sendOutcome = null`, through a **conditional** update `updateMany({ where: { id, userId, status: "approved", sendStartedAt: { not: null } } })`; a count of 0 is logged as an inconsistency;
   - create `SentEmail` (fromAddress, toAddress, gmailMessageId, threadId);
   - job: `statusId` = the `JobStatus` with `value: "applied"`, `applied = true`, `appliedDate = now`.

   If this transaction fails, `sendStartedAt` stays set, so the package can't be sent again. The error is logged with the Gmail message id. This is the same state as a process crash (lock held, outcome unknown): the user recovers with the same panel.
7. `revalidatePath` for the queue, the detail page and `/dashboard/myjobs`.

**Stale lock:** a lock without `sendOutcome` that is older than 60 s (the 20 s timeout plus margin) counts as unresolved, so a crash or a failed step-6 transaction leaves no dead end. The send-outcome panel then appears.

**Recovery actions** (exported from `cockpitSend.actions.ts`, same `requireUser()`-first rule). Both require `status = "approved"` and `sendStartedAt` not null, and are conditional `updateMany` calls:
- `markSendUnknownAsSent(id)`: package → `sent`, `sentVia="manual"`, `sentAt`, `sendOutcome = null`, and the job → `applied` (as step 6). No `SentEmail` row, since no Gmail message id is known.
- `releaseSendLock(id)`: clears `sendStartedAt` and `sendOutcome`; the package is `approved` again.

**Gmail client injection:** `src/lib/cockpit/gmail/client.ts` (`import "server-only"`) exports an interface `GmailClient { getAccessToken(refreshToken): Promise<string>; sendRaw(accessToken, raw): Promise<{ id: string; threadId: string }>; revoke(token): Promise<void> }` and `createHttpGmailClient()`. **`createHttpGmailClient()` throws when `process.env.VITEST` is set**, a safety net so no test can reach Google. Tests pass a mock client. Failures are mapped to the typed errors of §6.2.

## 7. Configuration summary (`.env.example` additions, documented only)
`COCKPIT_ENABLED=false`, `GOOGLE_CLIENT_ID=`, `GOOGLE_CLIENT_SECRET=`, `GOOGLE_REDIRECT_URI=http://localhost:3737/api/cockpit/gmail/callback`, `COCKPIT_GMAIL_ALLOWED_ADDRESS=you@example.com` (required for Send).

## 8. Out of scope (V1/V2, not built)
Reply mirroring, status suggestions, follow-ups, .ics, CV diff vs master, truthfulness guard, stats, reject-reason learning, PWA/push, bulk approve, in-app PDF rendering, cleanup of orphan files, sha256 dedupe of uploads, extra queue sort by readiness, `j` / `k` outside the `todo` detail page.

## 9. Allowed core edits
- `prisma/schema.prisma`: new models plus back-relation lines on `User`, `Job`, `File`.
- `src/app/api/mcp/route.ts`: one guarded call to `registerCockpitTools` (§3).
- `src/lib/mcp/rate-limit.ts`: `checkMcpRateLimit(userId, opts?)`, backward compatible (§3). `src/lib/mcp/toolDescriptions.ts` is **not** edited.
- `src/actions/mcpToken.actions.ts` (+ the existing token test): default scopes, spreading `COCKPIT_SCOPES`.
- `src/lib/constants.ts`: the `SIDEBAR_LINKS` entry (`cockpitOnly`) and the `Inbox` import.
- `src/components/Sidebar.tsx`, `src/components/Header.tsx`, `src/app/dashboard/layout.tsx`: the `cockpitEnabled` prop and the `cockpitOnly` filter (§5.1).
- `src/components/myjobs/JobDetails.tsx` (+ its page, to pass data): the package card.
- `next.config.mjs`: the scoped header entry for `/api/cockpit/files/:packageId`, appended after the global one (§4).
- Backup export code: only if it dumps tables generically (§6.2).
- `.github/workflows/*`, `package.json` / `package-lock.json` (`jsdom` only if it is not already a devDependency), `.env.example`.

## 10. Acceptance criteria
Verification types:
- **U:** Vitest unit test. Mock `@/lib/db` (default export `prisma`) and `@/utils/user.utils` per the repo convention; do not mock `@prisma/client`. `server-only` is already aliased by the Vitest config. Where a unit test needs `prisma.$transaction`, mock both its callback and array forms; prefer I tests for §2.2. The default environment is jsdom; fs, DB and static tests use `// @vitest-environment node`.
- **I:** Vitest integration test against a temporary SQLite database migrated with `prisma migrate deploy` (`// @vitest-environment node`), through the harness `__tests__/cockpit/helpers/sqlite.ts` (created in C-02): it sets `DATABASE_URL=file:<temp>` **before** the `PrismaClient` is created (the code under test gets it through a `vi.mock("@/lib/db")` factory that imports it dynamically) and runs the migration in `beforeAll`.
- **M:** manual check by the orchestrator (read code / run command).
- **H:** E2E in the handoff (Playwright or human).

| # | Criterion | Verify |
|---|---|---|
| AC-01 | The migration applies cleanly on an empty DB and on a copy of the real DB; existing rows are untouched; it is pure DDL (tables and indexes only, no `ALTER` on existing tables, no data statements), starts with a comment header, and creates `@@index([userId, status, createdAt])` | I + M (Phase 4) |
| AC-02 | First submit for a job creates version 1, `pending` | I |
| AC-03 | Resubmit creates version n+1 and supersedes the unlocked `pending` / `approved` / `changes_requested` ones (a changes_requested one also gets `changeRequestHandledAt`) | I |
| AC-04 | Same `idempotencyKey` returns the existing package, with no new version, including when two submits race: the `P2002` loser returns the existing package with `idempotent: true`, not `CONFLICT` | I |
| AC-05 | Submit fails with `ALREADY_SENT` if the job has any sent package, and with `JOB_REJECTED` if the active package is rejected | I |
| AC-06 | Submit fails with `NOT_FOUND` for another user's job, and with `FILE_NOT_FOUND` for a file outside the user's cockpit dir | I |
| AC-07 | Every input limit in §2.3 is enforced (CR/LF in subject or to, comma in to, sizes) by `XSchema`, and `contentBase64` ≤ 7,000,000 by `XInputShape` | U |
| AC-08 | `attach_file` stores a valid PDF under `files/cockpit/<userId>/`, rejects non-PDF magic, >5 MB, and a hostile file name (path not influenced) | U |
| AC-09 | Each cockpit MCP tool (tested through the registered handler) rejects a token missing its scope with `isError: true` and `UNAUTHORIZED_SCOPE`, before the rate limit is consumed and before any DB access | U |
| AC-10 | New MCP tokens get the three existing defaults plus `jobs:read` and `package:write` (spread from `COCKPIT_SCOPES`), whether or not the flag is on; the existing token test is updated to the five-element default | U |
| AC-11 | `list_jobs`, `get_job`, `list_change_requests` return only the token user's data in the documented shapes | U |
| AC-12 | `mark_change_request_done` moves `changes_requested` → `pending`, stores the response and keeps the change-request fields; it fails with `INVALID_STATE` from other statuses | U or I |
| AC-13 | With the flag on, the registered tool list has no tool matching `/send\|approve\|reject/`; with the flag off, `registerCockpitTools` is not called and the tool list equals upstream's | U + M |
| AC-14 | The review actions follow §2.1 exactly (allowed transitions succeed; all others give `INVALID_STATE`), require a session, are scoped to the user, and every transition/edit `where` includes `sendStartedAt: null` | U |
| AC-15 | `updatePackageContent` validates fields, rejects a cvJson whose shape changed, sets `cvPdfStale` only when a CV string changed, and refuses terminal statuses and locked packages | U |
| AC-16 | *Amended by D-011(a): no session gives the 307 redirect to `/signin`, not 401.* The file route `/api/cockpit/files/[packageId]` serves the user's package PDF inline with `nosniff`, a single `Content-Security-Policy: sandbox; frame-ancestors 'self'` and a generated (not stored) `Content-Disposition` name. Flag off → 404 (checked before auth); no session → 401; authenticated but another user's package, a missing package, or a file outside the cockpit dir → 404 | U |
| AC-17 | The queue shows one row per job (active package) with correct tab filtering and newest-first order | U (query) + H (UI) |
| AC-18 | The detail page shows the five panels (posting, CV, fit analysis, email preview with attachment size, letter); buttons appear only in allowed statuses | U (component) + H |
| AC-19 | `j` / `k` navigate the todo queue and are ignored in form fields; a hint is shown | U (hook) + H |
| AC-20 | Phone width (375 px): no horizontal scroll on the queue and detail pages | H |
| AC-21 | When the flag is off, the sidebar entry and the mobile-nav (`Header`) entry are hidden (`cockpitEnabled` prop from `dashboard/layout.tsx`, default `false`), the pages give 404, and the API gives 404 | U + M |
| AC-22 | OAuth connect sets the cookie `{state, verifier, userId, nonce}` (`Path=/api/cockpit/gmail`, `Max-Age=600`, httpOnly, `SameSite=Lax`, `Secure` iff the redirect URI is https) and redirects to Google with `gmail.send openid email`, offline, consent, S256 and the nonce | U |
| AC-23 | The callback rejects a bad or missing state (checked before `?error=`), a `userId` mismatch, a missing `refresh_token`, an `id_token` with wrong `aud` / `iss` / `exp` / `nonce`, an unverified email (`true` and `"true"` both accepted when verified), a missing `gmail.send` scope, and a non-allowed address; it checks `ENCRYPTION_KEY` before the exchange; it deletes the cookie on every exit; it redirects relative to the origin of `GOOGLE_REDIRECT_URI`; on success it revokes the previous token (mock) and stores the refresh token **encrypted** (never in plaintext) | U |
| AC-24 | MIME output: correct headers, RFC 2047 subject, base64 body and attachment, CRLF; header injection throws, including CR/LF in `To` and in the attachment name | U |
| AC-25 | *Amended by D-011(b): lock and precondition failures are `CONFLICT`.* Send succeeds only from `approved` with all preconditions (including `expectedUpdatedAt` match and an allowed address that is set and equal). On success: package `sent`, `SentEmail` row, job `applied` + `appliedDate`; the step-6 package update is conditional | U (mock Gmail) |
| AC-26 | The send lock prevents a second concurrent send. A **definitive** failure (token error, Gmail 400/401/403) clears the lock and leaves the package `approved`. `invalid_grant` and a decrypt failure give `GMAIL_RECONNECT_REQUIRED`. The package is re-read after the lock | U (mock Gmail) |
| AC-27 | `createHttpGmailClient()` throws under Vitest; no test performs network I/O to Google | U + M |
| AC-28 | Only the `sendPackage` server action calls `sendApplicationPackage` (grep check, complemented by AC-35) | M |
| AC-29 | Mark applied manually works only with an empty `emailTo` and an unlocked package, sets job `applied`, and its confirm text names company, role and URL; it lives in an overflow menu | U + H (UI) |
| AC-30 | Real Gmail connect, the first real send, and the PDF rendering in the `<iframe>` in a real browser | H |
| AC-31 | Lint, typecheck and Vitest no worse than the baseline (1 known failing test in `DataSettings.spec.tsx`). Existing tests stay green after the schema, token-scope and `checkMcpRateLimit` changes, in particular `backupRoundTrip.spec.ts`, the Sidebar tests and the MCP tests that mock `checkMcpRateLimit`; the token test is updated for the five-scope default | M |
| AC-32 | The `jobsync-cockpit:v0` Docker image builds | M |
| AC-33 | *Amended by D-011(b).* **Send-outcome-unknown flow.** On timeout (20 s), network error, 5xx or 429, `sendPackage` keeps `sendStartedAt`, sets `sendOutcome="unknown"` and returns `SEND_OUTCOME_UNKNOWN`. A lock older than 60 s with no outcome counts as unresolved. `markSendUnknownAsSent` → `sent`, `sentVia="manual"`, job `applied`, no `SentEmail`; `releaseSendLock` → `approved`, lock and outcome cleared. Both act only on a locked `approved` package. A failed step-6 transaction leaves the lock set. The UI shows the "Check your Gmail Sent folder" panel with both actions | U (mock Gmail) + U (component) |
| AC-34 | **Locked package is frozen.** With `sendStartedAt` set, approve, unapprove, reject, request changes, edit, mark applied manually and supersede all affect 0 rows (`INVALID_STATE` / not superseded), and `submitPackage` for that job returns `CONFLICT` | I |
| AC-35 | **Import-graph test.** Nothing under `src/lib/mcp/**` or `src/app/api/mcp/**` transitively imports `@/lib/cockpit/send` or `@/lib/cockpit/gmail/client`. `send.ts` and `gmail/client.ts` contain `import "server-only"`. The test is `// @vitest-environment node` and resolves `@/` aliases, relative paths and `import()` expressions | U (static test) |
| AC-36 | **No secrets in logs.** With a mock `fetch` returning `refresh_token=SECRET` (token endpoint) and a Gmail error body echoing parts of `raw`, nothing passed to the logger, thrown or returned contains the secret or the body; errors carry only a typed code and status | U |
| AC-37 | **Iframe headers.** `next.config.mjs` `headers()` returns the global `/(.*)` entry (`X-Frame-Options: DENY`) followed by the scoped `/api/cockpit/files/:packageId` entry with `X-Frame-Options: SAMEORIGIN` and nothing else, in that order (unit test on the `headers()` output: order and values); the file route sets `Content-Security-Policy: sandbox; frame-ancestors 'self'` | U (config) + M (`curl -I` on the built app, Phase 4: exactly one `X-Frame-Options: SAMEORIGIN`) + H (PDF renders in the iframe, AC-30) |
| AC-38 | **Superseded by D-013 for the quota part: there is no 200 file / 500 MB quota any more; the 7,000,000-char payload check stays.** **Quota and payload.** `attach_file` returns `TOO_LARGE` beyond 200 files or 500 MB per user (counted from the user's cockpit dir), and a call through the registered tool with `contentBase64` > 7,000,000 chars returns `isError: true` (shape error from the SDK) | U |
| AC-39 | *Amended by D-012: cockpit packages, sent emails and their CV files ARE now in the backup; only `GmailAccount` stays excluded.* **Backup exclusion.** After creating a `GmailAccount` row, the backup export contains no `GmailAccount`, `encryptedRefreshToken` or `iv`. Cockpit packages are not required in the backup (V0); `backupRoundTrip.spec.ts` stays green | I |
| AC-40 | **Null-user, no write.** For every exported function of every `src/actions/cockpit*.actions.ts` (actions and queries) and every cockpit page, with `getCurrentUser → null` (mock `@/utils/user.utils`), the call returns a failure result (pages: redirect, no render) and performs no `prisma.*` call, in particular no write; `requireUser()` runs inside the `try` and before the flag check | U |
| AC-41 | **Letter rendering safety.** `renderLetterMarkdown` (`src/lib/cockpit/markdown.ts`, no `stripThinking`) on `![x](http://a/b.png)` and `[x](javascript:alert(1))` yields an HTML string with no `<img>` and no `<a>`, with raw HTML escaped (primary assertion, on the markdown-it output); the output goes through `TipTapContentViewer`. `emailBody` and `fitAnalysis` render as text / `<pre>` | U |
| AC-42 | **File confinement.** `resolveCockpitFile` accepts only files under `<UPLOADS_DIR>/files/cockpit/<userId>/` (relative `UPLOADS_DIR`, `..` segments, a `cockpit/u1` vs `cockpit/u10` prefix, and a symlink escape all return `null`) | U (temp dir) |
| AC-43 | **Gmail account never reaches the client.** `GmailAccount` is read with an explicit `select` (`email`, `scopes`); the settings page props and `getPackageDetail` output contain no `encryptedRefreshToken` or `iv` | U |
| AC-44 | **`"use server"` exports.** Each `src/actions/cockpit*.actions.ts` starts with `"use server"`; a static test (`// @vitest-environment node`) parses its export list, allows `export type`, and fails on any export that is not an `async function` or not in the intended list (§6.1, §6.2, §6.4) | U (static test) |
| AC-45 | **Send dialog safety.** The dialog shows To in large text, the full scrollable body, the attachment size, and a warning for a domain mismatch or a free-mail recipient; `sendApplicationPackage` re-validates `emailTo` and `emailSubject` | U (component) + U |
| AC-46 | **MCP error style.** Handler-level cockpit tool errors return `isError: true` and text `"<CODE>: <message>"` (message from the fixed map) for every code in §3 reachable after the shape check; SDK shape errors only need to be an `isError: true` result | U |
| AC-47 | **Queue readiness.** Rows show the `Gmail`, `PDF stale`, `No CV` and `Link apply` chips under the stated conditions; the Gmail callout appears when Gmail is disconnected and an approved package with `emailTo` exists | U (component) + H |
| AC-48 | **Detail UX.** On a non-active version the action bar is hidden and a banner links to the active version; each state shows one primary CTA, the rest in a "More" sheet on mobile; Mark applied manually is in the overflow menu | U (component) + H |
| AC-49 | **Result shape.** Cockpit actions and queries return `{ success: true, data }` or `{ success: false, code, message }`; `message` comes from the fixed code → message map; an unexpected error (e.g. a Prisma error with a distinctive message) yields `INTERNAL` with the generic message, and the distinctive text appears in neither the result nor the log; no cockpit file imports `handleError` | U |
| AC-50 | **Rate limit.** `checkMcpRateLimit(userId)` without `opts` behaves exactly as before (existing callers and mocks unchanged); with `bucket` / `max` / `windowMs`, buckets are independent per user. Cockpit tools use bucket `cockpit` (120/h) and `attach_file` also `cockpit-attach` (30/h). A denied call returns `isError: true` with `RATE_LIMITED` | U |

## 11. Handoff notes carried from the reviews
- Create a **dedicated MCP token for the bot** (default scopes apply to every new token).
- Upstream `/api/profile/resume?filePath=` has no path confinement (no resolve-and-prefix check, no ownership check). The cockpit does not use it and does not fix it: it is an upstream gap, logged here only.
- Known risk: some browsers' built-in PDF viewers refuse a PDF served with `Content-Security-Policy: sandbox` inside an `<iframe>`. AC-30 checks this in a real browser. If it fails, record a decision (e.g. drop `sandbox`, keep `nosniff` and the scoped frame rules, or offer download-only).
- Google OAuth client type (Web vs Desktop) is the user's choice.
- V1 hook: including `ApplicationPackage` / `SentEmail` in backups (V0 only guarantees `GmailAccount` is never exported, §6.2). **Done by D-012** (packages, sent emails and their CV files travel in backups).
- The rate limits are per-process memory (reset on restart, not shared across replicas).
