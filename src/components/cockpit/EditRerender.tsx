"use client";
import { useState } from "react";
import { requestPackageChanges } from "@/actions/cockpit.actions";
import { toastError, toastSuccess } from "@/lib/toast";
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

export const RERENDER_INSTRUCTION =
  "Re-render the CV PDF from the edited cvJson and resubmit.";

// "Ask the bot to re-render" (SPEC §5.4): a request-changes call with a
// prefilled instruction the user can edit before sending.
export default function EditRerender({ packageId }: { packageId: string }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(RERENDER_INSTRUCTION);
  const [busy, setBusy] = useState(false);
  const trimmed = text.trim();

  async function submit() {
    setBusy(true);
    try {
      const r = await requestPackageChanges(packageId, trimmed);
      if (r.success) {
        toastSuccess("Re-render requested");
        setOpen(false);
      } else {
        toastError(r.message);
      }
    } catch {
      toastError("Request failed. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={() => {
          setText(RERENDER_INSTRUCTION);
          setOpen(true);
        }}
      >
        Ask the bot to re-render
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Ask the bot to re-render</DialogTitle>
            <DialogDescription>
              The CV text was edited, so the PDF no longer matches. This sends
              a change request; the bot resubmits a new version.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            aria-label="Instruction"
            value={text}
            maxLength={2000}
            onChange={(e) => setText(e.target.value)}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button disabled={busy || trimmed.length === 0} onClick={submit}>
              Request re-render
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
