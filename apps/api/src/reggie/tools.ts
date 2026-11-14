// Reggie's tools (docs/plan.md §1.101). Reading: the Ops MCP server's read tools, run as the
// signed-in operator through the back office's own routes (one set of tools, two front doors),
// plus Reggie's own reads. Changing: a change tool only proposes; the operator confirms its card,
// and only then does `apply` run, once.

import type { Session } from "@countersign/auth";
import { LeadRequestCreate, type LeadRequestCreateInput, routes } from "@countersign/core";
import type { Hono } from "hono";
import { z } from "zod";
import { type AppContext, type AppEnv, HttpError, invokeRoute, type RouteInput } from "../http";
import { OPS_TOOLS, type OpsToolCtx } from "../mcp/ops-tools";
import { clip, dataResult } from "../mcp/output";
import type { Content, ToolResult } from "../mcp/protocol";

/** What every Reggie tool gets: the request, the operator's session and the app's routes. */
export interface ReggieToolCtx {
  app: Hono<AppEnv>;
  c: AppContext;
  session: Session;
  now(): Date;
}

export interface ReadTool {
  kind: "read";
  name: string;
  description: string;
  input: z.ZodObject;
  run(ctx: ReggieToolCtx, args: unknown): Promise<string>;
}

/** What a change's card shows. */
export interface ChangePreview {
  title: string;
  lines: string[];
  clientId: string | null;
}

export interface ChangeTool {
  kind: "change";
  name: string;
  description: string;
  input: z.ZodObject;
  preview(ctx: ReggieToolCtx, args: unknown): Promise<ChangePreview>;
  /** Runs once, after the operator confirms; returns what it did, in plain words. */
  apply(ctx: ReggieToolCtx, args: unknown): Promise<{ outcome: string; result: unknown }>;
}

export type ReggieTool = ReadTool | ChangeTool;

const Id = z.string().uuid().describe("A Mezonas id (uuid)");
const ClientId = Id.describe("The client's id (uuid), from clients_list");

/** A back-office route, run as this operator, audited as Reggie's (§1.35). */
function route<R extends Parameters<typeof invokeRoute>[3]>(
  ctx: ReggieToolCtx,
  spec: R,
  raw: RouteInput = {},
) {
  return invokeRoute(ctx.app, ctx.c, ctx.session, spec, raw, "reggie");
}

function text(result: ToolResult): string {
  const parts = result.content
    .filter((c): c is Extract<Content, { type: "text" }> => c.type === "text")
    .map((c) => c.text);
  return parts.join("\n\n");
}

/** A client this operator serves, by id, with its name; refused otherwise (ids from a model). */
export function servedClient(ctx: ReggieToolCtx, clientId: string): { id: string; name: string } {
  if (!ctx.session.servedTenantIds.includes(clientId)) {
    throw new HttpError(404, "not_found", "no such client among those you serve");
  }
  const name =
    ctx.session.memberships.find((m) => m.tenantId === clientId)?.tenantName ?? "the client";
  return { id: clientId, name };
}

// ── Reading: the Ops MCP server's read tools ─────────────────────────────────────────────────────

// DECISION: Reggie reads with the MCP server's own tools (§1.34), so both front doors show the
// same data, scoped and fenced the same way; writes on the MCP server keep their two-step tokens
// and are not Reggie's (its changes are cards). The feedback tools are left out: they are about
// the product, not a client.
const MCP_READS = new Set([
  "whoami",
  "clients_list",
  "client_get",
  "runs_list",
  "run_get",
  "inbox_list",
  "connections_list",
  "records_search",
  "ops_health",
  "marketing_report",
]);

function mcpCtx(ctx: ReggieToolCtx): OpsToolCtx {
  const services = ctx.c.get("req").services();
  return {
    app: ctx.app,
    c: ctx.c,
    session: ctx.session,
    // Only the environment's name is read by the read tools; the rest is the MCP server's own.
    config: {
      resource: "",
      resourceMetadataUrl: "",
      authorizationServer: "",
      audience: "",
      environment: services.env.ENVIRONMENT ?? "development",
      sealPassword: "",
    },
    objects: services.deps.objects(services.env),
    now: ctx.now,
    audit: {},
    via: "reggie",
  };
}

const mcpReads: ReadTool[] = OPS_TOOLS.filter((t) => MCP_READS.has(t.name)).map((t) => ({
  kind: "read" as const,
  name: t.name,
  description: t.description,
  input: t.input,
  async run(ctx, args) {
    return text(await t.run(mcpCtx(ctx), t.input.parse(args) as Record<string, unknown>));
  },
}));

// ── Reggie's own reads ───────────────────────────────────────────────────────────────────────────

const ClientArgs = z.strictObject({ client: ClientId });

async function leadThreadId(ctx: ReggieToolCtx, clientId: string): Promise<string> {
  const out = await route(ctx, routes.opsThreads, {
    params: { id: clientId },
    query: { subject: "lead" },
  });
  const id = out.threads[0]?.id;
  if (!id) throw new HttpError(404, "not_found", "this client has no lead conversation");
  return id;
}

const textingGet: ReadTool = {
  kind: "read",
  name: "texting_get",
  description:
    "A client's texting set-up: its Twilio subaccount, numbers, quiet hours, and its US texting (A2P 10DLC) registration: the stage, what Twilio asked for, the fees.",
  input: ClientArgs,
  async run(ctx, args) {
    const { client } = ClientArgs.parse(args);
    const c = servedClient(ctx, client);
    const out = await route(ctx, routes.opsMessaging, { params: { id: client } });
    return text(dataResult("texting_get", `${c.name}'s texting set-up.`, clip(out.setup, 12_000)));
  },
};

const leadMessages: ReadTool = {
  kind: "read",
  name: "lead_messages",
  description:
    "The latest messages in a client's lead conversation (between the client's people and their Mezonas lead), oldest first.",
  input: z.strictObject({ client: ClientId, limit: z.number().int().min(1).max(50).default(20) }),
  async run(ctx, args) {
    const a = z.strictObject({ client: ClientId, limit: z.number().int().default(20) }).parse(args);
    const c = servedClient(ctx, a.client);
    const id = await leadThreadId(ctx, a.client);
    const out = await route(ctx, routes.opsThreadMessages, {
      params: { id },
      query: { limit: String(a.limit) },
    });
    return text(
      dataResult(
        "lead_messages",
        `The lead conversation with ${c.name}.`,
        clip(out.messages, 12_000),
      ),
    );
  },
};

const leadRequestsGet: ReadTool = {
  kind: "read",
  name: "lead_requests",
  description:
    "What the lead asked a client's admin on their Desk (by Reggie or in the back office), and their answers.",
  input: ClientArgs,
  async run(ctx, args) {
    const { client } = ClientArgs.parse(args);
    const c = servedClient(ctx, client);
    const out = await route(ctx, routes.opsLeadRequests, { params: { id: client } });
    return text(dataResult("lead_requests", `What we asked ${c.name}.`, out.items));
  },
};

/**
 * One look at a client's account: the client page (agents, connections, people, the supervisor's
 * findings), texting, what waits on the client and on us, and the lead's open requests.
 */
const clientReview: ReadTool = {
  kind: "read",
  name: "client_review",
  description:
    "A review of one client's account in one call: its agents, connections and their health, the supervisor's findings, texting and its US registration, what is waiting and on whom, and the lead's open requests. Start here when asked how a client is doing or what's needed to finish setting them up.",
  input: ClientArgs,
  async run(ctx, args) {
    const { client } = ClientArgs.parse(args);
    const c = servedClient(ctx, client);
    // One after another: the Worker's database client has one connection (Hyperdrive).
    const detail = await route(ctx, routes.opsClient, { params: { id: client } });
    const health = await route(ctx, routes.opsClientHealth, { params: { id: client } }).catch(
      () => null,
    );
    const texting = await route(ctx, routes.opsMessaging, { params: { id: client } }).catch(
      () => null,
    );
    const waiting = await route(ctx, routes.opsInbox, {
      query: { client, status: "open", assigned: "all" },
    }).catch(() => null);
    const requests = await route(ctx, routes.opsLeadRequests, { params: { id: client } });
    const reg = texting?.setup.twilio?.registration ?? null;
    return text(
      dataResult("client_review", `A review of ${c.name}'s account.`, {
        client: clip(detail, 8000),
        health: clip(health, 4000),
        texting: texting
          ? {
              connected: texting.setup.twilio?.status ?? "not set up",
              numbers: texting.setup.twilio?.numbers.map((n) => n.phoneNumber) ?? [],
              registrationStage: reg?.stage ?? null,
              registrationIssues: reg?.issues ?? [],
            }
          : null,
        waiting: clip(waiting, 4000),
        openRequests: requests.items.filter((r) => r.status === "open"),
      }),
    );
  },
};

// ── Changes ──────────────────────────────────────────────────────────────────────────────────────

const LeadMessageArgs = z.strictObject({
  client: ClientId,
  text: z
    .string()
    .trim()
    .min(1)
    .max(2000)
    .describe("The message, as the client's people will read it: from their Mezonas lead"),
});

const leadMessagePost: ChangeTool = {
  kind: "change",
  name: "lead_message_post",
  description:
    "Propose a message to a client in their lead conversation, posted as the operator (their Mezonas lead). Nothing is sent until the operator confirms the card.",
  input: LeadMessageArgs,
  async preview(ctx, args) {
    const a = LeadMessageArgs.parse(args);
    const c = servedClient(ctx, a.client);
    return {
      title: `Message ${c.name}`,
      lines: [`Posted in the lead conversation with ${c.name}, as you:`, a.text],
      clientId: c.id,
    };
  },
  async apply(ctx, args) {
    const a = LeadMessageArgs.parse(args);
    const c = servedClient(ctx, a.client);
    const id = await leadThreadId(ctx, a.client);
    const out = await route(ctx, routes.opsPostMessage, {
      params: { id },
      body: { text: a.text, audience: "client" },
    });
    return {
      outcome: `Posted to ${c.name}'s lead conversation.`,
      result: { threadId: id, messageIds: out.messages.map((m) => m.id) },
    };
  },
};

const LeadRequestArgs = LeadRequestCreate.extend({ client: ClientId });

const leadRequestCreate: ChangeTool = {
  kind: "change",
  name: "lead_request_create",
  description:
    "Propose a request on a client admin's Desk, from their Mezonas lead: a question to answer (with up to 6 choices, or a written answer) or something to do. Use it to ask a client for what only they can give: a decision, their details, a sign-off. Nothing is sent until the operator confirms the card. Read the answer later with lead_requests.",
  input: LeadRequestArgs,
  async preview(ctx, args) {
    const a = LeadRequestArgs.parse(args);
    const c = servedClient(ctx, a.client);
    return {
      title: `Ask ${c.name}'s admin`,
      lines: [
        `On ${c.name}'s admin's Desk, from you as their Mezonas lead:`,
        a.question,
        ...(a.detail ? [a.detail] : []),
        ...(a.choices ? [`Answers to pick from: ${a.choices.join(", ")}`] : []),
      ],
      clientId: c.id,
    };
  },
  async apply(ctx, args) {
    const { client, ...body } = LeadRequestArgs.parse(args);
    const c = servedClient(ctx, client);
    const out = await route(ctx, routes.opsLeadRequestCreate, {
      params: { id: client },
      body: body satisfies LeadRequestCreateInput,
    });
    return {
      outcome: `Asked on ${c.name}'s admin's Desk.`,
      result: { requestId: out.request.id },
    };
  },
};

export const REGGIE_TOOLS: readonly ReggieTool[] = [
  ...mcpReads,
  clientReview,
  textingGet,
  leadMessages,
  leadRequestsGet,
  leadMessagePost,
  leadRequestCreate,
];

export function reggieTool(name: string): ReggieTool | undefined {
  return REGGIE_TOOLS.find((t) => t.name === name);
}
