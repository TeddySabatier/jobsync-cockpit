"use client";
import { useEffect, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
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
// `destructive` styles the submit button red (Reject).
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
  destructive = false,
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
  destructive?: boolean;
}) {
  const [text, setText] = useState(initialValue);
  const trimmed = text.trim();
  const fieldId = useId();
  useEffect(() => {
    if (!open) setText(initialValue);
  }, [open, initialValue]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <Label htmlFor={fieldId}>{label}</Label>
        <Textarea
          id={fieldId}
          aria-describedby="text-dialog-count"
          className="min-h-32"
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
            variant={destructive ? "destructive" : "default"}
            data-destructive={destructive ? "true" : undefined}
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
