# Cockpit V0 overnight QA — plan

- Window: 2026-11-04 23:20 → 2026-11-05 06:30 (Europe/Paris). T-60: no new merges except the final report and fixes for red gates. T-30: freeze, final gates, final report PR.
- Base: `main` at b8bfad8 (+ #28).
- Surface under review: about 6,100 lines (src/lib/cockpit, src/lib/mcp, cockpit actions, cockpit API routes, review pages, cockpit components, next.config.mjs, middleware, schema, the V0 migration). One full read is about 70k tokens before per-call overhead.

## How free models are called

Every call runs through `opencode run --agent qa-free -m freellmapi/<model>`. The agent has a deny-all permission policy, so models get the prompt text only and no tools. Prompts are built only from allow-listed public paths (`scripts/qa/scrub.ts`). Token usage is read from the session export. Per-call overhead is about 3.8k input tokens.

`freellmapi/auto` does not report which model actually answered. For that reason, verifiers and PR reviewers always use a named model different from the producer's.

## Budget

The target is at least 100M tokens. At about 11k tokens per call, that is roughly 9,000 calls, or about 22 calls per minute sustained. The engine raises concurrency within provider limits when spend falls behind plan.

| Lane | Share | Mode |
|------|------:|------|
| L1 security | 16% | engine review |
| L2 state machine / concurrency | 10% | engine review + interleaving tests |
| L3 data / migrations | 6% | engine review + migration checks |
| L4 UX / a11y | 6% | engine review + Playwright/axe |
| L5 test quality (mutation) | 14% | test-running worker |
| L6 Next.js boundaries | 6% | engine review + bundle grep |
| L7 SPEC conformance | 8% | engine review + TRACEABILITY.md |
| L8 property tests | 10% | fast-check authoring |
| L9 E2E + fake Google | 8% | Playwright on port 3738 |
| L10 red team | 10% | payload lists → attack tests |
| Verification | 4% | two named-model verifiers |
| Reserve | 2% | |

Every hour, budget moves from lanes with no new confirmed findings to lanes that produced some. When a lane saturates, it climbs the escalation ladder (wider code, then execution, then tooling sweeps); it is never stopped.

## Finding pipeline

1. Reviewer JSON.
2. Mechanical check: the file exists and the quote appears verbatim within ±15 lines.
3. Dedupe and count votes.
4. Two verifiers on distinct named models.
5. A failing test when possible.
6. Orchestrator triage.
7. Fix PR.

Raw engine state lives in `.cockpit-tmp/` and is never committed. The curated outcome is summarised in `QA-REPORT.md`, `REJECTED.md` and `V1-IDEAS.md`.
