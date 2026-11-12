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

// navigator.clipboard only exists in a secure context (https or localhost), so
// a phone reaching the app over plain http needs the older route.
export async function copyText(text: string): Promise<boolean> {
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

// One click: copies a prompt for Claude. If the browser refuses, the prompt is
// shown in a box to copy by hand, so the button is never a dead end.
export function CopyPromptButton({
  buildPrompt,
  label,
  title,
  successMessage,
  testId,
  textTestId,
}: {
  buildPrompt: () => string;
  label: string;
  title: string;
  successMessage: string;
  testId: string;
  textTestId: string;
}) {
  const [manualText, setManualText] = useState<string | null>(null);

  const onClick = async () => {
    const text = buildPrompt();
    if (await copyText(text)) {
      toastSuccess(successMessage, "Prompt copied");
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
        data-testid={testId}
        title={title}
        onClick={onClick}
      >
        <ClipboardCopy className="h-3.5 w-3.5" />
        <span className="sr-only sm:not-sr-only sm:whitespace-nowrap">{label}</span>
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
            data-testid={textTestId}
            onFocus={(e) => e.currentTarget.select()}
          />
        </DialogContent>
      </Dialog>
    </>
  );
}
