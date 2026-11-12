"use client";
import { Archive, ListCollapse, MoreVertical, Pencil, StickyNote, Tags, Trash } from "lucide-react";
import { useRouter } from "next/navigation";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuPortal,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { Button } from "../ui/button";
import { JobResponse, JobStatus } from "@/models/job.model";
import { JobStatusMenuItems } from "./JobStatusMenuItems";

type JobActionsMenuProps = {
  job: JobResponse;
  jobStatuses: JobStatus[];
  editJob: (id: string) => void;
  onChangeJobStatus: (id: string, status: JobStatus) => void;
  onAddNote: (jobId: string) => void;
  onDeleteJob: (jobId: string) => void;
  onArchiveJob?: (jobId: string) => void;
};

export function JobActionsMenu({
  job,
  jobStatuses,
  editJob,
  onChangeJobStatus,
  onAddNote,
  onDeleteJob,
  onArchiveJob,
}: JobActionsMenuProps) {
  const router = useRouter();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          aria-haspopup="true"
          size="icon"
          variant="ghost"
          className="max-md:h-11 max-md:w-11"
          data-testid="job-actions-menu-btn"
        >
          <MoreVertical className="h-4 w-4" />
          <span className="sr-only">Toggle menu</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[200px]">
        <DropdownMenuLabel>Actions</DropdownMenuLabel>
        <DropdownMenuGroup>
          <DropdownMenuItem
            className="cursor-pointer"
            onClick={() => router.push(`/dashboard/myjobs/${job?.id}`)}
          >
            <ListCollapse className="mr-2 h-4 w-4" />
            View Details
          </DropdownMenuItem>
          <DropdownMenuItem
            className="cursor-pointer"
            onClick={() => editJob(job.id)}
          >
            <Pencil className="mr-2 h-4 w-4" />
            Edit Job
          </DropdownMenuItem>
          <DropdownMenuItem
            className="cursor-pointer"
            onClick={() => onAddNote(job.id)}
          >
            <StickyNote className="mr-2 h-4 w-4" />
            Add a Note
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <Tags className="mr-2 h-4 w-4" />
              Change status
            </DropdownMenuSubTrigger>
            <DropdownMenuPortal>
              <DropdownMenuSubContent className="p-0">
                <JobStatusMenuItems
                  jobStatuses={jobStatuses}
                  currentStatusId={job.Status.id}
                  onSelectStatus={(status) => onChangeJobStatus(job.id, status)}
                />
              </DropdownMenuSubContent>
            </DropdownMenuPortal>
          </DropdownMenuSub>
          <DropdownMenuSeparator />
          {onArchiveJob && job.Status?.value !== "archived" && (
            <DropdownMenuItem
              className="cursor-pointer"
              onClick={() => onArchiveJob(job.id)}
            >
              <Archive className="mr-2 h-4 w-4" />
              Archive
            </DropdownMenuItem>
          )}
          {/* A job with packages cannot be deleted (D-026): Archive only. */}
          {!(job._count?.applicationPackages && job._count.applicationPackages > 0) && (
            <DropdownMenuItem
              className="text-red-600 cursor-pointer"
              onClick={() => onDeleteJob(job.id)}
            >
              <Trash className="mr-2 h-4 w-4" />
              Delete
            </DropdownMenuItem>
          )}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
