# Cockpit (V0)

The **cockpit** is a review workflow inside JobSync. An external bot submits **application packages** (tailored CV PDF, CV JSON, cover letter, draft email, fit analysis) through the MCP server. You review, edit, approve, and **send from the UI only** — MCP cannot approve, send, or reject.

Examples below use placeholders (`you@example.com`, `http://localhost:3737`).

## Enable the cockpit

Set in your environment (see `.env.example`):

```bash
COCKPIT_ENABLED=true
```

When the flag is **not** exactly `"true"`:

- The **Review** nav entry is hidden; `/dashboard/review/**` returns 404 (after auth).
- `/api/cockpit/**` returns 404.
- Cockpit MCP tools are not registered.
- Cockpit server actions return `COCKPIT_DISABLED` (only after a signed-in session).

The MCP server itself still depends on `MCP_ENABLED` (on by default in dev). Both must be on for the bot to use cockpit tools in production.

Apply the cockpit database migration (`20261104120000_cockpit_v0`) before use.

## MCP: scopes and tokens

New scopes (added to **default** scopes for **new** MCP tokens):

| Scope | Purpose |
|-------|---------|
| `jobs:read` | List/read jobs and packages, list change requests |
| `package:write` | Attach PDFs, submit packages, mark change requests done |

**Existing MCP tokens do not gain these scopes.** Create a **new token** after enabling the cockpit. Use a **dedicated token for the bot** so other tokens are not widened by habit.

There is **no** MCP tool to approve, send, edit, or reject packages.

## MCP tools

All six tools are registered only when `COCKPIT_ENABLED=true`. Each handler runs: **scope check → rate limit → validation → database**.

| Tool | Scope | Notes |
|------|-------|--------|
| `attach_file` | `package:write` | PDF only; call before `submit_application_package` |
| `submit_application_package` | `package:write` | Creates version *n+1*; may supersede older active versions |
| `list_jobs` | `jobs:read` | Optional filters; includes active package summary |
| `get_job` | `jobs:read` | Job plus all package versions (newest first) |
| `list_change_requests` | `jobs:read` | Packages in `changes_requested` |
| `mark_change_request_done` | `package:write` | Bot response; moves package back to `pending` |

### Rate limits

Per user, in-memory (resets on process restart):

| Bucket | Limit | Applies to |
|--------|-------|------------|
| `cockpit` | 120 / hour | Every cockpit tool |
| `cockpit-attach` | 30 / hour | `attach_file` (in addition to `cockpit`) |

### Error style

Failed cockpit tool calls return `isError: true` with text:

```text
<CODE>: <fixed message>
```

Messages come from a fixed map (never raw Google/Prisma text). Common MCP codes: `UNAUTHORIZED_SCOPE`, `VALIDATION`, `NOT_FOUND`, `FILE_NOT_FOUND`, `ALREADY_SENT`, `JOB_REJECTED`, `INVALID_STATE`, `CONFLICT`, `TOO_LARGE`, `RATE_LIMITED`.

### Bot contract: submit, idempotency, versions

1. **`attach_file`** → `{ fileId }` → pass `cvFileId` in **`submit_application_package`**.
2. **`idempotencyKey`** (optional): same user + same key returns the existing package with `idempotent: true`. Reusing a key on a **different job** is `CONFLICT` — use a fresh key.
3. **Versioning**: each submit for a job gets the next version. Prior `pending` / `approved` / `changes_requested` packages (unlocked) become **`superseded`**.
4. **`CONFLICT`**: replay the **whole** submit (all checks, including idempotency and lock checks). Causes include concurrent writes, a send lock on the job, or version/idempotency races.
5. A job with **any** past **`sent`** package cannot accept new submits (`ALREADY_SENT`). A **rejected** active package blocks submit (`JOB_REJECTED`).
6. While **`sendStartedAt`** is set on any package for the job, submit returns **`CONFLICT`** — resolve send in the UI first.

`attach_file` has **no file-count or size quota** (D-013). Each PDF is still limited to the per-file size cap. To avoid bloat, every `attach_file` call first deletes the user's uploads that **no package uses** and that are older than **7 days** (set `COCKPIT_ORPHAN_DAYS`, minimum 1). Files of packages (pending, superseded, sent) are never deleted.

## Cover letter as a PDF

When a package has letter text, the sent email carries two PDFs: the CV and a cover letter PDF (named after the CV: `..._CV_...` becomes `..._Cover_Letter_...`). The cockpit makes the letter PDF itself from the letter text, at the moment you press Send, so it always matches your last edit. Review shows the same PDF in an iframe above the letter text ("PDF as it will be attached to the email"), and the Send dialog lists it. A package without letter text sends the CV only.

The letterhead (name, title, contact line) comes from the package's CV data. The layout is a plain A4 letter (Helvetica 11 pt, paragraphs, bullets, bold, italic), not the Word design of the CV. Typographic spaces and hyphens become plain ones, and Latin letters with an unusual mark keep their base letter (`ł` becomes `l`). **Letters of other alphabets (Greek, Cyrillic, Chinese) show as `?`** because the standard PDF fonts cannot draw them: check the preview before sending such a letter. Emoji and other symbols are dropped. A very long web link may be broken across lines with a hyphen added at the break. The email body is separate: if it repeats the whole letter, shorten it in Review.

## Claude prompt button (job page)

With the cockpit on, a job page has a **Claude prompt** button next to Match with AI. One click copies a ready-made prompt for Claude: the job (company, role, location, link, JobSync id), the posting text, and the instructions to run the bot's cockpit pipeline for this one job (fit check, tailored CV, letter, hand-over with `cockpit_submit.py`). Paste it into Claude (a session that can read the bot folder); the package then appears in Review. If a package already exists for the job, the prompt says so and asks Claude not to resubmit. If the browser refuses to copy (plain http on a phone), the prompt opens in a box to copy by hand.

The built-in **Cover Letter** and **Match with AI** buttons are JobSync's own AI feature and use the model set in the agent panel; they do not create the cockpit package.

## Review UI

- **Queue:** `/dashboard/review` — tabs: To do (`pending` + `approved`), Changes, Sent, Rejected. Readiness chips: Gmail, PDF stale, No CV, Link apply.
- **Detail:** `/dashboard/review/[packageId]` — posting, CV PDF, fit analysis, email preview, cover letter, version selector. **Non-active versions** show a banner; the action bar is hidden.
- **Edit:** email fields, letter, CV JSON string leaves; editing CV text marks **PDF stale** until the bot re-renders and resubmits.
- **Settings:** `/dashboard/review/settings` — Gmail connect/disconnect.

Keyboard: **`j` / `k`** on a **To do** detail page moves to next/previous in queue order.

## Gmail connect and send

### Google Cloud setup

1. Create an OAuth client in [Google Cloud Console](https://console.cloud.google.com/) — **Web application** (register the redirect URI) or **Desktop app** (Google allows loopback redirects for desktop clients).
2. Register the redirect URI exactly as `GOOGLE_REDIRECT_URI` (default below).
3. Scopes requested: **`gmail.send`** only for sending, plus **`openid email`** to identify the account (no mailbox read scope).

Required env (plus `ENCRYPTION_KEY` — see Security):

- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`
- `GOOGLE_REDIRECT_URI` — default `http://localhost:3737/api/cockpit/gmail/callback`
- `COCKPIT_GMAIL_ALLOWED_ADDRESS` — must match the connected Google account (case-insensitive). **Required for Send.**

Connect: **Review → Settings → Connect Gmail** → `/api/cockpit/gmail/connect`. Disconnect revokes the grant (best effort) and deletes the stored row.

**Reconnect (D-010):** reconnecting the **same** allowed address does **not** revoke the previous refresh token (shared grant). Reconnecting a **different** address revokes the old token. Disconnect always revokes.

OAuth errors appear on settings as `?error=<code>` with fixed messages (e.g. `address_not_allowed`, `encryption_unavailable`, `no_refresh_token`). Raw query values are never shown.

### Send (UI only)

Send runs only from a signed-in session via server action — **never via MCP**.

Flow: approve → **Send** (when Gmail connected, valid `emailTo`, CV file present, PDF not stale) → confirm dialog (full body, domain warning) → lock → Gmail API.

- **Lock:** while `sendStartedAt` is set, the package is frozen (no edit, approve, or supersede via submit).
- **Ambiguous failure** (timeout, 5xx, network): lock kept, `sendOutcome = "unknown"`. UI: check Gmail **Sent** folder, then **Mark as sent (manual)** or **Release lock**.
- **Definitive failure** (token/decrypt/MIME/400/401/403): lock cleared; fix and retry.
- Lock older than **60 s** without outcome is treated like unknown (crash recovery).

**Mark applied manually** (empty `emailTo` / link apply): overflow menu; no email sent.

## Security notes

- **PDF in iframe:** file route sets `Content-Security-Policy: sandbox; frame-ancestors 'self'` and scoped `X-Frame-Options: SAMEORIGIN` in Next config. Some browsers may not render sandboxed PDFs in an iframe — use download if preview fails.
- **Gmail tokens:** refresh tokens encrypted with `ENCRYPTION_KEY` (same key as other stored secrets). Must be set **before** OAuth callback stores a token. Changing the key requires reconnecting Gmail.
- **Backup (D-012):** the standard backup includes review packages, sent-email records and the CV PDFs they point at, so a restore brings them back. It never includes the Gmail connection (`GmailAccount`): its refresh token stays on the server, so after restoring onto a fresh instance you reconnect Gmail. Restoring over an existing account replaces its packages and sent history with the backup contents (the automatic pre-restore snapshot contains them too). Backups made before D-012 simply have no packages. An import or rollback is refused while a package is being sent or has an unresolved send lock: resolve it in the cockpit first. A package exported while locked is restored still locked, and the recovery panel releases it (D-016).
- **Upload path:** CV PDFs live under `<UPLOADS_DIR>/files/cockpit/<userId>/` (`UPLOADS_DIR` is `data` in dev, `/data` in production — not a separate env var).

## Troubleshooting by code

### MCP / domain (`"<CODE>: msg"`)

| Code | Meaning / action |
|------|------------------|
| `UNAUTHORIZED_SCOPE` | New token with `jobs:read` and `package:write` |
| `RATE_LIMITED` | Wait; up to 120/h (30/h extra on attach) |
| `CONFLICT` | Replay full submit; or clear send lock in UI |
| `ALREADY_SENT` | Job already has a sent application |
| `JOB_REJECTED` | User rejected; do not resubmit this job |
| `FILE_NOT_FOUND` | Run `attach_file` again for this user |
| `TOO_LARGE` | Smaller PDF |
| `NOT_FOUND` | Wrong id or not your job/package |

### UI actions (`success: false`, `code`)

| Code | Meaning / action |
|------|------------------|
| `COCKPIT_DISABLED` | Set `COCKPIT_ENABLED=true` and restart |
| `INVALID_STATE` | Wrong status or send in progress |
| `CONFLICT` | Package changed since dialog; refresh and retry send |
| `SEND_OUTCOME_UNKNOWN` | Check Gmail Sent; mark sent or release lock |
| `GMAIL_RECONNECT_REQUIRED` | Reconnect Gmail (token or `ENCRYPTION_KEY` issue) |
| `GMAIL_TOKEN` / `GMAIL_SEND` / `GMAIL_TIMEOUT` | Retry; check Google account and allowed address |

### Gmail settings (`?error=`)

| Code | Meaning |
|------|---------|
| `not_configured` | Set Google client env vars and allowed address |
| `encryption_unavailable` | Set `ENCRYPTION_KEY` before connecting |
| `address_not_allowed` | Connect with `COCKPIT_GMAIL_ALLOWED_ADDRESS` |
| `no_refresh_token` | Retry connect (consent/offline access) |

Further detail: `cockpit/SPEC.md` and `cockpit/DECISIONS.md` (e.g. D-010 reconnect).
