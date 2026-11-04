import {
  getJobDetails,
  getJobSourceList,
  getStatusList,
} from "@/actions/job.actions";
import JobDetails from "@/components/myjobs/JobDetails";
import { getAllCompanies } from "@/actions/company.actions";
import { getAllJobTitles } from "@/actions/jobtitle.actions";
import { getAllJobLocations } from "@/actions/jobLocation.actions";
import { getAllTags } from "@/actions/tag.actions";
import { notFound } from "next/navigation";
import { isCockpitEnabled } from "@/lib/cockpit/config";
import { getCurrentUser } from "@/utils/user.utils";
import { listJobVersions } from "@/lib/cockpit/packages";

// Active package of the job (highest non-superseded version), only with the
// cockpit flag on and a session; null otherwise.
async function getActivePackageCard(jobId: string) {
  if (!isCockpitEnabled()) return null;
  const user = await getCurrentUser();
  if (!user) return null;
  const versions = await listJobVersions(user.id, jobId);
  return versions.find((v) => v.status !== "superseded") ?? null;
}

async function JobDetailsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [{ job }, statuses, companies, titles, locations, sources, tags] =
    await Promise.all([
      getJobDetails(id),
      getStatusList(),
      getAllCompanies(),
      getAllJobTitles(),
      getAllJobLocations(),
      getJobSourceList(),
      getAllTags(),
    ]);

  // A link to a job that was deleted (or never belonged to this user) would
  // otherwise crash JobDetails on the first job.* read.
  if (!job) notFound();

  const cockpitPackage = await getActivePackageCard(job.id);

  return (
    <div className="col-span-3">
      <JobDetails
        job={job}
        jobStatuses={statuses}
        companies={companies}
        titles={titles}
        locations={locations}
        sources={sources}
        tags={tags ?? []}
        cockpitPackage={cockpitPackage}
      />
    </div>
  );
}

export default JobDetailsPage;
