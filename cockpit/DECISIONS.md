# Cockpit V0 decisions

Format: id, decision, why, cost if wrong.

## D-001 GitHub issues/PRs pending; stacked branches
- **Status: superseded by D-003** (the real issue/PR flow is used; the stacked-branch idea is kept for ordering only).
- **Decision:** `gh` was not authenticated for the repo owner at the time, so no issues or PRs are created and nothing is merged. Each ticket gets its own branch `cockpit/<n>-<slug>`, pushed to the `private` remote. Branches are **stacked**: ticket N branches from ticket N-1's branch, because later tickets need earlier code. The issue and PR bodies are written to files in `cockpit/pending-github/<n>-<slug>.md`, with the PR base noted. The reviewer verdict is written into that same file in place of a PR comment. Superseded by D-003.
- **Why:** follows the prompt's fallback ("keep working on branches ... never merge locally into the default branch").
- **Cost if wrong:** The owner has to open the PRs in order (or retarget each to `main` after its parent merges). If they are squash-merged them in order, the later PRs need a rebase. The handoff gives the exact sequence.

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
| S4 | Unbounded MCP payload and storage | Accept. `contentBase64` max 7,000,000. Per-user quota 200 files / 500 MB (`TOO_LARGE`). Stricter `attach_file` rate bucket reusing `checkMcpRateLimit`. **sha256 dedupe skipped** (YAGNI). Early `Content-Length` reject was in the review but not in the ruling; not added (the schema cap bounds the payload) | §2.3, §3, AC-38 |
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
