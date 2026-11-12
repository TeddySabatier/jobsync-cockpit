"use client";
import { CopyPromptButton } from "@/components/cockpit/CopyPromptButton";
import { buildRefreshJobsPrompt } from "@/lib/cockpit/claudePrompt";

// Jobs list: copies the prompt that makes Claude refresh the job list only.
export function RefreshJobsPromptButton() {
  return (
    <CopyPromptButton
      buildPrompt={buildRefreshJobsPrompt}
      label="Refresh jobs"
      title="Copy a prompt to paste into Claude: it fetches new postings and saves them here, without preparing any application"
      successMessage="Paste it into Claude to refresh the job list."
      testId="refresh-jobs-prompt-btn"
      textTestId="refresh-jobs-prompt-text"
    />
  );
}
