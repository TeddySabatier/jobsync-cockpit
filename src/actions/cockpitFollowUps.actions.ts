"use server";

import { mutate } from "@/lib/cockpit/actionRunner";
import { CockpitError } from "@/lib/cockpit/errors";
import {
  setFollowUpOutcome as setFollowUpOutcomeSvc,
  skipFollowUpStep as skipFollowUpStepSvc,
  snoozeFollowUp as snoozeFollowUpSvc,
  stopFollowUps as stopFollowUpsSvc,
  undoFollowUpOutcome as undoFollowUpOutcomeSvc,
} from "@/lib/cockpit/followUps";

// Follow-up actions (V1 plan 3.6 row actions, D-030). Session only: nothing here
// sends, and none of it is reachable from MCP. Every export of a "use server"
// file is a public endpoint, so only the async actions are exported. The
// non-"use server" logic is src/lib/cockpit/followUps.ts; run/mutate do
// requireUser(), then the flag, then the work (P6). The outcome actions do NOT
// change the job status: the UI asks for a confirm and calls the job status
// action itself (plan 3.6).

// Revalidated after a change: the queue and the job pages. Built from constants,
// not from the client id.
const PATHS = ["/dashboard/review", "/dashboard/myjobs"];

function jobIdOf(jobId: unknown): string {
  if (typeof jobId !== "string" || !jobId) throw new CockpitError("VALIDATION");
  return jobId;
}

export async function snoozeFollowUp(jobId: string, days: number) {
  return mutate(PATHS, (userId) => snoozeFollowUpSvc(userId, jobIdOf(jobId), days));
}

export async function skipFollowUpStep(jobId: string) {
  return mutate(PATHS, (userId) => skipFollowUpStepSvc(userId, jobIdOf(jobId)));
}

export async function stopFollowUps(jobId: string) {
  return mutate(PATHS, (userId) => stopFollowUpsSvc(userId, jobIdOf(jobId)));
}

export async function setFollowUpOutcome(jobId: string, outcome: string) {
  return mutate(PATHS, (userId) =>
    setFollowUpOutcomeSvc(userId, jobIdOf(jobId), outcome),
  );
}

export async function undoFollowUpOutcome(jobId: string) {
  return mutate(PATHS, (userId) => undoFollowUpOutcomeSvc(userId, jobIdOf(jobId)));
}
