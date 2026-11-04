// Cockpit tool descriptions (cockpit/SPEC.md §3). Kept apart from
// toolDescriptions.ts (shared with evals/mcp-tools) so the flag-off tool list
// is identical to upstream. Descriptions are prompt surface: they state the
// contract the bot has to follow.
export const COCKPIT_TOOL_DESCRIPTIONS = {
  attach_file:
    "Upload the tailored CV as a PDF (base64, at most about 5 MB) and get back a fileId. Call this first, then pass the returned fileId as cvFileId to submit_application_package. Only application/pdf is accepted; other content is rejected. Errors come back as isError with '<CODE>: message'.",
  submit_application_package:
    "Submit an application package for a saved job: email (subject, body, optional recipient), optional cover letter, fit grade and analysis, CV JSON and the CV PDF fileId from attach_file. Creates version n+1 for the job and supersedes open earlier versions. The user reviews, approves and sends it in the JobSync UI; there is no tool to approve or send. Pass an idempotencyKey to make retries safe. On CONFLICT, replay the whole submit. ALREADY_SENT and JOB_REJECTED mean stop: do not resubmit for that job.",
  list_jobs:
    "List the user's saved jobs, newest first, with the active package (id, version, status) of each. Filter by status value (e.g. 'draft', 'applied') or by hasPackage. Paginate with limit (1-100, default 50) and offset.",
  get_job:
    "Get one saved job (title, company, location, status, URL, description, match score) with all its package versions, newest first. Use it to read the job posting before preparing a package.",
  list_change_requests:
    "List packages where the user asked for changes (oldest first), with the user's instruction and the current package content. Fix each one, call attach_file if the PDF changed, submit a new version with submit_application_package, then close the request with mark_change_request_done only if you did not resubmit.",
  mark_change_request_done:
    "Close a change request without resubmitting: moves a package from changes_requested back to pending with a short response note for the user. Any other status gives INVALID_STATE. If the CV or email text changed, submit a new version instead.",
} as const;

export type CockpitToolName = keyof typeof COCKPIT_TOOL_DESCRIPTIONS;
