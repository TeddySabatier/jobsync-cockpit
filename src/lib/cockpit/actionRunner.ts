import { revalidatePath } from "next/cache";
import { requireUser } from "@/actions/shared";
import { isCockpitEnabled } from "./config";
import { CockpitError, toActionResult, type CockpitResult } from "./errors";

// The one run/mutate wrapper of the cockpit server actions. Deliberately NOT a
// "use server" module: everything exported there becomes a public endpoint.
// Order (P6): requireUser() inside the try, then the flag, then the work. A
// throw becomes a failure result and no DB access happens before the user is
// known.

export async function run<T>(
  fn: (userId: string) => Promise<T>,
): Promise<CockpitResult<T>> {
  try {
    const user = await requireUser();
    if (!isCockpitEnabled()) throw new CockpitError("COCKPIT_DISABLED");
    return { success: true, data: await fn(user.id) };
  } catch (e) {
    return toActionResult(e);
  }
}

// Runs a mutation, then revalidates `paths` after every outcome except an
// auth/flag failure: a failed mutation (INVALID_STATE, CONFLICT, a send that
// left a lock) means the page showed stale state and must be refreshed.
export async function mutate<T>(
  paths: string[],
  fn: (userId: string) => Promise<T>,
): Promise<CockpitResult<T>> {
  const result = await run(fn);
  if (
    result.success ||
    (result.code !== "UNAUTHENTICATED" && result.code !== "COCKPIT_DISABLED")
  ) {
    for (const p of paths) revalidatePath(p);
  }
  return result;
}

// Review pages of one package; `jobs` adds the job list for an action that
// changes the job (applied).
export function reviewPaths(id: string, opts?: { jobs?: boolean }): string[] {
  const paths = ["/dashboard/review", `/dashboard/review/${id}`];
  if (opts?.jobs) paths.push("/dashboard/myjobs");
  return paths;
}
