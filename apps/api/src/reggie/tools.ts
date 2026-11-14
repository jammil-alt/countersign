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

// ── Step 2: setting a client up (docs/plan.md §1.101) ────────────────────────────────────────────

const templatesList: ReadTool = {
  kind: "read",
  name: "templates_list",
  description:
    "The agent templates a client's agent can be made from: id, slug, name and description. Use the id with agent_add.",
  input: z.strictObject({}),
  async run(ctx) {
    const out = await route(ctx, routes.opsTemplates, { query: {} });
    return text(
      dataResult(
        "templates_list",
        `${out.templates.length} templates.`,
        out.templates.map((t) => ({
          id: t.id,
          slug: t.slug,
          name: t.name,
          description: (t as { description?: unknown }).description ?? null,
        })),
      ),
    );
  },
};

const peopleList: ReadTool = {
  kind: "read",
  name: "people_list",
  description:
    "A client's people (contacts): id, name, email, phone, organization, relationship, and whether each can be texted, called or emailed now. Use the ids with texting_invitations_send.",
  input: ClientArgs,
  async run(ctx, args) {
    const { client } = ClientArgs.parse(args);
    const c = servedClient(ctx, client);
    const out = await route(ctx, routes.opsContacts, { params: { id: client } });
    return text(
      dataResult(
        "people_list",
        `${out.items.length} people at ${c.name}.`,
        out.items.slice(0, 300).map((p) => ({
          id: p.id,
          name: p.name,
          email: p.email,
          phone: p.phone,
          relationship: p.relationship ?? null,
          canText: p.canMessage.sms,
          canCall: p.canCall,
          canEmail: p.canEmail,
          optedOut: p.optedOut,
        })),
      ),
    );
  },
};

const NumbersArgs = z.strictObject({
  client: ClientId,
  areaCode: z
    .string()
    .regex(/^\d{3}$/)
    .optional()
    .describe("A US area code, e.g. 512"),
});

const textingNumbersAvailable: ReadTool = {
  kind: "read",
  name: "texting_numbers_available",
  description:
    "US numbers Twilio has for sale for a client that already has its Twilio subaccount (texting_setup), by area code. Pick one for texting_number_buy.",
  input: NumbersArgs,
  async run(ctx, args) {
    const a = NumbersArgs.parse(args);
    const c = servedClient(ctx, a.client);
    const out = await route(ctx, routes.opsTwilioAvailableNumbers, {
      params: { id: a.client },
      query: { country: "US", ...(a.areaCode ? { areaCode: a.areaCode } : {}) },
    });
    return text(
      dataResult("texting_numbers_available", `Numbers for ${c.name}.`, out.items.slice(0, 20)),
    );
  },
};

const textingSignupLinkGet: ReadTool = {
  kind: "read",
  name: "texting_signup_link",
  description:
    "A client's texting sign-up link (§1.98): the page where its people sign up for texts. Made on first use.",
  input: ClientArgs,
  async run(ctx, args) {
    const { client } = ClientArgs.parse(args);
    const c = servedClient(ctx, client);
    const out = await route(ctx, routes.opsTextSignupLink, { params: { id: client } });
    return `${c.name}'s texting sign-up link: ${out.url}`;
  },
};

// DECISION: asking Twilio for the registration's status changes nothing anyone sees but the stored
// status, costs nothing and sends nothing, so it is a read for Reggie (no card), as the back
// office's "Check status" button is one click.
const textingRegistrationCheck: ReadTool = {
  kind: "read",
  name: "texting_registration_check",
  description:
    "Ask Twilio now where a client's US texting registration stands (the hourly pass does this too), and get the result.",
  input: ClientArgs,
  async run(ctx, args) {
    const { client } = ClientArgs.parse(args);
    const c = servedClient(ctx, client);
    const out = await route(ctx, routes.opsTwilioA2pRefresh, { params: { id: client } });
    const reg = out.setup.twilio?.registration ?? null;
    return text(
      dataResult("texting_registration_check", `${c.name}'s US texting registration now.`, {
        stage: reg?.stage ?? null,
        statuses: reg?.statuses ?? null,
        issues: reg?.issues ?? [],
        brandStatus: out.setup.twilio?.a2p.brandStatus ?? null,
        campaignStatus: out.setup.twilio?.a2p.campaignStatus ?? null,
      }),
    );
  },
};

const ClientCreateArgs = z.strictObject({
  name: z.string().trim().min(1).max(200).describe("The client business's name"),
  timezone: z
    .string()
    .trim()
    .max(64)
    .optional()
    .describe("An IANA time zone, e.g. America/Chicago"),
  adminEmail: z.string().trim().email().max(320).optional().describe("Its client admin, invited"),
  adminName: z.string().trim().max(200).optional(),
});

const clientCreate: ChangeTool = {
  kind: "change",
  name: "client_create",
  description:
    "Propose creating a client (you serve it), optionally inviting its client admin by email. Nothing happens until the operator confirms.",
  input: ClientCreateArgs,
  async preview(_ctx, args) {
    const a = ClientCreateArgs.parse(args);
    return {
      title: `Create ${a.name}`,
      lines: [
        "A new client, served by you:",
        a.name,
        ...(a.timezone ? [`Time zone: ${a.timezone}`] : []),
        a.adminEmail
          ? `Invite ${a.adminName ? `${a.adminName} (${a.adminEmail})` : a.adminEmail} as its admin.`
          : "No admin invited yet.",
      ],
      clientId: null,
    };
  },
  async apply(ctx, args) {
    const a = ClientCreateArgs.parse(args);
    const out = await route(ctx, routes.opsCreateClient, {
      body: {
        name: a.name,
        ...(a.timezone ? { timezone: a.timezone } : {}),
        ...(a.adminEmail
          ? { admin: { email: a.adminEmail, ...(a.adminName ? { name: a.adminName } : {}) } }
          : {}),
      },
    });
    return {
      outcome: `Created ${a.name}${out.admin ? " and invited its admin" : ""}.`,
      result: { clientId: out.client.id },
    };
  },
};

const textingSetup: ChangeTool = {
  kind: "change",
  name: "texting_setup",
  description:
    "Propose making a client's Twilio subaccount under Mezonas' account and connecting it: the first step of texting. Nothing happens until the operator confirms.",
  input: ClientArgs,
  async preview(ctx, args) {
    const { client } = ClientArgs.parse(args);
    const c = servedClient(ctx, client);
    return {
      title: `Set up texting for ${c.name}`,
      lines: [`Make ${c.name}'s Twilio subaccount under Mezonas' account and connect it.`],
      clientId: c.id,
    };
  },
  async apply(ctx, args) {
    const { client } = ClientArgs.parse(args);
    const c = servedClient(ctx, client);
    await route(ctx, routes.opsTwilioProvision, { params: { id: client } });
    return { outcome: `${c.name}'s Twilio subaccount is made and connected.`, result: {} };
  },
};

const BuyArgs = z.strictObject({
  client: ClientId,
  phoneNumber: z
    .string()
    .regex(/^\+[1-9]\d{7,14}$/)
    .describe("In international form, from texting_numbers_available"),
});

const textingNumberBuy: ChangeTool = {
  kind: "change",
  name: "texting_number_buy",
  description:
    "Propose buying a number in a client's Twilio subaccount, pointed at Mezonas: Twilio charges for it monthly. Nothing happens until the operator confirms.",
  input: BuyArgs,
  async preview(ctx, args) {
    const a = BuyArgs.parse(args);
    const c = servedClient(ctx, a.client);
    return {
      title: `Buy ${a.phoneNumber} for ${c.name}`,
      lines: [
        `Buy ${a.phoneNumber} in ${c.name}'s Twilio subaccount. Twilio charges for the number every month.`,
        "US texts from it wait for the client's US texting registration.",
      ],
      clientId: c.id,
    };
  },
  async apply(ctx, args) {
    const a = BuyArgs.parse(args);
    const c = servedClient(ctx, a.client);
    await route(ctx, routes.opsTwilioBuyNumber, {
      params: { id: a.client },
      body: { phoneNumber: a.phoneNumber },
    });
    return { outcome: `Bought ${a.phoneNumber} for ${c.name}.`, result: { number: a.phoneNumber } };
  },
};

/** The words of the request for a client's US texting details: fixed, not the model's. */
export const REGISTRATION_REQUEST = {
  question: "Please fill in your US texting details",
  detail:
    "Open Settings, then US texting, and fill in your business details and tax ID. We need them to register your texting number with the carriers before your agents can text anyone in the US. It takes about 5 minutes.",
} as const;

const textingRegistrationRequest: ChangeTool = {
  kind: "change",
  name: "texting_registration_request",
  description:
    "Propose asking a client's admin, on their Desk, to fill in their US texting details (Settings, US texting): only they enter their tax ID. Nothing is sent until the operator confirms.",
  input: ClientArgs,
  async preview(ctx, args) {
    const { client } = ClientArgs.parse(args);
    const c = servedClient(ctx, client);
    return {
      title: `Ask ${c.name} for their texting details`,
      lines: [
        `On ${c.name}'s admin's Desk, from you as their Mezonas lead:`,
        REGISTRATION_REQUEST.question,
        REGISTRATION_REQUEST.detail,
      ],
      clientId: c.id,
    };
  },
  async apply(ctx, args) {
    const { client } = ClientArgs.parse(args);
    const c = servedClient(ctx, client);
    const out = await route(ctx, routes.opsLeadRequestCreate, {
      params: { id: client },
      body: { question: REGISTRATION_REQUEST.question, detail: REGISTRATION_REQUEST.detail },
    });
    return {
      outcome: `Asked ${c.name}'s admin for their texting details.`,
      result: { requestId: out.request.id },
    };
  },
};

const SubmitArgs = z.strictObject({
  client: ClientId,
  reason: z
    .string()
    .trim()
    .min(3)
    .max(500)
    .describe("Why it's being submitted or resubmitted, kept with the submission"),
});

/** The registration's fees and what's still missing, read fresh for the card and at confirm. */
async function registrationFor(ctx: ReggieToolCtx, client: string) {
  const out = await route(ctx, routes.opsMessaging, { params: { id: client } });
  const reg = out.setup.twilio?.registration ?? null;
  if (out.setup.twilio?.status !== "connected") {
    throw new HttpError(
      409,
      "not_set_up",
      "this client's texting isn't set up: texting_setup first",
    );
  }
  if (!reg) {
    throw new HttpError(409, "no_details", "the client hasn't given their US texting details yet");
  }
  if (reg.missing.length > 0) {
    throw new HttpError(
      409,
      "details_missing",
      `the client's US texting details are missing: ${reg.missing.join(", ")}`,
    );
  }
  return reg;
}

const textingRegistrationSubmit: ChangeTool = {
  kind: "change",
  name: "texting_registration_submit",
  description:
    "Propose submitting (or resubmitting, after Twilio asked for changes) a client's US texting registration to Twilio with the details the client gave. The card shows the fees charged now and monthly; Mezonas pays and they come back as the client's credits. Nothing happens until the operator confirms.",
  input: SubmitArgs,
  async preview(ctx, args) {
    const a = SubmitArgs.parse(args);
    const c = servedClient(ctx, a.client);
    const reg = await registrationFor(ctx, a.client);
    const resubmit = reg.stage === "needs_changes";
    return {
      title: `${resubmit ? "Resubmit" : "Submit"} ${c.name}'s US texting registration`,
      lines: [
        `${resubmit ? "Resubmit" : "Submit"} ${c.name}'s details to Twilio for US texting.`,
        `Charged now: $${reg.fees.nowUsd}.`,
        ...reg.fees.lines.map((l) => `${l.label}: $${l.amountUsd}`),
        `Reason: ${a.reason}`,
      ],
      clientId: c.id,
    };
  },
  async apply(ctx, args) {
    const a = SubmitArgs.parse(args);
    const c = servedClient(ctx, a.client);
    // The details may have changed since the card: checked again before Twilio is asked.
    await registrationFor(ctx, a.client);
    const out = await route(ctx, routes.opsA2pSubmit, {
      params: { id: a.client },
      body: { reason: a.reason, confirmFees: true },
    });
    const stage = out.setup.twilio?.registration?.stage ?? "submitted";
    return {
      outcome: `Submitted ${c.name}'s US texting registration (now: ${stage}).`,
      result: { stage },
    };
  },
};

const AgentAddArgs = z.strictObject({
  client: ClientId,
  templateId: Id.describe("From templates_list"),
  serviceName: z.string().trim().max(200).optional().describe("What the client calls it"),
});

const agentAdd: ChangeTool = {
  kind: "change",
  name: "agent_add",
  description:
    "Propose giving a client its own agent made from a template (its live version). The agent starts with approval on for every write. Nothing happens until the operator confirms.",
  input: AgentAddArgs,
  async preview(ctx, args) {
    const a = AgentAddArgs.parse(args);
    const c = servedClient(ctx, a.client);
    const out = await route(ctx, routes.opsTemplates, { query: {} });
    const t = out.templates.find((x) => x.id === a.templateId);
    if (!t) throw new HttpError(404, "not_found", "no such template");
    return {
      title: `Give ${c.name} the ${t.name}`,
      lines: [
        `${c.name} gets its own agent from the ${t.name} template's live version.`,
        ...(a.serviceName ? [`Called: ${a.serviceName}`] : []),
        "Every write starts with approval on.",
      ],
      clientId: c.id,
    };
  },
  async apply(ctx, args) {
    const a = AgentAddArgs.parse(args);
    const c = servedClient(ctx, a.client);
    const out = await route(ctx, routes.opsFork, {
      params: { id: a.templateId },
      body: { clientId: a.client, ...(a.serviceName ? { serviceName: a.serviceName } : {}) },
    });
    return {
      outcome: `${c.name} has its own ${out.agent.name}.`,
      result: { agentId: out.agent.id },
    };
  },
};

const InviteArgs = z.strictObject({
  client: ClientId,
  people: z.array(Id).min(1).max(50).describe("Contact ids, from people_list"),
});

const textingInvitationsSend: ChangeTool = {
  kind: "change",
  name: "texting_invitations_send",
  description:
    "Propose emailing a client's people an invitation, in the client's name, to sign up for texts (§1.98): one invitation and at most one reminder each; texting starts only if they sign up. Nothing is sent until the operator confirms.",
  input: InviteArgs,
  async preview(ctx, args) {
    const a = InviteArgs.parse(args);
    const c = servedClient(ctx, a.client);
    const out = await route(ctx, routes.opsContacts, { params: { id: a.client } });
    const byId = new Map(out.items.map((p) => [p.id, p]));
    const names = a.people.map((id) => byId.get(id)?.name ?? "someone not at this client");
    return {
      title: `Invite ${a.people.length === 1 ? names[0] : `${a.people.length} people`} to texts`,
      lines: [
        `An email from ${c.name} via Mezonas inviting each to sign up for texts:`,
        names.join(", "),
        "Anyone opted out, already signed up, who said no, without an email, or asked recently is left out.",
      ],
      clientId: c.id,
    };
  },
  async apply(ctx, args) {
    const a = InviteArgs.parse(args);
    const c = servedClient(ctx, a.client);
    const out = await route(ctx, routes.opsTextInvitations, {
      params: { id: a.client },
      body: { contactIds: a.people },
    });
    return {
      outcome: `Invited ${out.sent.length} at ${c.name}${out.skipped.length ? `; ${out.skipped.length} left out` : ""}.`,
      result: out,
    };
  },
};

export const REGGIE_TOOLS: readonly ReggieTool[] = [
  ...mcpReads,
  clientReview,
  textingGet,
  leadMessages,
  leadRequestsGet,
  templatesList,
  peopleList,
  textingNumbersAvailable,
  textingSignupLinkGet,
  textingRegistrationCheck,
  leadMessagePost,
  leadRequestCreate,
  clientCreate,
  textingSetup,
  textingNumberBuy,
  textingRegistrationRequest,
  textingRegistrationSubmit,
  agentAdd,
  textingInvitationsSend,
];

export function reggieTool(name: string): ReggieTool | undefined {
  return REGGIE_TOOLS.find((t) => t.name === name);
}
