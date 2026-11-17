// Your call (docs/plan.md §1.124.3; docs/cases-plan.md T1): the to-do routes, what Reggie did on
// its own today, and the client page's work and activity. Operator only (`/api/ops`), each in a
// transaction over the clients the operator serves. "Do it" runs the to-do's primary action as the
// operator through `invokeRoute` (that route's roles, checks and audit row, marked `todo`), so a
// to-do never does anything its route would refuse.

import {
  DONE_TODAY_FLOWS,
  type DoneTodayRow,
  laterUntil,
  type RouteSpec,
  routes,
  type TodoAboutKind,
  WorkUrgency,
} from "@countersign/core";
import {
  build,
  clientAsk,
  deal,
  enhancement,
  issue,
  membership,
  message,
  playLog,
  run,
  type Tx,
  tenant,
  todo,
} from "@countersign/db";
import { leadThread, postMessage } from "@countersign/threads";
import { and, eq, gte, inArray, isNull, or, type SQL } from "drizzle-orm";
import type { Hono } from "hono";
import {
  type AppEnv,
  ensureClient,
  HttpError,
  invokeRoute,
  mount,
  mountLong,
  notFound,
} from "../http";
import { clientActivity } from "../work/activity";
import { clientWork } from "../work/client-work";
import { logPlay } from "../work/play-log";
import { aboutHref, todoList, todoScope, todoViews } from "../work/todos";
import { addTodo, type TodoRow } from "../work/todos-store";
import { sendDealEmail } from "./autopilot";

async function readTodo(
  tx: Tx,
  tenantIds: readonly string[],
  id: string,
  lock = false,
): Promise<TodoRow> {
  const q = tx
    .select()
    .from(todo)
    .where(and(eq(todo.id, id), todoScope(tenantIds)));
  const [row] = lock ? await q.for("update") : await q;
  if (!row) throw notFound("to-do");
  return row;
}

async function viewOf(tx: Tx, row: TodoRow) {
  const [v] = await todoViews(tx, [row]);
  if (!v) throw new Error("to-do view missing");
  return v;
}

/** The client an item belongs to, once it is found among the clients served (404 otherwise). */
async function clientOfAbout(
  tx: Tx,
  tenantIds: readonly string[],
  about: { kind: TodoAboutKind; id: string },
): Promise<string | null> {
  const served = [...tenantIds];
  const one = async (rows: Promise<{ c: string | null }[]>, what: string) => {
    const [r] = await rows;
    if (!r) throw notFound(what);
    return r.c;
  };
  switch (about.kind) {
    case "issue":
      return one(
        tx
          .select({ c: issue.tenantId })
          .from(issue)
          .where(and(eq(issue.id, about.id), inArray(issue.tenantId, served))),
        "issue",
      );
    case "client_ask":
      return one(
        tx
          .select({ c: clientAsk.tenantId })
          .from(clientAsk)
          .where(and(eq(clientAsk.id, about.id), inArray(clientAsk.tenantId, served))),
        "ask",
      );
    case "run":
      return one(
        tx
          .select({ c: run.tenantId })
          .from(run)
          .where(and(eq(run.id, about.id), inArray(run.tenantId, served))),
        "run",
      );
    case "question":
      return one(
        tx
          .select({ c: message.tenantId })
          .from(message)
          .where(and(eq(message.id, about.id), inArray(message.tenantId, served))),
        "message",
      );
    case "client":
      ensureClient({ tenantIds }, about.id);
      return about.id;
    case "build":
      return one(
        tx
          .select({ c: build.clientId })
          .from(build)
          .where(
            and(
              eq(build.id, about.id),
              or(isNull(build.clientId), inArray(build.clientId, served)) as SQL,
            ),
          ),
        "build",
      );
    case "deal":
      return one(
        tx
          .select({ c: deal.clientId })
          .from(deal)
          .where(
            and(
              eq(deal.id, about.id),
              or(isNull(deal.clientId), inArray(deal.clientId, served)) as SQL,
            ),
          ),
        "deal",
      );
    case "enhancement": {
      const [e] = await tx
        .select({ id: enhancement.id })
        .from(enhancement)
        .where(eq(enhancement.id, about.id));
      if (!e) throw notFound("enhancement");
      // Everyone's: an enhancement names no client.
      return null;
    }
  }
}

/** A named operator must be one: an operator member of some client this session can see. */
async function ensureOperatorUser(tx: Tx, userId: string, self: string): Promise<void> {
  if (userId === self) return;
  const [m] = await tx
    .select({ u: membership.userId })
    .from(membership)
    .where(and(eq(membership.userId, userId), eq(membership.role, "operator")))
    .limit(1);
  if (!m) throw new HttpError(422, "not_operator", "a to-do can be named only to an operator");
}

const refOf = (row: TodoRow): Record<string, string> =>
  ((row.primaryAction as { ref?: Record<string, string> } | null)?.ref ?? {}) as Record<
    string,
    string
  >;

/** A decide to-do's option: `{label, value}` as plays make them, or a word that is both. */
const optionOf = (v: unknown): { label: string; value: string } | null => {
  if (typeof v === "string") return { label: v, value: v };
  if (v && typeof v === "object") {
    const o = v as { label?: unknown; value?: unknown; text?: unknown };
    const value = typeof o.value === "string" ? o.value : null;
    const label =
      typeof o.label === "string" ? o.label : typeof o.text === "string" ? o.text : value;
    if (value && label) return { label, value };
  }
  return null;
};

/** A route by name, when its stream has added it (B2's deal email); else null. */
const startOfToday = (now: Date) =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

export function todoRoutes(app: Hono<AppEnv>): void {
  mount(app, routes.opsTodos, async ({ tx, tenantIds, query, session }) => {
    if (query.client) ensureClient({ tenantIds }, query.client);
    const about = query.about
      ? (() => {
          const [kind, id] = query.about.split(":") as [string, string];
          return { kind, id };
        })()
      : undefined;
    return todoList(tx, tenantIds, session.user.id, {
      owner: query.owner,
      client: query.client,
      kind: query.kind,
      mine: query.mine === "true",
      about,
    });
  });

  mount(app, routes.opsCreateTodo, async ({ tx, tenantIds, body, session }) => {
    if (body.clientId) ensureClient({ tenantIds }, body.clientId);
    const aboutClient = body.about ? await clientOfAbout(tx, tenantIds, body.about) : null;
    if (body.clientId && aboutClient && body.clientId !== aboutClient) {
      throw new HttpError(422, "wrong_client", "the to-do's client is not the item's");
    }
    if (body.ownerUserId) {
      if (body.owner !== "operator") {
        throw new HttpError(422, "not_operator", "only our own to-dos are named to a person");
      }
      await ensureOperatorUser(tx, body.ownerUserId, session.user.id);
    }
    const row = await addTodo(tx, {
      title: body.title,
      owner: body.owner,
      ownerUserId: body.ownerUserId ?? null,
      clientId: body.clientId ?? aboutClient ?? null,
      detail: body.detail ?? "",
      why: body.why ?? null,
      dueAt: body.dueAt ? new Date(body.dueAt) : null,
      about: body.about ?? null,
      source: "operator",
      createdBy: session.user.id,
    });
    return viewOf(tx, row);
  });

  mount(app, routes.opsUpdateTodo, async ({ tx, tenantIds, params, body, session }) => {
    const row = await readTodo(tx, tenantIds, params.id, true);
    if (row.state === "done" || row.state === "dropped") {
      throw new HttpError(409, "closed", "this to-do is closed");
    }
    const set: Partial<typeof todo.$inferInsert> = {};
    if (body.title !== undefined) set.title = body.title;
    if (body.detail !== undefined) set.detail = body.detail;
    if (body.why !== undefined) set.why = body.why;
    if (body.dueAt !== undefined) set.dueAt = body.dueAt ? new Date(body.dueAt) : null;
    if (body.owner !== undefined) set.owner = body.owner;
    const owner = body.owner ?? row.owner;
    if (body.ownerUserId !== undefined) {
      if (body.ownerUserId && owner !== "operator") {
        throw new HttpError(422, "not_operator", "only our own to-dos are named to a person");
      }
      if (body.ownerUserId) await ensureOperatorUser(tx, body.ownerUserId, session.user.id);
      set.ownerUserId = body.ownerUserId;
    } else if (owner !== "operator") {
      set.ownerUserId = null;
    }
    if (body.draftText !== undefined) {
      const draft = row.draft as Record<string, unknown> | null;
      if (!draft) throw new HttpError(409, "no_draft", "this to-do has no draft");
      set.draft = { ...draft, text: body.draftText };
    }
    if (body.dropped) {
      set.state = "dropped";
      set.doneAt = new Date();
      set.doneBy = session.user.id;
    }
    const [next] = await tx.update(todo).set(set).where(eq(todo.id, row.id)).returning();
    return viewOf(tx, next ?? row);
  });

  mount(app, routes.opsTodoDone, async ({ tx, tenantIds, params, session }) => {
    const row = await readTodo(tx, tenantIds, params.id, true);
    if (row.state === "done" || row.state === "dropped") return viewOf(tx, row);
    const [next] = await tx
      .update(todo)
      .set({ state: "done", doneAt: new Date(), doneBy: session.user.id })
      .where(eq(todo.id, row.id))
      .returning();
    return viewOf(tx, next ?? row);
  });

  mount(app, routes.opsTodoSnooze, async ({ tx, tenantIds, params, body }) => {
    const row = await readTodo(tx, tenantIds, params.id, true);
    if (row.state === "done" || row.state === "dropped") {
      throw new HttpError(409, "closed", "this to-do is closed");
    }
    const now = new Date();
    const until = body.until ? new Date(body.until) : laterUntil(now);
    if (until.getTime() <= now.getTime()) {
      throw new HttpError(422, "in_the_past", "snooze until a time still to come");
    }
    const [next] = await tx
      .update(todo)
      .set({ state: "snoozed", snoozedUntil: until })
      .where(eq(todo.id, row.id))
      .returning();
    return viewOf(tx, next ?? row);
  });

  mount(app, routes.opsTodoTake, async ({ tx, tenantIds, params, session }) => {
    const row = await readTodo(tx, tenantIds, params.id, true);
    if (row.owner !== "reggie") {
      throw new HttpError(409, "not_reggies", "only Reggie's to-dos are taken");
    }
    if (row.state === "done" || row.state === "dropped") {
      throw new HttpError(409, "closed", "this to-do is closed");
    }
    const [next] = await tx
      .update(todo)
      .set({ owner: "operator", ownerUserId: session.user.id, state: "open", snoozedUntil: null })
      .where(eq(todo.id, row.id))
      .returning();
    return viewOf(tx, next ?? row);
  });

  mountLong(app, routes.opsTodoAct, async (ctx) => {
    const row = await ctx.inTx((s) => readTodo(s.tx, s.tenantIds, ctx.params.id));
    if (row.state === "done" || row.state === "dropped") {
      throw new HttpError(409, "closed", "this to-do is closed");
    }
    const action = row.primaryAction as { kind?: string } | null;
    if (!action?.kind) throw new HttpError(409, "no_action", "this to-do has nothing to do");
    const ref = refOf(row);
    const call = <R extends RouteSpec>(spec: R, raw: Parameters<typeof invokeRoute<R>>[4]) =>
      invokeRoute(app, ctx.c, ctx.session, spec, raw, "todo");
    let done = "Done.";
    let href: string | null = null;
    let close = true;
    const draft = row.draft as { text?: string; subject?: string } | null;

    switch (action.kind) {
      case "send_reply": {
        const text = ctx.body.draftText ?? draft?.text;
        if (!text) throw new HttpError(422, "no_text", "write the reply first");
        if (ref.issueId) {
          await call(routes.opsIssueMessage, {
            params: { id: ref.issueId },
            body: { text, audience: "client" },
          });
          href = aboutHref("issue", ref.issueId);
        } else if (ref.dealId) {
          // The deal's email is Reggie's inbox's (§1.124.4). It is a slow route, which
          // invokeRoute can't run, so its sending is called directly, as this operator.
          await sendDealEmail(ctx, ref.dealId, { subject: draft?.subject ?? row.title, text });
          href = aboutHref("deal", ref.dealId);
        } else if (ref.buildId && row.clientId) {
          // A build's requirements chase (backoffice/tick.ts at draft): the reminder goes to the
          // client's lead conversation from this operator, as /todos/:id/remind does, and counts
          // on the chase play's record.
          const buildId = ref.buildId;
          const clientId = row.clientId;
          await ctx.inTx(async (s) => {
            const [b] = await s.tx
              .select({ id: build.id, title: build.title })
              .from(build)
              .where(and(eq(build.id, buildId), eq(build.clientId, clientId)));
            if (!b) throw notFound("build");
            const th = await leadThread(s.tx, clientId);
            await postMessage(s.tx, {
              tenantId: clientId,
              thread: th,
              senderType: "user",
              senderId: ctx.session.user.id,
              kind: "text",
              body: { text },
              sources: [],
              audience: "client",
            });
            await logPlay(s.tx, {
              clientId,
              flow: "builds",
              stage: "requirements",
              play: "chase_requirements",
              level: "draft",
              outcome: "sent",
              about: { kind: "build", id: b.id },
              summary: `Chased the requirements for ${b.title}`,
            });
          });
          href = aboutHref("build", buildId);
        } else {
          throw new HttpError(409, "no_target", "this reply has nowhere to go");
        }
        done = "Sent.";
        break;
      }
      case "approve_plan": {
        const steps = Array.isArray(row.plan) ? row.plan : [];
        if (!steps.length) throw new HttpError(409, "no_plan", "this to-do has no plan");
        const made = await ctx.inTx(async (s) => {
          let n = 0;
          for (const [i, step] of steps.entries()) {
            const p =
              typeof step === "string"
                ? { text: step, who: "operator", mode: "approve" }
                : (step as { text?: string; who?: string; mode?: string; detail?: string });
            if (!p.text) continue;
            // Reggie's own steps it may do alone; the rest are ours (and the client's theirs).
            const owner =
              p.who === "reggie" && p.mode === "auto"
                ? "reggie"
                : p.who === "client"
                  ? "client"
                  : "operator";
            await addTodo(s.tx, {
              title: p.text,
              owner,
              ownerUserId: owner === "operator" ? ctx.session.user.id : null,
              clientId: row.clientId,
              detail: p.detail ?? "",
              about: row.aboutKind && row.aboutId ? { kind: row.aboutKind, id: row.aboutId } : null,
              source: "operator",
              dedupeKey: `plan:${row.id}:${i}`,
              createdBy: ctx.session.user.id,
            });
            n++;
          }
          return n;
        });
        done = `${made} to-do${made === 1 ? "" : "s"} made from the plan.`;
        break;
      }
      case "decide": {
        // The choices are the to-do's options, as Reggie's plays make them ({label, value}) or
        // as plain words (the word is its own value), in the order Your call shows them.
        const options = (Array.isArray(row.options) ? row.options : []).map(optionOf);
        const at = ctx.body.option ?? 0;
        const picked = options[at];
        const choice = picked?.value;
        if (!picked || !choice) {
          throw new HttpError(422, "no_option", "choose one of the options");
        }
        if (row.aboutKind === "enhancement" && row.aboutId) {
          await call(routes.opsDecideEnhancement, {
            params: { id: row.aboutId },
            body: { decision: choice as "do", note: "" },
          });
        } else if (row.aboutKind === "deal" && row.aboutId) {
          if (["won", "lost", "not_now", "no"].includes(choice)) {
            const words = picked.label;
            await call(routes.opsDealOutcome, {
              params: { id: row.aboutId },
              body: { outcome: choice as "won", ...(choice === "no" ? { reason: words } : {}) },
            });
          } else {
            await call(routes.opsUpdateDeal, {
              params: { id: row.aboutId },
              body: { stage: choice as "pitch" },
            });
          }
        } else if (row.aboutKind === "issue" && row.aboutId) {
          // Reggie's "Confirm the urgency": the issue's own route, which keeps its history
          // and places a safety hold when it becomes critical.
          const urgency = WorkUrgency.safeParse(choice);
          if (!urgency.success) throw new HttpError(422, "no_option", "choose one of the options");
          await call(routes.opsUpdateIssue, {
            params: { id: row.aboutId },
            body: { urgency: urgency.data, reason: `Decided on Your call: ${picked.label}` },
          });
        } else {
          throw new HttpError(409, "no_target", "this decision has nowhere to go");
        }
        href = row.aboutKind && row.aboutId ? aboutHref(row.aboutKind, row.aboutId) : null;
        done = "Decided.";
        break;
      }
      case "send_requirements": {
        if (!ref.buildId || !ref.toUserId) {
          throw new HttpError(409, "no_target", "say whom the request goes to on the build first");
        }
        const dueOn = ref.dueOn ?? new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
        await call(routes.opsSendRequirements, {
          params: { id: ref.buildId },
          body: { dueOn, toUserId: ref.toUserId },
        });
        href = aboutHref("build", ref.buildId);
        done = "Requirements request sent.";
        break;
      }
      case "confirm_card": {
        if (!ref.actionId) throw new HttpError(409, "no_target", "this card is missing");
        await call(routes.opsReggieActionConfirm, { params: { id: ref.actionId } });
        done = "Confirmed.";
        break;
      }
      default: {
        // "Open" only takes you there; the to-do stays until you mark it done.
        close = false;
        href =
          ref.href ?? (row.aboutKind && row.aboutId ? aboutHref(row.aboutKind, row.aboutId) : null);
        done = "";
      }
    }

    const next = await ctx.inTx(async (s) => {
      if (!close) return readTodo(s.tx, s.tenantIds, row.id);
      const set: Partial<typeof todo.$inferInsert> = {
        state: "done",
        doneAt: new Date(),
        doneBy: ctx.session.user.id,
      };
      if (ctx.body.draftText && draft && ctx.body.draftText !== draft.text) {
        set.draft = { ...(row.draft as object), text: ctx.body.draftText };
      }
      const [u] = await s.tx.update(todo).set(set).where(eq(todo.id, row.id)).returning();
      return u ?? row;
    });
    return { todo: await ctx.inTx((s) => viewOf(s.tx, next)), done, href };
  });

  mount(app, routes.opsTodosDoneToday, async ({ tx, tenantIds }) => {
    const rows = await tx
      .select({
        id: playLog.id,
        flow: playLog.flow,
        summary: playLog.summary,
        internal: playLog.internal,
        edited: playLog.edited,
        aboutKind: playLog.aboutKind,
        aboutId: playLog.aboutId,
        clientId: playLog.clientId,
        clientName: tenant.name,
        flaggedAt: playLog.flaggedAt,
        createdAt: playLog.createdAt,
      })
      .from(playLog)
      .leftJoin(tenant, eq(tenant.id, playLog.clientId))
      .where(
        and(
          gte(playLog.createdAt, startOfToday(new Date())),
          inArray(playLog.outcome, ["sent", "done"]),
          tenantIds.length
            ? (or(isNull(playLog.clientId), inArray(playLog.clientId, [...tenantIds])) as SQL)
            : isNull(playLog.clientId),
        ),
      )
      .orderBy(playLog.createdAt)
      .limit(500);
    const groups = DONE_TODAY_FLOWS.map(([flow, name]) => ({
      flow,
      name,
      rows: rows
        .filter((r) => r.flow === flow)
        .map(
          (r): DoneTodayRow => ({
            id: r.id,
            at: r.createdAt.toISOString(),
            summary: r.summary,
            sent: !r.internal,
            edited: r.edited,
            client: r.clientId ? { id: r.clientId, name: r.clientName ?? "A client" } : null,
            href: r.aboutKind && r.aboutId ? aboutHref(r.aboutKind, r.aboutId) : null,
            flagged: r.flaggedAt !== null,
          }),
        ),
    })).filter((g) => g.rows.length > 0);
    return { groups, count: rows.length };
  });

  // play_log is updated only here: the flag (and its note) is the one change a row takes.
  mount(app, routes.opsFlagPlay, async ({ tx, tenantIds, params, body, session }) => {
    const [row] = await tx
      .update(playLog)
      .set({ flaggedAt: new Date(), flaggedBy: session.user.id, flagNote: body.note ?? null })
      .where(
        and(
          eq(playLog.id, params.id),
          tenantIds.length
            ? (or(isNull(playLog.clientId), inArray(playLog.clientId, [...tenantIds])) as SQL)
            : isNull(playLog.clientId),
        ),
      )
      .returning({ id: playLog.id });
    if (!row) throw notFound("play");
    return { ok: true as const };
  });

  mount(app, routes.opsClientActivity, async ({ tx, tenantIds, params, query }) => {
    ensureClient({ tenantIds }, params.id);
    return clientActivity(
      tx,
      params.id,
      query.filter,
      query.before ? new Date(query.before) : undefined,
    );
  });

  mount(app, routes.opsClientWork, async ({ tx, tenantIds, params, session }) => {
    ensureClient({ tenantIds }, params.id);
    return clientWork(tx, tenantIds, params.id, session.user.id);
  });
}
