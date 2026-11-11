# Cockpit V0 — AC traceability (SPEC §10)

How this was built: AC → test mapping from a read of test names and `AC-` tags (Vitest under `__tests__/cockpit/`, Playwright under `e2e/cockpit/`, property tests under `__tests__/cockpit/qa/property/`). A spot check of 5 ACs (AC-16, 20, 30, 31, 32) against SPEC found the citations correct. **The other mappings are unverified**: they come from test names and tags, not from reading each assertion. "unit" files are in `__tests__/cockpit/`; "e2e" files are in `e2e/cockpit/`.

Status: **covered** (an automated test asserts the AC), **weak** (partly asserted, gap noted), **missing** (no test), **handoff-only** (only a manual check in `cockpit/HANDOFF-CLAUDE-CODE.md`), **process** (a gate or build step, not a test).

| AC | Tests (file::name) | Status | Note |
|---|---|---|---|
| AC-01 | unit `migration.spec.ts` (pure DDL, header); harness applies the migration in `beforeAll` | weak | Real-DB-copy and row-count check was done by hand in Phase 4 (HANDOFF), not by a test |
| AC-02 | unit `packages.integration.spec.ts` (v1 pending, user-scoped) | covered | |
| AC-03 | unit `packages.integration.spec.ts` (n+1, supersede) | covered | e2e `01-review-flow` also resubmits |
| AC-04 | unit `packages.integration.spec.ts` (replay, race, P2002 loser) | covered | D-008 cross-job key tests in the same file |
| AC-05 | unit `packages.integration.spec.ts` (ALREADY_SENT, JOB_REJECTED) | covered | |
| AC-06 | unit `packages.integration.spec.ts`, `mcpTools.spec.ts` (NOT_FOUND, FILE_NOT_FOUND) | covered | |
| AC-07 | unit `schemas.spec.ts`; property `schemas.spec.ts` | covered | |
| AC-08 | unit `mcpTools.spec.ts` (PDF stored, rejects, hostile name); property `sanitizePdfName.spec.ts` | covered | |
| AC-09 | unit `mcpGuards.spec.ts` (UNAUTHORIZED_SCOPE before rate limit/DB) | covered | |
| AC-10 | unit `mcpTokenScopes.spec.ts` | covered | |
| AC-11 | unit `mcpTools.spec.ts` | covered | |
| AC-12 | unit `mcpTools.spec.ts`, `packages.integration.spec.ts` | covered | e2e `01-review-flow` runs the bot "mark done" step |
| AC-13 | unit `mcpRoute.spec.ts`, `mcpTools.spec.ts` (no send/approve/reject tool); e2e `flag-off` (cockpit tools absent, upstream ones present) | covered | Equality to the full upstream list is not asserted tool by tool. With the flag off the review pages show the not-found UI but answer HTTP **200** (soft 404 from `loading.tsx`), not 404 |
| AC-14 | unit `packages.integration.spec.ts` (transition matrix), `nullUser.review.spec.ts` | covered | |
| AC-15 | unit `packages.integration.spec.ts` (`updatePackageContent`), `cvLeaves.spec.ts` | covered | |
| AC-16 | unit `fileRoute.spec.ts`; e2e `05-file-route` (headers, 404s, unauthenticated 307) | covered | D-011: in the running app unauthenticated is **307 → /signin**, not the spec's 401; the unit test asserts 401 on the bare handler |
| AC-17 | unit `packages.integration.spec.ts` (tab, newest first), `queue.spec.tsx`; e2e `01-review-flow` (tabs follow status) | weak | "One row per job" with two versions is not asserted directly |
| AC-18 | unit `detail.spec.tsx`; e2e `01-review-flow` | covered | |
| AC-19 | unit `detail.spec.tsx` (j/k); e2e `07-responsive-keyboard` (j/k, ignored in fields and dialogs) | covered | Hint text visibility not asserted |
| AC-20 | e2e `07-responsive-keyboard` (375 px on queue, detail, edit, settings, Send dialog) | covered | Known gap: a 120-character unbroken subject scrolls (P3, issue #38, `test.fixme`) |
| AC-21 | unit `nav.spec.tsx`, `queue.spec.tsx`, `detail.spec.tsx`, `fileRoute.spec.ts`, `actions.spec.ts`; e2e `flag-off` | covered | |
| AC-22 | unit `gmailOauth.spec.ts`; e2e `02-gmail-connect` (cookie, Google URL params) | covered | |
| AC-23 | unit `gmailOauth.spec.ts`; e2e `02-gmail-connect` (callback rejections, reconnect) | covered | Reconnect revoke behaviour follows D-010, not the frozen SPEC text |
| AC-24 | unit `mime.spec.ts`; property `mime.spec.ts` | covered | |
| AC-25 | unit `send.integration.spec.ts`; e2e `03-send` (one send, side effects) | covered | Mock Gmail and fake Google only |
| AC-26 | unit `send.integration.spec.ts`; e2e `04-send-failures` (definitive classes, reconnect, lock released) | covered | |
| AC-27 | unit `gmailClient.spec.ts` | covered | "No network anywhere in tests" not asserted globally |
| AC-28 | unit `mcpImportGraph.spec.ts` (only `cockpitSend.actions.ts` imports `sendApplicationPackage`) | covered | |
| AC-29 | unit `packages.integration.spec.ts`, `detail.spec.tsx` | weak | Confirm text with company, role and URL not asserted in an integration or e2e test |
| AC-30 | e2e `02-gmail-connect` (connect against a fake Google only); e2e `06-pdf-iframe` (opt-in probe, not verified) | handoff-only | Real Gmail, first real send and PDF-in-iframe remain manual (`HUMAN-QUEUE.md`) |
| AC-31 | Gate logs: lint, tsc, vitest (3 runs) on `f8192ff` | process | Pass; run 1 had one upstream timeout (`AddExperience`) |
| AC-32 | none | process | Docker image built by hand in Phase 4 from `2297ca3`; not touched in QA; rebuild before deploy |
| AC-33 | unit `send.integration.spec.ts`, `sendOutcome.spec.tsx`; e2e `04-send-failures` (ambiguous classes, panel, release, mark as sent, 20 s timeout) | covered | |
| AC-34 | unit `send.integration.spec.ts`, `packages.integration.spec.ts`; e2e `04-send-failures` (locked package survives reload, bot cannot supersede) | covered | |
| AC-35 | unit `mcpImportGraph.spec.ts` | covered | |
| AC-36 | unit `gmailClient.spec.ts`, `sendNoSecretLogs.spec.ts`; e2e `04-send-failures` (Google body never in the UI) | covered | |
| AC-37 | unit `nextConfigHeaders.spec.ts`, `fileRoute.spec.ts`; e2e `05-file-route` (single `X-Frame-Options: SAMEORIGIN`, CSP, nosniff) | covered | Iframe render is AC-30 |
| AC-38 | unit `mcpTools.spec.ts` (7M shape error; the 200 files / 500 MB quota was removed by D-013, orphan cleanup tested there) | covered | amended by D-013 |
| AC-39 | unit `backupExclusion.spec.ts`, `__tests__/backupCockpit.spec.ts` (real SQLite: no token byte in any archive entry) | covered | |
| AC-40 | unit `nullUser.review.spec.ts`, `nullUser.send.spec.ts`, `nullUser.gmail.spec.ts`, `detail.spec.tsx`, `queue.spec.tsx` | covered | Split over several files; not checked that every exported action is listed |
| AC-41 | unit `letterRender.spec.tsx`; property `markdown.spec.ts` | covered | |
| AC-42 | unit `files.spec.ts`; property `pathConfinement.spec.ts` | covered | Dot-segment userId gap found by the property test, fixed in #37 |
| AC-43 | unit `gmailActions.spec.ts`, `gmailSettings.spec.tsx`, `actions.spec.ts` | covered | |
| AC-44 | unit `actionsExports.spec.ts` | covered | |
| AC-45 | unit `sendOutcome.spec.tsx` (dialog); e2e `03-send` (To, From, subject, size, full body, warnings) | weak | Re-validation of `emailTo`/`emailSubject` inside `sendApplicationPackage` is not singled out in a test |
| AC-46 | unit `mcpTools.spec.ts`, `mcpGuards.spec.ts` | covered | Not every §3 code enumerated |
| AC-47 | unit `queue.spec.tsx` (chips, Gmail callout) | covered | Visual check not automated |
| AC-48 | unit `detail.spec.tsx`; e2e `01-review-flow`, `07-responsive-keyboard` ("More" sheet) | covered | |
| AC-49 | unit `resultShape.spec.ts`, `actionsExports.spec.ts`, `actions.spec.ts` | covered | |
| AC-50 | unit `rateLimit.spec.ts`, `mcpGuards.spec.ts`; property `rateLimit.spec.ts` | covered | Limiter is a fixed window: up to 2×max can pass across a window edge (documented, `V1-IDEAS.md`) |

## Count (50 ACs)

| Status | Count |
|---|---:|
| covered | 43 |
| weak | 4 |
| handoff-only | 1 |
| process | 2 |
| missing | 0 |

Weak: AC-01, AC-17, AC-29, AC-45. The two process ACs (31, 32) have no test by nature. Counts follow the table above; treat the covered number as an upper bound given the unverified mappings.

## Other checks

| Decision | Test |
|---|---|
| D-008 idempotency key reused across jobs → CONFLICT | unit `packages.integration.spec.ts` |
| D-010 same-email reconnect does not revoke the shared grant | unit `gmailOauth.spec.ts`; e2e `02-gmail-connect` |
| D-011 unauthenticated file route → 307 | e2e `05-file-route` |
| D-012 packages, sent emails and CV files travel in backups; `GmailAccount` does not | unit `__tests__/backupCockpit.spec.ts`, `backupExclusion.spec.ts` |
| D-013 no attachment quota; old unreferenced uploads cleaned up (`COCKPIT_ORPHAN_DAYS`) | unit `mcpTools.spec.ts` |
| D-014 Claude prompt button | unit `claudePrompt.spec.tsx` |
| D-015 cover letter as a PDF (route, render, attachment, preview) | unit `letterRoute.spec.ts`, `letterPdf.spec.tsx`, `letterRender.spec.tsx`, `send.integration.spec.ts`; e2e `09-letter-pdf`, `03-send` (both PDFs reach the fake Google) |
| Fake Google refuses what real Google would (no PKCE verifier, wrong secret, wrong redirect, missing Bearer) | unit `fakeGoogle.spec.ts`; e2e `02-gmail-connect` ("token exchange sends PKCE...") |

Accessibility (not an AC): e2e `08-axe` runs axe on queue, detail, edit, settings, Send dialog and outcome panel. Open: focus does not return to Send after Escape (issue #39, `test.fixme`).
