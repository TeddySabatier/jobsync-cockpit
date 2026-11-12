// What the review UI may know about a package: an explicit field list, so a
// new column never reaches the client by accident (no idempotencyKey,
// sourceFolder, approval/send timestamps or file path).
type PackageRow = {
  id: string;
  version: number;
  status: string;
  emailTo: string | null;
  emailSubject: string;
  emailBody: string;
  letterMd: string | null;
  fitGrade: string | null;
  fitAnalysis: string | null;
  cvJson: string | null;
  cvFileId: string | null;
  cvPdfStale: boolean;
  rejectReason: string | null;
  changeRequest: string | null;
  changeRequestedAt: Date | null;
  changeRequestResponse: string | null;
  sendStartedAt: Date | null;
  sendOutcome: string | null;
  updatedAt: Date;
  job: {
    id: string;
    jobUrl: string | null;
    description: string;
    JobTitle: { label: string };
    Company: { label: string };
  };
};

export function toPackageView(p: PackageRow) {
  return {
    id: p.id,
    version: p.version,
    status: p.status,
    emailTo: p.emailTo,
    emailSubject: p.emailSubject,
    emailBody: p.emailBody,
    letterMd: p.letterMd,
    fitGrade: p.fitGrade,
    fitAnalysis: p.fitAnalysis,
    cvJson: p.cvJson,
    cvFileId: p.cvFileId,
    cvPdfStale: p.cvPdfStale,
    rejectReason: p.rejectReason,
    changeRequest: p.changeRequest,
    changeRequestedAt: p.changeRequestedAt,
    changeRequestResponse: p.changeRequestResponse,
    sendStartedAt: p.sendStartedAt,
    sendOutcome: p.sendOutcome,
    updatedAt: p.updatedAt,
    job: {
      id: p.job.id,
      jobUrl: p.job.jobUrl,
      description: p.job.description,
      JobTitle: { label: p.job.JobTitle.label },
      Company: { label: p.job.Company.label },
    },
  };
}
