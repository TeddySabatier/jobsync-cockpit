# Ideas and out-of-scope suggestions seen in the findings

None of these is a V0 bug. Source in brackets; "(mine)" = noticed during triage, not in the findings.

## Hardening (cheap, optional)
- Catch transport failures in every client action call and toast a reload hint (see CONFIRMED #2). [L2-001]
- Check the `azp` claim in `verifyIdToken` when it is present. Google single-audience tokens do not need it. [L1-04]
- Wrap `server.close()` in `try/finally` in `api/mcp/route.ts` (upstream file). [L2-F2]
- `sendBlockedReason` could also report "COCKPIT_GMAIL_ALLOWED_ADDRESS not set or different", so the Send button is hidden instead of failing with GMAIL_RECONNECT_REQUIRED. (mine; send.ts:141-145 vs ActionBar.tsx:57-63)
- Move focus to the error banner on `/dashboard/review/settings?error=` for screen readers. [ux-001]
- `aria-busy` on Disconnect while pending, and an `aria-label` on queue chips. [L4-F004, F003] (nits)

## Already named as V1 hooks (HANDOFF §8) and re-suggested by findings
- `userId` column on `File` + ownership check on the row. [F1 attachments.ts:65, F001 schema.prisma:108]
- Optimistic concurrency on edits (`expectedUpdatedAt` on `updatePackageContent`). [F-008 schema.prisma:560, L2-004 EditForm.tsx:23]
- Cleanup of unreferenced attachments (SPEC §8). [F-003 schemas.ts:62]
- sha256 dedupe of attachments (SPEC §8).
- ~~Include cockpit tables in backups (D-009).~~ Done in D-012.

## Product ideas
- `offset` on `list_change_requests` for pagination. [L7-003]
- Warn in "Mark applied manually" when the job is already `applied`. [L2-06 ActionBar.tsx:280]
- Sliding-window rate limiter and a store shared across replicas (the current fixed window allows 2x max across a boundary; found by the L8 property lane). [F3 rate-limit.ts]
- RFC 2231 attachment names if user-chosen names are ever sent (already a `shortcut:` in mime.ts:64).
- Cap batch size in upstream `add_jobs_batch` / `save_match_results_batch`: already done via MCP_BATCH_MAX_ITEMS (mcp.schema.ts:210-235); findings asking for it are wrong.
