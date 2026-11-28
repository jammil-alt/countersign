// v0.12 W2-E: the triggers list (ARCHITECTURE §10.8, §14; docs/plan.md §1.48). The operator's, for a
// client agent of a client they serve (inside withOperator).

import { getAgent } from "@countersign/agents";
import {
  type AgentTriggers,
  normalizeSignupPhone,
  type PortalTrigger,
  routes,
  type TestMessageAnswer,
  uuidv7,
} from "@countersign/core";
import { contact, document, run } from "@countersign/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Hono } from "hono";
import { ensureSeesAgent } from "../assigned";
import { type AppEnv, HttpError, mount, mountLong, notFound } from "../http";
import { dispatchEvents } from "../runs/dispatch";
import { addSandboxPerson } from "../sandbox/sample-company";
import { isSandboxClient } from "../sandbox/sandbox";
import { setInboundName } from "../triggers/inbound-name";
import { agentTriggers } from "../triggers/list";
import { receiveTestMessage } from "../triggers/test-message";

/**
 * A typed sender's address as the directory keeps it: an email lower case (named by the part
 * before the @), or a phone number in E.164 (named by itself); 422 when it is neither.
 */
export function senderAddress(raw: string): {
  name: string;
  email: string | null;
  phone: string | null;
} {
  const v = raw.trim();
  if (v.includes("@")) {
    const email = v.toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new HttpError(422, "invalid_email", "That isn't an email address");
    }
    // DECISION: a typed sender is named from their address ("sam.lee@" is Sam Lee); the operator
    // can rename them in the Sandbox's directory.
    const local = email.slice(0, email.indexOf("@"));
    const name = local
      .split(/[._\-+]+/)
      .filter(Boolean)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ");
    return { name: name || email, email, phone: null };
  }
  const phone = normalizeSignupPhone(v);
  if (!phone) {
    throw new HttpError(
      422,
      "invalid_phone",
      "Give an email address, or a phone number in international form (+15551234567) or as a 10-digit US number",
    );
  }
  return { name: phone, email: null, phone };
}

/** 422 `not_sandbox`: what is only for the Sandbox client. */
const notSandbox = (what: string) =>
  new HttpError(422, "not_sandbox", `${what} only in the Sandbox`);

export function triggerRouteHandlers(app: Hono<AppEnv>): void {
  // Sandbox inbound (2026-11-27): the first part of a Sandbox agent's address.
  // DECISION: Sandbox only, as the task's default: a real client's address (and its `/name`) is
  // printed on their forms and in their people's address books, so it is never renamed from here.
  mount(app, routes.opsAgentAddress, async (ctx) => {
    const row = await getAgent(ctx.tx, ctx.params.id).catch(() => {
      throw notFound("agent");
    });
    if (row.tenantId === null || !ctx.tenantIds.includes(row.tenantId)) throw notFound("agent");
    if (row.kind !== "client" || row.testCopy) {
      throw new HttpError(422, "not_a_client_agent", "only a client agent has an address");
    }
    if (!(await isSandboxClient(ctx.tx, row.tenantId))) throw notSandbox("an address is named");
    return setInboundName(ctx.tx, {
      agentId: row.id,
      name: ctx.body.name,
      actorId: ctx.session.user.id,
      domain: ctx.services.env.EMAIL_FORWARDING_DOMAIN,
      now: new Date(),
    });
  });

  // Sandbox inbound (2026-11-27): a test message, routed as a received one, then dispatched here
  // (not after the response) so the answer can name the run it started.
  mountLong(app, routes.opsSandboxTestMessage, async (ctx) => {
    const { body, services } = ctx;
    const now = new Date();
    const out = await ctx.inTx(async ({ tx }) => {
      const row = await getAgent(tx, body.agentId).catch(() => {
        throw notFound("agent");
      });
      if (row.tenantId === null || !ctx.tenantIds.includes(row.tenantId)) throw notFound("agent");
      const tenantId = row.tenantId;
      if (!(await isSandboxClient(tx, tenantId))) throw notSandbox("test messages go");
      const [from] = await tx
        .select()
        .from(contact)
        .where(and(eq(contact.tenantId, tenantId), eq(contact.id, body.fromContactId)));
      if (!from) throw new HttpError(422, "invalid_contact", "not one of the Sandbox's contacts");
      const documents = [...new Set(body.documentIds ?? [])];
      if (documents.length > 0) {
        const found = await tx
          .select({ id: document.id })
          .from(document)
          .where(and(eq(document.tenantId, tenantId), inArray(document.id, documents)));
        if (found.length !== documents.length) {
          throw new HttpError(422, "invalid_documents", "not all of these are the Sandbox's files");
        }
      }
      if (body.text.trim() === "" && documents.length === 0) {
        throw new HttpError(422, "empty_message", "write the message or attach a file");
      }
      const outcome = await receiveTestMessage(
        tx,
        { registry: services.platform.events },
        {
          tenantId,
          agentId: row.id,
          channel: body.channel,
          contact: from,
          subject: body.subject ?? null,
          text: body.text,
          documents,
          by: ctx.session.user.id,
          now,
        },
      );
      return { ...outcome, tenantId };
    });
    if (out.events.length > 0) {
      await dispatchEvents({ db: services.db, instances: services.instances }, out.events);
    }
    const answer = out.answer;
    if (answer.status !== "accepted") return answer;
    const [started] = await ctx.inTx(({ tx }) =>
      tx
        .select({ id: run.id })
        .from(run)
        .where(
          and(
            eq(run.tenantId, out.tenantId),
            eq(run.agentId, body.agentId),
            sql`${run.trigger}->'payload'->>'rawRecordId' = ${answer.rawRecordId}`,
          ),
        )
        .limit(1),
    );
    return started
      ? ({
          status: "started",
          runId: started.id,
          rawRecordId: answer.rawRecordId,
          reply: answer.reply,
        } satisfies TestMessageAnswer)
      : answer;
  });

  // Try it's From (2026-11-27): someone typed in as who a test message is from, added to the
  // Sandbox's directory with what the trigger takes, so it takes them.
  // DECISION: a contact found by the address keeps a relationship it has (a vendor's rep stays
  // one, and the trigger may refuse them, as it would a real one); one with none is given the
  // trigger's. The labels the trigger takes are added either way. No organization.
  mount(app, routes.opsSandboxSender, async (ctx) => {
    const { body } = ctx;
    if (!ctx.tenantIds.includes(body.clientId)) throw notFound("client");
    if (!(await isSandboxClient(ctx.tx, body.clientId))) throw notSandbox("people are added here");
    const person = senderAddress(body.address);
    const userId = ctx.session.user.id;
    const out = await addSandboxPerson(ctx.tx, {
      tenantId: body.clientId,
      userId,
      person,
      relationship: body.relationship ?? null,
      tags: body.tags ?? [],
      organizationId: null,
      id: uuidv7(),
      now: new Date(),
      entry: {
        title: null,
        roles: [],
        notes: "Added in Try it, as who a test message is from.",
      },
      conflict: (email, phone) =>
        `That email is ${email}'s and that number is ${phone}'s in the Sandbox's directory.`,
      mark: { via: "try" },
    });
    const [c] = await ctx.tx
      .select({ name: contact.name, email: contact.email, phone: contact.phone })
      .from(contact)
      .where(and(eq(contact.tenantId, body.clientId), eq(contact.id, out.id)));
    if (!c) throw notFound("contact");
    return {
      contactId: out.id,
      name: c.name,
      email: c.email,
      phone: c.phone,
      created: out.created,
    };
  });

  mount(app, routes.opsAgentTriggers, async (ctx) => {
    const row = await getAgent(ctx.tx, ctx.params.id);
    if (row.tenantId === null || !ctx.tenantIds.includes(row.tenantId)) throw notFound("agent");
    if (row.kind !== "client") throw new HttpError(422, "not_a_client_agent", "not a client agent");
    return agentTriggers(
      ctx.tx,
      { id: row.id, tenantId: row.tenantId, liveVersionId: row.liveVersionId },
      ctx.services.env.EMAIL_FORWARDING_DOMAIN,
    );
  });
}

/**
 * The portal's view of an agent's triggers (Agent settings): the operator's list cut to plain facts
 * for the enabled jobs of the client's own agent. Its run filters, dedupe keys, hooks and people
 * filters stay the operator's (invariant 11).
 */
export function portalTriggerRoutes(app: Hono<AppEnv>): void {
  mount(app, routes.portalAgentTriggers, async (ctx) => {
    const tenantId = ctx.tenantIds[0] as string;
    // §1.122: an agent off a limited client user's list is "not found".
    ensureSeesAgent(ctx.agents, ctx.params.id);
    const row = await getAgent(ctx.tx, ctx.params.id).catch(() => null);
    if (!row || row.tenantId !== tenantId || row.kind !== "client" || row.testCopy) {
      throw notFound("service");
    }
    const list = await agentTriggers(
      ctx.tx,
      { id: row.id, tenantId, liveVersionId: row.liveVersionId },
      ctx.services.env.EMAIL_FORWARDING_DOMAIN,
    );
    return {
      commandName: list.commandName,
      triggers: list.triggers.filter((t) => t.enabled).map(portalTrigger),
    };
  });
}

function portalTrigger(t: AgentTriggers["triggers"][number]): PortalTrigger {
  const g = t.guards;
  const str = (v: unknown) => (typeof v === "string" ? v : null);
  const client = g.client as { canRun?: unknown } | undefined;
  return {
    job: t.workflowName,
    type: t.type as PortalTrigger["type"],
    event: t.type === "event" ? str(g.event) : null,
    cron: t.type === "schedule" ? str(g.cron) : null,
    tz: t.type === "schedule" ? str(g.tz) : null,
    skipsHolidays: t.type === "schedule" && g.skipHolidays === true,
    clientCanRun: t.type === "manual" && client?.canRun === true,
    channels:
      t.type === "message" && Array.isArray(g.channels)
        ? g.channels.filter((c): c is string => typeof c === "string")
        : [],
    // A test run is never the client's: when its latest start was a test, none is shown.
    lastStartedAt: t.lastFired && t.lastFired.mode !== "test" ? t.lastFired.at : null,
  };
}
