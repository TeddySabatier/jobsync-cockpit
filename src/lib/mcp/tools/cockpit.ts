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
  AttachFileSchema,
  GetJobInputShape,
  GetJobSchema,
  ListChangeRequestsInputShape,
  ListChangeRequestsSchema,
  ListJobsInputShape,
  ListJobsSchema,
  MarkChangeRequestDoneInputShape,
  MarkChangeRequestDoneSchema,
  SubmitApplicationPackageInputShape,
  SubmitApplicationPackageSchema,
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

type Schema<T> = {
  safeParse(v: unknown): { success: true; data: T } | { success: false };
};

// Order is fixed: scope → rate limit → XSchema → DB (SPEC §3).
async function runTool<T>(
  ctx: CockpitToolContext,
  scope: "jobs:read" | "package:write",
  attach: boolean,
  schema: Schema<T>,
  rawInput: unknown,
  run: (input: T) => Promise<unknown>,
): Promise<ToolResult> {
  if (!ctx.scopes.includes(scope)) return cockpitToolResult("UNAUTHORIZED_SCOPE");

  if (!checkMcpRateLimit(ctx.userId, COCKPIT_RATE_LIMITS.cockpit).allowed) {
    return cockpitToolResult("RATE_LIMITED");
  }
  if (attach && !checkMcpRateLimit(ctx.userId, COCKPIT_RATE_LIMITS.attach).allowed) {
    return cockpitToolResult("RATE_LIMITED");
  }

  const parsed = schema.safeParse(rawInput);
  if (!parsed.success) return cockpitToolResult("VALIDATION");

  try {
    return okResult(await run(parsed.data));
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
      runTool(ctx, "package:write", true, AttachFileSchema, raw, (input) =>
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
        SubmitApplicationPackageSchema,
        raw,
        async (input) => {
          const r = await submitPackage(userId, input);
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
      runTool(ctx, "jobs:read", false, ListJobsSchema, raw, async (input) => {
        const where = {
          userId,
          ...(input.status ? { Status: { value: input.status } } : {}),
          ...(input.hasPackage === undefined
            ? {}
            : {
                applicationPackages: input.hasPackage
                  ? { some: { userId } }
                  : { none: { userId } },
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
      runTool(ctx, "jobs:read", false, GetJobSchema, raw, async (input) => {
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
              include: { cvFile: { select: { id: true, fileName: true } } },
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
          // Every package field except cvFileId (the file is cvFile).
          packages: job.applicationPackages.map(
            ({ cvFileId: _cvFileId, ...pkg }) => pkg,
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
        ListChangeRequestsSchema,
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
        MarkChangeRequestDoneSchema,
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
