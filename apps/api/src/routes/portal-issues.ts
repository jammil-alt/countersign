// The portal's Requests (docs/plan.md §1.124.1; docs/cases-plan.md B2): the client's issues
// ("something isn't working") and asks ("an idea or a change") as a conversation with its Mezonas
// lead, and the requirements form a build sends to the client admin's Desk. The portal says
// "Requests" (owner, 2026-11-17).
//
// What the client never gets (invariant 11): internal notes, Reggie's read, plan or draft, to-dos,
// urgency, the work order, who is waiting on whom, the cause, the hold's internals, other clients'
// asks or anything of an enhancement, and any operator's identity but the lead's name.
// DECISION: the portal keeps the word "Requests" (owner, 2026-11-17).

import {
  type PortalRequestState,
  type PortalRequirementsForm,
  type PortalWorkMessage,
  type PortalWorkRequest,
  type PortalWorkRequestDetail,
  type RequirementAnswers,
  RequirementField,
  type Role,
  requirementsProgress,
  routes,
} from "@countersign/core";
import { agent, clientAsk, inboxItem, issue, type Tx } from "@countersign/db";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { Hono } from "hono";
import { z } from "zod";
import { type AppEnv, HttpError, mount, notFound } from "../http";
import type { AskRow } from "../work/asks";
import {
  closeIssue,
  type IssueRow,
  leadNameFor,
  operatorsOf,
  postOnThread,
  reopenIssue,
  threadMessages,
  userNames,
} from "../work/issues";

/** A client user's requests are their own; the client admin sees everyone's (as §1.11's). */
function mine(role: Role) {
  return role !== "client_admin";
}

function issueState(r: IssueRow): PortalRequestState {
  if (r.stage === "closed") return r.causeKind && r.causeKind !== "not_a_bug" ? "fixed" : "closed";
  if (r.stage === "verify" || r.waitingOn === "client") return "waiting_on_you";
  return "on_it";
}

function askState(a: AskRow): PortalRequestState {
  if (a.status === "told") return "fixed";
  if (a.status === "closed") return "closed";
  return "on_it";
}

async function services(tx: Tx, tenantId: string, ids: (string | null)[]) {
  const wanted = [...new Set(ids.filter((v): v is string => !!v))];
  if (wanted.length === 0) return new Map<string, string>();
  const rows = await tx
    .select({ id: agent.id, name: agent.name, serviceName: agent.serviceName })
    .from(agent)
    .where(and(eq(agent.tenantId, tenantId), inArray(agent.id, wanted)));
  return new Map(rows.map((r) => [r.id, r.serviceName ?? r.name]));
}

async function views(
  tx: Tx,
  tenantId: string,
  issues: IssueRow[],
  asks: AskRow[],
): Promise<PortalWorkRequest[]> {
  const names = await userNames(tx, [
    ...issues.map((i) => i.raisedBy),
    ...asks.map((a) => a.raisedBy),
  ]);
  const svc = await services(tx, tenantId, [
    ...issues.map((i) => i.agentId),
    ...asks.map((a) => a.agentId),
  ]);
  const service = (id: string | null) =>
    id && svc.has(id) ? { id, name: svc.get(id) as string } : null;
  return [
    ...issues.map(
      (i): PortalWorkRequest => ({
        id: i.id,
        kind: "problem",
        number: i.number,
        title: i.title,
        text: i.description,
        state: issueState(i),
        service: service(i.agentId),
        raisedBy: (i.raisedBy && names.get(i.raisedBy)) || null,
        createdAt: i.createdAt.toISOString(),
        updatedAt: i.updatedAt.toISOString(),
        canConfirm: i.stage === "verify",
        canReopen: i.stage === "verify" || i.stage === "closed",
      }),
    ),
    ...asks.map(
      (a): PortalWorkRequest => ({
        id: a.id,
        kind: "idea",
        number: null,
        title: a.title,
        text: a.text,
        state: askState(a),
        service: service(a.agentId),
        raisedBy: (a.raisedBy && names.get(a.raisedBy)) || null,
        createdAt: a.createdAt.toISOString(),
        updatedAt: a.updatedAt.toISOString(),
        canConfirm: false,
        canReopen: false,
      }),
    ),
  ].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

type Found = { kind: "problem"; row: IssueRow } | { kind: "idea"; row: AskRow };

/** The request, when the person may see it (their own, or any for the client admin). */
async function findRequest(
  tx: Tx,
  tenantId: string,
  viewer: { role: Role; userId: string },
  id: string,
  lock = false,
): Promise<Found> {
  const own = (raisedBy: string | null) => !mine(viewer.role) || raisedBy === viewer.userId;
  const iq = tx
    .select()
    .from(issue)
    .where(and(eq(issue.id, id), eq(issue.tenantId, tenantId)));
  const [i] = lock ? await iq.for("update") : await iq;
  if (i && own(i.raisedBy)) return { kind: "problem", row: i };
  const aq = tx
    .select()
    .from(clientAsk)
    .where(and(eq(clientAsk.id, id), eq(clientAsk.tenantId, tenantId)));
  const [a] = lock ? await aq.for("update") : await aq;
  if (a && own(a.raisedBy)) return { kind: "idea", row: a };
  throw notFound("request");
}

/** The conversation as the client reads it: the client's side only, the lead by name. */
async function portalMessages(
  tx: Tx,
  tenantId: string,
  threadId: string,
  viewerId: string,
): Promise<PortalWorkMessage[]> {
  const rows = await threadMessages(tx, tenantId, threadId, ["client"]);
  const ops = await operatorsOf(
    tx,
    tenantId,
    rows.map((r) => r.senderId),
  );
  const names = await userNames(
    tx,
    rows.filter((r) => r.senderId && !ops.has(r.senderId)).map((r) => r.senderId),
  );
  const lead = await leadNameFor(tx, tenantId);
  return rows.map((m) => {
    const isUs = m.senderType !== "user" || (!!m.senderId && ops.has(m.senderId));
    const text = (m.body as { text?: unknown } | null)?.text;
    return {
      id: m.id,
      at: m.createdAt.toISOString(),
      from: isUs ? "lead" : m.senderId === viewerId ? "you" : "client",
      name: isUs ? lead : (m.senderId && names.get(m.senderId)) || "Someone",
      text: typeof text === "string" ? text : "",
    };
  });
}

async function detail(
  tx: Tx,
  tenantId: string,
  viewer: { role: Role; userId: string },
  id: string,
): Promise<PortalWorkRequestDetail> {
  const f = await findRequest(tx, tenantId, viewer, id);
  const [request] =
    f.kind === "problem"
      ? await views(tx, tenantId, [f.row], [])
      : await views(tx, tenantId, [], [f.row]);
  if (!request) throw notFound("request");
  return { request, messages: await portalMessages(tx, tenantId, f.row.threadId, viewer.userId) };
}

// ── Requirements ─────────────────────────────────────────────────────────────────────────────────

const Fields = z.array(RequirementField);

async function requirementsItem(tx: Tx, tenantId: string, id: string, lock = false) {
  const q = tx
    .select()
    .from(inboxItem)
    .where(
      and(
        eq(inboxItem.id, id),
        eq(inboxItem.tenantId, tenantId),
        eq(inboxItem.subjectType, "requirements_request"),
      ),
    );
  const [row] = lock ? await q.for("update") : await q;
  if (!row) throw notFound("requirements request");
  return row;
}

function formOf(row: typeof inboxItem.$inferSelect): PortalRequirementsForm {
  const p = (row.payload ?? {}) as { fields?: unknown; dueOn?: unknown; draft?: unknown };
  const fields = Fields.safeParse(p.fields).success ? (p.fields as z.infer<typeof Fields>) : [];
  const resolved =
    row.status === "resolved"
      ? ((row.resolution ?? {}) as { answers?: unknown }).answers
      : undefined;
  const raw = resolved ?? p.draft ?? {};
  const answers: RequirementAnswers = Object.fromEntries(
    Object.entries(typeof raw === "object" && raw ? raw : {}).filter(
      (e): e is [string, string] => typeof e[1] === "string",
    ),
  );
  const progress = requirementsProgress(fields, answers);
  return {
    itemId: row.id,
    title: row.title,
    dueOn: typeof p.dueOn === "string" ? p.dueOn : null,
    fields,
    answers,
    answered: progress.answered,
    total: progress.total,
    submitted: row.status === "resolved",
  };
}

/** Only the form's own keys are kept. */
function cleanAnswers(
  form: PortalRequirementsForm,
  answers: RequirementAnswers,
): RequirementAnswers {
  const keys = new Set(form.fields.map((f) => f.key));
  return Object.fromEntries(Object.entries(answers).filter(([k]) => keys.has(k)));
}

export function portalIssueRouteHandlers(app: Hono<AppEnv>): void {
  mount(app, routes.portalWorkRequests, async ({ tx, tenantIds, role, session, query }) => {
    const tenantId = tenantIds[0] as string;
    const who = mine(role) ? session.user.id : null;
    const issues = await tx
      .select()
      .from(issue)
      .where(and(eq(issue.tenantId, tenantId), ...(who ? [eq(issue.raisedBy, who)] : [])))
      .orderBy(desc(issue.createdAt))
      .limit(200);
    const asks = await tx
      .select()
      .from(clientAsk)
      .where(and(eq(clientAsk.tenantId, tenantId), ...(who ? [eq(clientAsk.raisedBy, who)] : [])))
      .orderBy(desc(clientAsk.createdAt))
      .limit(200);
    const items = (await views(tx, tenantId, issues, asks)).filter((r) => {
      const done = r.state === "fixed" || r.state === "closed";
      return query.status === "all" || (query.status === "closed" ? done : !done);
    });
    return { items };
  });

  mount(app, routes.portalWorkRequest, async ({ tx, tenantIds, role, session, params }) =>
    detail(tx, tenantIds[0] as string, { role, userId: session.user.id }, params.id),
  );

  mount(
    app,
    routes.portalWorkRequestMessage,
    async ({ tx, tenantIds, role, session, params, body }) => {
      const tenantId = tenantIds[0] as string;
      const viewer = { role, userId: session.user.id };
      const f = await findRequest(tx, tenantId, viewer, params.id, true);
      await postOnThread(tx, {
        tenantId,
        threadId: f.row.threadId,
        senderType: "user",
        senderId: session.user.id,
        text: body.text,
        audience: "client",
      });
      if (f.kind === "problem") {
        // A client's message is Reggie's to read; it waits on us again.
        await tx
          .update(issue)
          .set({
            needsReadAt: new Date(),
            waitingOn: f.row.waitingOn === "client" ? "operator" : f.row.waitingOn,
          })
          .where(and(eq(issue.id, f.row.id), eq(issue.tenantId, tenantId)));
      }
      return detail(tx, tenantId, viewer, params.id);
    },
  );

  mount(app, routes.portalConfirmFix, async ({ tx, tenantIds, role, session, params }) => {
    const tenantId = tenantIds[0] as string;
    const viewer = { role, userId: session.user.id };
    const f = await findRequest(tx, tenantId, viewer, params.id, true);
    if (f.kind !== "problem" || f.row.stage !== "verify") {
      throw new HttpError(409, "not_verifying", "there is no fix to confirm on this request");
    }
    await closeIssue(tx, f.row, { actor: "client", userId: session.user.id });
    return detail(tx, tenantId, viewer, params.id);
  });

  mount(app, routes.portalReopenRequest, async ({ tx, tenantIds, role, session, params }) => {
    const tenantId = tenantIds[0] as string;
    const viewer = { role, userId: session.user.id };
    const f = await findRequest(tx, tenantId, viewer, params.id, true);
    if (f.kind !== "problem" || (f.row.stage !== "verify" && f.row.stage !== "closed")) {
      throw new HttpError(409, "not_reopenable", "this request is still open");
    }
    await reopenIssue(tx, f.row, { actor: "client", userId: session.user.id, stage: "fix" });
    return detail(tx, tenantId, viewer, params.id);
  });

  // ── Requirements ─────────────────────────────────────────────────────────────────────────────
  mount(app, routes.portalRequirements, async ({ tx, tenantIds, params }) =>
    formOf(await requirementsItem(tx, tenantIds[0] as string, params.id)),
  );

  mount(app, routes.portalSaveRequirements, async ({ tx, tenantIds, params, body }) => {
    const tenantId = tenantIds[0] as string;
    const row = await requirementsItem(tx, tenantId, params.id, true);
    if (row.status !== "open") throw new HttpError(409, "submitted", "these answers were sent");
    const answers = cleanAnswers(formOf(row), body.answers);
    const [saved] = await tx
      .update(inboxItem)
      .set({ payload: { ...(row.payload as Record<string, unknown>), draft: answers } })
      .where(and(eq(inboxItem.id, row.id), eq(inboxItem.tenantId, tenantId)))
      .returning();
    if (!saved) throw notFound("requirements request");
    const form = formOf(saved);

    return form;
  });

  mount(app, routes.portalSubmitRequirements, async ({ tx, tenantIds, session, params, body }) => {
    const tenantId = tenantIds[0] as string;
    const row = await requirementsItem(tx, tenantId, params.id, true);
    if (row.status !== "open") throw new HttpError(409, "submitted", "these answers were sent");
    const answers = cleanAnswers(formOf(row), body.answers);
    const [done] = await tx
      .update(inboxItem)
      .set({
        status: "resolved",
        resolution: { answers },
        resolvedBy: session.user.id,
        resolvedAt: new Date(),
        payload: { ...(row.payload as Record<string, unknown>), draft: answers },
      })
      .where(and(eq(inboxItem.id, row.id), eq(inboxItem.tenantId, tenantId)))
      .returning();
    if (!done) throw notFound("requirements request");
    const form = formOf(done);

    return form;
  });
}
