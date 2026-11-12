import { toast } from "sonner";
import { restoreJobStatus } from "@/actions/job.actions";
import { toastError, toastSuccess } from "@/lib/toast";

type PreviousStatus = { id: string; label: string } | null | undefined;

// Success toast for Archive with an Undo that restores the status the job had
// before (issue #75). `after` refreshes whatever view is showing.
export function toastArchived(
  previous: PreviousStatus,
  jobId: string,
  after: () => void,
) {
  if (!previous) {
    toastSuccess("Job has been archived");
    return;
  }
  toast.success("Job has been archived", {
    action: {
      label: "Undo",
      onClick: async () => {
        const { success, message } = await restoreJobStatus(jobId, previous.id);
        if (success) {
          toastSuccess(`Job restored to ${previous.label}`);
          after();
        } else {
          toastError(message);
        }
      },
    },
  });
}
