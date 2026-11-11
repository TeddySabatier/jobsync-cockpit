import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import prisma from "@/lib/db";
import { checkMcpRateLimit } from "@/lib/mcp/rate-limit";
import { COCKPIT_RATE_LIMITS } from "@/lib/cockpit/config";
import {
  CockpitError,
  COCKPIT_ERROR_MESSAGES,
  toActionResult,
  type CockpitErrorCode,
} from "@/lib/cockpit/errors";
import { attachFile } from "@/lib/cockpit/attachments";
import { markChangeRequestDone, submitPackage } from "@/lib/cockpit/packages";
import {
  AttachFileInputShape,
  GetJobInputShape,
  ListChangeRequestsInputShape,
  ListJobsInputShape,
  MarkChangeRequestDoneInputShape,
  SubmitApplicationPackageInputShape,
  emptyToNull,
} from "@/lib/cockpit/schemas";
import { COCKPIT_TOOL_DESCRIPTIONS } from "./cockpitDescriptions";

// Cockpit MCP tools (cockpit/SPEC.md §3). There is deliberately no tool for
// approve, send, edit or reject, and nothing here may import the send or Gmail
// modules (enforced by __tests__/cockpit/mcpImportGraph.spec.ts).

export type CockpitToolContext = {
  userId: string;
  tokenName: string;
  scopes: string[];
};

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: true;
};

// "<CODE>: <fixed message>", never an error.message (SPEC §3 error style).
export function cockpitToolResult(code: CockpitErrorCode): ToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: `${code}: ${COCKPIT_ERROR_MESSAGES[code]}` }],
  };
}

const okResult = (data: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(data) }],
});

// The MCP SDK validates the arguments against the tool's InputShape *before*
// this callback runs, so a malformed argument is refused by the SDK in its own
// format ("MCP error -32602: Input validation error"), even for a token
// without the scope. Only domain errors (VALIDATION for a non-PDF, ...) reach
// the "<CODE>: message" format. `input` is the SDK-parsed value.
// Order inside the callback: scope → rate limit → DB (SPEC §3).
async function runTool<T>(
  ctx: CockpitToolContext,
  scope: "jobs:read" | "package:write",
  attach: boolean,
  input: T,
  run: (input: T) => Promise<unknown>,
): Promise<ToolResult> {
  if (!ctx.scopes.includes(scope)) return cockpitToolResult("UNAUTHORIZED_SCOPE");

  // The peek and the two spends below are consistent only because nothing is
  // awaited between them (the store is a synchronous in-process Map).
  // attach_file: look at its bucket first without spending a slot, so a call
  // refused by it does not also burn a general `cockpit` slot.
  if (
    attach &&
    !checkMcpRateLimit(ctx.userId, { ...COCKPIT_RATE_LIMITS.attach, peek: true })
      .allowed
  ) {
    return cockpitToolResult("RATE_LIMITED");
  }
  if (!checkMcpRateLimit(ctx.userId, COCKPIT_RATE_LIMITS.cockpit).allowed) {
    return cockpitToolResult("RATE_LIMITED");
  }
  if (attach) checkMcpRateLimit(ctx.userId, COCKPIT_RATE_LIMITS.attach);

  try {
    return okResult(await run(input));
  } catch (e) {
    // Unknown errors become INTERNAL and are logged by code only.
    const r = toActionResult(e);
    return cockpitToolResult(r.success ? "INTERNAL" : r.code);
  }
}

export function registerCockpitTools(
  server: McpServer,
  ctx: CockpitToolContext,
): void {
  const { userId } = ctx;

  server.tool(
    "attach_file",
    COCKPIT_TOOL_DESCRIPTIONS.attach_file,
    AttachFileInputShape,
    (raw) =>
      runTool(ctx, "package:write", true, raw, (input) =>
        attachFile(userId, input),
      ),
  );

  server.tool(
    "submit_application_package",
    COCKPIT_TOOL_DESCRIPTIONS.submit_application_package,
    SubmitApplicationPackageInputShape,
    (raw) =>
      runTool(
        ctx,
        "package:write",
        false,
        raw,
        async (input) => {
          const r = await submitPackage(userId, emptyToNull(input));
          return {
            packageId: r.package.id,
            version: r.package.version,
            status: r.package.status,
            supersededIds: r.supersededIds,
            idempotent: r.idempotent,
          };
        },
      ),
  );

  server.tool(
    "list_jobs",
    COCKPIT_TOOL_DESCRIPTIONS.list_jobs,
    ListJobsInputShape,
    (raw) =>
      runTool(ctx, "jobs:read", false, raw, async (input) => {
        const where = {
          userId,
          ...(input.status ? { Status: { value: input.status } } : {}),
          ...(input.hasPackage === undefined
            ? {}
            : {
                // "Has a package" means an active one (not superseded), as
                // activePackage below.
                applicationPackages: input.hasPackage
                  ? { some: { userId, status: { not: "superseded" } } }
                  : { none: { userId, status: { not: "superseded" } } },
              }),
        };
        const [total, rows] = await Promise.all([
          prisma.job.count({ where }),
          prisma.job.findMany({
            where,
            orderBy: { createdAt: "desc" },
            skip: input.offset,
            take: input.limit,
            select: {
              id: true,
              jobUrl: true,
              createdAt: true,
              appliedDate: true,
              JobTitle: { select: { label: true } },
              Company: { select: { label: true } },
              Status: { select: { value: true } },
              // Active package = highest non-superseded version.
              applicationPackages: {
                where: { userId, status: { not: "superseded" } },
                orderBy: { version: "desc" },
                take: 1,
                select: { id: true, version: true, status: true },
              },
            },
          }),
        ]);
        return {
          total,
          jobs: rows.map((j) => ({
            id: j.id,
            title: j.JobTitle.label,
            company: j.Company.label,
            status: j.Status.value,
            jobUrl: j.jobUrl,
            createdAt: j.createdAt,
            appliedDate: j.appliedDate,
            activePackage: j.applicationPackages[0] ?? null,
          })),
        };
      }),
  );

  server.tool(
    "get_job",
    COCKPIT_TOOL_DESCRIPTIONS.get_job,
    GetJobInputShape,
    (raw) =>
      runTool(ctx, "jobs:read", false, raw, async (input) => {
        const job = await prisma.job.findFirst({
          where: { id: input.jobId, userId },
          select: {
            id: true,
            jobUrl: true,
            description: true,
            matchScore: true,
            applied: true,
            appliedDate: true,
            JobTitle: { select: { label: true } },
            Company: { select: { label: true } },
            Location: { select: { label: true } },
            Status: { select: { value: true } },
            applicationPackages: {
              where: { userId },
              orderBy: { version: "desc" },
              select: {
                id: true,
                version: true,
                status: true,
                // The bot's own key: cockpit_submit.py uses it to recognise its
                // package after a crash.
                idempotencyKey: true,
                emailTo: true,
                emailSubject: true,
                emailBody: true,
                letterMd: true,
                fitGrade: true,
                fitAnalysis: true,
                cvJson: true,
                cvFile: { select: { id: true, fileName: true } },
                sourceFolder: true,
                rejectReason: true,
                changeRequest: true,
                changeRequestedAt: true,
                changeRequestHandledAt: true,
                changeRequestResponse: true,
                createdAt: true,
                approvedAt: true,
                rejectedAt: true,
                sentAt: true,
              },
            },
          },
        });
        if (!job) throw new CockpitError("NOT_FOUND");
        return {
          id: job.id,
          title: job.JobTitle.label,
          company: job.Company.label,
          location: job.Location?.label ?? null,
          status: job.Status.value,
          jobUrl: job.jobUrl,
          description: job.description,
          matchScore: job.matchScore,
          applied: job.applied,
          appliedDate: job.appliedDate,
          // Full content only on the newest version; older ones are a summary.
          packages: job.applicationPackages.map(
            ({ emailBody, letterMd, fitAnalysis, cvJson, ...summary }, i) =>
              i === 0 ? { ...summary, emailBody, letterMd, fitAnalysis, cvJson } : summary,
          ),
        };
      }),
  );

  server.tool(
    "list_change_requests",
    COCKPIT_TOOL_DESCRIPTIONS.list_change_requests,
    ListChangeRequestsInputShape,
    (raw) =>
      runTool(
        ctx,
        "jobs:read",
        false,
        raw,
        async (input) => {
          const rows = await prisma.applicationPackage.findMany({
            where: { userId, status: "changes_requested" },
            orderBy: { changeRequestedAt: "asc" },
            take: input.limit,
            select: {
              id: true,
              jobId: true,
              version: true,
              changeRequest: true,
              changeRequestedAt: true,
              emailTo: true,
              emailSubject: true,
              emailBody: true,
              letterMd: true,
              cvJson: true,
              fitGrade: true,
              fitAnalysis: true,
              sourceFolder: true,
              job: {
                select: {
                  JobTitle: { select: { label: true } },
                  Company: { select: { label: true } },
                },
              },
            },
          });
          return rows.map(({ id, job, ...rest }) => ({
            packageId: id,
            jobTitle: job.JobTitle.label,
            company: job.Company.label,
            ...rest,
          }));
        },
      ),
  );

  server.tool(
    "mark_change_request_done",
    COCKPIT_TOOL_DESCRIPTIONS.mark_change_request_done,
    MarkChangeRequestDoneInputShape,
    (raw) =>
      runTool(
        ctx,
        "package:write",
        false,
        raw,
        async (input) => {
          const pkg = await markChangeRequestDone(
            userId,
            input.packageId,
            input.response,
          );
          return { packageId: pkg.id, status: pkg.status };
        },
      ),
  );
}
