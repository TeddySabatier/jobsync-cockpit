import { z } from "zod";

// 2 = follow-ups (D-031): ApplicationPackage.kind / replyToPackageId,
// SentEmail.messageIdHeader and the JobFollowUp group. Version 1 backups still
// import: every new field has a default that reproduces the old behaviour.
export const BACKUP_FORMAT_VERSION = 2;
export const SUPPORTED_BACKUP_FORMAT_VERSIONS = [1, 2] as const;

export const ManifestSchema = z.object({
  formatVersion: z.union([z.literal(1), z.literal(2)]),
  appVersion: z.string(),
  exportedAt: z.string(),
  sourceEmail: z.string(),
  counts: z.record(z.string(), z.number()),
});

export type BackupManifest = z.infer<typeof ManifestSchema>;

const id = z.string().min(1);
const optId = z.string().min(1).nullable();
const str = z.string();
const optStr = z.string().nullable();
const dt = z.coerce.date();
const optDt = z.coerce.date().nullable();
const int = z.number().int();
const optInt = z.number().int().nullable();

const Company = z.object({ id, label: str, value: str, logoUrl: optStr });
const JobTitle = z.object({ id, label: str, value: str });
const Location = z.object({
  id,
  label: str,
  value: str,
  stateProv: optStr,
  country: optStr,
});
const JobSource = z.object({ id, label: str, value: str });
const Tag = z.object({ id, label: str, value: str });
const ActivityType = z.object({
  id,
  label: str,
  value: str,
  description: optStr,
  createdAt: dt,
  updatedAt: dt,
});

const Profile = z.object({ id });

// fileMissing marks a row whose bytes were absent on disk at export time.
const File = z.object({
  id,
  fileName: str,
  filePath: str,
  fileType: str,
  uploadedAt: dt,
  fileMissing: z.boolean().optional(),
});

const Resume = z.object({
  id,
  profileId: id,
  title: str,
  createdAt: dt,
  updatedAt: dt,
  FileId: optId,
  reviewData: optStr,
});

const ContactInfo = z.object({
  id,
  createdAt: dt,
  updatedAt: dt,
  resumeId: id,
  firstName: str,
  lastName: str,
  headline: str,
  email: str,
  phone: str,
  address: optStr,
  url1: optStr,
  url1Label: optStr,
  url2: optStr,
  url2Label: optStr,
});

const Summary = z.object({ id, createdAt: dt, updatedAt: dt, content: str });

const ResumeSection = z.object({
  id,
  resumeId: id,
  sectionTitle: str,
  sectionType: str,
  summaryId: optId,
});

const WorkExperience = z.object({
  id,
  createdAt: dt,
  updatedAt: dt,
  companyId: id,
  jobTitleId: id,
  startDate: dt,
  endDate: optDt,
  description: str,
  locationId: id,
  resumeSectionId: optId,
});

const Education = z.object({
  id,
  createdAt: dt,
  updatedAt: dt,
  institution: str,
  degree: str,
  fieldOfStudy: str,
  startDate: dt,
  endDate: optDt,
  description: optStr,
  locationId: id,
  resumeSectionId: optId,
});

const LicenseOrCertification = z.object({
  id,
  title: str,
  organization: str,
  issueDate: optDt,
  expirationDate: optDt,
  credentialUrl: optStr,
  resumeSectionId: optId,
});

const OtherSection = z.object({
  id,
  createdAt: dt,
  updatedAt: dt,
  title: str,
  content: str,
  resumeSectionId: optId,
});

const Skill = z.object({
  id,
  createdAt: dt,
  updatedAt: dt,
  category: optStr,
  order: int,
  tagId: id,
  resumeSectionId: id,
});

const CoverLetter = z.object({
  id,
  profileId: id,
  title: str,
  content: str,
  createdAt: dt,
  updatedAt: dt,
});

const Automation = z.object({
  id,
  name: str,
  jobBoard: str,
  keywords: str,
  location: str,
  sourceConfig: optStr,
  resumeId: id,
  matchThreshold: int,
  scheduleHour: int,
  nextRunAt: optDt,
  lastRunAt: optDt,
  status: str,
  createdAt: dt,
  updatedAt: dt,
});

const Job = z.object({
  id,
  jobUrl: optStr,
  description: str,
  jobType: str,
  workplaceType: optStr,
  createdAt: dt,
  applied: z.boolean(),
  appliedDate: optDt,
  dueDate: optDt,
  // The instance-local statusId is replaced by the stable natural key.
  statusValue: str,
  jobTitleId: id,
  companyId: id,
  jobSourceId: optId,
  salaryRange: optStr,
  locationId: optId,
  resumeId: optId,
  coverLetterId: optId,
  automationId: optId,
  matchScore: optInt,
  matchData: optStr,
  discoveryStatus: optStr,
  discoveredAt: optDt,
  createdVia: optStr,
  descriptionCompleteness: optStr,
});

// Cockpit (D-012). userId is the owner column: stripped on export, written from
// the session on import. GmailAccount is never part of a backup (AC-39).
const ApplicationPackage = z.object({
  id,
  jobId: id,
  version: int,
  // Absent in a version 1 backup: those are all applications (D-031).
  kind: z.enum(["application", "follow_up"]).default("application"),
  replyToPackageId: optId.default(null),
  status: str,
  emailTo: optStr,
  emailSubject: str,
  emailBody: str,
  letterMd: optStr,
  fitGrade: optStr,
  fitAnalysis: optStr,
  cvJson: optStr,
  cvFileId: optId,
  cvPdfStale: z.boolean(),
  sourceFolder: optStr,
  idempotencyKey: optStr,
  rejectReason: optStr,
  changeRequest: optStr,
  changeRequestedAt: optDt,
  changeRequestHandledAt: optDt,
  changeRequestResponse: optStr,
  editedAt: optDt,
  approvedAt: optDt,
  rejectedAt: optDt,
  sendStartedAt: optDt,
  sendOutcome: optStr,
  sentAt: optDt,
  sentVia: optStr,
  createdAt: dt,
  updatedAt: dt,
});

const SentEmail = z.object({
  id,
  packageId: id,
  fromAddress: str,
  toAddress: str,
  gmailMessageId: str,
  threadId: str,
  messageIdHeader: optStr.default(null),
  sentAt: dt,
});

// Append-only send history (D-028). Old backups have no such group: the
// default below imports them with an empty history.
const SendAttempt = z.object({
  id,
  packageId: id,
  outcome: str,
  errorCode: optStr,
  gmailMessageId: optStr,
  threadId: optStr,
  createdAt: dt,
});

// Follow-up state of a job (D-031). Absent from a version 1 backup: the group
// defaults to empty, so every job starts with no outcome, not stopped.
const JobFollowUp = z.object({
  id,
  jobId: id,
  outcome: z.enum(["replied", "interview", "rejected", "closed"]).nullable(),
  outcomeAt: optDt,
  stopped: z.boolean(),
  skippedThrough: z.number().int().min(0).max(2),
  skippedAt: optDt,
  snoozedUntil: optDt,
  createdAt: dt,
  updatedAt: dt,
});

const Note = z.object({
  id,
  jobId: id,
  content: str,
  createdAt: dt,
  updatedAt: dt,
});

const Interview = z.object({ id, createdAt: dt, jobId: id });

const Contact = z.object({
  id,
  name: str,
  email: str,
  createdAt: dt,
  interviewId: optId,
});

const Task = z.object({
  id,
  title: str,
  description: optStr,
  status: str,
  priority: int,
  percentComplete: int,
  dueDate: optDt,
  activityTypeId: optId,
  createdAt: dt,
  updatedAt: dt,
});

const Activity = z.object({
  id,
  activityName: str,
  startTime: dt,
  endTime: optDt,
  duration: optInt,
  breakMinutes: int,
  breakStartedAt: optDt,
  breakPlannedMins: optInt,
  description: optStr,
  createdAt: dt,
  updatedAt: dt,
  activityTypeId: id,
  taskId: optId,
});

const Question = z.object({
  id,
  question: str,
  answer: optStr,
  createdAt: dt,
  updatedAt: dt,
  createdVia: optStr,
});

const AutomationRun = z.object({
  id,
  automationId: id,
  jobsSearched: int,
  jobsDeduplicated: int,
  jobsProcessed: int,
  jobsMatched: int,
  jobsSaved: int,
  status: str,
  errorMessage: optStr,
  blockedReason: optStr,
  funnelStats: optStr,
  startedAt: dt,
  completedAt: optDt,
});

const UserSettings = z.object({
  id,
  settings: str,
  createdAt: dt,
  updatedAt: dt,
});

const group = <T extends z.ZodTypeAny>(schema: T) =>
  z.array(schema).default([]);

export const BackupDataSchema = z.object({
  Company: group(Company),
  JobTitle: group(JobTitle),
  Location: group(Location),
  JobSource: group(JobSource),
  Tag: group(Tag),
  ActivityType: group(ActivityType),
  Profile: group(Profile),
  File: group(File),
  Resume: group(Resume),
  ContactInfo: group(ContactInfo),
  Summary: group(Summary),
  ResumeSection: group(ResumeSection),
  WorkExperience: group(WorkExperience),
  Education: group(Education),
  LicenseOrCertification: group(LicenseOrCertification),
  OtherSection: group(OtherSection),
  Skill: group(Skill),
  CoverLetter: group(CoverLetter),
  Automation: group(Automation),
  Job: group(Job),
  ApplicationPackage: group(ApplicationPackage),
  SentEmail: group(SentEmail),
  SendAttempt: group(SendAttempt),
  JobFollowUp: group(JobFollowUp),
  Note: group(Note),
  Interview: group(Interview),
  Contact: group(Contact),
  Task: group(Task),
  Activity: group(Activity),
  Question: group(Question),
  AutomationRun: group(AutomationRun),
  UserSettings: group(UserSettings),

  // Implicit Prisma m2m relations are not models, so they travel as id pairs.
  _JobToTag: group(z.object({ jobId: id, tagId: id })),
  _QuestionToTag: group(z.object({ questionId: id, tagId: id })),

  // Natural keys for the only global table in the schema.
  jobStatuses: group(z.object({ label: str, value: str })),

  // The only User field that travels; applied after Resume rows exist.
  user: z
    .object({ defaultResumeId: optId })
    .default({ defaultResumeId: null }),
});

export type BackupData = z.infer<typeof BackupDataSchema>;
export type BackupRow = Record<string, unknown>;
