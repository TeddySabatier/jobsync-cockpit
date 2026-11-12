"use client";
import { useState } from "react";
import { requestPackageChanges } from "@/actions/cockpit.actions";
import { Button } from "@/components/ui/button";
import { runAction } from "./runAction";
import TextDialog from "./TextDialog";

export const RERENDER_INSTRUCTION =
  "Re-render the CV PDF from the edited cvJson and resubmit.";

// "Ask the bot to re-render" (SPEC §5.4): a request-changes call with a
// prefilled instruction the user can edit before sending.
export default function EditRerender({ packageId }: { packageId: string }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        Ask the bot to re-render
      </Button>
      <TextDialog
        open={open}
        onOpenChange={setOpen}
        title="Ask the bot to re-render"
        description="The CV text was edited, so the PDF no longer matches. This sends a change request; the bot resubmits a new version."
        label="Instruction"
        submitLabel="Request re-render"
        initialValue={RERENDER_INSTRUCTION}
        busy={busy}
        onSubmit={(text) =>
          runAction(() => requestPackageChanges(packageId, text), {
            success: "Re-render requested",
            setBusy,
            onSuccess: () => setOpen(false),
          })
        }
      />
    </>
  );
}
