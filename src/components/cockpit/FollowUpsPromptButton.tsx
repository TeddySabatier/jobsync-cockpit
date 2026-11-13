"use client";
import { CopyPromptButton } from "@/components/cockpit/CopyPromptButton";
import { buildFollowUpsPrompt } from "@/lib/cockpit/followUpPrompt";

// Copies the prompt that makes Claude draft the follow-ups that are due
// (D-034 j, D-042). Shown on the review queue, which only exists with the
// cockpit enabled. The drafts come back to To do; nothing is sent.
export function FollowUpsPromptButton({
  dueCount,
  className,
  variant,
}: {
  dueCount?: number;
  className?: string;
  variant?: "outline" | "default";
}) {
  return (
    <CopyPromptButton
      buildPrompt={() => buildFollowUpsPrompt({ dueCount })}
      label="Copy prompt: draft due follow-ups"
      title="Copy a prompt to paste into Claude: it drafts the follow-ups that are due and sends the drafts to Review. It never sends an email."
      successMessage="Paste it into Claude to draft your due follow-ups."
      testId="follow-ups-prompt-btn"
      textTestId="follow-ups-prompt-text"
      className={className}
      variant={variant}
    />
  );
}
