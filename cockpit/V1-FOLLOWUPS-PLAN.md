# V1 plan: application follow-ups

Status: **proposal, not frozen.** Written after V0 shipped (main at `abf22bc`). Needs an owner OK, then a SPEC amendment (new DECISIONS entry) before any ticket starts.

## 1. Goal and non-goals

**Goal.** After an application is sent, the cockpit tells you when a follow-up is due, the bot drafts it, you review/edit/approve it in the same queue, and you press Send. You close the loop by marking the outcome (replied, interview, rejected). Nothing is ever sent automatically.

**Decided with the owner**

| Question | Decision |
|---|---|
| Reply detection | **Manual.** One click: Got a reply / Interview / Rejected. No new Google permission. |
| Cadence | **Follow-up 1 at 7 days after sending, follow-up 2 at 14 days after follow-up 1, then stop.** Snooze or skip per job. |
| Who drafts | **The Claude bot drafts, the owner reviews.** Same review flow as applications. |

**Non-goals (V1):** automatic sending; reading the mailbox; calendar (.ics); stats; templates in the app; more than two automatic follow-ups (a third is a manual choice).

## 2. What the code already tells us (constraints)

1. **A sent application blocks every later package on that job** (`packages.ts`, rule "any past sent package blocks every later submit" → `ALREADY_SENT`). A follow-up cannot be "just another package" without changing that invariant.
2. **JobSync's `Task` has no link to a job** (title, due date, priority only). "Reminder as a task" cannot point at a job without editing upstream's schema, so reminders live in a cockpit table.
3. **Gmail scope is `gmail.send` only.** We can send into a thread (Gmail's `threadId` on send) but cannot read the original `Message-ID` header. `SentEmail` already stores `gmailMessageId` and `threadId`.
4. **Send is the most security-critical path** (lock, ambiguous-outcome recovery, session-only, import-graph test keeps it off MCP). It was hardened in V0 and must not regress.
5. **Backups now include cockpit tables** (D-012): any new table or column must be added to the backup model list and its test.
6. **Job statuses already exist:** `applied`, `interview`, `rejected`, `expired`, `archived`. No status needs inventing.
7. **The bot only acts when it runs.** Nothing wakes it; a due follow-up waits for its next run.

## 3. Design

### 3.1 Due follow-ups are derived, not scheduled
No job queue and no write inside the send transaction. A follow-up is **due** when all hold:
- the job has a `sent` application package and the job status is `applied`;
- no outcome has been recorded (replied / interview / rejected / closed);
- fewer than 2 follow-ups have been sent;
- `now >= dueAt`, where `dueAt` = sent application date + 7 days (follow-up 1) or last follow-up date + 14 days (follow-up 2), moved to the next weekday;
- not snoozed (`snoozedUntil` in the future) and not skipped.

Benefits: existing sent applications are covered retroactively, and the V0 send path is untouched.

### 3.2 Data (one small table, two columns)
- **`JobFollowUp`** (one optional row per job): `jobId` unique, `userId`, `outcome` (null | `replied` | `interview` | `rejected` | `closed`), `outcomeAt`, `snoozedUntil`, `skipped` (boolean), timestamps. Created lazily when you snooze, skip or mark an outcome.
- **`ApplicationPackage.kind`** (`"application"` default | `"follow_up"`) plus **`replyToSentEmailId`** (nullable): which sent email this follow-up replies to. The follow-up draft **reuses the whole package pipeline** (pending → approved → sent, edit, request changes, lock, recovery, backups).
- **`SentEmail.messageIdHeader`** (nullable): our own `Message-ID`, so a follow-up can set `In-Reply-To` / `References` (see spike S1).
- Migration: additive only, pure DDL, as in V0.

**Decision D1 (needs your OK): reuse packages with `kind`, or a separate `FollowUp` draft table?** Recommendation: reuse. It keeps one review UI, one send path and one backup path. The cost is auditing every query that assumes "one application per job". Fallback if the audit (S2) finds too many sites: a separate draft table sharing an extracted send helper.

### 3.3 Rules changed in the package service
- `ALREADY_SENT` and "active package per job" apply to `kind = "application"` only.
- A follow-up requires: a sent application on the job, job status `applied`, no outcome, no other open follow-up draft. Max 2 sent follow-ups through the bot; a third is a manual UI action.
- Follow-up draft defaults: To = original recipient, Subject = `Re: <original subject>`, **no CV attachment** (optional), reply into the original Gmail thread. The `threadId` always comes from our own `SentEmail` row, never from input.
- Sending a follow-up **does not** touch job status or `appliedDate`. Success records a `SentEmail`, which advances the cadence automatically (derived).

### 3.4 MCP tools (bot side)
| Tool | Scope | Purpose |
|---|---|---|
| `list_due_follow_ups` | `jobs:read` | Due jobs with context: company, role, posting, the sent email (subject/body), days since, follow-up number |
| `submit_follow_up` | `package:write` | `jobId`, `emailSubject`, `emailBody`, `idempotencyKey` → a pending follow-up draft |

The existing `list_change_requests` / `mark_change_request_done` loop works unchanged for follow-up drafts. No send, approve or outcome tool exists on MCP. Same rate limits, error style and import-graph test as V0.

### 3.5 UI
- **Queue:** new **Follow-ups** tab with a count badge on the sidebar's Review link. Rows: company, role, "sent 8 days ago", follow-up #1 or #2, state (due / draft ready / snoozed).
- **Row actions:** Snooze (3 / 7 days), Skip, **Got a reply / Interview / Rejected** (the last two also set the job status, with a confirm), **Open thread in Gmail** (so you can check before nudging).
- **Detail:** a timeline on the job's review page (sent, follow-ups, outcome). Follow-up drafts open in the normal review detail with a "Follow-up 1 · replies to your email of <date>" banner.
- Phone widths and keyboard behaviour as in V0.

### 3.6 Security and safety
- Never automatic: sending stays a session-only server action behind the V0 lock.
- Every query scoped by `userId`; explicit `select`; no Gmail data to client props.
- Recipient and subject re-validated at send (CR/LF, comma), as in V0.
- The follow-up send passes `threadId` only from the user's own `SentEmail`.
- Outcome buttons are session-only actions; no MCP tool can change an outcome or job status.
- Backup: `JobFollowUp`, `kind`, `replyToSentEmailId` and `messageIdHeader` round-trip; `GmailAccount` stays excluded.

## 4. Spikes first (small, answer before building)
- **S1: Gmail threading with send-only scope.** Real send to your own address with a custom `Message-ID`, then a second send with `threadId` + `In-Reply-To`/`References`. Check: does Gmail keep our `Message-ID`; does the reply thread in Gmail; does `https://mail.google.com/mail/u/0/#all/<threadId>` open the thread. Fallback: `threadId` + matching `Re:` subject only.
- **S2: invariant audit.** Count every query that assumes one application per job (queue, `list_jobs`, `get_job`, detail, version selector, adjacent ids, send). Decides D1.
- **S3: due-date edge cases.** Timezone (which clock "7 days" uses), weekends, jobs marked applied manually (no `SentEmail`).

## 5. Tickets (each reviewed by a different model, like V0)
| # | Ticket | Notes |
|---|---|---|
| F-0 | Spikes S1–S3 | Output: findings and the D1 ruling |
| F-1 | Migration: `kind`, `replyToSentEmailId`, `messageIdHeader`, `JobFollowUp` | Pure DDL; migration test on a temp DB |
| F-2 | Domain: due calculation (pure, heavily tested), kind-aware package rules, snooze / skip / outcome actions | The invariant changes live here |
| F-3 | MCP tools `list_due_follow_ups`, `submit_follow_up` | Import-graph test must still pass |
| F-4 | Send for follow-ups: thread reply, no status change, `messageIdHeader` stored on applications | Security-sensitive: line-by-line review |
| F-5 | UI: Follow-ups tab, badge, row actions, timeline, banner | Mobile + a11y checks |
| F-6 | Backup/restore for the new data, docs, bot instructions snippet, handoff | Round-trip tests as in D-012 |
| F-7 | QA: E2E with fake Google (set sent dates in the DB to simulate days), then one real follow-up to yourself | |

Rough size: about 7 tickets, comparable to the second half of V0.

## 6. Acceptance criteria (draft)
1. A sent application becomes due at +7 days (next weekday); after follow-up 1 is sent, follow-up 2 is due 14 days later; after 2, nothing is suggested.
2. No follow-up is due when the job status is not `applied`, an outcome is set, the job is skipped, or it is snoozed.
3. `submit_follow_up` is refused unless a sent application exists, and creates at most one open draft per job.
4. A follow-up draft appears in the Follow-ups tab and goes through edit / request changes / approve / Send like an application.
5. Sending a follow-up replies in the original Gmail thread, uses the original recipient by default, attaches no CV by default, and leaves the job status and applied date unchanged.
6. The V0 send protections hold for follow-ups: lock, ambiguous-outcome recovery panel, session-only, not reachable from MCP (import-graph test).
7. Got a reply / Interview / Rejected stop further suggestions; Interview and Rejected also set the job status after a confirm.
8. Backup export and restore carry follow-up state and drafts; Gmail tokens stay out.
9. Existing applications sent before V1 become due retroactively with no data migration.
10. Nothing in V1 sends automatically, and the bot cannot approve, send or set outcomes.

## 7. Risks and open items
- **Late drafts:** the bot only runs on its schedule, so a draft can be up to one run late. Fine for a 7-day cadence.
- **Forgotten replies:** manual marking means a reply you did not mark can still produce a nudge. Mitigation: the "Open thread in Gmail" link on every row. V2 hook: an `report_application_reply` MCP tool for the bot to mark replies.
- **Reply detection by the app** (a Gmail read scope) stays out of V1 by decision; revisit in V2 with its own security review.
- **Timezone** for "7 days" and "next weekday" needs a ruling (S3).
- **Threading** depends on spike S1; the fallback is slightly weaker threading outside Gmail.
- **Invariant sprawl** (S2) is the main engineering risk, which is why F-0 comes first.
