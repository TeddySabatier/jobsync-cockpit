// Cockpit tool descriptions (cockpit/SPEC.md §3). Kept apart from
// toolDescriptions.ts (shared with evals/mcp-tools) so the flag-off tool list
// is identical to upstream. Descriptions are prompt surface: they state the
// contract the bot has to follow.
export const COCKPIT_TOOL_DESCRIPTIONS = {
  attach_file:
    "Upload the tailored CV as a PDF (base64, at most about 5 MB) and get back a fileId. Call this first, then pass the returned fileId as cvFileId to submit_application_package. Only application/pdf is accepted. Domain errors come back as isError '<CODE>: message'; a malformed argument (wrong type, out of range) is rejected by the MCP layer before that, in its own format.",
  submit_application_package:
    "Submit an application package for a saved job. Fields: emailSubject (no line break), emailBody, emailTo (one address; omit or \"\" to apply via a link instead of email), fitGrade (only \"A\" or \"B\" is accepted), optional letterMd, fitAnalysis, cvJson, sourceFolder, contactSource (where you found the recipient address: a URL or a short note such as \"posting\"; shown to the owner next to the recipient), and cvFileId (fileId from attach_file; without it the owner cannot send the package by Gmail). Creates version n+1 for the job and supersedes its earlier unsent versions, including a pending change request. The user reviews, approves and sends it in the JobSync UI; there is no tool to approve or send. Pass an idempotencyKey to make retries safe; reusing a key for another job gives CONFLICT. On CONFLICT, replay the whole submit. ALREADY_SENT and JOB_REJECTED mean stop: do not resubmit for that job.",
  list_jobs:
    "List the user's saved jobs, newest first, with the active package (newest non-superseded version: id, version, status, else null) of each. Filter by status value (e.g. 'draft', 'applied') or by hasPackage (true: has an active package; false: has none). Paginate with limit (1-100, default 50) and offset.",
  get_job:
    "Get one saved job (title, company, location, status, URL, description, match score) with all its package versions, newest first. Every version has its status, idempotencyKey (to recognise your own package after a crash), email subject, grade, change/reject notes and CV file; full content (emailBody, letterMd, fitAnalysis, cvJson) only on the newest version. Use it to read the job posting before preparing a package.",
  list_change_requests:
    "List packages where the user asked for changes (oldest first), with the user's instruction and the current package content. For each one, either submit a new version with submit_application_package (call attach_file first if the PDF changed; this closes the request) or call mark_change_request_done, never both.",
  mark_change_request_done:
    "Close a change request without resubmitting: moves a package from changes_requested back to pending with a short response note for the user. Any other status gives INVALID_STATE. If the CV or email text changed, submit a new version instead.",
} as const;

export type CockpitToolName = keyof typeof COCKPIT_TOOL_DESCRIPTIONS;
