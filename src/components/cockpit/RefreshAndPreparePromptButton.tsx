"use client";
import { CopyPromptButton } from "@/components/cockpit/CopyPromptButton";
import { buildRefreshAndPreparePrompt, REFRESH_AND_PREPARE_CAP } from "@/lib/cockpit/claudePrompt";

// Jobs list: one prompt that refreshes the job list and then prepares the best
// new jobs (grade A or B, at most REFRESH_AND_PREPARE_CAP), without sending
// anything (D-041).
export function RefreshAndPreparePromptButton() {
  return (
    <CopyPromptButton
      buildPrompt={() => buildRefreshAndPreparePrompt()}
      label="Refresh and prepare"
      title={`Copy a prompt to paste into Claude: it fetches new postings, then prepares the best ones (at most ${REFRESH_AND_PREPARE_CAP}) for Review. It never sends an email.`}
      successMessage="Paste it into Claude to refresh and prepare applications."
      testId="refresh-prepare-prompt-btn"
      textTestId="refresh-prepare-prompt-text"
    />
  );
}
