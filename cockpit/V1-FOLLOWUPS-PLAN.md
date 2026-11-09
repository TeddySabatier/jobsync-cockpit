# V1 plan: application follow-ups

Status: **proposal, not frozen (revision 3: D1 approved by the owner; follow-ups shown as a thread under the application).** Written after V0 shipped (main at `abf22bc`). Needs an owner OK, then a SPEC amendment (new DECISIONS entry) before any ticket starts.

## 1. Goal and non-goals

**Goal.** After an application is sent by email, the cockpit tells you when a follow-up is due, the bot drafts it, you review/edit/approve it in the same queue, and you press Send. You close the loop by marking the outcome (replied, interview, rejected). Nothing is ever sent automatically.

**Decided with the owner**

| Question | Decision |
|---|---|
| Reply detection | **Manual.** One click: Got a reply / Interview / Rejected. No new Google permission. |
| Cadence | **Follow-up 1 at 7 days after the application was sent, follow-up 2 at 14 days after follow-up 1, then stop.** Snooze or skip per step. |
| Who drafts | **The Claude bot drafts, the owner reviews.** Same review flow as applications. |

**Non-goals (V1):** automatic sending; reading the mailbox; calendar (.ics); stats; templates in the app; a third follow-up; follow-ups for "apply via link" jobs (no recipient, no email sent); a due-notification channel other than the sidebar badge.

## 2. What the code already tells us (constraints, verified against V0)

1. **A sent application blocks every later package on that job** (`packages.ts:104-109`, `ALREADY_SENT`).
2. **JobSync's `Task` has no link to a job** (`schema.prisma:385-409`), so state lives in a cockpit table.
3. **Gmail scope is `gmail.send` + `openid email`** (`oauth.ts:8-9`). `SentEmail` stores `gmailMessageId` and `threadId` only; subject and body live on the package.
4. **The V0 send path cannot carry a follow-up as written** (it assumes an application with a CV):
   - `checkContent` requires a CV file (`send.ts:54-57`, else `FILE_NOT_FOUND`);
   - `buildMimeMessage` has a mandatory attachment and always builds multipart (`mime.ts:11,66,91-97`);
   - `sendRaw` takes no `threadId` (`client.ts:160-170`);
   - `markJobApplied` runs unconditionally and rewrites `appliedDate` in three places: send success (`send.ts:247`), `markSendUnknownAsSent` (`send.ts:306`), `markPackageAppliedManually` (`packages.ts:338-341`).
5. **`markSendUnknownAsSent` creates no `SentEmail`** (`send.ts:288-309`): "a sent email exists" is not a reliable signal that something was sent.
6. **"Apply via link" jobs** have a sent package but no recipient, no email and no thread (`packages.ts:318-344`).
7. **The V0 change-request loop** answers by resubmitting, which supersedes the `changes_requested` row (`packages.ts:141-169`); `list_change_requests` returns no `kind` (`cockpit.ts:246-276`).
8. **Backups include cockpit tables** (D-012): new tables and columns join `MODEL_SPECS`, `INSERT_ORDER`, `DELETE_ORDER` and the zod schema.
9. **`mime.ts:72` already generates a `Message-ID`**; it is just not returned or stored.
10. **The bot only acts when it runs.** Nothing wakes it.

## 3. Design

### 3.1 Due follow-ups are derived, not scheduled
No job queue and no write inside the send transaction. A job is **eligible** when it has a **sent application package with a non-empty `emailTo`** (this includes packages marked sent through the recovery panel; it excludes apply-via-link) and the job status is `applied`.

For an eligible job, with `anchor` = the application package's **`sentAt`** (not `Job.appliedDate`, which is user-editable) and `sentCount` = packages with `kind = follow_up` and `status = sent` (counted from packages, **not** from `SentEmail`, so recovery-marked sends count):

| Step | Due at |
|---|---|
| 1 (`sentCount = 0`) | `anchor + 7 days` |
| 2 (`sentCount = 1`) | `date of follow-up 1 (its sentAt) + 14 days` |
| none (`sentCount >= 2`) | nothing suggested |

Then, all of these must hold for a step to be **due**:
- `now >= dueAt`, moved to the next weekday, computed in `COCKPIT_TIMEZONE` (default `UTC`, documented);
- `now <= dueAt + COCKPIT_FOLLOWUP_WINDOW_DAYS` (default **30**): older applications are not suggested, so enabling V1 does not flood the queue with every old send;
- the job has no recorded outcome (replied / interview / rejected / closed);
- the job is not stopped, and the step was not skipped (below);
- `snoozedUntil` is empty or in the past.

Skipping a step moves its `skippedThrough` marker; for the next step the anchor becomes the skip date. **Rejecting a follow-up draft counts as skipping that step** (otherwise the bot would redraft every run). Changing the job status back to `applied` re-arms follow-ups (intended).

### 3.2 Data
- **`JobFollowUp`** (optional row per job, created lazily on the first snooze / skip / stop / outcome): `jobId` unique, `userId`, `outcome` (null | `replied` | `interview` | `rejected` | `closed`), `outcomeAt`, `stopped` (boolean: stop all follow-ups), `skippedThrough` (0 | 1 | 2), `skippedAt`, `snoozedUntil`, timestamps.
- **`ApplicationPackage.kind`**: `"application"` (default) | `"follow_up"`; **`replyToPackageId`** (nullable: the application it follows up).
- **Version sequence per kind:** `@@unique([jobId, kind, version])` replaces `[jobId, version]`, with versions allocated per `(jobId, kind)`.
- **`SentEmail.messageIdHeader`** (nullable): persist the `Message-ID` that `mime.ts` already generates, for `In-Reply-To` / `References`.
- Additive migration, pure DDL as in V0 (the unique replacement is a rebuild of that index only; checked in the migration test on a temp DB).

**Decision D1 (approved by the owner): reuse packages with `kind`, and present them as a thread under the application.** Two conditions from the review:
1. versions are sequenced per kind (above);
2. one helper, `activeApplication(jobId)`, owns the "which package is the application" filter, so the kind rule lives in one place.

Reuse keeps one review UI, one send path (lock, recovery), one edit path and one backup path. The cost is the audit below (about 20 sites). Fallback if the spike finds more: a separate draft table sharing an extracted send helper.

### 3.3 Rules in the package service
- `ALREADY_SENT`, "active package per job", supersede-on-resubmit and versioning apply **per kind**. The idempotency replay checks `kind` too.
- A follow-up requires an eligible job (3.1), no outcome, not stopped. **`submit_follow_up` supersedes any open follow-up draft** (pending, approved or `changes_requested`), the same way `submit_application_package` does, so the change-request loop keeps working.
- `list_change_requests` returns **`kind`**; the tool descriptions tell the bot which tool answers which kind.
- Defaults for a follow-up draft: To = original recipient, Subject = `Re: <original subject>`, **no CV attachment**, reply into the original thread when a `SentEmail` thread exists (else Subject match only).
- **Send-time recheck:** sending a follow-up fails with `CONFLICT` if, at send time, an outcome is recorded, the job is stopped, the job status is no longer `applied`, or the step was skipped. Setting an outcome (replied / interview / rejected / closed) also **supersedes any open follow-up draft**.
- An outcome can be **undone** (clears `outcome`; status changes made by Interview / Rejected are not reverted automatically, the confirm dialog says so).

### 3.4 Send path changes (all five sites, security-sensitive)
1. `checkContent`: a CV is required only for `kind = application`.
2. `buildMimeMessage`: attachment optional; plain `text/plain` message when there is none; optional `In-Reply-To` / `References`.
3. `sendRaw` / `GmailClient`: optional `threadId`.
4. `markJobApplied` (send success, `markSendUnknownAsSent`, `markPackageAppliedManually`): only for `kind = application`. A follow-up never changes job status or `appliedDate`.
5. Success for an application persists `messageIdHeader` on its `SentEmail`.

`In-Reply-To` / `References` come **from the database only** and must match a strict `<local@domain>` pattern (in addition to the existing CR/LF guard). Sends made before V1 have no stored `Message-ID`, so the spike-S1 fallback (thread id + matching `Re:` subject) is the normal case for every retroactive job.

### 3.5 MCP tools (bot side)
| Tool | Scope | Purpose |
|---|---|---|
| `list_due_follow_ups` | `jobs:read` | Due jobs with context: company, role, posting text, the sent email (from the package), days since, step number |
| `submit_follow_up` | `package:write` | `jobId`, `emailSubject`, `emailBody`, `idempotencyKey` → a pending follow-up draft; supersedes open follow-up drafts |

Plus `kind` on the `list_change_requests` output. Posting text is returned wrapped as **untrusted data** (stated in the tool description), like V0's posting handling. No send, approve, outcome or status tool exists on MCP. Same rate limits and error style as V0; the due module and both tools never import `send` or `gmail` (extend the import-graph test).

### 3.6 UI
- **Queue:** new **Follow-ups** tab with **one row per application thread** (not per draft). Rows: company, role, "sent 8 days ago", step 1 or 2, state (due / draft ready / snoozed). Follow-up drafts appear only in this tab, never in To do / Sent / Rejected.
- **Application thread (the main view):** each job's review page shows the application as a **conversation**, oldest first, one card per entry:
  1. **Application** (sent date, subject, short body, CV link; read-only once sent);
  2. **Follow-up 1**, then **Follow-up 2**, each in one of the states *scheduled for <date>* / *draft ready* (opens inline for edit, request changes, approve, Send) / *sent <date>* / *skipped*;
  3. **Outcome events** (Got a reply, Interview, Rejected, Closed, with their dates), and **Open thread in Gmail**, which opens the same conversation in Gmail because follow-ups are sent into the original Gmail thread.
  The thread rail appears on the page of **every package of the job**, so existing review URLs keep working, and an entry links to its package. The thread is **derived** from the job's packages (by `kind`, `sentAt`, `createdAt`) plus the single recorded outcome; no separate event table in V1 (outcome history is a non-goal, one outcome at a time).
- **Sidebar badge** on Review: due count. One cheap count query in the dashboard layout, **only when `COCKPIT_ENABLED`**. It is the **only** due signal in V1 (no push or email); the bot can mention due items in its own run summary.
- **Row actions:** Snooze (3 / 7 days), Skip step, Stop follow-ups, **Got a reply / Interview / Rejected** (the last two set the job status after a confirm that says what changes), **Undo outcome**, **Open thread in Gmail** (a plain `https://mail.google.com/...#all/<threadId>` URL; a thread id is an opaque id, not a credential. Tokens and ciphertext still never reach client props).
- **Detail:** a follow-up draft opens in the normal review detail inside its thread, with a "Follow-up 1 · replies to your email of <date>" banner. The sent application keeps showing as the active application.
- Phone widths and keyboard behaviour as in V0.

### 3.7 Security and safety
- Never automatic: sending stays a session-only server action behind the V0 lock; MCP cannot send, approve, set outcomes or change status.
- Every query scoped by `userId`; explicit `select`; no OAuth data in client props.
- Recipient and subject re-validated at send (CR/LF, comma); `threadId` and header values only from the user's own rows.
- **Backup:** add `JobFollowUp` to `MODEL_SPECS`, `INSERT_ORDER`, `DELETE_ORDER` and the zod schema, with `kind`, `replyToPackageId` and `messageIdHeader`. `GmailAccount` stays excluded. **Bump `BACKUP_FORMAT_VERSION` to 2** (new builds accept 1 and 2): an older build would otherwise silently import follow-up drafts as applications, including approved ones. This reverses D-012(e) for V1 and gets its own DECISIONS entry.

## 4. Spikes first (small, answer before building)
- **S1: Gmail threading with send-only scope.** Real send to your own address, then a reply with `threadId` + `In-Reply-To` / `References` using the persisted `Message-ID`. Check: does Gmail keep our `Message-ID`; does the reply thread; does the `#all/<threadId>` URL open the thread. Fallback: `threadId` + matching `Re:` subject only.
- **S2: invariant audit.** Largely pre-answered by the review (about 20 sites), to be confirmed; list below.
- **S3: due-date edge cases.** Confirm the timezone default, weekend rule and the 30-day window with the owner.

**S2 pre-answer: where "one application per job" is assumed**
- `packages.ts` submit: steps 3 (105), 4 (112), 5 (120), 7 (135, versions), 8 (142); idempotency replay (56-58); `listPackagesByTab` (414); `listJobVersions` (461).
- `send.ts`: active-version check (129-134).
- `cockpit.actions.ts`: `getReviewQueue` (110), `getPackageDetail` `activeId` / `isActive` (151), `getAdjacentPackageIds` (167).
- `myjobs/[id]/page.tsx` job-detail card (22-23).
- `cockpit.ts` MCP: `list_jobs` `hasPackage` / `activePackage` (139-168), `get_job` (207).
- UI: `QueueRow`, `DetailView` fit / CV / letter panes, readiness chips.

## 5. Tickets (each reviewed by a different model, like V0)
| # | Ticket | Notes |
|---|---|---|
| F-0 | Spikes S1–S3 | Output: findings, the D1 ruling, the DECISIONS entries (incl. backup version 2) |
| F-1 | Migration: `kind`, `replyToPackageId`, per-kind unique, `messageIdHeader`, `JobFollowUp` | Pure DDL; migration test on a temp DB; backup model/schema/version 2 + round-trip tests |
| F-2 | Domain: `activeApplication` helper, pure due calculation, kind-aware package rules, snooze / skip / stop / outcome / undo actions | The invariant changes live here; heavy unit tests incl. all cadence edge cases |
| F-3 | MCP: `list_due_follow_ups`, `submit_follow_up`, `kind` on `list_change_requests` | Import-graph test extended |
| F-4 | Send for follow-ups (the five sites in 3.4) incl. send-time recheck and recovery-panel / manual paths | Security-sensitive: line-by-line review, mocked Gmail |
| F-5 | UI: **application thread view** (rail on every package page), Follow-ups tab (one row per thread), badge, row actions, banner, undo | Mobile + a11y checks; the thread builder is a pure function, unit-tested |
| F-6 | Docs, handoff, **bot instructions snippet** (which tool answers which kind), `.env.example` (`COCKPIT_TIMEZONE`, `COCKPIT_FOLLOWUP_WINDOW_DAYS`) | |
| F-7 | QA: E2E with fake Google (set sent dates in the DB to simulate days), then one real follow-up to yourself | |

Rough size: about 7 tickets, comparable to the second half of V0.

## 6. Acceptance criteria (draft)
1. An email-sent application becomes due at `sentAt + 7 days` (next weekday, `COCKPIT_TIMEZONE`); after follow-up 1 is **sent** (including via the recovery panel), step 2 is due 14 days after it; after 2, nothing is suggested.
2. Nothing is due when the job status is not `applied`, an outcome is set, follow-ups are stopped, the step is skipped or snoozed, the job is apply-via-link, or the due date is older than the window.
3. Rejecting a follow-up draft skips that step; the bot is not asked to redraft it.
4. `submit_follow_up` is refused unless the job is eligible, and supersedes open follow-up drafts; resubmitting after a change request works.
5. `list_change_requests` returns `kind`, and an application submit on a job with a sent application still returns `ALREADY_SENT`.
6. A follow-up draft appears only in the Follow-ups tab and goes through edit / request changes / approve / Send like an application.
7. Sending a follow-up replies in the original thread when one exists, defaults to the original recipient, attaches no CV, and **never changes job status or `appliedDate`**, on all three paths: normal send, recovery "Mark as sent (manual)", and "Mark applied manually".
8. Sending is refused with `CONFLICT` if the outcome, stop, skip or job status changed after approval.
9. The V0 send protections hold for follow-ups: lock, ambiguous-outcome recovery, session-only, not reachable from MCP (import-graph test covers the new tools and the due module).
10. Got a reply / Interview / Rejected / Close stop suggestions and supersede open follow-up drafts; Interview and Rejected also set the job status after a confirm; **Undo outcome** works.
11. Backup export and restore carry follow-up state and drafts (format version 2); old v1 backups still import; Gmail tokens stay out.
12. Applications sent before V1 are covered with no data migration, within the window.
13. The sidebar badge is gated by `COCKPIT_ENABLED` and shows the due count.
14. Nothing in V1 sends automatically, and the bot cannot approve, send, set outcomes or change status.
15. A job's review page shows the application thread: the sent application, follow-up 1 and 2 (scheduled / draft ready / sent / skipped) and the outcome, in order, on the page of every package of the job; entries link to their package; the Follow-ups tab has one row per thread.
16. The thread is derived (no event table): it reflects a skipped step, an undone outcome and a restored backup correctly.

## 7. Risks and open items
- **Late drafts:** the bot only runs on its schedule, so a draft can be up to one run late. Fine for a 7-day cadence. The badge is the only due signal.
- **Forgotten replies:** manual marking means an unmarked reply can still produce a nudge. Mitigations: "Open thread in Gmail" on every row; the send-time recheck. V2 hook: an `report_application_reply` MCP tool for the bot.
- **Reply detection by the app** (a Gmail read scope) stays out of V1 by decision; revisit in V2 with its own security review.
- **Threading** depends on spike S1; the fallback is weaker threading outside Gmail, and it is the norm for pre-V1 sends.
- **Invariant sprawl** is the main engineering risk (about 20 sites); it is why F-0 and the `activeApplication` helper come first.

## 8. Changes from revision 2 (owner decision)
D1 approved: reuse the package pipeline with `kind`. Follow-ups are presented as a **thread under the application** (section 3.6, AC-15/16, F-5): a derived conversation view on every package page of the job, one row per thread in the Follow-ups tab.

## 9. Changes from revision 1 (independent review, `APPROVE WITH CHANGES`)
Added: send-path changes at all five sites; cadence counted from sent follow-up packages (not `SentEmail`); apply-via-link excluded; `submit_follow_up` supersedes open drafts and `kind` on `list_change_requests`; per-kind version sequence and `activeApplication` helper; anchor = `package.sentAt`; per-step skip and stop; rejected draft = skipped step; 30-day window; timezone setting; send-time recheck; outcome undo; the threadId rule clarified (opaque id may reach the client, tokens never); strict header validation; backup format version 2; badge gating; third-follow-up dropped from scope; S2 pre-answered; extra ACs and the bot-instructions ticket.
