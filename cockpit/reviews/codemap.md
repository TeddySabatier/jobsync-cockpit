# JobSync code map (cockpit recon)

Repo: `<local-checkout>` — Next.js App Router, Prisma + SQLite, NextAuth v5.

## 1. Prisma

**Datasource:** `provider = "sqlite"`, `url = env("DATABASE_URL")`.

**Latest 3 migration folders** (`sort | tail -3` of dirs): `20260904120000_remove_jsearch_rapidapi`, `20260904000000_job_status_offer_outcomes`, `20260813075758_add_activity_breaks`.

### Model fields (verbatim from schema)

**User**
```
id, name, email @unique, password, createdAt
defaultResumeId?, defaultResume?
jobsApplied Job[], JobTitle[], Location[], Company[], JobSource[], Contact[], Profile[], Activity[], ActivityType[], Task[], Automation[], Settings UserSettings?, ApiKey[], Note[], Tag[], Question[], McpAccessToken[], ChatConversation?
```

**JobStatus**
```
id, label, value @unique, jobs Job[]
```
Identified by **`value`** (e.g. `"applied"`). Seeded at signup: `JOB_STATUSES` in `src/lib/constants.ts` → loop `prisma.jobStatus.upsert({ where: { value }, create: status })` in `src/actions/auth.actions.ts`. Extra rows via migration `20260904000000_job_status_offer_outcomes` (INSERT OR IGNORE). Status list includes: new, draft, applied, interview, offer, offer-accepted, offer-declined, rejected, expired, archived.

**Job**
```
id, userId, User, jobUrl?, description, jobType, workplaceType?, createdAt, applied @default(false), appliedDate?, dueDate?, statusId, Status, JobTitle, jobTitleId, Company, companyId, JobSource?, jobSourceId?, salaryRange?, Location?, locationId?, Interview[], Resume?, resumeId?, CoverLetter?, coverLetterId?, Notes Note[], tags Tag[]
automationId?, automation?, matchScore?, matchData?, discoveryStatus?, discoveredAt?, createdVia?, descriptionCompleteness?
@@index([userId, automationId]), @@index([userId, discoveryStatus])
```

**Resume**
```
id, profileId, title, createdAt, updatedAt, ContactInfo?, ResumeSections[], profile, File? @relation FileId, FileId? @unique, Job[], Automation[], defaultForUser User[] @relation("UserDefaultResume"), reviewData?
```

**File**
```
id, fileName, filePath, fileType, uploadedAt, Resume?
```

**CoverLetter** — `id, profileId, title, content, createdAt, updatedAt, profile, Job[]`

**Note** — `id, jobId, job, userId, user, content, createdAt, updatedAt`

**McpAccessToken**
```
id, userId, User, name, tokenHash @unique, tokenPrefix, scopes String // JSON array e.g. ["jobs:write","questions:write","resume:write"]
expiresAt, lastUsedAt?, createdAt
@@unique([userId, name])
```

**ApiKey** — `id, userId, user, provider, encryptedKey, iv, last4, label?, createdAt, updatedAt, lastUsedAt?` @@unique([userId, provider])

## 2. MCP

**Route:** `src/app/api/mcp/route.ts` — POST/DELETE handler; GET → 405. Gated by `MCP_ENABLED` (default on unless `NODE_ENV=production`).

**Auth:** `src/lib/mcp/auth.ts` → `resolveMcpToken(req)`: Bearer token → `hashToken` (`src/lib/mcp/tokens.ts`, SHA-256 hex) → `prisma.mcpAccessToken.findUnique({ tokenHash })`, expiry check, `JSON.parse(record.scopes)`. Per-tool scope checks in route (except `review_resume` / `save_resume_review`).

**Registration example (verbatim pattern):**
```ts
server.tool(
  "add_job",
  MCP_TOOL_DESCRIPTIONS.add_job,
  McpAddJobInputShape,
  async (rawInput) => {
    if (!auth.scopes.includes("jobs:write")) { /* ... */ }
    const parsed = McpAddJobSchema.safeParse(rawInput);
    return handleAddJob(parsed.data, userId, tokenName);
  },
);
```

**Tool handlers:** `src/lib/mcp/tools/` — addJob, addJobsBatch, addQuestion, findJob, updateJob, saveMatchResult, saveMatchResultsBatch, reviewResume, saveResumeReview, matchDirective.

**Smallest tool + zod** — schema in `src/models/mcp.schema.ts`:
```ts
export const McpFindJobInputShape = {
  jobUrl: z.string().url().describe("..."),
};
export const McpFindJobSchema = z.object(McpFindJobInputShape);
```
Handler skeleton `src/lib/mcp/tools/findJob.ts`: `handleFindJob(input, userId)` → rate limit → `findExistingJobByUrl` → prisma select → `{ content: [{ type: "text", text }] }`. Scope check lives in route, not handler.

**Default token scopes:** `src/actions/mcpToken.actions.ts` — `scopes: JSON.stringify(["jobs:write", "questions:write", "resume:write"])`.

## 3. Server actions

Barrel: `src/actions/job.actions.ts` → `src/actions/job/mutations.ts`, `queries.ts`, etc.

Session: `requireUser()` in `src/actions/shared.ts` → `getCurrentUser()` in `src/utils/user.utils.ts` (`auth()` + prisma user exists).

Return shape: `{ success: true, data: job }` or `handleError(...)` from `@/lib/utils`.

```ts
export const addJob = async (data) => {
  const user = await requireUser();
  const job = await createJobRecord({ ... userId: user.id });
  revalidatePath("/dashboard");
  return { success: true, data: job };
};
```

## 4. File upload / download

**Route:** `src/app/api/profile/resume/route.ts` — POST multipart (auth via `auth()`), GET `?filePath=`.

**Storage:** `path.join(APP_CONSTANTS.UPLOADS_DIR, "files", "resumes")` — dev `data`, prod `/data` (`src/lib/constants.ts`). `File` row via profile actions (`createFileEntry`).

**Serve PDF:** GET reads `filePath` query → `fs.readFileSync` → `Content-Type: application/pdf`, `Content-Disposition: attachment`. Client: `DownloadFileButton` → `/api/profile/resume?filePath=...`.

## 5. Sidebar nav

**File:** `src/components/Sidebar.tsx` maps `SIDEBAR_LINKS` from `src/lib/constants.ts`.

```ts
{ icon: LayoutDashboard, route: "/dashboard", label: "Dashboard" },
{ icon: BriefcaseBusiness, route: "/dashboard/myjobs", label: "Jobs" },
```
Optional `devOnly: true` (Developer Options).

## 6. Job detail

**Route:** `src/app/dashboard/myjobs/[id]/page.tsx` → `JobDetails` (`src/components/myjobs/JobDetails.tsx`).

No Radix Tabs; sections inline: header/card, TipTap description, `MatchDetails`, resume download, `NotesSection`, edit via `AddJob` dialog, status dropdown.

## 7. Encryption

`src/lib/encryption.ts`: `encrypt(plaintext): { encrypted, iv }`, `decrypt(encryptedData, iv): string`, `getLast4(key): string`. Env: **`ENCRYPTION_KEY`**. Algorithm: **AES-256-GCM**, PBKDF2-SHA256 (100k iter), per-record salt in iv string.

## 8. Auth

**Config:** `src/auth.ts` (handlers), `src/auth.config.ts` (`AUTH_SECRET`, credentials).

**Middleware** `src/middleware.ts`:
```ts
matcher: ["/dashboard", "/dashboard/:path*", "/api/((?!auth|mcp).*)"]
```

**Current user:** `getCurrentUser()` / `requireUser()` (above). MCP excluded from middleware matcher.

## 9. Scheduler

`src/lib/scheduler/index.ts` — node-cron, automation runs; `timezone: process.env.TZ || "UTC"`. Started from `src/instrumentation.ts` when `NEXT_RUNTIME === "nodejs"`.

## 10. Tests

- **Vitest:** `vitest.config.ts` — `__tests__/` at repo root, `setupFiles`: vitest.polyfills.ts, vitest.setup.ts, jsdom, exclude `e2e/**`.
- **Playwright:** `playwright.config.ts`, `testDir: "./e2e"`.
- **Prisma mock example** (`__tests__/mcpAuth.spec.ts`):
```ts
vi.mock("@prisma/client", () => {
  const mPrismaClient = {
    mcpAccessToken: { findUnique: vi.fn(), update: vi.fn() },
  };
  return { PrismaClient: vi.fn(function () { return mPrismaClient; }) };
});
```

**package.json scripts:** dev, dev:webpack, build, start, lint, test, test:e2e, test:watch, test:coverage, eval:resume-review, eval:job-match, eval:automation-match, eval:resume-import, eval:mcp-tools, eval:agent-chat, eval:all, eval:view.

## 11. UI kit

shadcn/Radix: `src/components/ui/*`. Forms: react-hook-form + `@hookform/resolvers` + zod. Rich text: TipTap; markdown: `markdown-it`. Toast: `@/lib/toast` (toastError, toastSuccess).

## 12. Env vars (src, names only)

AUTH_SECRET, DATABASE_URL (schema), ENCRYPTION_KEY, MCP_ENABLED, NODE_ENV, OLLAMA_BASE_URL, OTEL_EXPORTER_OTLP_ENDPOINT, OTEL_CAPTURE_CONTENT, OTEL_SERVICE_NAME, OTEL_EXPORTER_OTLP_HEADERS, TELEMETRY_ENABLED (telemetry config), TZ, NEXT_RUNTIME, NEXT_TELEMETRY_DISABLED (Dockerfile).

**Docker:** `FROM node:20.20.2-alpine`; **entrypoint** `docker-entrypoint.sh` runs **`npx -y prisma@6.19.0 migrate deploy`** then `node server.js` as nextjs. Port 3737.

## 13. Feature flags

No central flag service. Ad hoc: `MCP_ENABLED`, sidebar/header `devOnly` + `NODE_ENV`, mock actions dev-only, telemetry env toggles.
