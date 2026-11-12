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

// Runs a mutation, then revalidates `paths` (the first one is the list page).
// Success and a state failure (INVALID_STATE, CONFLICT, a send that left a
// lock, GMAIL_*, INTERNAL) revalidate all of them: the page showed stale state.
// Not revalidated: UNAUTHENTICATED / COCKPIT_DISABLED (nothing happened),
// VALIDATION (an input error changes no state, a refresh would only flicker).
// NOT_FOUND only refreshes the list, never a path built from a client id.
export async function mutate<T>(
  paths: string[],
  fn: (userId: string) => Promise<T>,
): Promise<CockpitResult<T>> {
  const result = await run(fn);
  if (result.success) {
    for (const p of paths) revalidatePath(p);
    return result;
  }
  switch (result.code) {
    case "UNAUTHENTICATED":
    case "COCKPIT_DISABLED":
    case "VALIDATION":
      break;
    case "NOT_FOUND":
      if (paths[0]) revalidatePath(paths[0]);
      break;
    default:
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
