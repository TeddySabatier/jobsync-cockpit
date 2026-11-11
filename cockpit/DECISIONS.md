# Cockpit V0 decisions

Format: id, decision, why, cost if wrong.

## D-001 GitHub issues/PRs pending; stacked branches
- **Status: superseded by D-003** (the real issue/PR flow is used; the stacked-branch idea is kept for ordering only).
- **Decision:** `gh` was not authenticated for the repo owner at the time, so no issues or PRs are created and nothing is merged. Each ticket gets its own branch `cockpit/<n>-<slug>`, pushed to the `private` remote. Branches are **stacked**: ticket N branches from ticket N-1's branch, because later tickets need earlier code. The issue and PR bodies are written to files in `cockpit/pending-github/<n>-<slug>.md`, with the PR base noted. The reviewer verdict is written into that same file in place of a PR comment. Superseded by D-003.
- **Why:** follows the prompt's fallback ("keep working on branches ... never merge locally into the default branch").
- **Cost if wrong:** The owner has to open the PRs in order (or retarget each to `main` after its parent merges). If they are squash-merged in order, the later PRs need a rebase. The handoff gives the exact sequence.

## D-002 Work in a separate worktree
- **Decision:** work in a separate git worktree branched from `private/main`; the primary checkout is left untouched.
- **Why:** the primary checkout shows many files modified (line-ending noise) and may hold the owner's own work. A worktree never touches it, and it is faster for `npm ci` and the tests.
- **Cost if wrong:** none for the code. The worktree is listed in `git worktree list` and can be removed after the push.

## D-003 `gh` is authenticated as TeddySabatier; real issue/PR flow
- **Decision:** `gh` is now authenticated as TeddySabatier (verified with `gh api user --jq .login`). The D-001 fallback is superseded: use the real issue/PR flow via `gh ... --repo TeddySabatier/jobsync-cockpit`, after `gh auth switch --hostname github.com --user TeddySabatier`. The original prompt's "don't use gh" line is overridden by its later explicit gh instructions. No `cockpit/pending-github/` files are needed.
- **Why:** the blocker behind D-001 (stored token rejected) is gone, and the prompt's later instructions ask for issues, PRs and reviewer comments.
- **Cost if wrong:** if the wrong account is active, an issue or PR lands under the wrong account. Run `gh api user --jq .login` before each `gh` write and check it prints `TeddySabatier`.

## D-004 Security review rulings (review-security.md, SPEC v1.1)
All 15 items accepted, with the details below. Source of authority: the owner's handoff rulings on the reviews (kept outside the repo).

| # | Item | Ruling | SPEC |
|---|---|---|---|
| S1 | Lock does not freeze the package | Accept. `sendStartedAt: null` in every transition, edit and supersede `where`. A submit on a locked package returns `CONFLICT`. Step 6 is conditional. `sendPackage(id, expectedUpdatedAt)` re-reads after the lock | §2.1, §2.2, §6.1, §6.4, AC-25, AC-34 |
| S2 | Lock cleared on ambiguous Gmail failure | Accept. New field `sendOutcome String?` (`"unknown"`). Release the lock only on definitive failures (token error, Gmail 400/401/403). Timeout (20 s), 5xx or network error keep the lock and set `"unknown"`. The UI shows "Check your Gmail Sent folder" with **Mark as sent (manual)** and **Release lock**. The same path covers a crash (also UX #2) | §2, §5.3, §6.4, AC-33 |
| S3 | PDF iframe blocked by global `X-Frame-Options: DENY` | Accept. Scoped `next.config.mjs` rule for the file route (`SAMEORIGIN` + `frame-ancestors 'self'`), plus `CSP: sandbox` on the PDF response. `next.config.mjs` added to §9, owned by C-05. Risk noted: some browsers' PDF viewers refuse a sandboxed PDF (AC-30 checks) | §4, §9, §11, AC-37 |
| S4 | Unbounded MCP payload and storage | Accept. `contentBase64` max 7,000,000. Per-user quota 200 files / 500 MB (`TOO_LARGE`) **(quota superseded by D-013: removed)**. Stricter `attach_file` rate bucket reusing `checkMcpRateLimit`. **sha256 dedupe skipped** (YAGNI). Early `Content-Length` reject was in the review but not in the ruling; not added (the schema cap bounds the payload) | §2.3, §3, AC-38 |
| S5 | Letter rendering | Accept. Markdown with links and images disabled (as in `src/lib/agent/markdown.ts`), passed through `TipTapContentViewer`. Test: no `<img>` or `<a>`. Email body and fit analysis as text / `<pre>` only | §5, §5.3, AC-41 |
| S6, S7 | OAuth origin, cookie, state binding | Accept. Origin from `GOOGLE_REDIRECT_URI`. Cookie `Path=/api/cockpit/gmail`, `Max-Age=600`, `Secure` iff https, payload `{state, verifier, userId, nonce}`, deleted on every exit. State checked before `?error=`. `refresh_token` required. Old token revoked on reconnect. Error codes are an enum with a fixed message map | §6.2, AC-22, AC-23 |
| S8 | Allow-list and `id_token` checks | Accept. `COCKPIT_GMAIL_ALLOWED_ADDRESS` is required for Send. Check `aud`, `iss`, `exp`. `email_verified` accepts `true` or `"true"`. Nonce | §6.2, §6.4, §7, AC-23, AC-25 |
| S9 | Secrets in logs and client props | Accept. Every Google call goes through a wrapper that maps failures to typed errors with the status code only. Logging test with a mocked secret. `GmailAccount` read with an explicit `select` | §5.5, §6.2, AC-36, AC-43 |
| S10 | "No send via MCP" guard is a name regex | Accept. Import-graph test, `import "server-only"` in `send.ts` and `gmail/client.ts`, `"use server"` files export only the intended actions | §3, §6.1, AC-35, AC-44 |
| S11 | Action auth must not rely on middleware | Accept. `requireUser()` first, then the flag. Null-user test: failure and no DB write for every exported action | §1 P4/P5, AC-40 |
| S12 | File path confinement | Accept. One helper `resolveCockpitFile(userId, file)` (resolve/realpath, `base + path.sep`). File route becomes `/api/cockpit/files/[packageId]`. `Content-Disposition` uses the generated name. Helper is created in C-03 (submit needs it), extended in C-04 | §4, AC-16, AC-42 |
| S13 | Bot-controlled recipient | Accept. Domain-mismatch / free-mail warning in the Send dialog. Re-validate fields in `sendApplicationPackage`. MIME rejects CR/LF in `To` and the attachment name | §5.3, §6.3, §6.4, AC-24, AC-45 |
| S14 | MCP conventions mismatch | Accept. Cockpit tools return `isError: true` with `"<CODE>: msg"` (a new, explicit style). Handoff: the bot gets its own token. Every cockpit tool checks scope | §3, §11, AC-09, AC-46 |
| S15 | Encryption helper details | Accept. `ENCRYPTION_KEY` checked before the code exchange. Decrypt failure maps to `GMAIL_RECONNECT_REQUIRED`. Backup export must exclude `GmailAccount`, with a test | §6.2, AC-39 |

- **Cost if wrong:** more code and tests in C-04, C-09 and C-10 than the v1 draft (these tickets stay under orchestrator alignment checks). The unverified assumption is that a sandboxed PDF renders in the target browser; if not, AC-30 triggers a new decision.

## D-005 Data review rulings (review-data.md, SPEC v1.1)

| # | Item | Ruling | SPEC |
|---|---|---|---|
| D1 | Models missing from `schema.prisma` (Critical) | **Rejected.** The models are C-02's job; the review checked the code too early. Not a spec change | — |
| D2 | Idempotency race | Accept. On `P2002` for `(userId, idempotencyKey)`, return the existing package with `idempotent: true` | §2.2, AC-04 |
| D3 | Queue index | Accept. `@@index([userId, status, createdAt])` replaces `[userId, status]` | §2, AC-01 |
| D4 | `ALREADY_SENT` is "any sent package" | Keep. Any sent package blocks resubmit (no double apply). Documented | §2.2 step 3, AC-05 |
| D5, D6 | `userId` vs `Job.userId`; file ownership is path-only | Already covered (ownership via `findFirst({ id, userId })`, path check). Documented in the model notes | §2 notes |
| D7 | Retry semantics on `CONFLICT` | Accept. `CONFLICT` means the caller replays the whole submit | §2.2 |
| D8 | Nullable idempotency key in SQLite | No change | §2 notes |
| D9 | `done → pending` and change-request fields | Keep the fields as history | §2.1 |
| D10, D11 | Cascades on `User` and `Job` | Keep the cascades (V0) | §2 notes |
| D12 | Migration style | Accept. Pure DDL with a comment header | §2, AC-01 |

- **Cost if wrong:** D1 rejected means nothing, since C-02 creates the models and AC-01 checks the migration. D4 means a job with an old sent package can never get a new package; the user would have to create a new job.

## D-006 UX review rulings (review-ux.md, SPEC v1.1)

| # | Item | Ruling | SPEC |
|---|---|---|---|
| U1 | Send dialog lacks the body | Accept. Full email body, scrollable, plain text | §5.3, AC-45 |
| U2 | Post-send transaction failure dead end | Merged into S2 (send-outcome panel plus stale-lock rule) | §5.3, §6.4, AC-33 |
| U3 | Stale PDF blocks Send | **Partial.** `PDF stale` chip on the queue row. No 24 h warning | §5.2, §5.4, AC-47 |
| U4 | "Mark applied manually" too easy to tap | Accept. In an overflow menu; confirm text names company, role and URL. No type-to-confirm | §5.3, AC-29, AC-48 |
| U5 | Readiness on queue rows | Accept. Chips: Gmail, PDF stale, No CV, Link apply. No extra sort | §5.2, AC-47 |
| U6 | `j` / `k` limited to the todo detail page | **Rejected.** Stays todo-only; a small hint is shown | §5.2, §5.3, §8, AC-19 |
| U7 | Non-active version confusion | Accept. Action bar hidden on non-active versions, strong banner linking to the active one | §5.3, AC-48 |
| U8 | Attachment shown by name only | **Partial.** Show the file size next to the attachment (no submit-time / inline stale cue beyond the existing warning) | §5.3, AC-18 |
| U9 | No guidance when Gmail is disconnected | Accept. Queue callout when Gmail is disconnected and an approved email package exists | §5.2, AC-47 |
| U10 | Too many actions in the phone bar | Accept. One primary CTA per state, the rest in a menu sheet on mobile | §5.3, AC-48 |

- **Spec choices made while applying these (not in the handoff rulings, flag if you disagree):** (a) an approved package with empty `emailTo` gets "Open job posting" as its primary CTA, since Mark applied manually moved to the overflow menu; (b) a lock older than 60 s with no outcome counts as unresolved, so a crash needs no manual DB fix; (c) the Gmail chip means "package has an `emailTo` and Gmail is not connected".
- **Cost if wrong:** UI tickets C-06, C-07 and C-10 carry a little more work. Rejected U6 may annoy a power user who wants `j` / `k` from the list.

## D-007 Next.js review rulings (review-nextjs.md, SPEC v1.1 → v2)
All 18 items accepted (one with a ruling that adds a requirement instead of a fix). **SPEC frozen at v2 (2026-11-04); later changes need a new DECISIONS.md entry.**

| # | Item | Ruling | SPEC |
|---|---|---|---|
| N1 | `requireUser()` throws, it does not return null | Accept. Every action, query and route calls it first, inside `try`/`catch`; a throw becomes a failure result and no DB write happens. P4/P5/AC-40 reworded | §1 P5/P6, §6.1, AC-40 |
| N2 | `handleError` leaks `error.message`, carries no code | Accept. Not used. Results are `{ success: true, data } \| { success: false, code, message }`, with `message` from a fixed code → message map (never `error.message`), defined in `src/lib/cockpit/errors.ts` (C-02) | §1 P6, AC-49 |
| N3 | P5 rationale inaccurate; layout is not a guard | Accept. Every page, query, action and route authenticates itself; no reliance on middleware or layout | §1 P5, §5, AC-40 |
| N4 | `"use server"` file rules | Accept. Async-function exports only; helpers, schemas and `CockpitError` live in non-`"use server"` modules; `requireUser` from `@/actions/shared` | §6.1, AC-44 |
| N5 | MCP registration is inline in `route.ts` | Accept. All six tools in `src/lib/mcp/tools/cockpit.ts` (`registerCockpitTools(server, ctx)`); `route.ts` gets one call guarded by the flag; cockpit tools return `isError: true` | §3, §9, AC-13, AC-46 |
| N6 | SDK validates the raw shape before the handler | Accept. Schemas export `XInputShape` and `XSchema`; the handler re-parses with `XSchema`; ACs assert an error result, not exact text | §2.3, §3, AC-07, AC-38, AC-46 |
| N7 | Descriptions live in `toolDescriptions.ts` (shared with evals) | Accept. New `src/lib/mcp/tools/cockpitDescriptions.ts`; `toolDescriptions.ts` untouched | §3, §9 |
| N8 | Rate-limit signature cannot do a per-tool bucket | Accept. `checkMcpRateLimit(userId, opts?: { bucket?, max?, windowMs? })`, backward compatible. Buckets: `cockpit` 120/h (all cockpit tools), `cockpit-attach` 30/h (`attach_file`). New `RATE_LIMITED` code. `rate-limit.ts` added to §9. The review's alternative (exempt read tools or reuse the 60/h bucket) is not taken: cockpit tools get their own bucket | §3, §9, AC-50 |
| N9 | Default scopes duplicated; AC-10 breaks an existing test | Accept. `COCKPIT_SCOPES` defined once in `src/lib/cockpit/config.ts`, spread into the defaults **always** (not only with the flag: the tools are only registered when the flag is on). The existing token test is updated. Departs from the review's "only when the flag is on" suggestion | §3, §9, AC-10 |
| N10 | Flag unreadable in the client Sidebar; `Header.tsx` omitted | Accept. `dashboard/layout.tsx` reads the flag server-side and passes an optional prop to `Sidebar` and `Header`; `cockpitOnly` on the link. Three files added to §9 | §5.1, §9, AC-21 |
| N11 | Header precedence for the file route | Accept. Scoped `X-Frame-Options: SAMEORIGIN` entry appended **after** the global one (global not narrowed); the handler sets a single `CSP: sandbox; frame-ancestors 'self'`. C-05 unit-tests the `headers()` output (order and values); real browser stays AC-30 | §4, §9, AC-16, AC-37 |
| N12 | File storage details | Accept. Reuse `PDF_MAGIC` and `MAX_RESUME_FILE_SIZE_BYTES`; storage dir resolved at call time; `mkdir -p`; `prisma.file.create` directly. The upstream `/api/profile/resume` confinement gap is **not fixed**, only noted | §3, §4, §11 |
| N13 | Unauthenticated behavior of `/api/cockpit/**` | Accept. No session → 401; authenticated but missing or not owned → 404; flag off → 404, checked before `auth()`. Real middleware behavior checked in Phase 4 | §1 P4, §4, AC-16 |
| N14 | `renderAgentMarkdown` strips thinking blocks | Accept. New `src/lib/cockpit/markdown.ts` (no `stripThinking`), links and images disabled; the test asserts on the markdown-it HTML string | §5.3, AC-41 |
| N15 | No i18n in the app | Accept. Inline English strings; no locale files, no catalog | §5 |
| N16 | Test conventions | Accept. No `server-only` stub (alias exists); mock `@/lib/db` and `@/utils/user.utils`; C-02 creates the temp-SQLite harness (`__tests__/cockpit/helpers/sqlite.ts`, client created after `DATABASE_URL` is set); C-01 adds `jsdom` only if missing | §10, §9 |
| N17 | Container-query layout | Accept. `@md/main:` / `@3xl/main:` variants; `review/layout.tsx` gives all review pages a full-width `col-span-3` wrapper | §5, §5.2, §5.3 |
| N18 | Backup and new tables | **Ruling (requirement, not a fix).** V0 does not add cockpit tables to the backup. Requirement: the export never includes `GmailAccount`. C-09 reads the backup code; if it dumps tables generically it excludes `GmailAccount` (and `SentEmail` / `ApplicationPackage` only if needed to keep `backupRoundTrip.spec.ts` green) and logs what it found. Packages in backups are a V1 hook | §6.2, §11, AC-39 |

- **Ticket ownership changes (TICKETS.md final):** `errors.ts` and the SQLite harness → C-02; MCP `cockpit.ts`, `cockpitDescriptions.ts`, `attachments.ts`, `rate-limit.ts`, `mcpToken.actions.ts` (+ test), `route.ts` → C-04; `next.config.mjs` → C-05; `layout.tsx`, `Sidebar`, `Header` → C-06; `markdown.ts` → C-07; backup → C-09.
- **New ACs:** AC-49 (result shape and error mapping), AC-50 (rate limit). No renumbering.
- **Cost if wrong:** C-04 and C-05 carry more tests (shape vs schema, rate-limit compatibility, headers order). The unverified assumptions are: Next applies the last matching `headers()` entry per key, and the SDK 1.30 shape-validation text. Both are covered by tests or the Phase 4 `curl -I` check.

## D-008 Idempotency key reused across jobs (C-03 alignment check, refines SPEC §2.2 step 2)

- **Ruling:** an `idempotencyKey` that matches an existing package of the same user but a **different job** is `CONFLICT` (checked in the pre-check and in the `P2002` race path). The same job still replays the existing package with `idempotent: true`.
- **Reason:** silently returning the other job's package would make the bot believe the new job was submitted (wrong-job replay). `CONFLICT` tells the bot to pick a fresh key.
- **Scope:** `src/lib/cockpit/packages.ts` (`submitPackage`) and its integration tests only. SPEC stays frozen; this entry is the amendment of record.

## D-009 Backup finding (C-09, closes N18)

- **Finding:** the backup export (`src/lib/backup/export.ts`) is not a generic table dump. It reads only the models listed in the `INSERT_ORDER` / `MODEL_SPECS` allow-list (`src/lib/backup/ordering.ts`), and `BackupDataSchema` parses the result. `GmailAccount`, `SentEmail` and `ApplicationPackage` are not in that list, so none of them is exported. `backupRoundTrip.spec.ts` is unaffected.
- **Ruling:** no change to the backup code (the "core edit only if it dumps tables generically" condition is false). AC-39 is covered by `__tests__/cockpit/backupExclusion.spec.ts` (a seeded `GmailAccount` appears nowhere in `collectBackupData` or the zip, and `GmailAccount` is not in the model list). Packages in backups stay a V1 hook (SPEC §11).
- **Risk if wrong:** if someone adds `GmailAccount` to `ordering.ts`, that test fails.

## D-010 Gmail reconnect does not revoke a shared grant (C-09 alignment check, overrides D-004 S6/S7 "revoke old token on reconnect")

- **Ruling:** reconnecting with the **same** Google account does not revoke the previous token: refresh tokens for one client + account share one grant, and revoking any of them revokes the grant, so the new token would die with the old one. A reconnect with a **different** email revokes the old account's token (best effort; a different account is a different grant). The `COCKPIT_GMAIL_ALLOWED_ADDRESS` check normally keeps the email the same.
- **Disconnect still revokes** (it ends the whole grant, which is the intent).
- **Rejected post-exchange tokens** (bad `id_token`, wrong address, missing scope) are revoked only when no `GmailAccount` is stored for the user; with a stored connection the new token may share its grant and revoking it would kill the working connection.
- **Scope:** `src/app/api/cockpit/gmail/callback/route.ts` and `__tests__/cockpit/gmailOauth.spec.ts`. SPEC §6.2 stays frozen; this entry is the amendment of record.

## D-011 Phase 4 behaviour vs SPEC wording (integration checks)

| # | Topic | Ruling | SPEC / AC |
|---|---|---|---|
| (a) | Unauthenticated `/api/cockpit/files/**` | **Accept.** No session → the middleware's **307 redirect to `/signin`**, not the **401** in SPEC §4 / AC-16. Access is still denied and no file data is returned. Changing global middleware is a core edit outside V0 scope. | §4, AC-16, D-007 N13 |
| (b) | Send preconditions and lock errors | **Accept.** Sending when the package is already **locked**, **not approved**, **stale** (`expectedUpdatedAt` mismatch), or **not the active version** returns **`CONFLICT`** (SPEC §6.4 says `INVALID_STATE` for the lock case). One code tells the UI to reload. **`sendStartedAt` stays set** after a sent / manual-sent package (`sent` is terminal). | §6.4, AC-25, AC-33 |

- **Cost if wrong:** handoff and E2E docs must describe 307 vs 401 for the file route; UI must handle `CONFLICT` on send reload paths consistently.


## D-012 Cockpit data travels in backups (overrides the V0 part of D-009)

| # | Topic | Ruling | Reason |
|---|---|---|---|
| (a) | `ApplicationPackage`, `SentEmail` and the CV `File` rows they reference are **included** in backup export and import | **Accept (reverses D-009 / D-007 N18 for these tables).** They are added to `MODEL_SPECS` and `INSERT_ORDER` (after `Job`); the `File` scope also matches CV PDFs of the user's packages. | Found in QA: restoring over an account with packages silently deleted them and their sent history (cascade from `Job`), left the CV bytes orphaned on disk, and the pre-import snapshot had no copy to recover from. |
| (b) | `GmailAccount` stays **excluded** | **Keep (AC-39).** Never a backup model; a restore neither exports nor wipes it. | The refresh token must not leave the server. After restoring onto a new instance the owner reconnects Gmail. |
| (c) | Cockpit CV files are restored into `cockpitUserDir(<importing user>)` as `<newFileId>.pdf` | **Accept.** Detection comes from the package rows (`cvFileId`), never from the carried `filePath`; only real PDFs are written; others are dropped and the row keeps a path inside the cockpit folder. | `resolveCockpitFile` and the file route only serve from that folder (SPEC §4). |
| (d) | The wipe deletes the user's old `File` rows **by id** (captured before the transaction) and the old bytes after commit | **Accept.** | By the time the wipe reaches `File`, the `Resume` and package rows are already deleted (`DELETE_ORDER`), so neither branch of the `File` scope matches any more and a scoped delete would leave the rows behind. |
| (e) | Backup format version stays **1** | **Accept, with a known limit.** The new groups default to empty, so older backups still import. The reverse is not clean: an older build of this fork importing a newer backup drops the unknown `ApplicationPackage` / `SentEmail` groups but still imports the CV `File` rows, which then have no owner and are orphaned (rows and bytes), with no warning. Restore a newer backup on a build that includes D-012. | Additive change; this fork has a single deployed version, so a version bump (old builds rejecting v2 cleanly) was judged not worth the churn. Revisit if backups start crossing builds. |

- **Scope:** `src/lib/backup/{ordering,schema,import}.ts`, `__tests__/backupCockpit.spec.ts` and the three backup specs that mock the model list.
- **Not changed:** `GmailAccount` handling, the MCP tools, Send. SPEC stays frozen; this entry is the amendment of record.

## D-013 No attachment quota; unreferenced uploads are cleaned up (overrides D-004 S4 and AC-38 for the quota)

| # | Topic | Ruling | Reason |
|---|---|---|---|
| (a) | The per-user quota of 200 files / 500 MB on `attach_file` is **removed** | **Accept (owner decision, issue #49).** The per-file size cap and the base64 payload cap (7,000,000) stay. | A daily bot counting every file ever uploaded would hit 200 within weeks and then fail every submit with `TOO_LARGE`. |
| (b) | Each `attach_file` first deletes the user's files in `cockpitUserDir` that are **older than `COCKPIT_ORPHAN_DAYS` (default 7, minimum 1)** and referenced by **no `ApplicationPackage` and no `Resume`**, together with their `File` rows (stray files without a row too) | **Accept.** Best effort: a failure of the cleanup never blocks the upload. Files are matched to rows by file name, not by the stored path string (a relative or differently written `UPLOADS_DIR` must not make claimed files look stray); rows are deleted in one transaction only while still unreferenced, and a file whose row was claimed meanwhile is kept. A `COCKPIT_ORPHAN_DAYS` below 1 or not a number falls back to 7 with a logged warning (once per process). A row stored in a foreign path form (another directory, or a Windows-style path) is never cleaned: its file is kept, which is the safe direction but leaves a leak. File names compare case-insensitively. | Bounds the bloat from failed or abandoned submits without a limit. A recent orphan is kept because a submit normally follows within seconds. |
| (c) | Files of packages (pending, superseded, sent, rejected) are **kept** | **Accept.** | They are history and the backup (D-012) carries them; deleting them would break the application thread. |
| (d) | Disk use is otherwise unbounded | **Known limit.** About one CV per application and version; the rate limit on `attach_file` still applies. | A leaked bot token can fill the disk; revoke the token. |

- **Scope:** `src/lib/cockpit/attachments.ts`, `__tests__/cockpit/mcpTools.spec.ts`, `docs/cockpit.md`, `docs/cockpit-bot.md`, `cockpit/qa/TRACEABILITY.md`.
- **Not changed:** the MCP tool list, backup/restore (it never counted quota), Send. SPEC stays frozen; this entry is the amendment of record.

## D-014 "Claude prompt" button on the job page (V1 convenience, no new server surface)

| # | Topic | Ruling | Reason |
|---|---|---|---|
| (a) | The job page gets a **Claude prompt** button (only with `COCKPIT_ENABLED`) that copies a text prompt for the owner to paste into Claude | **Accept (owner request).** Client-side only: no new endpoint, tool, scope or table. | The CV, letter and email are made by the Claude bot, not by JobSync's own AI buttons; this makes starting one application a single click. |
| (b) | The prompt embeds the posting text, marked as data, and says never to send email and never to invent experience | **Accept.** | Same rules as the bot pipeline; the text can come from a third-party posting. |
| (c) | An existing active package is named in the prompt and Claude is told not to resubmit | **Accept.** | Avoids duplicate packages (`ALREADY_SUBMITTED`). |
| (d) | Copy uses `navigator.clipboard`, then `execCommand`, then a text box | **Accept.** | Plain http (a phone over the tailnet) has no `navigator.clipboard`. |
| (e) | `cockpit_submit.py` defaults to `http://127.0.0.1:3737/api/mcp` instead of `localhost` | **Accept.** | On Windows `localhost` tries IPv6 first: about 20 s per request, which made a 39-job import take many minutes. |

- **Scope:** `src/lib/cockpit/claudePrompt.ts`, `src/components/cockpit/ClaudePromptButton.tsx`, `JobDetails.tsx`, the job page, `__tests__/cockpit/claudePrompt.spec.tsx`, `scripts/bot/cockpit_submit.py` (default URL), docs.
- **Not changed:** the MCP tools, Send, backup. SPEC stays frozen; this entry is the amendment of record.

## D-015 The cover letter is sent as a PDF, made by the cockpit from the letter text

| # | Topic | Ruling | Reason |
|---|---|---|---|
| (a) | At Send, when the package has letter text (`letterMd`), the email carries a **second PDF attachment** made from that text, after the CV | **Accept (owner request).** No letter text: no second attachment (CV only, as before). | A cover letter is expected as a document next to the CV. |
| (b) | The PDF is **rendered by the cockpit** (`@react-pdf/renderer`, already a dependency) at Send and at preview time; it is never stored and has no `File` row | **Accept.** Chosen over a bot-rendered PDF. | It always matches what the owner edited in Review: no stale-PDF problem, no migration, no change to the bot, MCP tools, backup or `attach_file`. |
| (c) | Review shows the **exact PDF** in an iframe (`GET /api/cockpit/letter/:packageId`, same guards and headers as the CV route, framed by our own pages only) | **Accept.** | "What I see is what is sent": the preview and the attachment use the same function. |
| (d) | Letterhead (name, title, contact line) comes from the package's `cvJson` (`name`, `title`, `contact`); without it the PDF has no letterhead | **Accept.** | The CV is the source of the owner's details; no extra profile lookup. |
| (e) | Layout: A4, Helvetica 11 pt, paragraphs, bullet lists (nested, numbered), code blocks as plain text, bold and italic; markdown links and images stay inert text. Very long words (a deep link) may break anywhere, the PDF engine adding a hyphen at the break | **Accept, known limit.** The look differs from the Word CV. | Nothing may be cut off silently at the margin or a page end. |
| (e2) | Characters the standard PDF fonts cannot draw: typographic spaces and hyphens become plain ones, arrows and comparison signs become `->`, `>=` and the like, Latin letters with a missing mark keep their base letter (`ł` becomes `l`, `ř` becomes `r`), **letters of other alphabets (Greek, Cyrillic, CJK) show as `?`**, emoji and other symbols are dropped | **Accept, known limit.** Embedding a Unicode font is the follow-up if non-Latin letters matter. | A visible `?` in the preview tells the owner; nothing disappears silently. |
| (e3) | The PDF is rendered **before** the send lock is taken (step 1) and reused after it; it is re-rendered only if the row changed in between, which the `updatedAt` condition rules out | **Accept (review finding).** A render failure is `INTERNAL` with no lock taken and no Gmail call. | A long letter takes seconds to render; inside the lock it would eat the 60 s stale-lock margin and could invite a duplicate send. |
| (f) | The attachment name pairs with the CV name (`Jane_Doe_CV_Acme.pdf` becomes `Jane_Doe_Cover_Letter_Acme.pdf`); the Send dialog lists it | **Accept.** | Recognisable for the recipient. |
| (g) | The email **body** is unchanged: it stays whatever the package says. A body that repeats the whole letter can now be shortened in Review | **Accept.** | Keeps this change small; the bot's default body is a separate choice. |

- **Scope:** `src/lib/cockpit/{letterPdf.tsx,letterName.ts,send.ts,gmail/mime.ts}`, `src/app/api/cockpit/letter/[packageId]/route.ts`, `next.config.mjs` (frame header), `Panels.tsx`, `SendDialog.tsx`, `cockpit.actions.ts` (`letterAttachment`), tests (`letterPdf`, `letterRoute`, `send.integration`, e2e `09-letter-pdf`), docs.
- **Not changed:** schema, backup, MCP tools, the bot script. SPEC stays frozen; this entry is the amendment of record.

## D-016 MCP server review fixes (issue #56; amends N6 and SPEC §3)

| # | Topic | Ruling | Reason |
|---|---|---|---|
| (a) | The handler no longer re-parses with `XSchema`; only the SDK checks the shape (N6 amended) | **Accept (simple route).** Argument shape errors always come back in the SDK format (`MCP error -32602`), even for a token without the scope. `VALIDATION` is only for post-shape failures (a non-PDF). `emptyToNull` is applied in the submit handler. The `XSchema` exports stay for the UI services and tests. | The re-parse could not fail, and the "<CODE>: message" claim in the descriptions was false for the commonest bad-argument case. A scope-less token learning the field schema was judged harmless (it is the owner's own bot). |
| (b) | `TOO_LARGE` reads "The content is too large"; `CONFLICT` reads "The package or job changed, or a send is in progress; fetch the current state and retry the whole request" | **Accept.** | No quota exists since D-013; the same text is shown to the bot and to the owner. The bot rule "replay the whole submit" (D7) stays in the tool description. |
| (c) | A call refused by the `cockpit-attach` bucket spends no `cockpit` slot | **Accept.** `checkMcpRateLimit` gets an optional `peek` flag; `attach_file` peeks the attach bucket first, then spends `cockpit`, then `cockpit-attach`. Supersedes the "accepted" note in SPEC §3. | A bot looping on a refused attach was draining its whole budget. |
| (d) | `get_job` returns an explicit field list; `emailBody`, `letterMd`, `fitAnalysis`, `cvJson` only on the newest version; `idempotencyKey` **is** returned (the bot script `cockpit_submit.py` uses it to recognise its own package after a crash; it is the bot's own key); no `sendOutcome`, `sendStartedAt`, `sentVia`, `cvPdfStale` | **Accept.** SPEC §3 "every field except cvFileId" is amended. | Smaller responses, no internals. |
| (e) | `list_jobs` `hasPackage` means an **active** (non-superseded) package | **Accept.** | Matches `activePackage` and the description. |

- **Scope:** `src/lib/mcp/tools/cockpit.ts`, `cockpitDescriptions.ts`, `src/lib/mcp/rate-limit.ts`, `src/lib/cockpit/{errors,schemas}.ts`, `__tests__/cockpit/*`, `docs/cockpit.md`.
- **Not changed:** legacy tools, in-memory rate-limit persistence, token scope choice. SPEC stays frozen; this entry is the amendment of record.

## D-018 Core library hardening (review 01, issue #53)

| # | Topic | Ruling | Reason |
|---|---|---|---|
| (a) | A send (Gmail, **Mark as sent (manual)** or **Mark applied manually**) moves the job **status** to `applied` **only from `draft` or `new`**; a job already at `interview`, `offer` or any other status keeps its status. Whatever the status, the send **always sets `applied = true`** and sets `appliedDate` to the send time **only when it is empty** (an existing date is never overwritten). One shared helper (`markJobApplied` in `packages.ts`) serves every path and refuses an empty job id | **Accept (review finding; applied/appliedDate rule by maintainer decision on PR #68).** | The owner may have moved the job on by hand; a late send must not rewind the status. But the application did happen: the job card must not say "Not applied" after a real send. Prisma reads `id: undefined` as no filter, a mass-write risk. |
| (b) | `submit_application_package` and the edit schema are **strict**: an unknown key (`emailTooo`) is refused, not dropped. The MCP tool registers the strict object, so the SDK error names the key | **Accept (review finding).** | A dropped `emailTo` typo silently turned a package into "apply via link". |
| (c) | A whitespace-only subject or body is refused (over MCP as an SDK shape error, per D-016 (a); the edit form says "Must not be blank"). The stored text is not trimmed | **Accept (review finding).** | `" "` passed `min(1)`. |
| (d) | A Prisma write conflict on submit is `CONFLICT` (replay), like a version race, not `INTERNAL`: `P2034`, and `P1008` / `P2028`, which is what SQLite busy under concurrent writers actually raises on Prisma (a test holding the write lock from a second connection gets `P1008`, never `P2034`) | **Accept (review finding).** | Same remedy for the bot: replay the whole submit. |
| (e) | Letter markdown: the `reference` rule is off too, so a line like `[1]: https://...` stays visible text. The HTML preview and the letter PDF (D-015) share **one** parser instance (`letterMarkdown` in `markdown.ts`), so they never disagree | **Accept (review finding).** | With links off the definition line vanished from the letter. |
| (f) | Request changes clears `approvedAt`; the next version needs a fresh approval | **Accept (review finding).** | Cosmetic stale timestamp. |
| (g) | `cvPdfStale` stays set once a CV string changed, even if a later edit restores the original text | **Accept, documented.** | Conservative: only the bot re-render clears it. |

- **Scope:** `src/lib/cockpit/{packages.ts,cvLeaves.ts,schemas.ts,markdown.ts,letterPdf.tsx,send.ts}`, `src/components/cockpit/EditForm.tsx`, `src/lib/mcp/tools/cockpit.ts` (submit registration), tests (`packages.integration`, `packages.contention.integration`, `send.integration`, `schemas`, `letterRender`, `mcpTools`, `botSubmitArgs`), docs.
- **Not changed:** schema, Job delete cascade, error messages (owned by other issues). SPEC stays frozen; this entry is the amendment of record.

## D-019 Bot hand-over: replaying a submit is safe; the script retries a CONFLICT once

| # | Topic | Ruling | Reason |
|---|---|---|---|
| (a) | Replaying the whole `attach_file` + `submit_application_package` with the same idempotency key and the same content is **safe** (the server answers with the existing package); consistent with D-016(b), whose `CONFLICT` text says to fetch the current state and retry the whole request | **Accept.** Documented in `docs/cockpit-bot.md`; the server tool description already said so. | The old doc line "do not retry blindly" contradicted it. |
| (b) | The script retries a `CONFLICT` **once** (a second one is reported, no loop; it can mean the owner is sending). Before the replay it **re-reads the job**: another live package (a concurrent run) gives `ALREADY_SUBMITTED`, its own landed package gives the recovered result; only a clean job is replayed, reusing the first upload's file id (no second `attach_file`). `INVALID_STATE` and every other error are never retried | **Accept.** | A concurrent write clears on replay; a real clash (a key used for another job) must reach the operator. |
| (c) | `changes` prints a **summary** by default (`count`, and `truncated` when the list is full; default limit 20); `--full` or `--package ID` prints the content, and `--package` always searches up to 100 requests | **Accept.** | Full items carry the CV, letter and email (up to megabytes) into the bot's context. |
| (d) | `list_change_requests` also returns `fitGrade`, which `--revision` uses as the fit | **Accept.** | The analysis JSON of a package from another client may have no verdict. |
| (e) | Two runs on the same link at once (daily task and the Claude prompt button) are **not** locked; the loser gets `CONFLICT` or `ALREADY_SUBMITTED` | **Accept, documented.** | Rare, and both outcomes are safe. |

- **Scope:** `scripts/bot/cockpit_submit.py`, its tests, `src/lib/mcp/tools/cockpit.ts` (one select field), `.gitignore`, docs.
- **Not changed:** schema, Send, the other MCP tools.

## D-022 Send path review fixes (review 02, issue #54)

The lost-lock cases below need a recovery action (allowed only on a lock older than 60 s or an unknown outcome) to run while the Gmail call is still in flight (20 s timeout): unreachable today, closed anyway because the cost is a double send.

| # | Topic | Ruling | Reason |
|---|---|---|---|
| (a) | Step 6 (success record): if the package is no longer approved **and locked by this send**, the transaction throws and rolls back: no `SentEmail` row, no job update. The owner gets `SEND_OUTCOME_UNKNOWN` | **Accept (review finding).** | It used to only log, then record a `SentEmail` row and mark the job applied on a package that could be released and sent again (its unique `packageId` then failed the second send's step 6 after a real second email). |
| (b) | Every write after the lock (release, outcome flag, step 6) matches the **exact lock timestamp** this send wrote, not just "some lock". The re-read after the lock checks it too | **Accept (review finding).** | Otherwise a late failure of send 1 could release or flag the lock of a send 2 that is in flight. |
| (c) | When the email went out or may have (ambiguous Gmail failure, step 6 failure) and this send's lock is gone while the package is **approved and unlocked**, the package is **locked again** with `sendOutcome="unknown"`. A package locked by another send, or already `sent` (Mark as sent ran), is left alone | **Accept.** | "Release lock" means "the email is not in Gmail"; a late answer proves otherwise, so the owner must check again before any new send. The recovery panel shows at once; both actions work as before. |
| (d) | A letter or CV data that differs after the lock (it cannot, by the `updatedAt` lock condition) gives `CONFLICT` and releases the lock; the letter is **never rendered inside the lock** | **Accept (review finding: remove the impossible branch or make it an assertion).** | Rendering there used the lock window and could send a letter the owner never saw. |
| (e) | `getAccessTokenFromStored` (gmail/client.ts) is **deleted** with its tests; the send service keeps the one decrypt (after the lock; a failure gives `GMAIL_RECONNECT_REQUIRED`) and calls `getAccessToken` through `GmailClient` | **Accept (review finding).** | Production never called it, so its tests covered code the app does not run. Moving decrypt behind the interface would make the test mock re-implement it, the same problem again. The send integration tests cover the real path. |
| (f) | When step 6 fails, the Gmail message id is **logged only**, not stored | **Reject (nit), documented.** | The package has no column for it and the `SentEmail` row is what failed; a column needs a migration for a rare path. |
| (g) | The letter PDF sets react-pdf's hyphenation callback **on every render**, not once at module load | **Reject (nit), documented, tested.** | The callback is process-wide global state. Registering per render is cheap and keeps the letter independent of whatever else registers a callback in the same process. Today the app's other registrations (`(w) => [w]` in the resume and cover-letter exports) run only in the browser (`"use client"` code), so production is not affected; the clash exists in a shared process such as vitest, or if server code ever registers its own callback. |

- **Scope:** `src/lib/cockpit/send.ts`, `src/lib/cockpit/gmail/client.ts` (also: `googleRequest` returns the JSON only; comments on send 4xx and on the `sendRaw` caller), `src/lib/cockpit/letterPdf.tsx` (comment), tests (`send.integration`, `gmailClient`, `letterPdf`, `mime`), `docs/cockpit.md`.
- **Not changed:** the allow-list comparison (issue #71), schema, the Gmail status rules (only 400/401/403 on send are definitive), MIME folding (review nit 8, out of scope).
