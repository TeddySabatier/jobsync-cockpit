"use client";
import { useState } from "react";
import { ClipboardCopy } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { toastSuccess } from "@/lib/toast";
import { buildClaudePrompt, type ClaudePromptInput } from "@/lib/cockpit/claudePrompt";

// navigator.clipboard only exists in a secure context (https or localhost), so
// a phone reaching the app over plain http needs the older route.
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "absolute";
    area.style.left = "-9999px";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}

// One click: copies the prompt for Claude. If the browser refuses, the prompt is
// shown in a box to copy by hand, so the button is never a dead end.
export function ClaudePromptButton({ input }: { input: ClaudePromptInput }) {
  const [manualText, setManualText] = useState<string | null>(null);

  const onClick = async () => {
    const text = buildClaudePrompt(input);
    if (await copyText(text)) {
      toastSuccess("Paste it into Claude to prepare this application.", "Prompt copied");
    } else {
      setManualText(text);
    }
  };

  return (
    <>
      <Button
        size="sm"
        variant="outline"
        className="h-8 gap-1 cursor-pointer"
        data-testid="claude-prompt-btn"
        title="Copy a ready-made prompt to paste into Claude: it prepares the CV, letter and email for this job"
        onClick={onClick}
      >
        <ClipboardCopy className="h-3.5 w-3.5" />
        <span className="sr-only sm:not-sr-only sm:whitespace-nowrap">Claude prompt</span>
      </Button>
      <Dialog open={manualText !== null} onOpenChange={(open) => !open && setManualText(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Copy this prompt</DialogTitle>
            <DialogDescription>
              Your browser did not allow automatic copying. Select all, copy, and paste it into Claude.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            readOnly
            value={manualText ?? ""}
            className="h-72 font-mono text-xs"
            data-testid="claude-prompt-text"
            onFocus={(e) => e.currentTarget.select()}
          />
        </DialogContent>
      </Dialog>
    </>
  );
}
