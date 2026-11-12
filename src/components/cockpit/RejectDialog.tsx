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
import { REJECT_REASON_CHIPS, TEXT_MAX } from "@/lib/cockpit/rejectReasons";

// Reject (D-041): the reason is OPTIONAL. A chip fills it in one tap; free text
// is still possible. The submit is destructive-styled and always enabled.
export default function RejectDialog({
  open,
  onOpenChange,
  busy,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  busy: boolean;
  onSubmit: (reason: string) => void;
}) {
  const [text, setText] = useState("");
  useEffect(() => {
    if (!open) setText("");
  }, [open]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Reject this application</DialogTitle>
          <DialogDescription>
            The reason is optional. It is kept with the application, and you can reopen it later.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap gap-2" role="group" aria-label="Quick reasons">
          {REJECT_REASON_CHIPS.map((chip) => (
            <Button
              key={chip}
              type="button"
              variant="outline"
              size="sm"
              className="h-9"
              aria-pressed={text === chip}
              onClick={() => setText(text === chip ? "" : chip)}
            >
              {chip}
            </Button>
          ))}
        </div>
        <Textarea
          aria-label="Reject reason (optional)"
          placeholder="Optional: say why"
          className="min-h-24"
          value={text}
          maxLength={TEXT_MAX}
          onChange={(e) => setText(e.target.value)}
        />
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={busy}
            onClick={() => onSubmit(text.trim())}
          >
            Reject
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
