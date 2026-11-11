# Cockpit V0 run log

Orchestrator: Claude Opus. Every subagent call is logged with tier and model.
Tiers available in this harness: T0/T1 = `@fast` (composer-2.5-fast), T1+ = `@medium` (claude-sonnet), T2 = `@heavy` / orchestrator (claude-opus).

## Phase 0: recon

| Check | Result |
|---|---|
| Previous run (`cockpit/`) | none, fresh start |
| GitHub `main` | seeded (`3af4f70 Seed from upstream JobSync v1.1.19 (#2)`), not LICENSE-only. OK to branch |
| SSH access to the `private` remote | authenticates as TeddySabatier. OK |
| `git remote -v` | `private` points to TeddySabatier/jobsync-cockpit; `origin` push disabled. OK |
| `jobsyncdb/` ignored | `.gitignore:54:/jobsyncdb/`. OK |
| `AUTH_SECRET` / `ENCRYPTION_KEY` | not the placeholder values (checked in the deployment config, values never printed). Gmail token storage allowed |
| `gh` as TeddySabatier | not authenticated for the repo owner at that point. See DECISIONS D-001 (superseded by D-003) |
| Local main checkout | ~939 files show as modified (line-ending noise, the owner's own working copy). Work happens in a separate worktree off `private/main` so that checkout is never touched |
| Workflows | `ci.yml` (PR on main/dev), `release.yml` (manual, pushes images/releases), `wiki.yml` (push to main, publishes wiki) |
| Latest upstream migration | `20260904120000_remove_jsearch_rapidapi` |

### Baseline (clean worktree at `3af4f70`, Node 24.21)
- `npm ci`, `npx prisma generate`, `npm run lint`, `npx tsc --noEmit`: all exit 0.
- `npx vitest run`: `jsdom` is not installed by `npm ci` (vitest uses `environment: "jsdom"`, but jsdom is not in `package.json`), so 211 of 212 files fail to start. After `npm i --no-save jsdom`: **211 files passed, 1 failed; 2558 tests passed, 1 failed**. The baseline failure is `__tests__/DataSettings.spec.tsx > shows the backup preview after a preflight, without importing` (a `waitFor` timeout, likely load-sensitive). Ticket runs install jsdom the same way. Adding jsdom to devDependencies is left to the CI ticket (C-01), since upstream CI may need it too.

## Subagent calls

| # | Phase/ticket | Agent (model) | Purpose | Attempts | Result |
|---|---|---|---|---|---|
| 1 | P0 | @fast (composer-2.5-fast) | gate checks | 2 | interrupted twice; orchestrator ran the checks directly |
| 2 | P0 | @fast (composer-2.5-fast) | code map | 2 | partial, then completed → `cockpit/reviews/codemap.md` |
| 3 | P1 | orchestrator (Opus) | SPEC.md draft v1, TICKETS.md | 1 | done |
| 4 | P1 SME | @medium (claude-sonnet) | security review | 1 | 15 issues → `cockpit/reviews/review-security.md` |
| 5 | P1 SME | @fast (composer-2.5-fast) | data-model review | 1 | 12 issues → `cockpit/reviews/review-data.md` |
| 6 | P1 SME | @fast (composer-2.5-fast) | product/UX review | 1 | 10 issues → `cockpit/reviews/review-ux.md` |
| 7 | P1 SME | @fast (composer-2.5-fast) | Next.js conventions review | 1 | ended without a result (no file). Must be re-run on resume |

**Run paused by the owner after the Phase 1 SME round. Handoff notes are kept outside the repo.**

| # | Phase/ticket | Agent (model) | Purpose | Attempts | Result |
|---|---|---|---|---|---|
| 8 | C-01 | @medium (claude-sonnet) | fork hygiene: workflows, jsdom, docs scrub | 1 | PR opened; vitest matches baseline (1 pre-existing failure) |
| 9 | C-02 | @medium (claude-sonnet) | Prisma models, migration `20261104120000_cockpit_v0`, `errors.ts`, temp-SQLite harness | 1 | PR opened; vitest matches baseline (1 pre-existing failure) |
| 10 | C-03 | @medium (claude-sonnet) | domain service: config, schemas, files (`resolveCockpitFile`), packages (submit, lifecycle, queries) + unit/integration tests | 1 | PR opened; vitest matches baseline (1 pre-existing failure) |
| 11 | C-04 | @medium (claude-sonnet) | six cockpit MCP tools (`registerCockpitTools`), `attach_file` storage + quota, `checkMcpRateLimit` buckets, default token scopes + tests | 1 | PR opened; vitest matches baseline (1 pre-existing failure) |
| 12 | C-05 | @medium (claude-sonnet) | review actions (`cockpit.actions.ts`), file route `/api/cockpit/files/[packageId]`, scoped `X-Frame-Options: SAMEORIGIN` entry in `next.config.mjs` + tests | 1 | PR opened; vitest matches baseline (1 pre-existing failure) |
| 13 | C-06 | @medium (claude-sonnet) | review queue page (tabs, rows, readiness chips, Gmail callout, loading), `review/layout.tsx`, `cockpitOnly` nav link + `cockpitEnabled` prop to Sidebar and Header + tests | 1 | PR opened; vitest matches baseline (1 pre-existing failure) |
| 14 | C-07 | @medium (claude-sonnet) | review detail page (panels, version selector + banner, action bar, More sheet, mark-applied confirm, j/k), `renderLetterMarkdown`, job-detail package card + tests | 1 | PR opened; vitest matches baseline (1 pre-existing failure) |
| 15 | C-08 | @medium (claude-sonnet) | edit mode (letter, email, CV string leaves via `updatePackageContent`), read-only gating, stale-PDF "Ask the bot to re-render" + tests | 1 | PR opened; vitest matches baseline (1 pre-existing failure) |
| 16 | C-09 | @medium (claude-sonnet) | Gmail OAuth connect/callback (PKCE, state cookie, id_token checks, encrypted refresh token, revoke on reconnect), `gmail/client.ts` typed Google errors, `disconnectGmail`, settings page + `GmailCard`, backup exclusion test + tests | 1 | PR opened; vitest matches baseline (see PR) |
| 17 | C-10 | @medium (claude-sonnet) | MIME builder, send service (conditional lock, re-read, definitive vs ambiguous failures, `sendOutcome`), actions `sendPackage` / `markSendUnknownAsSent` / `releaseSendLock`, Send button + dialog, send-outcome panel, import-graph + export-allowlist updates + tests (mocked Gmail only) | 1 | PR opened; vitest matches baseline (1 pre-existing failure) |
| 18 | C-11 | @fast (composer-2.5-fast) | `docs/cockpit.md`, `.env.example` cockpit block | 1 | PR opened; lint exit 0 |
| 19 | Phase 4 integration | @medium (claude-sonnet) | migration on DB copy, local image `jobsync-cockpit:v0`, MCP E2E on 3738, curl/file-route checks | 1 | **PASS** — `20261104120000_cockpit_v0` clean; row counts unchanged; 3 new tables empty; image `463c02fc5c70` (~364 MB, `2297ca3`); MCP tools/list (6, no send/approve/reject/edit), submit/resubmit/idempotency/change-request flows, scope and PDF validation; unauthenticated file route **307 → /signin** (D-011); `/` **X-Frame-Options: DENY** |
| 20 | Phase 5 handoff | @fast (composer-2.5-fast) | `HANDOFF-CLAUDE-CODE.md`, D-011, RUNLOG rows | 1 | Free models unavailable (3 tried); draft by composer-2.5-fast; reviewed by orchestrator (claude-opus) |

**QA run 2026-11-05** (details in `cockpit/qa/QA-REPORT.md`)

| # | Phase/ticket | Agent (model) | Purpose | Attempts | Result |
|---|---|---|---|---|---|
| 21 | QA overnight | free models via `opencode run` (engine in `scripts/qa/`); paid models for triage, property tests, E2E and fixes | review lanes L1–L4, L6, L7, L10; mechanical quote check; triage; property tests (#32); E2E with fake Google; fixes #34, #37 | 1 night | About 5M tokens against a 100M target (2,349 calls, 722 failed: model unavailable, rate limits). 274 findings indexed, 2 confirmed P3 (fixed), 9 known, 193 rejected. Gates on `f8192ff` green (one upstream test timed out once in 3 runs). E2E: 47 pass, 2 fixme (P3, #38, #39) at that time; later specs (09 letter PDF, fake-Google validation) were added, rerun for the current count. AC-30 PDF render and real Google not verified. |
