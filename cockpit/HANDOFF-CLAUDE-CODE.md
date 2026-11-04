# Cockpit V0 — handoff for Claude Code and owner

## Status

All **11 tickets C-01..C-11** are merged into `main` of [TeddySabatier/jobsync-cockpit](https://github.com/TeddySabatier/jobsync-cockpit) through reviewed PRs **#4, #6, #8, #10, #12, #14, #16, #18, #20, #22, #24**; related issues are closed; **no pending GitHub work**. The D-001 fallback (stacked branches without `gh`) was **superseded by D-003** (real issue/PR flow). **Phase 4 integration is done** (see below).

---

## Phase 4 results

- **Migration:** `20261104120000_cockpit_v0` applied cleanly to a **copy** of the real DB; existing row counts unchanged; **3 new cockpit tables empty**.
- **Image:** `jobsync-cockpit:v0` built locally (image id `463c02fc5c70`, ~364 MB, from commit `2297ca3`). C-11 is docs-only; rebuild is optional.
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

- [ ] Full review flow: queue → detail → edit → request changes → bot marks done → approve.
- [ ] **AC-20:** no horizontal scroll at **375 px** on queue / detail / edit / settings.
- [ ] **AC-30:** CV PDF renders in the iframe with `CSP: sandbox; frame-ancestors 'self'`. Some browser PDF viewers refuse sandboxed PDFs — if so, **record a DECISIONS entry** before dropping `sandbox`.
- [ ] Authenticated `curl -I` of `/api/cockpit/files/<id>`: exactly **one** `X-Frame-Options: SAMEORIGIN` and the expected CSP.
- [ ] Overflow menu → confirm dialog focus (Radix).
- [ ] Send dialog: full body, attachment name + size, domain / free-mail warning (heuristic; may false-positive).
- [ ] Send-outcome panel after a simulated stuck lock.
- [ ] Leaving edit mode via a sidebar link does **not** warn about unsaved changes (**known limit**).

## 5. First real send (owner only)

- [ ] One application the owner chooses.
- [ ] Confirm email in **Gmail Sent**, package **`sent`**, job **applied** with a date.

## 6. Bot switch

- [ ] Update the owner's bot pipeline doc and scheduled task to call **`attach_file`** + **`submit_application_package`** instead of Gmail drafts, and to poll **`list_change_requests`** / call **`mark_change_request_done`**.
- [ ] Do this **only after** steps 1–5 pass.

## 7. Risks and open items

- PR **#4**'s first commit `817a1d9` remains visible on the PR page (mentions an SSH alias name, a second GitHub account, and local paths; no secrets; **not in main**).
- Commits may show the owner's personal email as author (public repo; consider a GitHub `noreply` address).
- Upstream **`/api/profile/resume`** has no path confinement (upstream code; not changed in V0).
- **`attach_file` quota check is not atomic** (shortcut: single user).
- **`File` rows have no `userId` column** — ownership is path-based via `cockpitUserDir`.
- **Edits have no optimistic-concurrency check** (two tabs can overwrite; Send re-checks `updatedAt`).
- **`__tests__/DataSettings.spec.tsx > shows the backup preview after a preflight, without importing`** fails intermittently (pre-existing).
- C-09 PR body still says "revokes old one" (**superseded by D-010**).

## 8. V1 hooks noticed (not built)

- Include cockpit tables in backups.
- sha256 dedupe of attachments.
- Optimistic concurrency on edits.
- `userId` column on `File`.

## Housekeeping

- Scratch folder **`/.cockpit-tmp/`** in the repo is git-ignored.
- Local handoff note **`cockpit/TAKEOVER.md`** is git-excluded and can be deleted.
