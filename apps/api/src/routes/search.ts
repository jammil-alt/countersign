// v0.12 W2-F: ⌘K search and plain-words questions, both surfaces (ARCHITECTURE §11.6; docs/plan.md
// §1.49). The portal reads exactly its one client (invariant 1) and its answers carry no
// templates, bundles, costs or operator notes (invariant 11); the back office reads the clients it
// serves, or the one it names. A question becomes a RunFilter (./runs-ask) and runs through the
// runs lists' own query.

import {
  ASK_NOT_UNDERSTOOD,
  ASK_RUNS_LIMIT,
  type AskContext,
  askChips,
  type OpsSearchResult,
  type PortalSearchResult,
  portalRunFilter,
  readSearchText,
  routes,
  runFilterQuery,
  shortRunId,
} from "@countersign/core";
import { agent, run, type Tx, tenant } from "@countersign/db";
import { createLlmClient, type LlmTransport } from "@countersign/llm";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { Hono } from "hono";
import { type AppEnv, ensureClient, type HandlerCtx, mount } from "../http";
import { clientStatusWhere, clientWaits, OPEN_RUN } from "../runs/client-status";
import { workerTransport } from "../runs/execute";
import { reachContext, runWaits } from "../runs/run-wait";
import { runSubjects } from "../runs/subject";
import { compileQuestion } from "../runs-ask/ask";
import { askContext } from "../runs-ask/context";
import { recordAskUsage } from "../runs-ask/usage";
import {
  type SearchScope,
  searchAgents,
  searchDocuments,
  searchOrganizations,
  searchPeople,
  searchRecords,
  searchRuns,
} from "../search/queries";
import { runSummaries } from "./portal";
import { runFilterWhere } from "./run-controls";

/** The clients a back-office request covers: the one it names (if served), else all served. */
function opsIds(ctx: { tenantIds: readonly string[] }, client: string | undefined): string[] {
  if (client) {
    ensureClient(ctx, client);
    return [client];
  }
  return [...ctx.tenantIds];
}

async function clientNames(tx: Tx, ids: readonly string[]) {
  const rows = ids.length
    ? await tx
        .select({ id: tenant.id, name: tenant.name })
        .from(tenant)
        .where(inArray(tenant.id, [...ids]))
    : [];
  const names = new Map(rows.map((r) => [r.id, r.name]));
  return (id: string | null) => (id ? { id, name: names.get(id) ?? "" } : null);
}

/** Every kind's hits, each one query. */
// DECISION: the kinds are asked at once, in the request's one transaction: the driver pipelines
// them on its connection, so a search costs about one round trip to the database instead of ten
// in a row (it took about 4 seconds on staging). Each query still names its clients (RLS too).
async function searchAll(tx: Tx, scope: SearchScope, q: string) {
  const text = readSearchText(q);
  const [agents, runs, records, people, organizations, documents] = await Promise.all([
    searchAgents(tx, scope, text),
    searchRuns(tx, scope, text),
    searchRecords(tx, scope, text),
    searchPeople(tx, scope, text),
    searchOrganizations(tx, scope, text),
    searchDocuments(tx, scope, text),
  ]);
  return {
    agents,
    runs,
    records,
    people,
    organizations,
    documents,
  };
}

/** The model transport: the app's (tests pass a FakeModel), else the Worker's live one. */
function transport(ctx: Pick<HandlerCtx<never>, "services">): LlmTransport {
  const { deps, env } = ctx.services;
  return deps.llm?.(env) ?? workerTransport(env);
}

function namesOf(context: AskContext) {
  return {
    agents: new Map(context.agents.map((a) => [a.id, a.serviceName ?? a.name])),
    clients: new Map((context.clients ?? []).map((c) => [c.id, c.name])),
    templates: new Map((context.templates ?? []).map((t) => [t.id, t.name])),
    connectors: new Map(context.connectors.map((c) => [c.id, c.name])),
  };
}

export function searchRoutes(app: Hono<AppEnv>): void {
  // ── Search ──
  mount(app, routes.portalSearch, async ({ tx, tenantIds, query, services }) => {
    const tenantId = tenantIds[0] as string;
    const hits = await searchAll(tx, { surface: "portal", tenantIds: [tenantId] }, query.q);
    // UI cleanup (stream A): a run waiting on the client reads "waiting on you", as on Runs.
    const waits = await clientWaits(
      tx,
      tenantId,
      hits.runs.map((r) => r.id),
    );
    const subjects = await runSubjects(tx, [tenantId], hits.runs, services.platform);
    // Only what the portal shows: no client ids, templates, notes or costs.
    const result: PortalSearchResult = {
      services: hits.agents.map((a) => ({
        id: a.id,
        name: a.serviceName ?? a.name,
        status: a.runStatus,
      })),
      runs: hits.runs.map((r) => ({
        id: r.id,
        shortId: r.shortId,
        service: { id: r.agentId, name: r.serviceName ?? r.agentName },
        status: r.status,
        createdAt: r.createdAt.toISOString(),
        waitingOnYou:
          (OPEN_RUN as readonly string[]).includes(r.status) &&
          (r.status === "waiting" || (waits.get(r.id)?.waitingOnYou ?? false)),
        subject: subjects.get(r.id),
      })),
      records: hits.records.map(({ tenantId: _t, ...r }) => r),
      people: hits.people.map(({ tenantId: _t, ...p }) => p),
      organizations: hits.organizations.map(({ tenantId: _t, ...o }) => o),
      documents: hits.documents.map((d) => ({
        id: d.id,
        filename: d.filename,
        status: d.status,
        vendor: d.vendor,
        number: d.number,
        receivedAt: d.receivedAt.toISOString(),
      })),
    };
    return result;
  });

  mount(app, routes.opsSearch, async (ctx) => {
    const { tx, query } = ctx;
    const ids = opsIds(ctx, query.client);
    const hits = await searchAll(tx, { surface: "ops", tenantIds: ids }, query.q);
    const subjects = await runSubjects(tx, ids, hits.runs, ctx.services.platform);
    const client = await clientNames(tx, ids);
    // UI cleanup (stream A): who each waiting run waits on.
    const waits = await runWaits(tx, hits.runs, reachContext(ctx.services));
    const named = (id: string) => client(id) ?? { id, name: "" };
    const result: OpsSearchResult = {
      agents: hits.agents.map((a) => ({
        id: a.id,
        name: a.name,
        serviceName: a.serviceName,
        kind: a.kind,
        client: client(a.tenantId),
        status: a.runStatus,
      })),
      runs: hits.runs.map((r) => ({
        id: r.id,
        shortId: r.shortId,
        service: { id: r.agentId, name: r.serviceName ?? r.agentName },
        status: r.status,
        createdAt: r.createdAt.toISOString(),
        client: named(r.tenantId),
        mode: r.mode,
        summary: r.summary,
        waiting: waits.get(r.id) ?? null,
        subject: subjects.get(r.id),
      })),
      records: hits.records.map(({ tenantId, ...r }) => ({ ...r, client: named(tenantId) })),
      people: hits.people.map(({ tenantId, ...p }) => ({ ...p, client: named(tenantId) })),
      organizations: hits.organizations.map(({ tenantId, ...o }) => ({
        ...o,
        client: named(tenantId),
      })),
      documents: hits.documents.map((d) => ({
        id: d.id,
        filename: d.filename,
        status: d.status,
        vendor: d.vendor,
        number: d.number,
        receivedAt: d.receivedAt.toISOString(),
        client: named(d.tenantId),
      })),
    };
    return result;
  });

  // ── Plain-words questions ──
  // DECISION: the model call runs inside the request's transaction (as the Builder's do), so the
  // question's cost is written with the request; a refused answer is a 200 with `understood:
  // false`, not an error status, because an error would roll back the cost it incurred.

  mount(app, routes.portalRunsAsk, async (ctx) => {
    const { tx, tenantIds, body, services, session } = ctx;
    const tenantId = tenantIds[0] as string;
    const context = await askContext(tx, {
      surface: "portal",
      tenantIds: [tenantId],
      platform: services.platform,
      now: new Date(),
    });
    const llm = createLlmClient({ transport: transport(ctx) });
    const outcome = await compileQuestion({ llm, question: body.text, context });
    if (outcome.record) {
      await recordAskUsage(tx, {
        surface: "portal",
        tenantId,
        userId: session.user.id,
        question: body.text,
        record: outcome.record,
        filter: outcome.ok ? outcome.filter : null,
        refused: outcome.ok ? null : outcome.reason,
      });
    }
    if (!outcome.ok) {
      console.info(JSON.stringify({ event: "runs.ask.refused", reason: outcome.reason }));
      return { understood: false as const, message: ASK_NOT_UNDERSTOOD };
    }
    // The portal's own filter (no back-office keys: the schema refused them), its live runs only.
    const filter = portalRunFilter(outcome.filter);
    // Statuses are the client's (a run waiting on the client is "waiting"), as on its runs list.
    const { statuses, ...rest } = filter;
    const runs = await runSummaries(
      tx,
      tenantId,
      [
        ...runFilterWhere(rest, services.platform.ctx.tools.specs()),
        ...clientStatusWhere(statuses),
      ],
      ASK_RUNS_LIMIT,
      services.platform,
    );
    return {
      understood: true as const,
      filter,
      chips: askChips(filter, namesOf(context)),
      // v0.14 W4-B: what the question asked that the filter can't express.
      leftOut: outcome.leftOut,
      query: runFilterQuery(filter),
      runs: runs.map((r) => ({ ...r, shortId: shortRunId(r.id) })),
    };
  });

  mount(app, routes.opsRunsAsk, async (ctx) => {
    const { tx, body, services, session } = ctx;
    const ids = opsIds(ctx, body.client);
    const context = await askContext(tx, {
      surface: "ops",
      tenantIds: ids,
      platform: services.platform,
      now: new Date(),
    });
    const llm = createLlmClient({ transport: transport(ctx) });
    const outcome = await compileQuestion({ llm, question: body.text, context });
    if (outcome.record) {
      await recordAskUsage(tx, {
        surface: "ops",
        tenantId: null,
        userId: session.user.id,
        question: body.text,
        record: outcome.record,
        filter: outcome.ok ? outcome.filter : null,
        refused: outcome.ok ? null : outcome.reason,
      });
    }
    if (!outcome.ok) {
      console.info(JSON.stringify({ event: "runs.ask.refused", reason: outcome.reason }));
      return { understood: false as const, message: ASK_NOT_UNDERSTOOD };
    }
    const filter = outcome.filter;
    // The runs list's own query, over the clients this question covers.
    const rows = await tx
      .select({ r: run, a: agent })
      .from(run)
      .innerJoin(agent, and(eq(agent.id, run.agentId), eq(agent.tenantId, run.tenantId)))
      .where(
        and(
          inArray(run.tenantId, ids),
          ...runFilterWhere(filter, services.platform.ctx.tools.specs()),
        ),
      )
      .orderBy(desc(run.createdAt))
      .limit(ASK_RUNS_LIMIT);
    const client = await clientNames(tx, ids);
    return {
      understood: true as const,
      filter,
      chips: askChips(filter, namesOf(context)),
      // v0.14 W4-B: what the question asked that the filter can't express.
      leftOut: outcome.leftOut,
      query: runFilterQuery(filter),
      runs: rows.map(({ r, a }) => ({
        id: r.id,
        shortId: shortRunId(r.id),
        client: client(r.tenantId) ?? { id: r.tenantId, name: "" },
        agent: { id: a.id, name: a.name, serviceName: a.serviceName },
        status: r.status,
        mode: r.mode,
        createdAt: r.createdAt.toISOString(),
        costUsd: r.costUsd,
      })),
    };
  });
}
