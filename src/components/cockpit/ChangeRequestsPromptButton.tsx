"use client";
import { CopyPromptButton } from "@/components/cockpit/CopyPromptButton";
import { buildChangeRequestsPrompt } from "@/lib/cockpit/claudePrompt";

// Copies the prompt that makes Claude answer every open change request (D-041).
// Used on the "Changes requested" state of an application and on the Changes tab.
export function ChangeRequestsPromptButton({
  className,
  variant,
}: {
  className?: string;
  variant?: "outline" | "default";
}) {
  return (
    <CopyPromptButton
      buildPrompt={() => buildChangeRequestsPrompt()}
      label="Copy prompt: handle change requests"
      title="Copy a prompt to paste into Claude: it answers your change requests and sends the new versions back to Review. It never sends an email."
      successMessage="Paste it into Claude to handle your change requests."
      testId="change-requests-prompt-btn"
      textTestId="change-requests-prompt-text"
      className={className}
      variant={variant}
    />
  );
}
