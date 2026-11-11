import { randomUUID } from "crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { APIRequestContext } from "@playwright/test";
import { makePdf } from "./pdf";

// Bot-side helpers: the real MCP protocol over HTTP with the bot token the
// e2e server script seeds directly into the DB. Synthetic data only.

export type ToolOutcome = {
  isError: boolean;
  text: string;
  // Parsed JSON for cockpit tools (they return JSON text); null otherwise.
  json: Record<string, unknown> | null;
};

export const CV_FILE_NAME = "jane-doe-cv.pdf";
export const CV_PDF_TEXT = "COCKPIT-E2E-CV";
export const cvPdf = () => makePdf(CV_PDF_TEXT);

export async function callTool(
  baseURL: string,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolOutcome> {
  const token = process.env.E2E_MCP_TOKEN;
  if (!token) throw new Error("E2E_MCP_TOKEN missing (global setup did not run)");
  const client = new Client({ name: "cockpit-e2e", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("/api/mcp", baseURL), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  try {
    const res = await client.callTool({ name, arguments: args });
    const text = (res.content as Array<{ text?: string }>)
      .map((c) => c.text ?? "")
      .join("\n");
    let json: Record<string, unknown> | null = null;
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed && typeof parsed === "object") json = parsed as Record<string, unknown>;
    } catch {
      // Not JSON (add_job answers in prose, errors are "<CODE>: msg").
    }
    return { isError: res.isError === true, text, json };
  } finally {
    await client.close();
  }
}

export async function listToolNames(baseURL: string): Promise<string[]> {
  const token = process.env.E2E_MCP_TOKEN;
  const client = new Client({ name: "cockpit-e2e", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("/api/mcp", baseURL), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  try {
    return (await client.listTools()).tools.map((t) => t.name);
  } finally {
    await client.close();
  }
}

export async function attachPdf(
  baseURL: string,
  fileName: string,
  pdf: Buffer,
): Promise<string> {
  const r = await callTool(baseURL, "attach_file", {
    fileName,
    mimeType: "application/pdf",
    contentBase64: pdf.toString("base64"),
  });
  const id = r.json?.fileId;
  if (typeof id !== "string") throw new Error(`attach_file failed: ${r.text}`);
  return id;
}

export type SeedOptions = {
  noEmail?: boolean;
  noCv?: boolean;
  cvFileId?: string;
  emailTo?: string;
  subject?: string;
  body?: string;
};

export type Seeded = {
  jobId: string;
  packageId: string;
  company: string;
  role: string;
  jobUrl: string;
  to: string | null;
  subject: string;
  body: string;
};

// Company is a single word and the recipient domain contains it, so the Send
// dialog shows no domain warning unless a test asks for one.
export async function seedPackage(
  baseURL: string,
  opts: SeedOptions = {},
): Promise<Seeded> {
  const tag = randomUUID().slice(0, 8);
  const company = `Acme${tag}`;
  const role = `Backend Engineer ${tag}`;
  const jobUrl = `https://${company.toLowerCase()}.example.com/jobs/1`;
  const to = opts.noEmail
    ? null
    : (opts.emailTo ?? `jobs@${company.toLowerCase()}.example.com`);
  const subject = opts.subject ?? `Application – ${role}`;
  const body =
    opts.body ??
    `Dear hiring team,\n\nPlease find my application for ${role} attached.\n\nBest regards,\nJane Doe`;

  const job = await callTool(baseURL, "add_job", {
    company,
    jobTitle: role,
    jobDescription:
      "We are hiring a backend engineer to build and run our platform services, work with product and ship features end to end.",
    location: "Remote",
    jobUrl,
  });
  const jobId = job.text.match(/Job created \(id: ([^)]+)\)/)?.[1];
  if (!jobId) throw new Error(`add_job failed: ${job.text}`);

  const submit = await callTool(baseURL, "submit_application_package", {
    jobId,
    ...(to ? { emailTo: to } : {}),
    emailSubject: subject,
    emailBody: body,
    letterMd: "Dear hiring team,\n\nI am **Jane Doe** and I would like to join you.\n\nSincerely,\nJane",
    fitGrade: "A",
    fitAnalysis: {
      summary: "Strong match on backend experience.",
      strengths: ["Node.js", "SQL"],
      score: 87,
    },
    cvJson: {
      name: "Jane Doe",
      summary: "Backend engineer with five years of experience.",
      experience: [{ company: "Example Corp", bullets: ["Built APIs", "Ran on-call"] }],
    },
    ...(opts.noCv ? {} : { cvFileId: opts.cvFileId ?? process.env.E2E_CV_FILE_ID }),
  });
  const packageId = submit.json?.packageId;
  if (typeof packageId !== "string") throw new Error(`submit failed: ${submit.text}`);
  return { jobId, packageId, company, role, jobUrl, to, subject, body };
}

export type CodeSpec = {
  email?: string;
  emailVerified?: boolean | string;
  scope?: string;
  refreshToken?: boolean;
  aud?: string;
  expOffsetS?: number;
};

// Drives the real connect route, then the callback with a fake code the fake
// token endpoint understands. `nonce` is read from the redirect to Google
// (never followed); the state cookie travels in the request jar.
export async function connectGmail(
  request: APIRequestContext,
  spec: CodeSpec = {},
  stateOverride?: string,
): Promise<{ status: number; location: string }> {
  const start = await request.get("/api/cockpit/gmail/connect", { maxRedirects: 0 });
  const auth = new URL(start.headers()["location"]);
  const state = stateOverride ?? auth.searchParams.get("state") ?? "";
  const nonce = auth.searchParams.get("nonce") ?? "";
  // The fake token endpoint checks the verifier the app posts against this
  // challenge (PKCE), so dropping or breaking the verifier fails the connect.
  const challenge = auth.searchParams.get("code_challenge") ?? "";
  const code =
    "fc_" + Buffer.from(JSON.stringify({ nonce, challenge, ...spec })).toString("base64url");
  const cb = await request.get(
    `/api/cockpit/gmail/callback?state=${encodeURIComponent(state)}&code=${code}`,
    { maxRedirects: 0 },
  );
  return { status: cb.status(), location: cb.headers()["location"] ?? "" };
}
