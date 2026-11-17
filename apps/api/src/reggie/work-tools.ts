// Reggie's tools for the back office's work (docs/plan.md §1.123.4; docs/cases-plan.md §5, A1):
// Build's issues, asks, enhancements and builds, Sales' deals and the safety holds. As every Reggie
// tool (§1.101): reads run the back office's own routes as the signed-in operator, scoped to the
// clients they serve and fenced as untrusted data; a change only proposes a card, and only the
// operator's confirm runs it, once.
//
// Never a tool, not even as a card (core REGGIE_NEVER_A_TOOL): releasing a hold, rolling an agent
// back, moving a promised date, prices and terms. A test checks none of them is here. Placing a
// hold is a card: it only makes things safer, but a person still confirms it here.

import {
  routes,
  UpdateIssue,
  WorkCauseKind,
  WorkEnhancementDecision,
  WorkIssueStage,
  WorkUrgency,
} from "@countersign/core";
import { z } from "zod";
import { HttpError, invokeRoute, type RouteInput } from "../http";
import { clip, dataResult } from "../mcp/output";
import type { Content, ToolResult } from "../mcp/protocol";
import type { ChangeTool, ReadTool, ReggieTool, ReggieToolCtx } from "./tools";

const Id = z.string().uuid().describe("A Mezonas id (uuid)");
const ClientId = Id.describe("The client's id (uuid), from clients_list");

function route<R extends Parameters<typeof invokeRoute>[3]>(
  ctx: ReggieToolCtx,
  spec: R,
  raw: RouteInput = {},
) {
  return invokeRoute(ctx.app, ctx.c, ctx.session, spec, raw, "reggie");
}

function text(result: ToolResult): string {
  return result.content
    .filter((c): c is Extract<Content, { type: "text" }> => c.type === "text")
    .map((c) => c.text)
    .join("\n\n");
}

/** A client this operator serves, by id, with its name; refused otherwise (ids from a model). */
function served(ctx: ReggieToolCtx, clientId: string): { id: string; name: string } {
  if (!ctx.session.servedTenantIds.includes(clientId)) {
    throw new HttpError(404, "not_found", "no such client among those you serve");
  }
  const name =
    ctx.session.memberships.find((m) => m.tenantId === clientId)?.tenantName ?? "the client";
  return { id: clientId, name };
}

const read = (
  name: string,
  description: string,
  input: z.ZodObject,
  run: (ctx: ReggieToolCtx, args: never) => Promise<{ summary: string; value: unknown }>,
): ReadTool => ({
  kind: "read",
  name,
  description,
  input,
  async run(ctx, args) {
    const out = await run(ctx, input.parse(args) as never);
    return text(dataResult(name, out.summary, clip(out.value, 16_000)));
  },
});

// ── Reads ────────────────────────────────────────────────────────────────────────────────────────

const WorkListArgs = z.strictObject({
  tab: z.enum(["all", "issues", "builds", "enh"]).default("all"),
  client: ClientId.optional(),
});

const workList = read(
  "work_list",
  "Build's work in its order: open issues (with urgency), agent builds (promised dates) and enhancements, each with why it is where it is, and the safety holds in force.",
  WorkListArgs,
  async (ctx, a: z.infer<typeof WorkListArgs>) => {
    if (a.client) served(ctx, a.client);
    const out = await route(ctx, routes.opsWork, {
      query: { tab: a.tab, ...(a.client ? { client: a.client } : {}) },
    });
    return {
      summary: `${out.items.length} items of work.`,
      value: { items: out.items, holds: out.holds },
    };
  },
);

const IdArgs = z.strictObject({ id: Id });

const issueGet = read(
  "issue_get",
  "One issue: its client, agent, urgency, stage, targets, the conversation (internal notes included), its history, to-dos and any hold.",
  IdArgs,
  async (ctx, a: z.infer<typeof IdArgs>) => {
    const out = await route(ctx, routes.opsIssue, { params: { id: a.id } });
    return { summary: `Issue #${out.issue.number} at ${out.issue.client.name}.`, value: out };
  },
);

const DealsArgs = z.strictObject({
  tab: z.enum(["all", "new", "grow"]).default("all"),
  client: ClientId.optional(),
});

const dealsList = read(
  "deals_list",
  "Sales' deals: new accounts and expansion, with stage, value a month, where each stands and its next step.",
  DealsArgs,
  async (ctx, a: z.infer<typeof DealsArgs>) => {
    if (a.client) served(ctx, a.client);
    const out = await route(ctx, routes.opsDeals, {
      query: { tab: a.tab, ...(a.client ? { client: a.client } : {}) },
    });
    return { summary: `${out.deals.length} deals.`, value: out };
  },
);

const dealGet = read(
  "deal_get",
  "One deal: its people, value, terms, activity (emails, notes, calls) and the builds it opened.",
  IdArgs,
  async (ctx, a: z.infer<typeof IdArgs>) => {
    const out = await route(ctx, routes.opsDeal, { params: { id: a.id } });
    return { summary: `The deal "${out.deal.title}".`, value: out };
  },
);

const enhancementGet = read(
  "enhancement_get",
  "One enhancement: what it is, its decision, and each client's ask grouped under it (in their words).",
  IdArgs,
  async (ctx, a: z.infer<typeof IdArgs>) => {
    const out = await route(ctx, routes.opsEnhancement, { params: { id: a.id } });
    return { summary: `The enhancement "${out.enhancement.title}".`, value: out };
  },
);

const holdsList = read(
  "holds_list",
  "Client agents on a safety hold now, since when and by whom, and how many writes and messages wait.",
  z.strictObject({}),
  async (ctx) => {
    const out = await route(ctx, routes.opsHolds, {});
    return { summary: `${out.holds.length} agents on a safety hold.`, value: out.holds };
  },
);

// ── Changes: cards the operator confirms ─────────────────────────────────────────────────────────

const change = <S extends z.ZodObject>(
  name: string,
  description: string,
  input: S,
  preview: (
    ctx: ReggieToolCtx,
    a: z.infer<S>,
  ) => Promise<{ title: string; lines: string[]; clientId: string | null }>,
  apply: (ctx: ReggieToolCtx, a: z.infer<S>) => Promise<{ outcome: string; result: unknown }>,
): ChangeTool => ({
  kind: "change",
  name,
  description,
  input,
  preview: (ctx, args) => preview(ctx, input.parse(args)),
  apply: (ctx, args) => apply(ctx, input.parse(args)),
});

const IssueCreateArgs = z.strictObject({
  client: ClientId,
  title: z.string().trim().min(1).max(200),
  text: z.string().trim().max(4000).default(""),
  urgency: WorkUrgency.optional(),
  agentId: Id.optional().describe("The client's agent it is about"),
});

const issueCreate = change(
  "issue_create",
  "Propose opening an issue for a client (something isn't working). A critical one about an agent puts that agent on a safety hold. Nothing happens until the operator confirms.",
  IssueCreateArgs,
  async (ctx, a) => {
    const c = served(ctx, a.client);
    return {
      title: `Open an issue for ${c.name}`,
      lines: [a.title, ...(a.text ? [a.text] : []), `Urgency: ${a.urgency ?? "normal"}`],
      clientId: c.id,
    };
  },
  async (ctx, a) => {
    const c = served(ctx, a.client);
    const out = await route(ctx, routes.opsCreateIssue, {
      body: {
        clientId: a.client,
        title: a.title,
        text: a.text,
        ...(a.urgency ? { urgency: a.urgency } : {}),
        ...(a.agentId ? { agentId: a.agentId } : {}),
      },
    });
    return {
      outcome: `Opened issue #${out.issue.number} for ${c.name}.`,
      result: { issueId: out.issue.id },
    };
  },
);

// Urgency, stage and cause only: no promised dates (fixBy), no titles on the client's words.
const IssueUpdateArgs = z.strictObject({
  id: Id,
  urgency: WorkUrgency.optional(),
  stage: WorkIssueStage.exclude(["closed"]).optional(),
  causeKind: WorkCauseKind.nullable().optional(),
  reason: z.string().trim().min(1).max(500).describe("Why, kept on the issue's history"),
});

const issueUpdate = change(
  "issue_update",
  "Propose changing an issue's urgency, stage or cause, with the reason. Raising it to critical holds its agent. Nothing happens until the operator confirms.",
  IssueUpdateArgs,
  async (ctx, a) => {
    const out = await route(ctx, routes.opsIssue, { params: { id: a.id } });
    const i = out.issue;
    return {
      title: `Change issue #${i.number} at ${i.client.name}`,
      lines: [
        ...(a.urgency ? [`Urgency: ${i.urgency} → ${a.urgency}`] : []),
        ...(a.stage ? [`Stage: ${i.stage} → ${a.stage}`] : []),
        ...(a.causeKind !== undefined
          ? [`Cause: ${i.causeKind ?? "none"} → ${a.causeKind ?? "none"}`]
          : []),
        `Why: ${a.reason}`,
      ],
      clientId: i.client.id,
    };
  },
  async (ctx, a) => {
    const { id, ...body } = a;
    const out = await route(ctx, routes.opsUpdateIssue, {
      params: { id },
      body: UpdateIssue.parse(body),
    });
    return { outcome: `Changed issue #${out.issue.number}.`, result: { issueId: out.issue.id } };
  },
);

const IssueReplyArgs = z.strictObject({
  id: Id,
  text: z
    .string()
    .trim()
    .min(1)
    .max(4000)
    .describe("What the client reads, from their Mezonas lead"),
});

const issueReply = change(
  "issue_reply",
  "Propose a reply to the client on an issue, posted as the operator (their Mezonas lead); emailed too when the issue came by email. Nothing is sent until the operator confirms.",
  IssueReplyArgs,
  async (ctx, a) => {
    const out = await route(ctx, routes.opsIssue, { params: { id: a.id } });
    return {
      title: `Reply on ${out.issue.client.name} #${out.issue.number}`,
      lines: [`To ${out.issue.client.name}, as you:`, a.text],
      clientId: out.issue.client.id,
    };
  },
  async (ctx, a) => {
    const out = await route(ctx, routes.opsIssueMessage, {
      params: { id: a.id },
      body: { text: a.text, audience: "client" },
    });
    return { outcome: `Replied on #${out.issue.number}.`, result: { issueId: out.issue.id } };
  },
);

const AskGroupArgs = z
  .strictObject({
    askId: Id,
    enhancementId: Id.optional(),
    newEnhancement: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .optional()
      .describe("A new enhancement's title"),
  })
  .refine((a) => !!a.enhancementId !== !!a.newEnhancement, { message: "name one" });

const askGroup: ChangeTool = {
  kind: "change",
  name: "ask_group",
  description:
    "Propose grouping a client's ask under an enhancement (an existing one, or a new one by title), so the same ask from several clients is decided once. Nothing happens until the operator confirms.",
  input: AskGroupArgs as unknown as z.ZodObject,
  async preview(_ctx, args) {
    const a = AskGroupArgs.parse(args);
    return {
      title: "Group an ask",
      lines: [
        a.newEnhancement
          ? `Under a new enhancement: ${a.newEnhancement}`
          : "Under an existing enhancement.",
      ],
      clientId: null,
    };
  },
  async apply(ctx, args) {
    const a = AskGroupArgs.parse(args);
    const out = await route(ctx, routes.opsGroupAsk, {
      params: { id: a.askId },
      body: a.enhancementId
        ? { enhancementId: a.enhancementId }
        : { newEnhancement: { title: a.newEnhancement as string } },
    });
    return {
      outcome: `Grouped under "${out.enhancement.title}".`,
      result: { enhancementId: out.enhancement.id },
    };
  },
};

const DecideArgs = z.strictObject({
  id: Id,
  decision: WorkEnhancementDecision,
  note: z.string().trim().min(1).max(2000).describe("Why, in a line the clients can read"),
});

const enhancementDecideDraft = change(
  "enhancement_decide_draft",
  "Draft a decision on an enhancement (do it, later, no or sell it) for the operator: deciding is theirs, so this only shows as a card they confirm or turn down.",
  DecideArgs,
  async (ctx, a) => {
    const out = await route(ctx, routes.opsEnhancement, { params: { id: a.id } });
    return {
      title: `Decide "${out.enhancement.title}": ${a.decision}`,
      lines: [`${out.enhancement.asks} clients asked.`, a.note],
      clientId: null,
    };
  },
  async (ctx, a) => {
    const out = await route(ctx, routes.opsDecideEnhancement, {
      params: { id: a.id },
      body: { decision: a.decision, note: a.note },
    });
    return {
      outcome: `Decided "${out.enhancement.title}": ${a.decision}.`,
      result: { enhancementId: a.id },
    };
  },
);

const DealCreateArgs = z.strictObject({
  kind: z.enum(["new", "expansion"]),
  client: ClientId.optional(),
  company: z.string().trim().min(1).max(200).optional(),
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).optional(),
  personName: z.string().trim().min(1).max(200).optional(),
  personEmail: z.string().trim().email().max(320).optional(),
  nextStep: z.string().trim().max(300).optional(),
});

// DECISION: Reggie's deals start at no value (mrr 0): prices and terms are the operator's
// (docs/cases-plan.md §5), entered on the deal's page.
const dealCreate = change(
  "deal_create",
  "Propose opening a deal: a new account (a company, not yet a client) or expansion for a client. Its value and terms are the operator's to enter. Nothing happens until the operator confirms.",
  DealCreateArgs,
  async (ctx, a) => {
    const c = a.client ? served(ctx, a.client) : null;
    return {
      title: `Open a deal: ${a.title}`,
      lines: [
        c ? `For ${c.name} (${a.kind}).` : `With ${a.company ?? "a company"} (new account).`,
        ...(a.description ? [a.description] : []),
        ...(a.personName
          ? [`Person: ${a.personName}${a.personEmail ? ` <${a.personEmail}>` : ""}`]
          : []),
      ],
      clientId: c?.id ?? null,
    };
  },
  async (ctx, a) => {
    if (a.client) served(ctx, a.client);
    const out = await route(ctx, routes.opsCreateDeal, {
      body: {
        kind: a.kind,
        ...(a.client ? { clientId: a.client } : {}),
        ...(a.company ? { company: a.company } : {}),
        title: a.title,
        ...(a.description ? { description: a.description } : {}),
        mrr: "0",
        source: "reggie",
        ...(a.personName
          ? {
              people: [
                {
                  name: a.personName,
                  ...(a.personEmail ? { email: a.personEmail } : {}),
                  isPrimary: true,
                },
              ],
            }
          : {}),
        ...(a.nextStep ? { nextStep: a.nextStep } : {}),
      },
    });
    return { outcome: `Opened the deal "${out.deal.title}".`, result: { dealId: out.deal.id } };
  },
);

// No prices, value or terms: those are always the operator's.
const DealUpdateArgs = z.strictObject({
  id: Id,
  stage: z.string().trim().min(1).max(40).optional(),
  nextStep: z.string().trim().max(300).optional(),
  statusLine: z.string().trim().max(120).optional(),
  waitingOn: z.enum(["operator", "reggie", "client"]).optional(),
  reason: z.string().trim().min(1).max(500).optional(),
});

const dealUpdate = change(
  "deal_update",
  "Propose moving a deal's stage or changing its next step and where it stands (never its value, prices or terms). Nothing happens until the operator confirms.",
  DealUpdateArgs,
  async (ctx, a) => {
    const out = await route(ctx, routes.opsDeal, { params: { id: a.id } });
    return {
      title: `Change the deal "${out.deal.title}"`,
      lines: [
        ...(a.stage ? [`Stage: ${out.deal.stage} → ${a.stage}`] : []),
        ...(a.nextStep !== undefined ? [`Next step: ${a.nextStep}`] : []),
        ...(a.statusLine !== undefined ? [`Where it stands: ${a.statusLine}`] : []),
        ...(a.reason ? [`Why: ${a.reason}`] : []),
      ],
      clientId: out.deal.client?.id ?? null,
    };
  },
  async (ctx, a) => {
    const { id, ...body } = a;
    const out = await route(ctx, routes.opsUpdateDeal, { params: { id }, body: body as never });
    return { outcome: `Changed the deal "${out.deal.title}".`, result: { dealId: id } };
  },
);

const AgentToBuild = z.strictObject({
  name: z.string().trim().min(1).max(200),
  templateId: Id.nullable(),
});

const DealSetupArgs = z.strictObject({
  id: Id,
  name: z.string().trim().min(1).max(200).describe("The client business's name"),
  timezone: z.string().trim().max(64).optional(),
  adminEmail: z.string().trim().email().max(320).optional(),
  adminName: z.string().trim().max(200).optional(),
  agents: z.array(AgentToBuild).min(1).max(20),
});

const dealSetup = change(
  "deal_setup",
  "Propose setting up a won deal's account: create the client (creating a client is always the operator's), invite its admin and open a build per agent sold. Nothing happens until the operator confirms.",
  DealSetupArgs,
  async (_ctx, a) => ({
    title: `Set up ${a.name}`,
    lines: [
      "Create the client, served by you.",
      a.adminEmail
        ? `Invite ${a.adminName ?? a.adminEmail} as its admin.`
        : "No admin invited yet.",
      `Open ${a.agents.length} build${a.agents.length === 1 ? "" : "s"}: ${a.agents.map((x) => x.name).join(", ")}.`,
    ],
    clientId: null,
  }),
  async (ctx, a) => {
    const { id, ...body } = a;
    const out = await route(ctx, routes.opsDealSetup, { params: { id }, body });
    return { outcome: `Set up ${a.name} and opened ${out.buildIds.length} builds.`, result: out };
  },
);

const BuildOpenArgs = z.strictObject({
  client: ClientId,
  title: z.string().trim().min(1).max(200),
  templateId: Id.optional().describe("From templates_list; without one, a new agent"),
  originKind: z.enum(["deal", "ask", "enhancement", "issue"]).optional(),
  originId: Id.optional(),
});

const buildOpen = change(
  "build_open",
  "Propose opening an agent build for a client, from a template or new, linked to what started it. The promised date is the operator's to set. Nothing happens until the operator confirms.",
  BuildOpenArgs,
  async (ctx, a) => {
    const c = served(ctx, a.client);
    return {
      title: `Open a build for ${c.name}: ${a.title}`,
      lines: [a.templateId ? "From a template." : "A new agent, with the Builder."],
      clientId: c.id,
    };
  },
  async (ctx, a) => {
    const c = served(ctx, a.client);
    const out = await route(ctx, routes.opsStartBuild, {
      body: {
        kind: "agent",
        title: a.title,
        clientId: a.client,
        ...(a.templateId ? { path: "template", templateId: a.templateId } : { path: "new" }),
        ...(a.originKind && a.originId ? { origin: { kind: a.originKind, id: a.originId } } : {}),
      },
    });
    return { outcome: `Opened a build for ${c.name}.`, result: { buildId: out.build.id } };
  },
);

const RequirementsArgs = z.strictObject({
  buildId: Id,
  dueOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  toUserId: Id.describe("The client admin who answers it"),
});

const requirementsSend = change(
  "requirements_send",
  "Propose sending a build's requirements request (the template's intake questions, pre-filled) to the client admin's Desk. Nothing is sent until the operator confirms.",
  RequirementsArgs,
  async (_ctx, a) => ({
    title: "Send the requirements request",
    lines: [`Answers due ${a.dueOn}.`],
    clientId: null,
  }),
  async (ctx, a) => {
    const out = await route(ctx, routes.opsSendRequirements, {
      params: { id: a.buildId },
      body: { dueOn: a.dueOn, toUserId: a.toUserId },
    });
    return { outcome: "Sent the requirements request.", result: out };
  },
);

const HoldArgs = z.strictObject({
  agentId: Id,
  issueId: Id,
  reason: z.string().trim().min(3).max(500),
});

const holdPlace = change(
  "hold_place",
  "Propose putting a client's agent on a safety hold for an issue: its writes and messages stop and wait; its runs go on as drafts. Only the operator releases a hold, on their own screen. Nothing happens until the operator confirms.",
  HoldArgs,
  async (ctx, a) => {
    const out = await route(ctx, routes.opsIssue, { params: { id: a.issueId } });
    return {
      title: `Hold ${out.issue.agent?.name ?? "the agent"} at ${out.issue.client.name}`,
      lines: [`For issue #${out.issue.number}: ${out.issue.title}`, a.reason],
      clientId: out.issue.client.id,
    };
  },
  async (ctx, a) => {
    const out = await route(ctx, routes.opsHoldAgent, {
      params: { id: a.agentId },
      body: { issueId: a.issueId, reason: a.reason },
    });
    return { outcome: `Held ${out.agent.name}.`, result: { agentId: a.agentId } };
  },
);

export const WORK_TOOLS: readonly ReggieTool[] = [
  workList,
  issueGet,
  dealsList,
  dealGet,
  enhancementGet,
  holdsList,
  issueCreate,
  issueUpdate,
  issueReply,
  askGroup,
  enhancementDecideDraft,
  dealCreate,
  dealUpdate,
  dealSetup,
  buildOpen,
  requirementsSend,
  holdPlace,
];
