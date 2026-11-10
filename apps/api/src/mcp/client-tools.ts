// The client's MCP tools (docs/plan.md §1.86): what the portal shows a client's admin or user, for
// their own client, read only. The same `/mcp` as the back office's tools; who signs in decides
// which set they get (./routes.ts). Every read goes through a portal route's own handler
// (`invokeRoute`: its roles, the one-client scope, its schemas and its response contract, which
// never carries agent bundles, instructions, prompts or cost: invariant 11). A back-office route
// is refused here before it runs. Every result is fenced as untrusted data (./output.ts).

import { buildSession, type Session } from "@countersign/auth";
import {
  InboxKindSchema,
  InboxStatusSchema,
  isClientRole,
  isUuid,
  RECORD_LIST_KINDS,
  type RouteSpec,
  RunStatusSchema,
  routeFamily,
  routes,
} from "@countersign/core";
import type { Hono } from "hono";
import { z } from "zod";
import { type AppContext, type AppEnv, HttpError, invokeRoute, type RouteInput } from "../http";
import type { McpConfig } from "./config";
import { clip, dataResult } from "./output";
import type { Tool } from "./protocol";

export interface ClientToolCtx {
  app: Hono<AppEnv>;
  c: AppContext;
  /** The signed-in person with all their memberships; each tool narrows it to one client. */
  session: Session;
  config: McpConfig;
  now(): Date;
  /** The client a call acted in, for the audit entry (set by `asClient`). */
  audit: { outcome?: "preview" | "done"; target?: Record<string, string> };
}

const Id = z.string().refine(isUuid, "not an id").describe("A Mezonas id (uuid)");
const ClientArg = Id.optional().describe(
  "Which of your businesses (its id from whoami). Leave out when you belong to one.",
);

const READ = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The clients this person belongs to as a client admin or user. */
export function clientMemberships(session: Session) {
  return session.memberships.filter((m) => isClientRole(m.role));
}

/**
 * The session narrowed to one client, as a portal request is (invariant 1: exactly one client):
 * the one named, or the only one this person belongs to.
 */
// DECISION: a person in more than one client names the client on each call (from whoami), as the
// portal's client switcher does per request; nothing is remembered between calls.
export function asClient(ctx: ClientToolCtx, requested: string | undefined): Session {
  const mine = clientMemberships(ctx.session);
  const chosen = requested
    ? mine.find((m) => m.tenantId === requested)
    : mine.length === 1
      ? mine[0]
      : undefined;
  if (!chosen) {
    if (requested) throw new HttpError(404, "not_found", "client not found");
    throw new HttpError(
      400,
      "choose_client",
      "you belong to more than one business: pass `client` (whoami lists them)",
    );
  }
  const built = buildSession(
    ctx.session.user,
    ctx.session.memberships,
    ctx.session.adapter,
    chosen.tenantId,
  );
  if (!built.ok || !built.session.activeRole || !isClientRole(built.session.activeRole)) {
    throw new HttpError(403, "forbidden", "the portal is for client users");
  }
  ctx.audit.target = { client: chosen.tenantId };
  return built.session;
}

/** A portal route, run as this person in one client. Back-office routes are refused. */
function route<R extends RouteSpec>(
  ctx: ClientToolCtx,
  session: Session,
  spec: R,
  raw: RouteInput = {},
) {
  if (routeFamily(spec) !== "portal") {
    throw new Error(`${spec.method} ${spec.path} is a back-office route, not for client tools`);
  }
  return invokeRoute(ctx.app, ctx.c, session, spec, raw);
}

/** Query strings for invokeRoute: set values only, as strings. */
function query(values: Record<string, string | number | boolean | undefined>) {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(values)) if (v !== undefined) out[k] = String(v);
  return out;
}

// ── Tools ────────────────────────────────────────────────────────────────────────────────────────

const whoami: Tool<ClientToolCtx> = {
  name: "whoami",
  title: "Who am I",
  description:
    "Who you are signed in as, which Mezonas environment this is (staging or production), and the business (or businesses) you belong to with your role in each.",
  input: z.strictObject({}),
  annotations: READ,
  async run(ctx) {
    const mine = clientMemberships(ctx.session);
    const { user } = ctx.session;
    return dataResult(
      "whoami",
      `Signed in to Mezonas ${ctx.config.environment}, a member of ${plural(mine.length, "business", "businesses")}.`,
      {
        user: { id: user.id, email: user.email, name: user.name },
        environment: ctx.config.environment,
        server: ctx.config.resource,
        clients: mine.map((m) => ({ id: m.tenantId, name: m.tenantName, role: m.role })),
      },
    );
  },
};

const overview: Tool<ClientToolCtx> = {
  name: "overview",
  title: "Overview",
  description:
    "Your home page: your services (agents), how many items wait on you, recent runs, and the latest health summary.",
  input: z.strictObject({ client: ClientArg }),
  annotations: READ,
  async run(ctx, args) {
    const session = asClient(ctx, args.client as string | undefined);
    const out = await route(ctx, session, routes.portalOverview);
    return dataResult(
      "overview",
      `${plural(out.services.length, "service")}, ${plural(out.needsYou.inbox, "item")} waiting on you, ${plural(out.recentRuns.length, "recent run")}.`,
      out,
    );
  },
};

const inboxList: Tool<ClientToolCtx> = {
  name: "inbox_list",
  title: "List your inbox",
  description:
    "Your inbox: approvals, reviews and questions your agents wait on (a client user sees the items assigned to them). Open and waiting by default; `view: snoozed` lists snoozed ones.",
  input: z.strictObject({
    client: ClientArg,
    status: InboxStatusSchema.default("open"),
    kind: InboxKindSchema.optional(),
    view: z.enum(["waiting", "snoozed"]).optional(),
  }),
  annotations: READ,
  async run(ctx, args) {
    const { client, ...rest } = args as Record<string, string | undefined>;
    const session = asClient(ctx, client);
    const { items } = await route(ctx, session, routes.portalInbox, { query: query(rest) });
    return dataResult("inbox_list", `${plural(items.length, "inbox item")} (${rest.status}).`, {
      items: items.map((i) => ({ ...i, payload: clip(i.payload, 2000) })),
    });
  },
};

const runsList: Tool<ClientToolCtx> = {
  name: "runs_list",
  title: "List runs",
  description:
    "Your services' runs, newest first (never test runs). Filter by status (failed, waiting, running, done, …), service (an agent's id from overview), since and until (ISO 8601) and text.",
  input: z.strictObject({
    client: ClientArg,
    status: RunStatusSchema.optional(),
    service: Id.optional().describe("A service's (agent's) id, from overview"),
    since: z.iso.datetime({ offset: true }).optional(),
    until: z.iso.datetime({ offset: true }).optional(),
    text: z.string().trim().min(1).max(200).optional(),
    limit: z.int().min(1).max(100).default(25),
  }),
  annotations: READ,
  async run(ctx, args) {
    const { client, ...rest } = args as Record<string, string | number | undefined>;
    const session = asClient(ctx, client as string | undefined);
    const { runs } = await route(ctx, session, routes.portalRuns, { query: query(rest) });
    return dataResult("runs_list", `${plural(runs.length, "run")}. run_get shows one.`, { runs });
  },
};

const runGet: Tool<ClientToolCtx> = {
  name: "run_get",
  title: "Get a run",
  description:
    "One run as your portal shows it: its steps, the approvals it asked for and who gave them, and the changes it made to your tools.",
  input: z.strictObject({ client: ClientArg, id: Id }),
  annotations: READ,
  async run(ctx, args) {
    const { client, id } = args as { client?: string; id: string };
    const session = asClient(ctx, client);
    const r = await route(ctx, session, routes.portalRun, { params: { id } });
    return dataResult(
      "run_get",
      `Run ${r.run.status}, ${plural(r.steps.length, "step")}, ${plural(r.approvals.length, "approval")}, ${plural(r.actions.length, "change")} to your tools.`,
      r,
    );
  },
};

const connectionsList: Tool<ClientToolCtx> = {
  name: "connections_list",
  title: "List connections",
  description:
    "The tools you can connect (QuickBooks, Gmail, uploads, …): which are connected, their status, and what agents may do in each. Never credentials.",
  input: z.strictObject({ client: ClientArg }),
  annotations: READ,
  async run(ctx, args) {
    const session = asClient(ctx, args.client as string | undefined);
    const { connections } = await route(ctx, session, routes.portalConnections);
    return dataResult("connections_list", `${plural(connections.length, "connection")}.`, {
      connections,
    });
  },
};

const requestsList: Tool<ClientToolCtx> = {
  name: "requests_list",
  title: "List requests",
  description:
    "What you have asked us (Mezonas) for, newest first: changes to a service or something new, with their status (a client user sees the ones they raised).",
  input: z.strictObject({
    client: ClientArg,
    status: z.enum(["open", "resolved", "all"]).default("all"),
  }),
  annotations: READ,
  async run(ctx, args) {
    const { client, status } = args as { client?: string; status: string };
    const session = asClient(ctx, client);
    const out = await route(ctx, session, routes.portalRequests, { query: { status } });
    return dataResult("requests_list", `Your requests (${status}).`, out);
  },
};

const recordsSearch: Tool<ClientToolCtx> = {
  name: "records_search",
  title: "Search records",
  description:
    "What your connections brought in (transactions, vendors, items or receivables), newest first, with the portal's Records search: a doc number, memo, vendor, customer or name, or an amount.",
  input: z.strictObject({
    client: ClientArg,
    q: z.string().trim().max(200).optional(),
    kind: z.enum(RECORD_LIST_KINDS).optional(),
    offset: z.int().min(0).max(1_000_000).optional(),
    limit: z.int().min(1).max(200).optional(),
  }),
  annotations: READ,
  async run(ctx, args) {
    const { client, ...rest } = args as Record<string, string | number | undefined>;
    const session = asClient(ctx, client as string | undefined);
    const list = await route(ctx, session, routes.portalRecords, { query: query(rest) });
    return dataResult("records_search", "Records found (counts and one page).", list);
  },
};

const recordGet: Tool<ClientToolCtx> = {
  name: "record_get",
  title: "Get a record",
  description: "One of your records, by the id a run or report cites: its kind, fields and source.",
  input: z.strictObject({ client: ClientArg, id: Id }),
  annotations: READ,
  async run(ctx, args) {
    const { client, id } = args as { client?: string; id: string };
    const session = asClient(ctx, client);
    const out = await route(ctx, session, routes.portalRecord, { params: { id } });
    return dataResult("record_get", "The record.", out);
  },
};

const documentsList: Tool<ClientToolCtx> = {
  name: "documents_list",
  title: "List documents",
  description: "Your recent documents: uploaded and forwarded, newest first.",
  input: z.strictObject({ client: ClientArg, limit: z.int().min(1).max(200).default(50) }),
  annotations: READ,
  async run(ctx, args) {
    const { client, limit } = args as { client?: string; limit: number };
    const session = asClient(ctx, client);
    const { documents } = await route(ctx, session, routes.portalDocuments, {
      query: { limit: String(limit) },
    });
    return dataResult("documents_list", `${plural(documents.length, "document")}.`, {
      documents,
    });
  },
};

const documentGet: Tool<ClientToolCtx> = {
  name: "document_get",
  title: "Get a document",
  description:
    "One document: its details and what was read from it (the latest extraction). Open the file itself in the portal.",
  input: z.strictObject({ client: ClientArg, id: Id }),
  annotations: READ,
  async run(ctx, args) {
    const { client, id } = args as { client?: string; id: string };
    const session = asClient(ctx, client);
    const out = await route(ctx, session, routes.portalDocument, { params: { id } });
    // DECISION: the file's 5-minute link is left out: anyone holding it can download the file for
    // those minutes, and a chat transcript is kept far longer. The portal opens the file.
    return dataResult(
      "document_get",
      out.extraction ? "The document and what was read from it." : "The document; not read yet.",
      { document: out.document, extraction: out.extraction },
    );
  },
};

const reportsList: Tool<ClientToolCtx> = {
  name: "reports_list",
  title: "List reports",
  description:
    "The business areas switched on for you (purchasing, marketing, bookkeeping, …) and their reports. report_get opens one by its pack and report name.",
  input: z.strictObject({ client: ClientArg }),
  annotations: READ,
  async run(ctx, args) {
    const session = asClient(ctx, args.client as string | undefined);
    const { packs } = await route(ctx, session, routes.portalPacks);
    const on = packs.filter((p) => p.enabled);
    return dataResult("reports_list", `${plural(on.length, "area")} switched on.`, {
      packs: on.map((p) => ({
        pack: p.id,
        name: p.name,
        description: p.description,
        reports: p.screens.map((s) => ({ title: s.title, route: s.route })),
      })),
    });
  },
};

const reportGet: Tool<ClientToolCtx> = {
  name: "report_get",
  title: "Get a report",
  description:
    "One of your business area reports, as the portal shows it: `pack` and `report` name it (e.g. materials and prices; the last two parts of a report's route in reports_list), `query` takes the report's own filters as strings.",
  input: z.strictObject({
    client: ClientArg,
    pack: z.string().regex(/^[a-z][a-z0-9_-]*$/),
    report: z.string().regex(/^[a-z][a-z0-9_-]*$/),
    query: z
      .record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/), z.string().max(500))
      .optional()
      .describe("The report's query parameters, as strings"),
  }),
  annotations: READ,
  async run(ctx, args) {
    const {
      client,
      pack,
      report,
      query: q,
    } = args as { client?: string; pack: string; report: string; query?: Record<string, string> };
    const session = asClient(ctx, client);
    const out = await route(ctx, session, routes.portalPackReport, {
      params: { pack, report },
      query: q ?? {},
    });
    return dataResult("report_get", `Your ${pack} report: ${report}.`, out.report);
  },
};

export const CLIENT_TOOLS: readonly Tool<ClientToolCtx>[] = [
  whoami,
  overview,
  inboxList,
  runsList,
  runGet,
  connectionsList,
  requestsList,
  recordsSearch,
  recordGet,
  documentsList,
  documentGet,
  reportsList,
  reportGet,
];
