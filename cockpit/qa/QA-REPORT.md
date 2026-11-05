# Cockpit V0 — QA report (2026-11-04/05)

Scope: the cockpit V0 code on `main` (about 6,100 lines: `src/lib/cockpit`, `src/lib/mcp`, cockpit actions and API routes, review pages and components, `next.config.mjs`, middleware, schema, the V0 migration). Base: `b8bfad8`; final gates on `f8192ff`.

**Bottom line:** no P0, P1 or P2 bug survived triage. Two P3 defects were confirmed and are fixed (#34, #37). The automated suite is green. What was **not** done is real-world: no real Google account, no PDF-in-iframe check in a real browser. Those are the owner's checks (see `HUMAN-QUEUE.md`).

## 1. Method

1. **Free-model review lanes.** An engine (`scripts/qa/`, PR #30) sent allow-listed source to free models through `opencode run`. The model gets prompt text only and no tools. Lenses: L1 security, L2 state machine and concurrency, L3 data and migration, L4 UX and a11y, L6 Next.js boundaries, L7 SPEC conformance, L10 red team (payload generation).
2. **Mechanical quote check.** A finding survives only if its file exists and its quoted line appears in the file (whitespace-normalised). This killed the "model made it up" class.
3. **Dedupe and vote count**, then **paid-model triage** of the survivors: every in-scope finding (P0, P1, and P2 with at least 2 votes) was read against the real code path including callers. Output: `FINDINGS.jsonl`, `REJECTED.md`, `V1-IDEAS.md`.
4. **Test-writing lanes (not free-model reviews):** L8 property tests (fast-check, PR #32) and L9 end-to-end tests (Playwright against a fake Google, PR for issue #36).
5. **Gates:** fresh `npm ci`, lint, tsc, build, vitest ×3 on `f8192ff`.

Planned but replaced: two named-model verifiers per finding. They failed (section 3), so verification was the mechanical check plus the paid triage.

## 2. Numbers (honest)

Source: engine budget file. Run window 2026-11-04T22:32Z → 2026-11-05T06:21Z; the engine logged `ENGINE done spent=5023430 findings=274`.

| | Value |
|---|---|
| Model calls | 2,349 (1,627 ok, 722 failed, 511 served from cache) |
| Tokens, measured | 4.12M in + 0.68M out = **4.80M** |
| Tokens, estimated | 0.22M (calls where the session export gave no usage; **estimate**) |
| Total | **≈5.02M** |
| Target in PLAN | ≥100M. **Reached ≈5%.** |

**Why the gap.** The plan assumed about 9,000 calls at 11k tokens. The run made 2,349, and 31% of them failed:
- Named models were almost all unavailable: `qwen-3.8-27b` 4% ok (5/138), `gpt-oss-120b` 16% (29/176), `glm-4.7-flash` 8% (11/144), `llama-3.3-70b` 2% (3/129), `nemotron-3-super-120b` 0% (0/50), `gemini-3.8-flash` 0% (0/58). Only `freellmapi/auto` worked: 96% ok (1,579/1,651), but it hides which model answered.
- Failure causes seen in the engine log: model unavailable, Google 400s, rate-limit exhaustion, `ECONNREFUSED`.
- Calls are slow (about 61 s average on `auto`), and the host was memory-starved during the run (swap full, load average about 40 for part of the night), so concurrency could not be raised to catch up.
- The engine did not stop at the target; it ran out of working capacity, not out of ideas. More tokens would mostly have produced more of the same low-precision findings (section 4).

### Per lane

Tokens = measured in+out; "est" = estimated part, shown separately. "Findings" is the raw lane output before dedupe; "invalid" is rejected by the mechanical check.

| Lane | Calls | ok | failed | ok % | Tokens (measured) | est | Findings | Valid | Invalid rate |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| probe | 31 | 18 | 13 | 58% | 93k | 0 | - | - | - |
| L1 security | 721 | 554 | 167 | 77% | 1.66M | 118k | 313 | 177 | 43.5% |
| L2 state/concurrency | 444 | 329 | 115 | 74% | 788k | 35k | 183 | 101 | 44.8% |
| L3 data/migration | 97 | 66 | 31 | 68% | 239k | 9k | 22 | 7 | 68.2% |
| L4 UX/a11y | 92 | 66 | 26 | 72% | 271k | 2k | 53 | 26 | 50.9% |
| L6 Next.js | 98 | 71 | 27 | 72% | 221k | 12k | 38 | 16 | 57.9% |
| L7 SPEC conformance | 331 | 234 | 97 | 71% | 649k | 14k | 150 | 89 | 40.7% |
| L10 red team | 389 | 282 | 107 | 72% | 821k | 32k | 162 | **0** | **100%** |
| verify lanes (L1–L7) | 146 | 7 | 139 | 5% | 65k | 0 | - | - | - |

- **Invalid-quote rate** (quote not found or wrong length) specifically: L1 33%, L2 30%, L3 50%, L4 36%, L6 53%, L7 27%; overall 27% (248 of 921 raw findings). Overall invalid for any reason: 55% (505 of 921), the rest being non-concrete scenarios, schema errors and bad line ranges.
- **L10** produced 162 findings, all rejected for schema, and 677 attack payloads under the scratch folder. No attack test came out of it and no L10 finding reached triage (the payloads were not run against the app as far as the artefacts show).
- **Verify lanes** (named models): 7 of 146 calls succeeded; effectively no independent model verification took place.
- L5, L8 and L9 are not in the engine budget (they are test-writing lanes run by workers).
- 274 findings are in the index after dedupe: L1 137, L2 49, L7 53, L4 14, L6 14, L3 7. 204 records after merging same-file-same-cause.

## 3. Findings and verdicts

Of 274 indexed findings (204 records after dedupe): **2 confirmed, 9 known, 0 unclear, 193 rejected.**

| Orig. severity | confirmed | known | rejected | total |
|---|---:|---:|---:|---:|
| P0 | 0 | 5 | 62 | 67 |
| P1 | 1 | 3 | 76 | 80 |
| P2 | 1 | 1 | 48 | 50 |
| P3 | 0 | 0 | 7 | 7 |

182 findings were in scope (P0, P1, P2 with ≥2 votes). **0 of them is a real bug at its reported severity.** The 68 P0s were all wrong or already known.

Verdict by lens (a record counts once per lens): L1 0/2/105 (confirmed/known/rejected), L2 1/5/34, L3 1/0/4, L4 0/0/13, L6 0/0/13, L7 0/2/44.

### Confirmed (both P3, both fixed)

| What | Reported as | Real severity | Fixed |
|---|---|---|---|
| `resolveCockpitFile` accepted userId `"."` and `".."` (single-segment guard let dot segments through). Not reachable today because userIds are cuids; defence in depth. Found by the L8 property test and independently by an L3 finding | P2 | P3 | #37 (issue #35) |
| Client components had no `catch` around server-action calls (`GmailCard`, `ActionBar`, `SendDialog`, `SendOutcomePanel`, `EditForm`, `EditRerender`). A transport failure showed no message. Safety invariants held (the send lock blocks a second send, stale-lock panel recovers) | P1 | P3 | #34 (issue #33) |

### Known (9)

Re-found items that match HANDOFF §7 or a DECISIONS ruling: `File` has no `userId` column (path-based ownership), edits have no optimistic concurrency, stale-lock design, Gmail chip semantics (D-006), default token scopes (D-007), `review_resume` has no scope check (upstream). They stay open as documented risks.

### Why the rest were rejected

Dominant failure modes of the free models:
- **Cannot see the caller.** The model assumes a missing `userId` check; the code scopes every query.
- **AC restatement filed as a violation.** "Code matches the AC" reported as P0.
- **Upstream files** the cockpit did not touch.
- **Contradicts the frozen SPEC** (find_job scope, idempotent replay).

Details per finding: `FINDINGS.jsonl`, `REJECTED.md`. Out-of-scope ideas: `V1-IDEAS.md`.

## 4. What each lane found

| Lane | Result |
|---|---|
| L1 security | 137 indexed, none real at the reported severity. Many "missing userId" claims, all wrong (the code scopes every query). |
| L2 state/concurrency | 49 indexed. Found the missing action `catch` (real, P3). Re-found stale-lock and lost-update design as known. |
| L3 data/migration | 7 indexed. Its one confirmed record is the dot-segment userId issue (same as the L8 property result); the other 4 were rejected. |
| L4 UX/a11y | 14 indexed, none real (nits against SPEC-conformant UI). Ideas moved to `V1-IDEAS.md`. |
| L6 Next.js boundaries | 14 indexed, all rejected (for example a claimed missing `"use client"` that is present on line 1). |
| L7 SPEC conformance | 53 indexed, all rejected or known. Mostly read the wrong file for the AC. Its useful output is the AC traceability (`TRACEABILITY.md`). |
| L8 property tests | 7 fast-check files (MIME, rate limit, path confinement, PDF name sanitising, schemas, markdown, package state machine). One real finding (dot-segment userId), fixed in #37. State-machine property: no failure. Assumptions listed in the test files. |
| L9 end-to-end | 47 passed, 2 `test.fixme` for real P3 product bugs (below), see section 5. |
| L10 red team | No usable output (schema failures only). |
| L5 test quality | **Not run.** |

## 5. Automated test results

- **Vitest, final gates on `f8192ff`** (fresh `npm ci`, 3 full runs, 3,143 tests): runs 2 and 3 green. Run 1 had one timeout in upstream `__tests__/AddExperience.spec.tsx` (5 s under load, unrelated to the cockpit). The `DataSettings` timezone failure is fixed by #28 and was green in all 3 runs.
- **Property tests:** PR #32. The dot-segment `it.fails` was flipped to a normal test by #37.
- **End-to-end** (`e2e/cockpit/`, Playwright, fake Google on port 3738, PR for issue #36): **47 passed, 2 fixme.** Passing:
  - review flow (queue, detail, edit, request changes, bot marks done, approve, reject)
  - Gmail connect and callback rejections, disconnect and reconnect
  - send OK, double click and two-tab race give exactly one send
  - all Gmail failure classes: 400/401/403 definitive; 429/500/timeout/network/bad body ambiguous with outcome panel; release lock; mark as sent manually; real 20 s client timeout
  - file route: single `X-Frame-Options: SAMEORIGIN`, sandbox CSP, `nosniff`; unauthenticated gives 307 (D-011)
  - flag off: covered by the Vitest flag tests; the E2E `flag-off.spec.ts` (separate server, `COCKPIT_E2E_FLAG_OFF=1`) was not run in the final pass
  - 375 px: no horizontal scroll on queue, detail, edit, settings, and Send dialog
  - keyboard: j/k, dialog focus trap
  - axe on queue, detail, edit, settings, Send dialog, outcome panel: zero serious/critical, except `aria-input-field-name` on the read-only Tiptap panels (Posting, Cover letter), which is exempted in `08-axe.spec.ts` and still open
- **The 2 fixme are real product bugs, both P3:** an unbroken 120-character subject scrolls horizontally at 375 px (issue #38); focus is not returned to Send after Escape closes the dialog (issue #39).
- **AC-30 PDF in the iframe under `sandbox` CSP: not verified.** A probe exists (`06-pdf-iframe.spec.ts`, opt-in with `COCKPIT_E2E_PDF=1`), but full Chromium with the PDF viewer cannot launch in the WSL test host; the headless shell has no PDF viewer, so it proves nothing.

## 6. What was not checked

| Not checked | Detail |
|---|---|
| AC-30 PDF render | See above. Needs a real desktop browser. |
| Real Google | All Gmail behaviour was tested against a fake Google (and mocked Gmail in unit tests). Consent screen, real token endpoint, real Gmail API responses, real quota, real `invalid_grant`: not exercised. |
| Firefox and WebKit | Chromium only. |
| Chaos, soak, scale | Not run. No large data set, no long run, no kill-during-send test beyond the stale-lock logic tests. |
| Mutation testing (L5) | Not run. Test quality is judged only by the AC traceability and by the property tests, not by killed mutants. Coverage was not measured. |
| Upgrade path from older schemas | The migration was applied to a **copy of the real DB** in Phase 4 (row counts unchanged, 3 new tables empty) and the Vitest harness applies it to an empty DB. No other source schema was tried. |
| Docker | Out of bounds for this run. The local image `jobsync-cockpit:v0` was built in Phase 4 from `2297ca3`, **before** #34 and #37. Rebuild from current `main` before deploy. |
| L10 attack payloads | 677 generated, no attack test written, none confirmed as executed. |
| Independent model verification | Verify lanes failed (section 2). |
| 100M-token goal | Not reached (about 5M). |

## 7. Gates

The numbered G1–G11 list was not stored in the repo; the numbering below is a reconstruction from `PLAN.md` and the run notes. Statuses are what the logs and test runs show.

| Gate | Check | Status |
|---|---|---|
| G1 | Lint on `main` | **Pass** (fresh `npm ci`) |
| G2 | Typecheck (`tsc --noEmit`) | **Pass** |
| G3 | Production build | **Pass** (about 135 s) |
| G4 | Full Vitest, 3 runs | **Partial.** 3,143 tests; 2 of 3 runs fully green; run 1 one upstream timeout (`AddExperience`) |
| G5 | Review harness merged, engine run to completion | **Pass** (#30; engine ended normally) but at 5% of the token target |
| G6 | Findings mechanically checked and triaged | **Pass** (274/274 verbatim after upstream filter; 182 in-scope read against code) |
| G7 | No open P0/P1/P2 | **Pass** (none confirmed; 2 P3 fixed with tests) |
| G8 | Property tests | **Pass** (#32) |
| G9 | End-to-end with fake Google | **Partial.** 47 pass; 2 known P3 fixme |
| G10 | Real browser: PDF in iframe (AC-30) | **Not run** |
| G11 | AC traceability | **Done, partly unverified** (`TRACEABILITY.md`) |

Not part of any gate: L5 mutation, real Google, cross-browser, chaos/soak/scale (all not run).

## 8. Fixed during the run

| PR | What |
|---|---|
| #28 | `DataSettings` preview test depended on the timezone (issue #27) |
| #30 | Overnight review harness (issue #29) |
| #32 | Property tests (issue #31) |
| #34 | Error toast when a server-action request rejects (issue #33) |
| #37 | Reject `.` and `..` as cockpit user dir (issue #35) |

Open: issues #36 (E2E suite, PR opened in parallel), #38, #39.

## 9. GO / NO-GO

| Decision | Verdict | Why | What flips or confirms it |
|---|---|---|---|
| **Owner deploy** (flag on, own data) | **GO, with conditions** | No P0–P2 found; gates green; flag off is the default and covered by Vitest. The code has never run against a real Gmail account, but deploy alone sends nothing. | Before deploy: cold backup of the data folder (HANDOFF §1); rebuild the image from current `main` (the existing local image predates #34 and #37); after restart, the log shows `20261104120000_cockpit_v0` applied and `/dashboard/review` opens. |
| **Real Gmail connect** | **GO, conditional** | The OAuth flow passed against a fake Google, including all rejection paths and reconnect (D-010). Real Google behaviour is untested. Connecting itself sends no mail. | Flips to confirmed when: own OAuth client with `COCKPIT_GMAIL_ALLOWED_ADDRESS` set to the owner's address; connect works on `/dashboard/review/settings`; **one reconnect** works. If connect fails, stop and read the error message shown on the settings page; do not retry blindly. |
| **First real send** | **NO-GO until a self-send passes** | The send path is only tested against mocks and a fake Google. Real MIME rendering, real Gmail errors and the sandboxed PDF preview are unverified. A real send to a company cannot be undone. | Flips to GO when all of these pass: (1) connect and reconnect above; (2) AC-30 PDF check in a real browser (if the sandbox blocks the viewer, record a DECISIONS entry first); (3) one package whose `emailTo` is the owner's **own** address: Send, then check Gmail Sent (subject, body, attachment opens), package `sent`, job `applied` with a date. Only then send to a real recipient. |

Bot switch (HANDOFF §6) stays after all three.
