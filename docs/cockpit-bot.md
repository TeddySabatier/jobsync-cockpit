# Connecting a daily Claude bot to the cockpit

The cockpit replaces the "create a Gmail draft" step of a daily job-application bot. The bot still finds postings, checks the fit, tailors the CV and writes the letter. At the end it **hands the package to the cockpit** instead of creating a draft. You review it there and press Send yourself. The bot has no way to send.

The hand-over is a small script, `scripts/bot/cockpit_submit.py` (Python standard library only, no installs). The bot runs it the same way it runs a CV renderer. A script is needed because the PDF travels inside the request as base64, which an LLM cannot type out reliably.

## One-time setup

1. Copy `scripts/bot/cockpit_submit.py` into the bot folder, next to the CV renderer.
2. In the cockpit, open **Settings → MCP Access → Generate**. Name it after the bot. Pick the **longest expiry** and note the date: when a token expires the bot silently stops being able to submit. Copy the token (it is shown once).
3. Save it in `secrets/cockpit_token.txt` next to the script (or set `COCKPIT_TOKEN`). Never commit it.
4. If the cockpit is not at `http://localhost:3737`, set `COCKPIT_URL` to `<address>/api/mcp`.
5. Run `python cockpit_submit.py check`. Expected: `{"ok": true, "tools": [...]}`.

A token created before the cockpit was installed lacks the new permissions: create a new one.

## What to change in the bot's pipeline

**Hard rules.** Replace "only create drafts via the Gmail tools" with:
> Never send email. You have no send tool. You hand each application to the cockpit with `cockpit_submit.py`; the owner reviews it and presses Send. Don't apply twice: the script is safe to re-run (same day, company and role give the same package; it remembers the result in `.cockpit-submitted.json` inside the application folder and does not upload again; delete that file to force a fresh submit), and the cockpit refuses a job that was already sent (`ALREADY_SENT`: skip it and log it).

**New first step: change requests.** Add before "Fetch":
> Run `python cockpit_submit.py changes`. For each item, open the application folder named in `sourceFolder`, read `changeRequest`, and apply it truthfully (same rules as for a new application: never invent experience). Re-render the CV, rewrite `letter.md`, then resubmit with the same company, role, subject and fit, adding `--revision <packageId>`. That creates the next version and closes the request. If the instruction needs no new version (a question), run `python cockpit_submit.py done --package <packageId> --response "<what you did>"`.

**Replace the "Create the draft" step** with:
> Create the package, from the bot folder:
> `python cockpit_submit.py submit --folder ..\applications\<folder> --company "<Company>" --role "<Role>" --subject "<same subject as the old draft>" --fit A --track <Energy|Fintech|AI|Startup|Consulting> --url "<posting link>" --to "<recruiter address>" --location "<location>" --reasons "<why it fits; second reason>"`
> Leave `--to` out when the posting gives no address: the cockpit then treats it as "apply via link" and puts that link first in the body. The folder must contain `letter.md`, `posting.md`, `cv.json` and the rendered PDF. The command prints one JSON line. `"ok": true` means done. On `"ok": false`, log the `error` and `message` and continue with the next posting.

The Gmail labels are gone: the fit grade and the track are stored in the package.

**Close out.** Log the stage as `Submitted to cockpit` (instead of `Draft ready`), with the folder or link.

## Scheduling

A daily run means a change request waits up to a day. Add a second, cheap scheduled task every 30 to 60 minutes whose whole prompt is the **change requests** step above. It does nothing when the list is empty.

## Errors

| `error` | Meaning | What to do |
|---|---|---|
| `UNAUTHORIZED` | Token wrong or expired | Generate a new token |
| `UNAUTHORIZED_SCOPE`, `MISSING_TOOLS` | Token made before the cockpit, or cockpit disabled | New token; check `COCKPIT_ENABLED` |
| `UNREACHABLE` | The app is down or the URL is wrong | Start the app; check `COCKPIT_URL` |
| `NOT_FOUND` | Wrong address, or the cockpit is off | Check the URL and `COCKPIT_ENABLED` |
| `ALREADY_SENT` | That job was already sent | Skip it |
| `RATE_LIMITED` | Too many requests | Wait and retry later |
| `TOO_LARGE` | PDF over the size limit | Shrink the CV |
| `VALIDATION` | A field was rejected (message says which) | Fix and re-run |
| `FILE_NOT_FOUND` | A file is missing from the folder | Render the CV, write the letter |
| `NO_TOKEN` | No token configured | See setup |

## What you do in the cockpit

Open **Review**: edit the letter, email and CV fields, ask for changes, reject with a reason, or approve and press **Send**. Sending is possible only from your signed-in session, never from the bot.
