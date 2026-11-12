"use client";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export const TEXT_DIALOG_MAX = 2000;

// A dialog with one required free-text field (reject reason, change request,
// re-render instruction). The text resets to `initialValue` when it closes.
export default function TextDialog({
  open,
  onOpenChange,
  title,
  description,
  label,
  submitLabel,
  busy,
  onSubmit,
  initialValue = "",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  label: string;
  submitLabel: string;
  busy: boolean;
  onSubmit: (text: string) => void;
  initialValue?: string;
}) {
  const [text, setText] = useState(initialValue);
  const trimmed = text.trim();
  useEffect(() => {
    if (!open) setText(initialValue);
  }, [open, initialValue]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <Textarea
          aria-label={label}
          aria-describedby="text-dialog-count"
          value={text}
          maxLength={TEXT_DIALOG_MAX}
          onChange={(e) => setText(e.target.value)}
        />
        <p
          id="text-dialog-count"
          className="text-right text-xs text-muted-foreground"
        >
          {`${text.length} / ${TEXT_DIALOG_MAX}`}
        </p>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={busy || trimmed.length === 0}
            onClick={() => onSubmit(trimmed)}
          >
            {submitLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
