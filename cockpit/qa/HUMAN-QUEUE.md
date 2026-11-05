# Human queue — what only the owner can check

Ordered by when you need them. Details for deploy and Gmail steps are in `cockpit/HANDOFF-CLAUDE-CODE.md`.

## Before deploy

- [ ] **Rebuild the image from current `main`.** The local `jobsync-cockpit:v0` was built from `2297ca3`, before the fixes in #34 (error toast when an action request fails) and #37 (dot-segment user dir).
- [ ] Cold backup of the data folder with the app stopped (HANDOFF §1).

## Real Gmail (not testable by automation)

- [ ] **Connect** from `/dashboard/review/settings` with your own OAuth client; `COCKPIT_GMAIL_ALLOWED_ADDRESS` set to your address.
- [ ] **Reconnect once** and confirm the connection still works afterwards (D-010).
- [ ] **First send to yourself**: a package whose recipient is your own address. Check Gmail Sent: subject, body, attachment opens. Package shows `sent`, job shows `applied` with a date.
- [ ] Only then the first send to a real recipient.

## AC-30: PDF in the review iframe

- [ ] In a real desktop browser (Chrome, then Firefox and Safari if you use them), open a package detail page and check that the CV PDF renders in the iframe. The file route sends `Content-Security-Policy: sandbox; frame-ancestors 'self'`.
- [ ] **If the PDF does not render:** record a DECISIONS entry before changing anything. Options in SPEC §11: drop `sandbox` (keep `nosniff` and the scoped frame rules) or offer download only.
- Automation could not verify this: full Chromium with a PDF viewer cannot launch in the WSL test host. The opt-in probe is `e2e/cockpit/06-pdf-iframe.spec.ts` (`COCKPIT_E2E_PDF=1`); run it on a machine where full Chromium starts.

## Two P3 product bugs (end-to-end tests marked `test.fixme`)

- [ ] Issue #38: an unbroken 120-character subject makes the page scroll horizontally at 375 px.
- [ ] Issue #39: focus is not returned to the Send button after Escape closes the Send dialog.

Flip the two `fixme` to `test` when the fixes land.

## Known items still open (HANDOFF §7)

- [ ] `File` rows have no `userId` column; ownership is path-based (V1 hook).
- [ ] Edits have no optimistic concurrency; two tabs can overwrite each other (Send re-checks `updatedAt`).
- [ ] `attach_file` quota check is not atomic (single user).
- [ ] Upstream `/api/profile/resume` has no path confinement (upstream code, not changed in V0).
- [ ] Leaving edit mode through a sidebar link does not warn about unsaved changes (known limit).
- [ ] Rate limits are per process and a fixed window (can pass up to 2× max across a window edge); not shared across replicas.
- [ ] Use a dedicated MCP token for the bot, created after upgrade (older tokens lack `package:write` and `jobs:read`).
- [ ] The Send dialog's domain and free-mail warning is a heuristic and can false-positive.

## Housekeeping

- [ ] **Flaky upstream test:** `__tests__/AddExperience.spec.tsx` timed out once (5 s) under load in 1 of 3 full runs. Not cockpit code. Raise its timeout or leave it; track upstream.
- [ ] **PR #4 old commit:** its first commit `817a1d9` is still visible on the PR page and mentions an SSH alias, a second GitHub account and local paths (no secrets, not in `main`). Consider deleting or rewriting the PR if that matters to you.
- [ ] Commits may show your personal email as author; consider a GitHub `noreply` address.
- [ ] C-09's PR body still says "revokes old one"; D-010 supersedes it.
- [ ] Resolved, for the record: the `DataSettings` timezone flake (#28).
