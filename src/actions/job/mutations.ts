"use server";
import prisma from "@/lib/db";
import { handleError } from "@/lib/utils";
import { createJobRecord } from "@/lib/jobs/createJobRecord";
import { AddJobFormSchema } from "@/models/addJobForm.schema";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUser } from "../shared";

export const addJob = async (
  data: z.infer<typeof AddJobFormSchema>,
): Promise<any | undefined> => {
  try {
    const user = await requireUser();

    const {
      title,
      company,
      location,
      type,
      workplaceType,
      status,
      source,
      salaryRange,
      dueDate,
      dateApplied,
      jobDescription,
      jobUrl,
      applied,
      resume,
      coverLetter,
      tags,
    } = data;

    const job = await createJobRecord({
      jobTitleId: title,
      companyId: company,
      locationId: location,
      statusId: status,
      jobSourceId: source,
      salaryRange: salaryRange || null,
      dueDate,
      appliedDate: dateApplied,
      description: jobDescription,
      jobType: type,
      workplaceType,
      userId: user.id,
      jobUrl,
      applied,
      resumeId: resume,
      coverLetterId: coverLetter,
      tagIds: tags ?? [],
    });
    revalidatePath("/dashboard");
    return { success: true, data: job };
  } catch (error) {
    const msg = "Failed to create job. ";
    return handleError(error, msg);
  }
};

export const updateJob = async (
  data: z.infer<typeof AddJobFormSchema>,
): Promise<any | undefined> => {
  try {
    const user = await requireUser();
    if (!data.id) {
      throw new Error("Job id is required");
    }

    const {
      id,
      title,
      company,
      location,
      type,
      workplaceType,
      status,
      source,
      salaryRange,
      dueDate,
      dateApplied,
      jobDescription,
      jobUrl,
      applied,
      resume,
      coverLetter,
      tags,
    } = data;

    const tagIds = tags ?? [];

    const job = await prisma.job.update({
      where: {
        id,
        userId: user.id,
      },
      data: {
        jobTitleId: title,
        companyId: company,
        locationId: location,
        statusId: status,
        jobSourceId: source,
        salaryRange: salaryRange || null,
        createdAt: new Date(),
        dueDate: dueDate,
        appliedDate: dateApplied,
        description: jobDescription,
        jobType: type,
        workplaceType,
        jobUrl,
        applied,
        resumeId: resume,
        coverLetterId: coverLetter,
        tags: { set: tagIds.map((id) => ({ id })) },
      },
    });
    revalidatePath("/dashboard");
    return { success: true, data: job };
  } catch (error) {
    const msg = "Failed to update job. ";
    return handleError(error, msg);
  }
};

const JOB_HAS_PACKAGES_MESSAGE =
  "This job has application packages and sent-email history, so it cannot be deleted. Archive it instead.";

// Deleting a job must never delete the history of what was sent (issue #75,
// D-026): a job with any application package is refused here with a message
// pointing to Archive. The schema backs this up (ApplicationPackage.job is
// ON DELETE RESTRICT), so a race or a code path that skips this check fails
// loudly instead of cascading.
export const deleteJobById = async (
  jobId: string,
): Promise<any | undefined> => {
  try {
    const user = await requireUser();

    const packages = await prisma.applicationPackage.count({
      where: { jobId, job: { userId: user.id } },
    });
    if (packages > 0) {
      return { success: false, message: JOB_HAS_PACKAGES_MESSAGE };
    }

    const res = await prisma.job.delete({
      where: {
        id: jobId,
        userId: user.id,
      },
    });
    revalidatePath("/dashboard");
    return { res, success: true };
  } catch (error) {
    // A package created between the check and the delete trips the RESTRICT.
    if ((error as { code?: string } | null)?.code === "P2003") {
      return { success: false, message: JOB_HAS_PACKAGES_MESSAGE };
    }
    const msg = "Failed to delete job.";
    return handleError(error, msg);
  }
};

// Archive = status "archived". Reversible (change the status back) and keeps
// the job's packages, Review history and sent emails untouched.
export const archiveJobById = async (
  jobId: string,
): Promise<any | undefined> => {
  try {
    const user = await requireUser();

    const owned = await prisma.job.findFirst({
      where: { id: jobId, userId: user.id },
      select: { id: true, Status: true },
    });
    if (!owned) {
      return { success: false, message: "Job not found." };
    }

    const status = await prisma.jobStatus.upsert({
      where: { value: "archived" },
      update: {},
      create: { label: "Archived", value: "archived" },
    });
    const job = await prisma.job.update({
      where: { id: jobId },
      data: { statusId: status.id },
    });
    revalidatePath("/dashboard");
    // Returned so the UI can offer Undo. Null when it was already archived.
    const previousStatus =
      owned.Status.value === "archived" ? null : owned.Status;
    return { job, success: true, previousStatus };
  } catch (error) {
    const msg = "Failed to archive job.";
    return handleError(error, msg);
  }
};

// Undo for archiveJobById: puts back the status the job had before. Only sets
// the status (updateJobStatus has side effects for "applied") and only acts
// on a job that is still archived, so a stale Undo cannot overwrite a later
// manual status change.
export const restoreJobStatus = async (
  jobId: string,
  statusId: string,
): Promise<any | undefined> => {
  try {
    const user = await requireUser();

    const res = await prisma.job.updateMany({
      where: { id: jobId, userId: user.id, Status: { value: "archived" } },
      data: { statusId },
    });
    if (res.count === 0) {
      return {
        success: false,
        message: "Nothing to undo: the job is no longer archived.",
      };
    }
    revalidatePath("/dashboard");
    return { success: true };
  } catch (error) {
    const msg = "Failed to restore job status.";
    return handleError(error, msg);
  }
};
