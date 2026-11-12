"use client";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../ui/table";
import { StickyNote } from "lucide-react";
import { Badge } from "../ui/badge";
import { format } from "date-fns";
import { useState } from "react";
import { JobResponse, JobStatus } from "@/models/job.model";
import Link from "next/link";
import { DeleteAlertDialog } from "../DeleteAlertDialog";
import { CircularScore } from "@/components/CircularScore";
import { JobStatusBadgeMenu } from "./JobStatusBadgeMenu";
import { TooltipProvider } from "../ui/tooltip";
import { JobActionsMenu } from "./JobActionsMenu";

type MyJobsTableProps = {
  jobs: JobResponse[];
  jobStatuses: JobStatus[];
  deleteJob: (id: string) => void;
  archiveJob?: (id: string) => void;
  editJob: (id: string) => void;
  onChangeJobStatus: (id: string, status: JobStatus) => void;
  onAddNote: (jobId: string) => void;
};

function MyJobsTable({
  jobs,
  jobStatuses,
  deleteJob,
  archiveJob,
  editJob,
  onChangeJobStatus,
  onAddNote,
}: MyJobsTableProps) {
  const [alertOpen, setAlertOpen] = useState(false);
  const [jobIdToDelete, setJobIdToDelete] = useState("");

  const onDeleteJob = (jobId: string) => {
    setAlertOpen(true);
    setJobIdToDelete(jobId);
  };

  return (
    <TooltipProvider delayDuration={300}>
      {/* Below md each row becomes a stacked card (title, company, status on
          the left, the actions menu on the right) so nothing is clipped or
          hidden behind a horizontal scroll. From md up it is the usual table. */}
      <Table role="table" aria-label="My jobs" className="max-md:block">
        <TableHeader role="rowgroup" className="max-md:sr-only">
          <TableRow role="row">
            <TableHead role="columnheader" className="hidden w-[100px] md:table-cell">
              <span className="sr-only">Company Logo</span>
            </TableHead>
            <TableHead role="columnheader" className="hidden md:table-cell">Date Applied</TableHead>
            <TableHead role="columnheader">Title</TableHead>
            <TableHead role="columnheader">Company</TableHead>
            <TableHead role="columnheader" className="hidden md:table-cell">Location</TableHead>
            <TableHead role="columnheader">Status</TableHead>
            <TableHead role="columnheader" className="hidden md:table-cell">Match</TableHead>
            <TableHead role="columnheader" className="hidden md:table-cell">Source</TableHead>
            <TableHead role="columnheader">
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody role="rowgroup" className="max-md:block">
          {jobs.map((job: JobResponse) => {
            return (
              <TableRow role="row"
                key={job.id}
                className="max-md:grid max-md:grid-cols-[minmax(0,1fr)_auto] max-md:items-center max-md:gap-x-2 max-md:gap-y-1 max-md:py-2"
              >
                <TableCell role="cell" className="hidden md:table-cell">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    alt="Company logo"
                    className="rounded-md object-cover h-8 w-8 min-w-8"
                    src={job.Company?.logoUrl || "/images/jobsync-logo.svg"}
                    onError={(e) => {
                      e.currentTarget.onerror = null;
                      e.currentTarget.src = "/images/jobsync-logo.svg";
                    }}
                  />
                </TableCell>
                <TableCell role="cell" className="hidden md:table-cell w-[120px] whitespace-nowrap">
                  {job.appliedDate ? format(job.appliedDate, "PP") : "N/A"}
                </TableCell>
                <TableCell role="cell"
                  className="font-medium cursor-pointer min-w-0 max-md:col-start-1 max-md:block max-md:max-w-none max-md:px-2 max-md:py-0 md:max-w-[220px]"
                >
                  <div className="flex items-center gap-1.5">
                    <Link
                      href={`/dashboard/myjobs/${job?.id}`}
                      className="block min-w-0 truncate max-md:flex-1 max-md:py-3 max-md:leading-5"
                      title={job.JobTitle?.label}
                    >
                      {job.JobTitle?.label}
                    </Link>
                    {(job._count?.Notes ?? 0) > 0 && (
                      <Badge variant="secondary" className="text-xs px-1.5 py-0 h-5 shrink-0">
                        <StickyNote className="h-3 w-3 mr-0.5" />
                        {job._count!.Notes}
                      </Badge>
                    )}
                  </div>
                </TableCell>
                <TableCell role="cell" className="min-w-0 font-medium max-md:col-start-1 max-md:block max-md:max-w-none max-md:px-2 max-md:py-0 md:max-w-[160px]">
                  <span className="block truncate" title={job.Company?.label}>
                    {job.Company?.label}
                  </span>
                </TableCell>
                <TableCell role="cell" className="hidden md:table-cell whitespace-nowrap max-w-[120px]">
                  <span className="block truncate">{job.Location?.label}</span>
                </TableCell>
                <TableCell role="cell" className="max-md:col-start-1 max-md:block max-md:px-2 max-md:py-0">
                  <JobStatusBadgeMenu
                    job={job}
                    jobStatuses={jobStatuses}
                    onChangeJobStatus={onChangeJobStatus}
                    className="min-w-[110px] whitespace-nowrap justify-center"
                  />
                </TableCell>
                <TableCell role="cell" className="hidden md:table-cell">
                  {job.matchScore != null ? (
                    <CircularScore score={job.matchScore} size="sm" animate={false} />
                  ) : (
                    <span className="text-muted-foreground">-</span>
                  )}
                </TableCell>
                <TableCell role="cell" className="hidden md:table-cell">
                  {job.JobSource?.label}
                </TableCell>
                <TableCell role="cell" className="max-md:col-start-2 max-md:row-span-3 max-md:row-start-1 max-md:block max-md:px-0 max-md:py-0">
                  <JobActionsMenu
                    job={job}
                    jobStatuses={jobStatuses}
                    editJob={editJob}
                    onChangeJobStatus={onChangeJobStatus}
                    onAddNote={onAddNote}
                    onDeleteJob={onDeleteJob}
                    onArchiveJob={archiveJob}
                  />
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      <DeleteAlertDialog
        pageTitle="job"
        open={alertOpen}
        onOpenChange={setAlertOpen}
        onDelete={() => deleteJob(jobIdToDelete)}
      />
    </TooltipProvider>
  );
}

export default MyJobsTable;
