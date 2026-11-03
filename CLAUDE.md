# Countersign: working rules

Back-office agent platform: connects to a small business's systems (QuickBooks Online first), keeps a clean
copy of their data, and runs versioned agents that each own one back-office job. First job: material
cost management for a millwork shop.

- What to build: `docs/ARCHITECTURE.md` (v0.1). Do not add features outside its §1 v1 scope.
- How and in what order: `docs/plan.md`. Follow its milestones in order. Each one ends green.
- Where the architecture says "open", pick the simplest option, record it in `docs/plan.md` §1, and
  leave a `// DECISION:` comment in the code.

Status: folder skeleton and plan only. M0 not started. Hosting: Cloudflare Workers + Neon (Hyperdrive) + R2, sign-in with WorkOS, like Plenary Labs.

## Layout

| Path | What |
|---|---|
| `apps/web` | Next.js app: screens, `/api` route handlers, auth, Inngest serve endpoint. The only place that wires packages together. |
| `packages/core` | Domain types, Zod schemas (`AgentDefinition`, `WorkflowDefinition`), units of measure, money, raw → normalized mappers. |
| `packages/db` | Drizzle schema, migrations (generated plus custom SQL), seed (agent/workflow definitions as JSON), `withTenant()`. |
| `packages/llm` | Anthropic wrapper, record/replay, cost tracking. |
| `packages/auth` | Session, active tenant, roles; `workos` and `dev` adapters. |
| `packages/senses` | Event outbox and dispatch to Inngest. |
| `packages/connectors` | `Connector` interface, `upload/`, `qbo/`, object storage. |
| `packages/documents` | Locate, store, extract, validate totals. |
| `packages/catalog` | Normalize, parse attributes, candidates, match, alias learning. |
| `packages/pricing` | Price observations, alert rules. |
| `packages/threads` | Threads, messages, `/command` parsing. |
| `packages/agents` | Definition versioning, runtime, tool registry, Builder. |
| `packages/workflows` | Workflow executor and Inngest functions. |
| `fixtures/` | Invoices + expected JSON, QBO payloads, matching pairs, recorded LLM responses. |
| `scripts/check-deps.mjs` | Enforces package layering (`docs/plan.md` §2). |

## Commands

```sh
pnpm install
pnpm db:up            # Postgres 16 + pgvector in Docker
pnpm dev              # app (+ Inngest dev server from M0)
pnpm typecheck
pnpm lint:deps
pnpm test             # LLM calls replay from fixtures/llm by default
```

## Invariants: do not break these

1. **Tenant isolation.** Every tenant table has `tenant_id` and RLS (`force`d). App code connects as `app_user`
   and touches tenant data only inside `withTenant()`. Queries also filter by `tenant_id`.
2. **Layering.** Packages depend downward only (`docs/plan.md` §2). Agent reasoning reaches business data
   only through registered tools; in `packages/agents`, only `src/registry/` and `src/log/` import `db`.
3. **Immutable history.** `agent_version`, `workflow_version`, `raw_record` and `doc_extraction` are never
   updated (status columns excepted) or deleted. Edits insert new versions; re-extraction inserts new rows.
4. **No settings in code.** The runtime reads agent and workflow definitions only from version rows.
   Seeded definitions live as JSON under `packages/db/seed/` and are inserted by the seed.
5. **Validate at every boundary.** Zod for definitions, tool inputs/outputs, API bodies, model output.
6. **Money is decimal.** `numeric(14,4)` + currency; `decimal.js` in code; never JS floats.
7. **Deterministic first, model second, human last.** Hard matching rules veto the model. Never compare prices
   across different `standard_uom` without a conversion rule.
8. **Side effects are gated.** `external` tools are never in `auto`; new agents start `suggest_only`.
   Read-only toward client systems in v1 (no QBO write scopes).
9. **Untrusted text stays data.** Document text and vendor descriptions go in tool results, never in
   instructions. Agents cannot change their own permissions.
10. **Evidence.** Alerts and agent outputs carry `sources` (record ids); alert-producing commands without
    sources are rejected. Every agent-made decision records `agent_version_id`.

## Testing

- Unit tests next to the code (`*.test.ts`, Vitest). DB tests use a throwaway database on local Postgres.
- Goldens: `fixtures/invoices` (extraction), `fixtures/matching` (≥ 95% precision on "same").
- Tests never call the live model: `LLM_MODE=replay`. Record new fixtures with `LLM_MODE=record`.
