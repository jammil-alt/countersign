// The back office's MCP tools (docs/plan.md §1.34): reads of what the back office shows, for the
// clients this operator serves, and one two-step write. Reads go through the back office's own
// route handlers (`invokeRoute`: the same roles, client scope, schemas and response contracts) or,
// where no route answers the question, through a query in the same operator scope. Every result is
// fenced as untrusted data (./output.ts).

import { ATTENTION_ISSUE_KINDS } from "@countersign/agents";
import type { Session } from "@countersign/auth";
import type { ObjectStore } from "@countersign/connectors";
import {
  FEEDBACK_SCREENSHOT_TYPE,
  InboxStatusSchema,
  isUuid,
  RECORD_LIST_KINDS,
  type RouteSpec,
  RunStatusSchema,
  routes,
} from "@countersign/core";
import { connection, connectionChange, type Tx } from "@countersign/db";
import { captureException } from "@sentry/cloudflare";
import { and, count, desc, inArray } from "drizzle-orm";
import type { Hono } from "hono";
import { z } from "zod";
import { type AuditEntry, auditAlone, auditInTx } from "../audit";
import { attentionOf } from "../connection-attention";
import {
  type AppContext,
  type AppEnv,
  auditActor,
  auditClient,
  HttpError,
  inScope,
  invokeRoute,
  type RouteInput,
  type Scoped,
  scopeOf,
  toHttpError,
} from "../http";
import { healthFindings } from "../observability/health";
import { opsFeedbackItem, resolveFeedback } from "../routes/feedback";
import { opsConnection } from "../routes/mappers";
import { latestHealthSummary } from "../routes/supervisor";
import type { McpConfig } from "./config";
import {
  CONFIRM_ARG,
  CONFIRM_TTL_SEC,
  checkConfirmToken,
  claimNonce,
  issueConfirmToken,
} from "./confirm";
import { DEV_QUEUE_TOOLS } from "./dev-queue-tools";
import { clip, dataResult, errorResult } from "./output";
import type { Content, Tool, ToolResult } from "./protocol";

export interface OpsToolCtx {
  app: Hono<AppEnv>;
  c: AppContext;
  session: Session;
  config: McpConfig;
  objects: ObjectStore;
  now(): Date;
  /** What a write did, for the audit entry (set by the tool). */
  audit: { outcome?: "preview" | "done"; target?: Record<string, string> };
  /** Who is calling: the MCP server (default) or Reggie, which reads with these tools (§1.101). */
  via?: "mcp" | "reggie";
  /**
   * §1.190: clients in HIPAA mode the MCP connector may not send data for (./hipaa.ts); the tools
   * in LEAVE_OUT_HELD leave them out. Unset for Reggie, whose model calls are held instead.
   */
  hipaaHeld?: ReadonlySet<string>;
}

/** Of the clients from a list, those the connector may show; and how many it left out. */
function shown<T extends { id: string }>(ctx: OpsToolCtx, clients: readonly T[]) {
  const held = ctx.hipaaHeld;
  const kept = held?.size ? clients.filter((c) => !held.has(c.id)) : [...clients];
  return { kept, leftOut: clients.length - kept.length };
}

const leftOutNote = (n: number) =>
  n === 0
    ? ""
    : ` ${plural(n, "client")} in HIPAA mode ${n === 1 ? "is" : "are"} left out here: Anthropic's BAA for Claude isn't signed.`;

const Id = z.string().refine(isUuid, "not an id").describe("A Mezonas id (uuid)");
const ClientId = Id.describe("A client's id (uuid), from clients_list");

const READ = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

/** A back-office route, run as this operator. */
function route<R extends RouteSpec>(ctx: OpsToolCtx, spec: R, raw: RouteInput = {}) {
  return invokeRoute(ctx.app, ctx.c, ctx.session, spec, raw, ctx.via ?? "mcp");
}

/**
 * Work in the operator's scope: the clients they serve (withOperator), as /api/ops runs. Audited
 * as `invokeRoute` audits a route (§1.35): an ok row in the work's own transaction (it commits
 * with whatever the work wrote, and a failure to write it fails the work), or a refused or failed
 * row alone. `what` names the tool's read or write (`<via> tool <name>`); `target` holds ids only.
 */
async function asOperator<T>(
  ctx: OpsToolCtx,
  what: {
    tool: string;
    client?: string | null;
    target?: Record<string, string>;
  },
  work: (s: Scoped) => Promise<T>,
  /** The client the work turned out to act in (a feedback item's), when `what` names none. */
  clientOf?: (out: T) => string | null,
): Promise<T> {
  const scope = scopeOf(ctx.session, ["operator"], "ops");
  const entry = (
    outcome: AuditEntry["outcome"],
    httpStatus: number,
    found: string | null = null,
  ): AuditEntry => ({
    ...auditActor(ctx.session),
    tenantId: scope.ok ? auditClient(scope, found ?? what.client ?? null, what.target ?? {}) : null,
    action: `${ctx.via ?? "mcp"} tool ${what.tool}`,
    outcome,
    httpStatus,
    target: {
      ...Object.fromEntries(
        Object.entries(what.target ?? {}).map(([k, v]) => [k, String(v).slice(0, 200)]),
      ),
      ...(what.client ? { client: what.client.slice(0, 200) } : {}),
    },
  });
  try {
    if (!scope.ok) throw new HttpError(scope.status, scope.code, scope.message);
    return await inScope(ctx.c, scope, async (scoped) => {
      const out = await work(scoped);
      await auditInTx(scoped.tx, ctx.c, entry("ok", 200, clientOf?.(out) ?? null));
      return out;
    });
  } catch (error) {
    const status = toHttpError(error).status;
    await auditAlone(
      ctx.c.get("req").services().db,
      ctx.c,
      entry(status >= 500 ? "error" : "refused", status),
    );
    throw error;
  }
}

/** Query strings for invokeRoute: set values only, as strings. */
function query(values: Record<string, string | number | boolean | undefined>) {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(values)) if (v !== undefined) out[k] = String(v);
  return out;
}

function clientName(ctx: OpsToolCtx, tenantId: string | null): string | null {
  if (!tenantId) return null;
  return ctx.session.memberships.find((m) => m.tenantId === tenantId)?.tenantName ?? null;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

// ── Tools ────────────────────────────────────────────────────────────────────────────────────────

const whoami: Tool<OpsToolCtx> = {
  name: "whoami",
  title: "Who am I",
  description:
    "Who you are signed in as, which Mezonas environment this is (staging or production), and the clients you serve.",
  input: z.strictObject({}),
  annotations: READ,
  async run(ctx) {
    const listed = shown(ctx, (await route(ctx, routes.opsClients)).clients);
    const clients = listed.kept;
    const { user } = ctx.session;
    return dataResult(
      "whoami",
      `Signed in to Mezonas ${ctx.config.environment} as an operator serving ${plural(clients.length + listed.leftOut, "client")}.${leftOutNote(listed.leftOut)}`,
      {
        user: { id: user.id, email: user.email, name: user.name },
        environment: ctx.config.environment,
        server: ctx.config.resource,
        clients: clients.map((c) => ({ id: c.id, name: c.name, sandbox: c.sandbox ?? false })),
      },
    );
  },
};

const clientsList: Tool<OpsToolCtx> = {
  name: "clients_list",
  title: "List clients",
  description:
    "The clients you serve, each with its active agents, open inbox items, connections by status, and the supervisor's latest health check (good or attention).",
  input: z.strictObject({}),
  annotations: READ,
  async run(ctx) {
    const listed = shown(ctx, (await route(ctx, routes.opsClients)).clients);
    const clients = listed.kept;
    const extra = await asOperator(ctx, { tool: "clients_list" }, async ({ tx, tenantIds }) => {
      const ids = clients.map((c) => c.id).filter((id) => tenantIds.includes(id));
      const byStatus = ids.length
        ? await tx
            .select({ tenantId: connection.tenantId, status: connection.status, n: count() })
            .from(connection)
            .where(inArray(connection.tenantId, ids))
            .groupBy(connection.tenantId, connection.status)
        : [];
      const health = new Map<string, Awaited<ReturnType<typeof latestHealthSummary>>>();
      for (const id of ids) health.set(id, await latestHealthSummary(tx, id));
      return { byStatus, health };
    });
    const out = clients.map((c) => ({
      ...c,
      connections: Object.fromEntries(
        extra.byStatus.filter((r) => r.tenantId === c.id).map((r) => [r.status, r.n]),
      ),
      health: extra.health.get(c.id) ?? null,
    }));
    const attention = out.filter((c) => c.health?.state === "attention").length;
    return dataResult(
      "clients_list",
      `${plural(out.length, "client")}; ${attention} need attention by their latest health check.${leftOutNote(listed.leftOut)}`,
      { clients: out },
    );
  },
};

const clientGet: Tool<OpsToolCtx> = {
  name: "client_get",
  title: "Get a client",
  description:
    "One client: its details, agents with their status, connections with status and last sync, members, and its health (the supervisor's latest summary and open findings).",
  input: z.strictObject({ client: ClientId }),
  annotations: READ,
  async run(ctx, args) {
    const { client } = args as { client: string };
    const detail = await route(ctx, routes.opsClient, { params: { id: client } });
    const health = await route(ctx, routes.opsClientHealth, {
      params: { id: client },
      query: { status: "open" },
    });
    return dataResult(
      "client_get",
      `Client with ${plural(detail.agents.length, "active agent")}, ${plural(detail.connections.length, "connection")} and ${plural(health.findings.length, "open finding")}.`,
      {
        client: detail.client,
        agents: detail.agents.map((a) => ({
          id: a.id,
          slug: a.slug,
          name: a.name,
          serviceName: a.serviceName,
          status: a.status,
          runStatus: a.runStatus,
          liveVersionId: a.liveVersionId,
          templateId: a.templateId,
          linked: a.linked,
          testCopy: a.testCopy,
        })),
        connections: detail.connections.map((c) => ({
          id: c.id,
          connector: c.connector,
          status: c.status,
          externalAccountId: c.externalAccountId,
          lastSyncAt: c.lastSyncAt,
          permissions: c.permissions,
          createdAt: c.createdAt,
        })),
        members: detail.members,
        health: {
          supervisor: health.supervisor,
          summary: health.summary,
          findings: health.findings,
        },
      },
    );
  },
};

const feedbackList: Tool<OpsToolCtx> = {
  name: "feedback_list",
  title: "List feedback",
  description:
    "Feedback sent with the Feedback button, from the back office and the portals of the clients you serve, newest first. Filter by status (open by default) and client.",
  input: z.strictObject({
    status: z.enum(["open", "resolved", "all"]).default("open"),
    client: ClientId.optional(),
    back_office: z
      .boolean()
      .optional()
      .describe("true: only the back office's own feedback; false: only clients' portals"),
    limit: z.int().min(1).max(200).default(50),
  }),
  annotations: READ,
  async run(ctx, args) {
    const a = args as { status: string; client?: string; back_office?: boolean; limit: number };
    if (a.client && !ctx.session.servedTenantIds.includes(a.client)) {
      throw new HttpError(404, "not_found", "client not found");
    }
    const { items } = await route(ctx, routes.opsFeedback, { query: { status: a.status } });
    const matched = items.filter(
      (i) =>
        (!a.client || i.client?.id === a.client) &&
        (a.back_office === undefined || (i.client === null) === a.back_office),
    );
    const shown = matched.slice(0, a.limit);
    return dataResult(
      "feedback_list",
      `${plural(matched.length, "feedback item")} (${a.status})${shown.length < matched.length ? `, showing ${shown.length}` : ""}. feedback_get shows one with its screenshot.`,
      { items: shown },
    );
  },
};

async function screenshot(ctx: OpsToolCtx, key: string | null): Promise<Content[]> {
  if (!key) return [];
  const stored = await ctx.objects.get(key);
  if (!stored) return [{ type: "text", text: "The screenshot is missing from storage." }];
  return [{ type: "image", data: base64(stored.bytes), mimeType: FEEDBACK_SCREENSHOT_TYPE }];
}

const feedbackGet: Tool<OpsToolCtx> = {
  name: "feedback_get",
  title: "Get feedback",
  description:
    "One feedback item: the comment, the page it was sent from, where the pin was dropped, the client, who sent it and when, and its screenshot as an image.",
  input: z.strictObject({ id: Id }),
  annotations: READ,
  async run(ctx, args) {
    const { id } = args as { id: string };
    const { item, screenshotKey } = await asOperator(
      ctx,
      { tool: "feedback_get", target: { feedback: id } },
      ({ tx, tenantIds }) => opsFeedbackItem(tx, tenantIds, id),
      (o) => o.item.client?.id ?? null,
    );
    const image = await screenshot(ctx, screenshotKey);
    const pin = item.pin
      ? ` The pin is at (${item.pin.x}, ${item.pin.y}) in a ${item.viewport.width}×${item.viewport.height} viewport.`
      : "";
    return dataResult(
      "feedback_get",
      `Feedback, ${item.status}, ${item.hasScreenshot ? "with" : "without"} a screenshot.${pin}`,
      { item },
      image,
    );
  },
};

const feedbackResolve: Tool<OpsToolCtx> = {
  name: "feedback_resolve",
  title: "Resolve feedback",
  description: `Mark feedback resolved, with an optional note (for example a PR link). Two steps: call it without confirm_token to see what it will do and get a token; then call it again with the same id and note and that confirm_token to do it. A token works once, for ${CONFIRM_TTL_SEC / 60} minutes, and only for you.`,
  input: z.strictObject({
    id: Id,
    note: z.string().trim().max(2000).optional(),
    [CONFIRM_ARG]: z
      .string()
      .min(1)
      .max(4000)
      .optional()
      .describe("From the first call's answer; leave out to preview"),
  }),
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  async run(ctx, args) {
    const a = args as { id: string; note?: string; [CONFIRM_ARG]?: string };
    const userId = ctx.session.user.id;
    const bound = { id: a.id, ...(a.note ? { note: a.note } : {}) };
    ctx.audit.target = { feedback: a.id };
    const token = a[CONFIRM_ARG];
    if (!token) {
      const { item } = await asOperator(
        ctx,
        { tool: "feedback_resolve", target: { feedback: a.id } },
        ({ tx, tenantIds }) => opsFeedbackItem(tx, tenantIds, a.id),
        (o) => o.item.client?.id ?? null,
      );
      if (item.status === "resolved")
        throw new HttpError(409, "already_resolved", "already resolved");
      const issued = await issueConfirmToken({
        password: ctx.config.sealPassword,
        userId,
        tool: feedbackResolve.name,
        args: bound,
        now: ctx.now(),
      });
      ctx.audit.outcome = "preview";
      return dataResult(
        "feedback_resolve",
        [
          `Preview, nothing changed yet. This will mark this feedback resolved as you, ${a.note ? "with the note below" : "with no note"}, in Mezonas ${ctx.config.environment}.`,
          `To do it, call feedback_resolve again with the same id and note and confirm_token "${issued.token}" (it expires at ${issued.expiresAt.toISOString()}).`,
        ].join("\n"),
        { item, note: a.note ?? null },
      );
    }
    const checked = await checkConfirmToken({
      token,
      password: ctx.config.sealPassword,
      userId,
      tool: feedbackResolve.name,
      args: bound,
      now: ctx.now(),
    });
    if (!checked.ok) {
      const why = {
        invalid: "that confirm token is not valid",
        expired: "that confirm token has expired; preview again for a new one",
        mismatch:
          "that confirm token was for different arguments (or another user); preview again with these",
        used: "that confirm token was already used",
      }[checked.reason];
      throw new HttpError(422, `confirm_${checked.reason}`, why);
    }
    if (!(await claimNonce(ctx.objects, checked.nonce, ctx.now()))) {
      throw new HttpError(422, "confirm_used", "that confirm token was already used");
    }
    const item = await asOperator(
      ctx,
      { tool: "feedback_resolve", target: { feedback: a.id, result: "done" } },
      ({ tx, tenantIds }) => resolveFeedback(tx, tenantIds, a.id, userId, a.note),
      (o) => o.client?.id ?? null,
    );
    ctx.audit.outcome = "done";
    return dataResult("feedback_resolve", "Resolved.", { item });
  },
};

const runsList: Tool<OpsToolCtx> = {
  name: "runs_list",
  title: "List runs",
  description:
    "Agent runs across the clients you serve, newest first. Filter by client, status (failed, waiting, running, …), agent, mode (live or test), since (ISO 8601), text, and what the runs were about (a vendor, a customer, a document or its number).",
  input: z.strictObject({
    client: ClientId.optional(),
    status: RunStatusSchema.optional(),
    agent: Id.optional().describe("An agent's id (uuid)"),
    mode: z.enum(["live", "test"]).optional(),
    since: z.iso.datetime({ offset: true }).optional(),
    // R2 (docs/plan.md §1.193): the runs list's own `text` and `about`.
    text: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .optional()
      .describe(
        "A short id (R-1a2b3c), a workflow, an agent's name, words of an error, or a name or number a run was about",
      ),
    about: z
      .array(z.string().trim().min(2).max(100))
      .min(1)
      .max(20)
      .optional()
      .describe(
        "Runs about any of these: words without commas in a name or number (Acme, PO-1032), or kind:id for one of our records (vendor:<uuid>, from records_search)",
      ),
    limit: z.int().min(1).max(100).default(25),
  }),
  annotations: READ,
  async run(ctx, args) {
    const { about, ...a } = args as Record<string, string | number | undefined> & {
      about?: string[];
    };
    const { runs, agents, ...found } = await route(ctx, routes.opsRuns, {
      query: query({ ...a, about: about?.join(",") }),
    });
    const agentOf = (id: string | null) => agents.find((g) => g.id === id) ?? null;
    return dataResult(
      "runs_list",
      `${plural(runs.length, "run")}. run_get shows one with its steps.`,
      {
        // R2: the records `about` named, as their runs kept them.
        ...(found.about ? { about: found.about } : {}),
        runs: runs.map((r) => ({
          id: r.id,
          client: { id: r.tenantId, name: clientName(ctx, r.tenantId) },
          agent: agentOf(r.agentId),
          workflowSlug: r.workflowSlug,
          mode: r.mode,
          status: r.status,
          trigger: r.trigger,
          error: r.error,
          costUsd: r.costUsd,
          createdAt: r.createdAt,
          startedAt: r.startedAt,
          finishedAt: r.finishedAt,
        })),
      },
    );
  },
};

const runGet: Tool<OpsToolCtx> = {
  name: "run_get",
  title: "Get a run",
  description:
    "One run: its steps with summaries and errors, the tool calls, the changes to the client's tools with before and after, the inbox items it waits on, and its cost.",
  input: z.strictObject({ id: Id }),
  annotations: READ,
  async run(ctx, args) {
    const { id } = args as { id: string };
    const r = await route(ctx, routes.opsRun, { params: { id } });
    const waiting = r.inbox.filter((i) => i.status === "open").length;
    return dataResult(
      "run_get",
      `Run ${r.run.status}, ${plural(r.steps.length, "step")}, ${plural(r.actions.length, "change")} to tools, ${waiting} open inbox ${waiting === 1 ? "item" : "items"}.`,
      {
        run: { ...r.run, client: { id: r.run.tenantId, name: clientName(ctx, r.run.tenantId) } },
        agent: r.agent,
        version: r.version,
        workflow: r.workflow ? { slug: r.workflow.slug, name: r.workflow.name } : null,
        steps: r.steps.map((s) => ({
          id: s.id,
          nodeId: s.nodeId,
          nodeType: s.nodeType,
          skillRef: s.skillRef,
          status: s.status,
          summary: s.summary,
          output: clip(s.output),
          costUsd: s.costUsd,
          startedAt: s.startedAt,
          finishedAt: s.finishedAt,
        })),
        toolCalls: r.toolCalls.map((t) => ({
          id: t.id,
          stepRunId: t.stepRunId,
          tool: t.tool,
          status: t.status,
          durationMs: t.durationMs,
          input: clip(t.input, 2000),
          output: clip(t.output, 2000),
        })),
        actions: r.actions.map((x) => ({
          ...x,
          input: clip(x.input),
          before: clip(x.before),
          result: clip(x.result),
        })),
        inbox: r.inbox.map((i) => ({
          id: i.id,
          kind: i.kind,
          title: i.title,
          status: i.status,
          assigneeRole: i.assigneeRole,
          dueAt: i.dueAt,
          createdAt: i.createdAt,
          resolvedAt: i.resolvedAt,
          resolution: clip(i.resolution, 2000),
        })),
      },
    );
  },
};

const inboxList: Tool<OpsToolCtx> = {
  name: "inbox_list",
  title: "List inbox items",
  description:
    "Inbox items (approvals, reviews, person steps) across the clients you serve: open ones by default, everyone's unless assigned is 'operator'.",
  input: z.strictObject({
    client: ClientId.optional(),
    status: InboxStatusSchema.default("open"),
    assigned: z.enum(["all", "operator"]).default("all"),
  }),
  annotations: READ,
  async run(ctx, args) {
    const a = args as Record<string, string | undefined>;
    const { items, agents } = await route(ctx, routes.opsInbox, { query: query(a) });
    return dataResult("inbox_list", `${plural(items.length, "inbox item")} (${a.status}).`, {
      items: items.map((i) => ({
        id: i.id,
        client: { id: i.tenantId, name: clientName(ctx, i.tenantId) },
        kind: i.kind,
        title: i.title,
        agent: agents.find((g) => g.id === i.agentId) ?? null,
        runId: i.runId,
        assigneeRole: i.assigneeRole,
        status: i.status,
        dueAt: i.dueAt,
        createdAt: i.createdAt,
        resolvableByOperator: i.resolvableByOperator,
        payload: clip(i.payload, 2000),
      })),
    });
  },
};

// QA (2026-11-22): what needs us, as Home's Needs us and Escalations count it, so an answer to
// "what needs me?" is the same number the back office shows (inbox_list's assigned items are only
// one part of it).
const needsUsList: Tool<OpsToolCtx> = {
  name: "needs_us",
  title: "What needs us",
  description:
    "What needs us (the operator) now, across the clients you serve or for one client: the same list and count as Needs us on the back office's Home and Escalations. Items assigned to us, failed live runs not retried, broken connections an agent uses, low-confidence readings of the last day, and clients' approvals nobody at the client can act on (one per client and reason, with the items it covers). Items only the client can answer are not here: inbox_list with assigned 'all' lists them.",
  input: z.strictObject({ client: ClientId.optional() }),
  annotations: READ,
  async run(ctx, args) {
    const a = args as Record<string, string | undefined>;
    const out = await route(ctx, routes.opsNeedsUs, { query: query(a) });
    return dataResult("needs_us", `${plural(out.count, "thing needs", "things need")} us.`, {
      count: out.count,
      escalations: out.escalations.map((e) => ({
        kind: e.kind,
        id: e.id,
        client: e.client,
        agent: e.agent,
        runId: e.runId,
        title: e.title,
        blockedSince: e.blockedSince,
        ...(e.wait ? { wait: e.wait } : {}),
        ...(e.itemIds ? { itemIds: e.itemIds } : {}),
      })),
    });
  },
};

async function connectionsIn(tx: Tx, tenantIds: readonly string[], client: string | undefined) {
  const ids = client ? tenantIds.filter((t) => t === client) : [...tenantIds];
  if (ids.length === 0) return [];
  const rows = await tx
    .select()
    .from(connection)
    .where(inArray(connection.tenantId, ids))
    .orderBy(connection.tenantId, connection.connector);
  const changes = rows.length
    ? await tx
        .select()
        .from(connectionChange)
        .where(
          and(
            inArray(connectionChange.tenantId, ids),
            inArray(
              connectionChange.connectionId,
              rows.map((r) => r.id),
            ),
          ),
        )
        .orderBy(desc(connectionChange.createdAt))
    : [];
  return rows.map((row) => {
    const mine = changes.filter((ch) => ch.connectionId === row.id);
    const last = mine[0];
    const issue = mine.find((ch) =>
      (ATTENTION_ISSUE_KINDS as readonly unknown[]).includes(
        (ch.change as { kind?: unknown } | null)?.kind,
      ),
    );
    return {
      row,
      attention: attentionOf(row.status, issue?.change as Record<string, unknown> | undefined),
      lastChange: last
        ? { at: last.createdAt.toISOString(), change: clip(last.change, 1000) }
        : null,
    };
  });
}

const connectionsList: Tool<OpsToolCtx> = {
  name: "connections_list",
  title: "List connections",
  description:
    "Connections to clients' tools (QuickBooks, Gmail, uploads, …) across the clients you serve or for one client: status, whether it needs attention and why (`attention`: error, the client signs in again; refresh_failing, still connected but renewing our access has failed for a day), last sync and the last change. Never credentials.",
  input: z.strictObject({ client: ClientId.optional() }),
  annotations: READ,
  async run(ctx, args) {
    const { client } = args as { client?: string };
    if (client && !ctx.session.servedTenantIds.includes(client)) {
      throw new HttpError(404, "not_found", "client not found");
    }
    const rows = await asOperator(
      ctx,
      { tool: "connections_list", client: client ?? null },
      ({ tx, tenantIds }) => connectionsIn(tx, tenantIds, client),
    );
    const inError = rows.filter((r) => r.attention === "error").length;
    const renewing = rows.filter((r) => r.attention === "refresh_failing").length;
    return dataResult(
      "connections_list",
      `${plural(rows.length, "connection")}, ${inError} in error, ${renewing} failing to renew our access.`,
      {
        connections: rows.map(({ row, attention, lastChange }) => {
          const c = opsConnection(row);
          return {
            id: c.id,
            client: { id: c.tenantId, name: clientName(ctx, c.tenantId) },
            connector: c.connector,
            status: c.status,
            needsAttention: attention !== null,
            attention,
            externalAccountId: c.externalAccountId,
            lastSyncAt: c.lastSyncAt,
            permissions: c.permissions,
            createdAt: c.createdAt,
            lastChange,
          };
        }),
      },
    );
  },
};

const recordsSearch: Tool<OpsToolCtx> = {
  name: "records_search",
  title: "Search records",
  description:
    "What a client's connections brought in (transactions, vendors, items or receivables), newest first, with the same search as the back office's Records page: a doc number, memo, vendor, customer or name, or an amount.",
  input: z.strictObject({
    client: ClientId,
    q: z.string().trim().max(200).optional(),
    kind: z.enum(RECORD_LIST_KINDS).optional(),
    source: Id.optional().describe("A connection's id, to search one source"),
    offset: z.int().min(0).max(1_000_000).optional(),
  }),
  annotations: READ,
  async run(ctx, args) {
    const { client, ...rest } = args as Record<string, string | number | undefined>;
    const list = await route(ctx, routes.opsClientRecords, {
      params: { id: String(client) },
      query: query(rest),
    });
    return dataResult("records_search", "Records found (counts and one page).", list);
  },
};

const opsHealth: Tool<OpsToolCtx> = {
  name: "ops_health",
  title: "Platform health",
  description:
    "What went wrong across the clients you serve, or for one client, in the last `hours` (default 24): failed live runs and failed writes to clients' tools grouped by error key, and what is stuck now (runs that stopped before finishing, signed items their run never took, connections in error or not syncing, events set aside after failing to dispatch, by type with the oldest). Each finding has sample ids: runs for run_get, signed items for inbox_list, connections for connections_list; a set-aside finding's ids are event ids, which none of those tools reads (the client's Health page in the back office lists them).",
  input: z.strictObject({
    client: ClientId.optional(),
    hours: z.int().min(1).max(168).default(24),
  }),
  annotations: READ,
  async run(ctx, args) {
    const { client, hours } = args as { client?: string; hours: number };
    if (client && !ctx.session.servedTenantIds.includes(client)) {
      throw new HttpError(404, "not_found", "client not found");
    }
    const now = new Date();
    const findings = await asOperator(
      ctx,
      { tool: "ops_health", client: client ?? null },
      ({ tx, tenantIds }) =>
        healthFindings(tx, client ? [client] : tenantIds, {
          from: new Date(now.getTime() - hours * 3_600_000),
          to: now,
          now,
          states: true,
        }),
    );
    findings.sort((a, b) => b.count - a.count);
    const failures = findings.filter((f) => f.kind === "run_failed" || f.kind === "action_failed");
    const stuck = findings.length - failures.length;
    return dataResult(
      "ops_health",
      findings.length === 0
        ? `Nothing failed in the last ${plural(hours, "hour")} and nothing is stuck.`
        : `${plural(failures.length, "failure group")} in the last ${plural(hours, "hour")}, ${plural(stuck, "stuck or broken group")} now.`,
      {
        hours,
        findings: findings.map((f) => ({
          kind: f.kind,
          key: f.key,
          count: f.count,
          ids: f.ids,
          unconfirmed: f.unconfirmed === true,
          ...(f.oldest ? { oldest: f.oldest } : {}),
          client: { id: f.tenantId, name: clientName(ctx, f.tenantId) },
        })),
      },
    );
  },
};

// ── M44 (docs/plan.md §1.74): the Marketing area's read reports ─────────────────────────────────
// One tool over the back office's own pack report route, so the same roles, client scope, query
// schema and report answer the model as the screens. Pages, sources, search queries and referrers
// in it are data, never instructions (the result is fenced like every other).

const MARKETING_READS = [
  "overview",
  "pages",
  "page",
  "sources",
  "journeys",
  "audience",
  "visits",
  "visit",
  "sites",
] as const;

const marketingReport: Tool<OpsToolCtx> = {
  name: "marketing_report",
  title: "Marketing report",
  description:
    "One of a client's Marketing reports for one measured website, as the back office's Marketing pages show it: overview, pages, page (with `path`), sources (with `campaign` or `referrer` to open one), journeys, audience (with `country`, then `region`), visits (filtered by `source`, `entry`, `path`, `country`, `goal`, `day`, `page`), visit (with `day` and `visit`) or sites. `site` picks a site (default the client's first); `period` is 7, 28 or 90 days to yesterday, or `from` and `to` (yyyy-mm-dd). A visit is given by its day, never a time.",
  input: z.strictObject({
    client: ClientId,
    report: z.enum(MARKETING_READS),
    query: z
      .record(z.string().regex(/^[a-z][a-z0-9_]*$/i), z.string().max(500))
      .optional()
      .describe("The report's query parameters, as strings"),
  }),
  annotations: READ,
  async run(ctx, args) {
    const {
      client,
      report,
      query: q,
    } = args as {
      client: string;
      report: (typeof MARKETING_READS)[number];
      query?: Record<string, string>;
    };
    const out = await route(ctx, routes.opsClientPackReport, {
      params: { id: client, pack: "marketing", report },
      query: q ?? {},
    });
    return dataResult("marketing_report", `The client's Marketing report: ${report}.`, out.report);
  },
};

/**
 * §1.190: the tools that leave a client in HIPAA mode out of their answer instead of being refused
 * (they list clients, so the operator can still find the ones they may ask about).
 */
export const LEAVE_OUT_HELD: ReadonlySet<string> = new Set([whoami.name, clientsList.name]);

export const OPS_TOOLS: readonly Tool<OpsToolCtx>[] = [
  whoami,
  clientsList,
  clientGet,
  feedbackList,
  feedbackGet,
  feedbackResolve,
  runsList,
  runGet,
  inboxList,
  needsUsList,
  connectionsList,
  recordsSearch,
  opsHealth,
  marketingReport,
  // docs/plan.md §1.125: the Dev queue
  ...DEV_QUEUE_TOOLS,
];

/**
 * A tool's failure as the model sees it: the API's error code and message (as /api would answer),
 * never a stack, a query or a database message.
 */
export function toolError(error: unknown): ToolResult & { code: string; status: number } {
  const e = toHttpError(error);
  if (e.status === 500) {
    console.error(error);
    captureException(error, { tags: { route: "/mcp" } });
  }
  return { ...errorResult(`${e.code}: ${e.message}`), code: e.code, status: e.status };
}
