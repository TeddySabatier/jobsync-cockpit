import type { CockpitResult } from "@/lib/cockpit/errors";
import { toastError, toastSuccess } from "@/lib/toast";

export const REQUEST_FAILED = "Request failed. Check your connection and try again.";

// The try / toast / busy wrapper of the cockpit components. A failure result
// toasts its fixed message, a thrown action (network drop, deploy mid-request)
// toasts REQUEST_FAILED; busy is always reset.
export async function runAction<T>(
  fn: () => Promise<CockpitResult<T>>,
  opts: {
    success: string;
    setBusy: (busy: boolean) => void;
    // Success only.
    onSuccess?: () => void;
    // Replaces the plain success toast (e.g. one with an Undo button).
    showSuccess?: () => void;
    // Any returned result (not a throw), after the toast.
    onSettled?: () => void;
  },
): Promise<void> {
  opts.setBusy(true);
  try {
    const r = await fn();
    if (r.success) {
      if (opts.showSuccess) opts.showSuccess();
      else toastSuccess(opts.success);
      opts.onSuccess?.();
    } else {
      toastError(r.message);
    }
    opts.onSettled?.();
  } catch {
    toastError(REQUEST_FAILED);
  } finally {
    opts.setBusy(false);
  }
}
