"use client";
import { CopyPromptButton } from "@/components/cockpit/CopyPromptButton";
import { buildClaudePrompt, type ClaudePromptInput } from "@/lib/cockpit/claudePrompt";

// One click: copies the prompt for Claude to prepare this one application.
export function ClaudePromptButton({ input }: { input: ClaudePromptInput }) {
  return (
    <CopyPromptButton
      buildPrompt={() => buildClaudePrompt(input)}
      label="Claude prompt"
      title="Copy a ready-made prompt to paste into Claude: it prepares the CV, letter and email for this job"
      successMessage="Paste it into Claude to prepare this application."
      testId="claude-prompt-btn"
      textTestId="claude-prompt-text"
    />
  );
}
