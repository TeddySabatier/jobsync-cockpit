# Cockpit V0 — handoff for Claude Code and owner

## Status

All **11 tickets C-01..C-11** are merged into `main` of [TeddySabatier/jobsync-cockpit](https://github.com/TeddySabatier/jobsync-cockpit) through reviewed PRs **#4, #6, #8, #10, #12, #14, #16, #18, #20, #22, #24**; related issues are closed; **no pending GitHub work**. The D-001 fallback (stacked branches without `gh`) was **superseded by D-003** (real issue/PR flow). **Phase 4 integration is done** (see below). After the handoff, decisions **D-008 and D-010..D-015** amended the frozen SPEC (idempotency across jobs, Gmail reconnect, backups carry cockpit data, no attachment quota, the Claude prompt button, the cover letter sent as a PDF); read `DECISIONS.md` next to the SPEC. The Phase 4 results below are the V0 state and were not re-run for them.

---

## Phase 4 results

- **Migration:** `20261104120000_cockpit_v0` applied cleanly to a **copy** of the real DB; existing row counts unchanged; **3 new cockpit tables empty**.
- **Image:** `jobsync-cockpit:v0` built locally (image id `463c02fc5c70`, ~364 MB, from commit `2297ca3`). **Rebuild from current `main` before deploy:** it predates the QA fixes #34 and #37 and D-012..D-015.
- **MCP E2E** (port **3738**, DB copy, throwaway secrets): **all PASS**
  - `tools/list`: 6 cockpit tools; **no** send / approve / reject / edit tool
  - `list_jobs`, `attach_file`, submit v1, resubmit → v2 supersedes v1
  - Same idempotency key → `idempotent: true`
  - `get_job`, `list_change_requests`, `mark_change_request_done`
  - `jobs:write`-only token → `UNAUTHORIZED_SCOPE`; non-PDF → `VALIDATION`
- **HTTP checks:** unauthenticated file route → **307** to `/signin` (**D-011**); `/` sends `X-Frame-Options: DENY`.
- **Backup folder:** `jobsyncdb/backup-20261104-195714Z` created next to live data (owner may keep or delete).

---

## 1. Deploy (owner)

- [ ] With the app **stopped**, take a fresh backup of `jobsyncdb/data` (sqlite3 is not installed on the host — a **cold copy** is the safe approach).
- [ ] Point the compose image at **`jobsync-cockpit:v0`**.
- [ ] Set `COCKPIT_ENABLED=true` and Gmail-related vars in the **git-excluded** compose override (never commit it).
- [ ] Restart; confirm container log shows `prisma migrate deploy` applying **`20261104120000_cockpit_v0`**.
- [ ] Open **`/dashboard/review`**.

## 2. Gmail connect (owner, browser)

- [ ] Create a Google Cloud OAuth client (see `cockpit/SPEC.md` §6.1 and `docs/cockpit.md`).
- [ ] Register redirect URI `http://localhost:3737/api/cockpit/gmail/callback` (or the HTTPS host you use).
- [ ] Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`, `COCKPIT_GMAIL_ALLOWED_ADDRESS` (= the owner's Gmail address).
- [ ] Connect from **`/dashboard/review/settings`**.
- [ ] Test **one reconnect** and confirm **Send still works** afterwards (**D-010** same-grant behaviour).

## 3. MCP token for the bot

- [ ] Create a **new** token in the UI (older tokens lack `package:write` / `jobs:read`).
- [ ] Use a token **dedicated to the bot**.

## 4. E2E + visual checks (Claude Code with Playwright)

- [x] Full review flow: queue → detail → edit → request changes → bot marks done → approve. (e2e `01-review-flow.spec.ts`)
- [x] **AC-20:** no horizontal scroll at **375 px** on queue / detail / edit / settings. (e2e `07-responsive-keyboard.spec.ts`; known gap: a 120-character unbroken subject scrolls, issue #38)
- [ ] **AC-30:** CV PDF renders in the iframe with `CSP: sandbox; frame-ancestors 'self'`. Some browser PDF viewers refuse sandboxed PDFs — if so, **record a DECISIONS entry** before dropping `sandbox`.
- [x] Authenticated `curl -I` of `/api/cockpit/files/<id>`: exactly **one** `X-Frame-Options: SAMEORIGIN` and the expected CSP. (e2e `05-file-route.spec.ts`)
- [ ] Overflow menu → confirm dialog focus (Radix).
- [x] Send dialog: full body, attachment name + size, domain / free-mail warning (heuristic; may false-positive). (e2e `03-send.spec.ts`; focus trap in `07-responsive-keyboard.spec.ts`; focus not returned to Send after Escape, issue #39)
- [x] Send-outcome panel after a simulated stuck lock. (e2e `04-send-failures.spec.ts`: ambiguous Gmail failures, release lock, mark as sent; the 60 s stale-lock age rule is covered by unit tests only)
- [ ] Leaving edit mode via a sidebar link does **not** warn about unsaved changes (**known limit**).

Not ticked, by design: **AC-30** PDF render in the iframe (needs a real desktop browser; the automated probe could not launch full Chromium) and the sidebar-link check (known limit). Also open: the overflow-menu confirm dialog focus check.

## 4b. QA run (2026-11-05)

An overnight QA run covered the code after the handoff: free-model review lanes, paid-model triage, property tests, and an end-to-end suite against a fake Google. Result: no P0, P1 or P2 bug; 2 P3 fixed (#34, #37); 2 P3 open (#38, #39). Not verified: real Google, PDF render (AC-30), Firefox/WebKit. See [`cockpit/qa/QA-REPORT.md`](qa/QA-REPORT.md) (GO / NO-GO per deploy, Gmail connect, first send) and [`cockpit/qa/HUMAN-QUEUE.md`](qa/HUMAN-QUEUE.md).

## 5. First real send (owner only)

- [ ] One application the owner chooses.
- [ ] Confirm email in **Gmail Sent**, package **`sent`**, job **applied** with a date.

## 6. Bot switch

- [ ] Switch the owner's bot pipeline and scheduled task to the cockpit as described in `docs/cockpit-bot.md` (the single source for the script, setup, pipeline text and errors).
- [ ] Do this **only after** steps 1–5 pass.

## 7. Risks and open items

- PR **#4**'s first commit `817a1d9` remains visible on the PR page (mentions an SSH alias name, a second GitHub account, and local paths; no secrets; **not in main**).
- Commits may show the owner's personal email as author (public repo; consider a GitHub `noreply` address).
- ~~`attach_file` quota check is not atomic~~ the quota was removed (D-013); unreferenced uploads are cleaned up instead.
- **`File` rows have no `userId` column** — ownership is path-based via `cockpitUserDir`.
- **Edits have no optimistic-concurrency check** (two tabs can overwrite; Send re-checks `updatedAt`).
- ~~`__tests__/DataSettings.spec.tsx` preview test fails intermittently~~ fixed in #28 (it depended on the timezone).
- C-09 PR body still says "revokes old one" (**superseded by D-010**).

## 8. V1 hooks noticed (not built)

- sha256 dedupe of attachments.
- Optimistic concurrency on edits.
- `userId` column on `File`.

## Housekeeping

- Scratch folder **`/.cockpit-tmp/`** in the repo is git-ignored.
- Local handoff note **`cockpit/TAKEOVER.md`** is git-excluded and can be deleted.
