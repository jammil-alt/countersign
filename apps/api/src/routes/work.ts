// Build in the back office (docs/plan.md §1.123.1; docs/cases-plan.md §3.2): the work list in the
// work order, issues and their conversation, the safety hold, asks and enhancements, and a build's
// requirements request. Operator only; each route runs over the clients the operator serves.

import { issueTargets, type RequirementField, routes } from "@countersign/core";
import {
  agent,
  appUser,
  build,
  clientAsk,
  enhancement,
  inboxItem,
  issue,
  membership,
  type Tx,
  tenant,
} from "@countersign/db";
import { and, eq, inArray } from "drizzle-orm";
import type { Hono } from "hono";
import { auditInTx } from "../audit";
import { clientBusinessHours } from "../hours/hours";
import { type AppEnv, auditActor, ensureClient, HttpError, mount, notFound } from "../http";
import {
  askViews,
  createAsk,
  declineAsks,
  enhancementDetail,
  groupAsk,
  readAsk,
  readEnhancement,
  tellAsks,
} from "../work/asks";
import { holdViews, placeHold, releaseHold } from "../work/holds";
import {
  addIssueEvent,
  closeIssue,
  convertToAsk,
  createIssue,
  issueDetail,
  operatorMessage,
  readIssue,
  reopenIssue,
} from "../work/issues";
import { addTodo } from "../work/todos-store";
import { workList } from "../work/work-list";

async function hoursOf(tx: Tx, tenantId: string) {
  const [t] = await tx
    .select({ timezone: tenant.timezone, settings: tenant.settings })
    .from(tenant)
    .where(eq(tenant.id, tenantId));
  return clientBusinessHours(t ?? { timezone: "UTC", settings: {} }).hours;
}

export function workRouteHandlers(app: Hono<AppEnv>): void {
  mount(app, routes.opsWork, async ({ tx, tenantIds, query }) => {
    if (query.client) ensureClient({ tenantIds }, query.client);
    return workList(tx, tenantIds, { tab: query.tab, client: query.client });
  });

  mount(app, routes.opsHolds, async ({ tx, tenantIds }) => ({
    holds: await holdViews(tx, tenantIds),
  }));

  // ── Issues ─────────────────────────────────────────────────────────────────────────────────────
  mount(app, routes.opsCreateIssue, async ({ tx, tenantIds, session, body }) => {
    ensureClient({ tenantIds }, body.clientId);
    const row = await createIssue(tx, {
      tenantId: body.clientId,
      title: body.title,
      description: body.text,
      urgency: body.urgency,
      agentId: body.agentId ?? null,
      source: "ops",
      actor: "operator",
      userId: session.user.id,
    });
    return issueDetail(tx, row);
  });

  mount(app, routes.opsIssue, async ({ tx, tenantIds, params }) =>
    issueDetail(tx, await readIssue(tx, tenantIds, params.id)),
  );

  mount(app, routes.opsUpdateIssue, async ({ tx, tenantIds, params, body, session }) => {
    const row = await readIssue(tx, tenantIds, params.id, true);
    if (row.stage === "closed") throw new HttpError(409, "closed", "reopen the issue first");
    const userId = session.user.id;
    const set: Partial<typeof issue.$inferInsert> = {};
    const ev = (
      kind: Parameters<typeof addIssueEvent>[2]["kind"],
      from: string | null,
      to: string | null,
    ) =>
      addIssueEvent(tx, row, {
        kind,
        from,
        to,
        reason: body.reason ?? null,
        actor: "operator",
        userId,
      });
    if (body.title && body.title !== row.title) set.title = body.title;
    if (body.stage && body.stage !== row.stage) {
      set.stage = body.stage;
      set.stageAt = new Date();
      // At Verify the client is asked to confirm the fix: it waits on them.
      if (body.stage === "verify") set.waitingOn = "client";
      await ev("stage", row.stage, body.stage);
    }
    if (body.urgency && body.urgency !== row.urgency) {
      if (!body.reason) throw new HttpError(422, "reason_required", "say why the urgency changes");
      const t = issueTargets(body.urgency, row.createdAt, await hoursOf(tx, row.tenantId));
      set.urgency = body.urgency;
      set.replyBy = t.replyBy;
      set.fixBy = t.fixBy;
      await ev("urgency", row.urgency, body.urgency);
    }
    if (body.causeKind !== undefined && body.causeKind !== row.causeKind) {
      set.causeKind = body.causeKind;
      await ev("cause", row.causeKind ?? null, body.causeKind);
    }
    if (body.agentId !== undefined && body.agentId !== row.agentId) {
      if (body.agentId) {
        const [a] = await tx
          .select({ id: agent.id })
          .from(agent)
          .where(
            and(
              eq(agent.id, body.agentId),
              eq(agent.tenantId, row.tenantId),
              eq(agent.kind, "client"),
            ),
          );
        if (!a) throw notFound("agent");
      }
      set.agentId = body.agentId;
      await ev("assign", row.agentId, body.agentId);
    }
    if (body.waitingOn) set.waitingOn = body.waitingOn;
    if (body.statusLine !== undefined) set.statusLine = body.statusLine;
    if (body.stuck !== undefined) set.stuck = body.stuck;
    if (body.fixBy !== undefined) {
      set.fixBy = body.fixBy ? new Date(body.fixBy) : null;
      await ev("moved", row.fixBy?.toISOString() ?? null, body.fixBy);
    }
    if (Object.keys(set).length > 0) {
      await tx
        .update(issue)
        .set(set)
        .where(and(eq(issue.id, row.id), eq(issue.tenantId, row.tenantId)));
    }
    const after = await readIssue(tx, tenantIds, row.id);
    // DECISION: only a critical issue holds the agent; high does not (owner, 2026-11-17).
    if (after.urgency === "critical" && after.agentId && (set.urgency || set.agentId)) {
      await placeHold(tx, {
        agentId: after.agentId,
        issueId: after.id,
        by: "operator",
        userId,
        reason: `Critical issue #${after.number}: ${after.title}`.slice(0, 500),
        tenantIds,
      });
      await auditInTx(tx, null, {
        ...auditActor(session),
        tenantId: after.tenantId,
        action: "agent.hold",
        outcome: "ok",
        target: { agent: after.agentId, issue: after.id },
      });
    }
    return issueDetail(tx, after);
  });

  mount(app, routes.opsIssueMessage, async ({ tx, tenantIds, params, body, session }) => {
    const row = await readIssue(tx, tenantIds, params.id, true);
    await operatorMessage(tx, row, {
      userId: session.user.id,
      text: body.text,
      audience: body.audience,
      sources: body.sources ?? [],
    });
    return issueDetail(tx, await readIssue(tx, tenantIds, row.id));
  });

  mount(app, routes.opsCloseIssue, async ({ tx, tenantIds, params, body, session }) => {
    const row = await readIssue(tx, tenantIds, params.id, true);
    await closeIssue(tx, row, { note: body.note, actor: "operator", userId: session.user.id });
    return issueDetail(tx, await readIssue(tx, tenantIds, row.id));
  });

  mount(app, routes.opsReopenIssue, async ({ tx, tenantIds, params, session }) => {
    const row = await readIssue(tx, tenantIds, params.id, true);
    if (row.stage !== "closed") throw new HttpError(409, "not_closed", "this issue is open");
    await reopenIssue(tx, row, { actor: "operator", userId: session.user.id });
    return issueDetail(tx, await readIssue(tx, tenantIds, row.id));
  });

  mount(app, routes.opsConvertIssue, async ({ tx, tenantIds, params, session }) => {
    const row = await readIssue(tx, tenantIds, params.id, true);
    return { askId: await convertToAsk(tx, row, session.user.id) };
  });

  // ── The safety hold ──────────────────────────────────────────────────────────────────────────
  mount(app, routes.opsHoldAgent, async ({ tx, tenantIds, params, body, session }) => {
    const row = await readIssue(tx, tenantIds, body.issueId);
    if (row.agentId && row.agentId !== params.id) {
      throw new HttpError(422, "other_agent", "the issue is about another agent");
    }
    await placeHold(tx, {
      agentId: params.id,
      issueId: row.id,
      by: "operator",
      userId: session.user.id,
      reason: body.reason,
      tenantIds,
    });
    if (!row.agentId) {
      await tx
        .update(issue)
        .set({ agentId: params.id })
        .where(and(eq(issue.id, row.id), eq(issue.tenantId, row.tenantId)));
    }
    const [view] = await holdViews(tx, [row.tenantId], { agentId: params.id });
    if (!view) throw new Error("hold not in force");
    return view;
  });

  // Releasing is a person's, here only: never one of Reggie's tools or the MCP server's
  // (docs/cases-plan.md §5, "always the operator's").
  mount(app, routes.opsReleaseAgent, async ({ tx, tenantIds, params, body, session }) => {
    const [view] = await holdViews(tx, tenantIds, { agentId: params.id });
    const was = await releaseHold(tx, {
      agentId: params.id,
      userId: session.user.id,
      reason: body.reason,
      tenantIds,
    });
    return { hold: was ? (view ?? null) : null };
  });

  mount(app, routes.opsMoveWork, async ({ tx, tenantIds, body, session }) => {
    const position = body.position;
    if (body.kind === "issue") {
      const row = await readIssue(tx, tenantIds, body.id, true);
      await tx
        .update(issue)
        .set({ manualRank: position })
        .where(and(eq(issue.id, row.id), eq(issue.tenantId, row.tenantId)));
      await addIssueEvent(tx, row, {
        kind: "moved",
        from: row.manualRank === null ? null : String(row.manualRank),
        to: position === null ? null : String(position),
        actor: "operator",
        userId: session.user.id,
      });
    } else if (body.kind === "build") {
      const [b] = await tx
        .select({ id: build.id, clientId: build.clientId })
        .from(build)
        .where(eq(build.id, body.id));
      if (!b || (b.clientId && !tenantIds.includes(b.clientId))) throw notFound("build");
      await tx.update(build).set({ manualRank: position }).where(eq(build.id, b.id));
    } else {
      const e = await readEnhancement(tx, body.id, true);
      await tx.update(enhancement).set({ manualRank: position }).where(eq(enhancement.id, e.id));
    }
    return { ok: true as const };
  });

  // ── Asks and enhancements ────────────────────────────────────────────────────────────────────
  mount(app, routes.opsAsks, async ({ tx, tenantIds, query }) => {
    if (query.client) ensureClient({ tenantIds }, query.client);
    const scope = query.client ? [query.client] : [...tenantIds];
    if (scope.length === 0) return { asks: [] };
    const rows = await tx
      .select()
      .from(clientAsk)
      .where(
        and(
          inArray(clientAsk.tenantId, scope),
          ...(query.status ? [eq(clientAsk.status, query.status)] : []),
        ),
      )
      .orderBy(clientAsk.createdAt)
      .limit(500);
    return { asks: (await askViews(tx, rows)).reverse() };
  });

  mount(app, routes.opsCreateAsk, async ({ tx, tenantIds, body }) => {
    ensureClient({ tenantIds }, body.clientId);
    const row = await createAsk(tx, {
      tenantId: body.clientId,
      title: body.title,
      text: body.text,
      source: "ops",
      agentId: body.agentId ?? null,
    });
    const [view] = await askViews(tx, [row]);
    if (!view) throw new Error("no ask");
    return view;
  });

  mount(app, routes.opsGroupAsk, async ({ tx, tenantIds, params, body, session }) => {
    const ask = await readAsk(tx, tenantIds, params.id, true);
    let e: typeof enhancement.$inferSelect;
    if (body.enhancementId) {
      e = await readEnhancement(tx, body.enhancementId, true);
    } else {
      const [made] = await tx
        .insert(enhancement)
        .values({ title: body.newEnhancement?.title ?? ask.title, createdBy: session.user.id })
        .returning();
      if (!made) throw new Error("enhancement insert returned nothing");
      e = made;
    }
    await groupAsk(tx, ask, e);
    return enhancementDetail(tx, await readEnhancement(tx, e.id), tenantIds);
  });

  mount(app, routes.opsCreateEnhancement, async ({ tx, tenantIds, body, session }) => {
    const [e] = await tx
      .insert(enhancement)
      .values({
        title: body.title,
        description: body.description ?? "",
        createdBy: session.user.id,
      })
      .returning();
    if (!e) throw new Error("enhancement insert returned nothing");
    return enhancementDetail(tx, e, tenantIds);
  });

  mount(app, routes.opsEnhancement, async ({ tx, tenantIds, params }) =>
    enhancementDetail(tx, await readEnhancement(tx, params.id), tenantIds),
  );

  mount(app, routes.opsUpdateEnhancement, async ({ tx, tenantIds, params, body }) => {
    const e = await readEnhancement(tx, params.id, true);
    const set: Partial<typeof enhancement.$inferInsert> = {};
    if (body.title) set.title = body.title;
    if (body.description !== undefined) set.description = body.description;
    if (body.stage && body.stage !== e.stage) {
      set.stage = body.stage;
      set.stageAt = new Date();
    }
    if (body.decideBy !== undefined) set.decideBy = body.decideBy;
    if (body.waitingOn) set.waitingOn = body.waitingOn;
    if (body.statusLine !== undefined) set.statusLine = body.statusLine;
    if (body.stuck !== undefined) set.stuck = body.stuck;
    if (Object.keys(set).length)
      await tx.update(enhancement).set(set).where(eq(enhancement.id, e.id));
    return enhancementDetail(tx, await readEnhancement(tx, e.id), tenantIds);
  });

  // Deciding is the operator's: do it, later, no, or sell it (Sales picks it up from the link the
  // page shows: /ops/sales/grow?from=enhancement:<id>).
  mount(app, routes.opsDecideEnhancement, async ({ tx, tenantIds, params, body, session }) => {
    const e = await readEnhancement(tx, params.id, true);
    if (e.stage === "shipped") throw new HttpError(409, "shipped", "this enhancement has shipped");
    if (body.decision === "no" && !body.note) {
      throw new HttpError(422, "note_required", "say why not: the clients who asked are told");
    }
    const now = new Date();
    await tx
      .update(enhancement)
      .set({
        decision: body.decision,
        decisionNote: body.note || null,
        decidedAt: now,
        stage: e.stage === "built" ? "built" : "decided",
        stageAt: now,
      })
      .where(eq(enhancement.id, e.id));
    // "No" is told to the clients who asked, with its note, and their asks close.
    if (body.decision === "no" && body.note) {
      await declineAsks(tx, e, { note: body.note, userId: session.user.id, tenantIds });
    }
    return enhancementDetail(tx, await readEnhancement(tx, e.id), tenantIds);
  });

  mount(app, routes.opsToldEnhancement, async ({ tx, tenantIds, params, body, session }) => {
    const e = await readEnhancement(tx, params.id, true);
    if (e.decision === "no")
      throw new HttpError(409, "decided_no", "this enhancement was decided no");
    await tellAsks(tx, e, { note: body.note, userId: session.user.id, tenantIds });
    return enhancementDetail(tx, await readEnhancement(tx, e.id), tenantIds);
  });

  // ── A build's requirements request ───────────────────────────────────────────────────────────
  mount(app, routes.opsSendRequirements, async ({ tx, tenantIds, params, body, session }) => {
    const [b] = await tx.select().from(build).where(eq(build.id, params.id)).for("update");
    if (!b?.clientId || !tenantIds.includes(b.clientId)) throw notFound("build");
    const [to] = await tx
      .select({ userId: membership.userId, name: appUser.name, email: appUser.email })
      .from(membership)
      .innerJoin(appUser, eq(appUser.id, membership.userId))
      .where(
        and(
          eq(membership.tenantId, b.clientId),
          eq(membership.userId, body.toUserId),
          eq(membership.role, "client_admin"),
        ),
      );
    if (!to) throw new HttpError(422, "not_client_admin", "send it to one of the client's admins");
    const fields = body.fields ?? setupFields(b.fitgap);
    if (fields.length === 0) throw new HttpError(422, "no_fields", "name the questions to ask");
    const total = fields.filter((f) => f.required).length;
    const [item] = await tx
      .insert(inboxItem)
      .values({
        tenantId: b.clientId,
        kind: "request",
        assigneeRole: "client_admin",
        assigneeUserId: to.userId,
        subjectType: "requirements_request",
        subjectId: b.id,
        title: `Questions for your new agent: ${b.title}`.slice(0, 200),
        payload: { fields, buildId: b.id, dueOn: body.dueOn, answers: {} },
        dueAt: new Date(`${body.dueOn}T23:59:59Z`),
      })
      .returning();
    if (!item) throw new Error("inbox insert returned nothing");
    await tx
      .update(build)
      .set({
        requirements: {
          inboxItemId: item.id,
          fields,
          sentAt: new Date().toISOString(),
          dueOn: body.dueOn,
          to: { userId: to.userId, name: to.name ?? to.email },
          answered: 0,
          total,
        },
        waitingOn: "client",
        statusLine: `0 of ${total} answered`,
      })
      .where(eq(build.id, b.id));
    await addTodo(tx, {
      title: `Requirements due from ${to.name ?? to.email}`,
      owner: "client",
      clientId: b.clientId,
      about: { kind: "build", id: b.id },
      dueAt: new Date(`${body.dueOn}T23:59:59Z`),
      deskItemId: item.id,
      source: "system",
      dedupeKey: `requirements:${item.id}`,
      createdBy: session.user.id,
    });
    return { buildId: b.id, itemId: item.id };
  });
}

/** The questions of a template build's client intake form (§1.108's fit-gap set-up), if any. */
function setupFields(fitgap: unknown): RequirementField[] {
  const setup = (fitgap as { setup?: unknown } | null)?.setup;
  if (!Array.isArray(setup)) return [];
  return setup.flatMap((s, n): RequirementField[] => {
    const row = s as {
      key?: unknown;
      label?: unknown;
      question?: unknown;
      required?: unknown;
      hint?: unknown;
    };
    const label =
      typeof row.label === "string"
        ? row.label
        : typeof row.question === "string"
          ? row.question
          : null;
    if (!label) return [];
    return [
      {
        key: typeof row.key === "string" && row.key ? row.key.slice(0, 100) : `q${n + 1}`,
        label: label.slice(0, 300),
        kind: "text",
        required: row.required !== false,
        ...(typeof row.hint === "string" ? { hint: row.hint.slice(0, 500) } : {}),
      },
    ];
  });
}
