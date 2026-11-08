// P-4: conversations with people (ARCHITECTURE §10.12; docs/plan.md §1.66).
//
// The `comms.converse` step: the agent talks with one person on one channel until a typed goal is
// met (and confirmed, when asked), within limits on messages, time and cost. Each message to a
// contact is a reach-out of its own (a `reach_out` row with the message as fixed text), sent by
// reach out's `attemptFrom`, so every check reach out makes holds per message: opt-out, consent,
// the person's autonomy, the agent's bound channel, the matrix and grant, a human release, quiet
// hours (held by the cron) and an idempotency key. Replies are matched by reach out's matcher and
// wake the run; each turn is one model call (packages/agents' `converseTurn`), its answer stored on
// the message row before the message goes. A limit hands the conversation to a person. Rows are
// the truth: events only wake the run. Every transaction is withTenant for the run's own client
// (invariant 1).

import {
  type ConverseTurnResult,
  checkAgainst,
  converseMaxChars,
  converseTurn,
} from "@countersign/agents";
import {
  type AgentBundle,
  CONVERSE_CHANNEL_WORDS,
  CONVERSE_FIXED_INPUTS,
  type ConverseAnswer,
  type ConverseChannel,
  ConverseInput,
  type ConverseLine,
  type ConverseOutcome,
  type ConverseOutput,
  channelTool,
  converseMessageNode,
  converseSubject,
  DEFAULT_APPROVAL,
  DEFAULT_QUIET_HOURS,
  Decimal,
  effectiveMode,
  fixedInputProblem,
  inWhatsAppWindow,
  isPlainObject,
  isUuid,
  type JsonObject,
  type JsonSchema,
  type Locale,
  levelFor,
  type PeopleBinding,
  parseDuration,
  pickMessage,
  planReachOut,
  QuietHours,
  type ReachChannel,
  ReachConditions,
  type ReachReply,
  routeApproval,
} from "@countersign/core";
import {
  agent,
  agentVersion,
  connection,
  contact,
  inboxItem,
  reachOut,
  run,
  type Tx,
  tenant,
  withTenant,
} from "@countersign/db";
import type {
  ResumeRequest,
  RunInfo,
  SkillStepRequest,
  StepOutcome,
  WaitRequest,
} from "@countersign/workflows";
import { and, asc, eq, gte, ne, sql } from "drizzle-orm";
import { type ContactRow, contactLanguage, reachContactOf } from "../messaging/contacts";
import { lastInboundAt } from "../messaging/services";
import {
  attemptFrom,
  endReachOut,
  planWhyApproval,
  type ReachDeps,
  type ReachOutRow,
  reachOutEventType,
  type StoredPlan,
} from "../reach/service";

export type ConverseDeps = ReachDeps;

// ── What a conversation keeps on its message rows ───────────────────────────────────────────────

/** Fixed when the conversation starts: kept on its first message's row. */
interface ConverseSetup {
  input: ConverseInput;
  contactId: string;
  contactName: string;
  role: string | null;
  language: Locale;
  startedAt: string;
  deadlineAt: string;
  /** Each message after the first needs its own signature (the person's autonomy, the stage). */
  perMessage: boolean;
  /** The step's model override, for every turn. */
  model?: { id: string; maxTokens?: number | undefined } | undefined;
}

/** `reach_out.plan.converse`: the turn that wrote this message. */
interface ConverseMeta {
  key: string;
  turn: number;
  kind: "ask" | "confirm" | "closing";
  /** A `confirm` message's proposed result. */
  proposed?: unknown;
  model: string;
  costUsd: string;
  tokensIn: number;
  tokensOut: number;
  /** On the first message only. */
  setup?: ConverseSetup;
  /** A hand-over item waiting for a person's answer. */
  handover?: { inboxItemId: string; reason: string };
  /** How it ended, once it did: a retried step returns this again. */
  end?: { outcome: ConverseOutcome; result: unknown; confirmed: boolean; reason: string | null };
}

type ConversePlan = StoredPlan & { converse: ConverseMeta };

function planOf(row: ReachOutRow): ConversePlan {
  return row.plan as unknown as ConversePlan;
}
function metaOf(row: ReachOutRow): ConverseMeta {
  return planOf(row).converse;
}
function sentAt(row: ReachOutRow): string | null {
  const a = ((row.attempts ?? []) as { status?: string; at?: string }[]).find(
    (x) => x.status === "sent",
  );
  return a?.at ?? null;
}
function textOf(row: ReachOutRow): string {
  const plan = planOf(row);
  return "template" in plan.message ? pickMessage(plan.message.template, plan.language) : "";
}

/** What the step's waits and approvals carry: the conversation's key, and what they wait on. */
export interface ConverseState {
  converse: { key: string; reachOutId?: string; handover?: string };
}

export function converseState(state: unknown): ConverseState["converse"] | null {
  if (!isPlainObject(state) || !isPlainObject(state.converse)) return null;
  const c = state.converse;
  return typeof c.key === "string" ? (c as ConverseState["converse"]) : null;
}

export interface ConversePort {
  start(req: SkillStepRequest): Promise<StepOutcome>;
  resume(req: ResumeRequest): Promise<StepOutcome>;
  waitDone(req: WaitRequest): Promise<boolean>;
  afterWait(req: WaitRequest & { timedOut: boolean }): Promise<StepOutcome>;
}

function clientQuietHours(settings: unknown) {
  const q = QuietHours.safeParse(
    (settings as { messaging?: { quietHours?: unknown } } | null)?.messaging?.quietHours,
  );
  return q.success ? q.data : DEFAULT_QUIET_HOURS;
}

function json(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

/** The record's data, as data, at most 8,000 characters. */
function clip(value: unknown): unknown {
  const s = JSON.stringify(value ?? null);
  return s.length <= 8000 ? JSON.parse(s) : `${s.slice(0, 8000)}…`;
}

/** Where a conversation's step runs: enough to log, route approvals and find its rows. */
interface Place {
  run: RunInfo;
  nodeId: string;
  stepRunId: string;
  key: string;
  approval: SkillStepRequest["approval"];
  stepApprover: string | undefined;
}

// ── The service ─────────────────────────────────────────────────────────────────────────────────

export function conversePort(deps: ConverseDeps): ConversePort {
  const now = () => deps.now?.() ?? deps.runtime.now?.() ?? new Date();
  const { db } = deps;

  const rowsOf = (tenantId: string, runId: string, key: string) =>
    withTenant(db, tenantId, (tx) =>
      tx
        .select()
        .from(reachOut)
        .where(
          and(
            eq(reachOut.tenantId, tenantId),
            eq(reachOut.runId, runId),
            eq(reachOut.subject, converseSubject(runId, key)),
          ),
        )
        .orderBy(asc(reachOut.createdAt)),
    ).then((rows) => rows.sort((a, b) => metaOf(a).turn - metaOf(b).turn));

  const setupOf = (rows: ReachOutRow[]): ConverseSetup => {
    const setup = rows[0] ? metaOf(rows[0]).setup : undefined;
    if (!setup) throw new Error("the conversation has no setup");
    return setup;
  };

  /** Who is talking, as the transcript reads it. */
  const transcriptOf = (rows: ReachOutRow[]): ConverseLine[] => {
    const lines: ConverseLine[] = [];
    for (const r of rows) {
      const at = sentAt(r);
      if (at) lines.push({ direction: "out", text: textOf(r), at, sourceId: r.id });
      const reply = r.reply as ReachReply | null;
      if (reply) {
        lines.push({
          direction: "in",
          text: reply.text,
          at: reply.at,
          sourceId: reply.rawRecordId ?? r.id,
        });
      }
    }
    return lines;
  };

  const outputOf = (
    rows: ReachOutRow[],
    end: { outcome: ConverseOutcome; result: unknown; confirmed: boolean; reason: string | null },
  ): ConverseOutput => {
    const setup = setupOf(rows);
    const transcript = transcriptOf(rows);
    const cost = rows.reduce((sum, r) => sum.plus(metaOf(r).costUsd || "0"), new Decimal(0));
    const sources = [
      ...setup.input.about,
      ...transcript.map((l) => l.sourceId).filter((s): s is string => !!s),
    ];
    return {
      outcome: end.outcome,
      result: end.result ?? null,
      confirmed: end.confirmed,
      who: { kind: "contact", id: setup.contactId, name: setup.contactName },
      channel: setup.input.channel,
      messages: transcript.filter((l) => l.direction === "out").length,
      replies: transcript.filter((l) => l.direction === "in").length,
      transcript,
      sources: [...new Set(sources)],
      reason: end.reason,
      costUsd: cost.toFixed(4),
    };
  };

  /** Ends the conversation: kept on its last row, so a retried step returns the same. */
  const finish = async (
    rows: ReachOutRow[],
    end: { outcome: ConverseOutcome; result: unknown; confirmed: boolean; reason: string | null },
  ): Promise<StepOutcome> => {
    const last = rows.at(-1) as ReachOutRow;
    const plan = planOf(last);
    await withTenant(db, last.tenantId, async (tx) => {
      await tx
        .update(reachOut)
        .set({
          plan: json({ ...plan, converse: { ...plan.converse, end } }),
          runReceivedAt: now(),
        })
        .where(and(eq(reachOut.id, last.id), eq(reachOut.tenantId, last.tenantId)));
    });
    return { kind: "done", output: outputOf(rows, end) };
  };

  /**
   * Hands the conversation to a person: whoever approves the conversation (the step's approver,
   * the approver rules, the agent's, the client's setting, else the client admin; a test run's to
   * the operator), with the goal and the transcript, the person's words quoted as theirs. The step
   * waits for the answer like a person step.
   *
   * DECISION (owner, 2026-11-08): the client's team runs its agents day to day and the operator
   * oversees, so a hand-over goes to the client's side unless the client's approvals are set to us.
   */
  const handOver = async (
    place: Place,
    rows: ReachOutRow[],
    reason: string,
    proposed: unknown = null,
  ): Promise<StepOutcome> => {
    const last = rows.at(-1) as ReachOutRow;
    const setup = setupOf(rows);
    const { run: info } = place;
    const t = now();
    const itemId = await withTenant(db, info.tenantId, async (tx) => {
      const { assignee } = await approverFor(tx, place, setup);
      const transcript = transcriptOf(rows).map((l) => ({
        from: l.direction === "out" ? "agent" : "them",
        text: l.text,
        at: l.at,
        ...(l.direction === "in" ? { theirWords: true } : {}),
      }));
      const [item] = await tx
        .insert(inboxItem)
        .values({
          tenantId: info.tenantId,
          kind: "request",
          agentId: info.agentId,
          subjectType: CONVERSE_HANDOVER_SUBJECT,
          subjectId: info.id,
          runId: info.id,
          ...assignee,
          title: `Take over the conversation with ${setup.contactName}: ${reason}`.slice(0, 200),
          payload: {
            mode: "ask",
            nodeId: place.nodeId,
            question: `Finish this with ${setup.contactName}: ${setup.input.goal}`.slice(0, 500),
            converse: {
              key: place.key,
              who: { id: setup.contactId, name: setup.contactName },
              channel: setup.input.channel,
              goal: setup.input.goal,
              reason,
              proposed: (proposed ?? null) as JsonObject[string],
              fields: Object.keys((setup.input.result.properties as Record<string, unknown>) ?? {}),
              transcript,
            },
            sources: setup.input.about,
            ...(info.mode === "test" ? { testRun: true } : {}),
          } as JsonObject,
          dueAt: new Date(t.getTime() + parseDuration(place.approval.timeout ?? "7 days")),
        })
        .returning({ id: inboxItem.id });
      if (!item) throw new Error("inbox item insert returned nothing");
      const plan = planOf(last);
      await tx
        .update(reachOut)
        .set({
          plan: json({
            ...plan,
            converse: { ...plan.converse, handover: { inboxItemId: item.id, reason } },
          }),
        })
        .where(and(eq(reachOut.id, last.id), eq(reachOut.tenantId, last.tenantId)));
      return item.id;
    });
    return {
      kind: "approval",
      pending: {
        inboxItemId: itemId,
        state: { converse: { key: place.key, handover: itemId } },
        waitingFor: "answer",
      },
    };
  };

  /** The wait for a reply to an open message (or its send, held by quiet hours). */
  const waitFor = (row: ReachOutRow, setup: ConverseSetup, key: string): StepOutcome => {
    const due = Math.min(
      row.dueAt?.getTime() ?? Number.POSITIVE_INFINITY,
      new Date(setup.deadlineAt).getTime(),
    );
    const remaining = Math.max(60_000, due - now().getTime());
    return {
      kind: "waiting",
      wait: {
        eventType: reachOutEventType(row.id),
        timeout: `${Math.ceil(remaining / 60_000)} minutes`,
        state: { converse: { key, reachOutId: row.id } },
      },
    };
  };

  /** Sends an open message (once: reach out's key), then what the step does next. */
  const send = async (place: Place, row: ReachOutRow): Promise<StepOutcome> => {
    const reach = { ...deps };
    await attemptFrom(reach, row.tenantId, row.id, now);
    // Held by quiet hours: the reply wait starts when it goes, not now.
    const [fresh] = await withTenant(db, row.tenantId, async (tx) => {
      const [r] = await tx
        .select()
        .from(reachOut)
        .where(and(eq(reachOut.id, row.id), eq(reachOut.tenantId, row.tenantId)));
      if (r && r.status === "open" && !sentAt(r) && r.nextAttemptAt) {
        const plan = planOf(r);
        const dueAt = new Date(r.nextAttemptAt.getTime() + parseDuration(plan.timeout));
        const [u] = await tx
          .update(reachOut)
          .set({ dueAt })
          .where(and(eq(reachOut.id, r.id), eq(reachOut.tenantId, r.tenantId)))
          .returning();
        return [u ?? r];
      }
      return [r];
    });
    if (!fresh) return { kind: "failed", error: "the conversation's message is gone" };
    return advance(place);
  };

  /** Makes message `n` (the model's answer already in hand) and sends it or asks for a signature. */
  const nextMessage = async (
    place: Place,
    rows: ReachOutRow[],
    answer:
      | Extract<ConverseAnswer, { action: "ask" | "confirm" }>
      | { action: "closing"; message: string },
    usage: { model: string; costUsd: string; tokensIn: number; tokensOut: number },
  ): Promise<StepOutcome> => {
    const setup = setupOf(rows);
    const first = rows[0] as ReachOutRow;
    const n = rows.length + 1;
    const { run: info } = place;
    const t = now();
    // WhatsApp's 24-hour window: a message after the first goes only inside it (§1.66).
    if (setup.input.channel === "whatsapp" && answer.action !== "closing") {
      const open = await withinWindow(info.tenantId, setup);
      if (!open) {
        return handOver(
          place,
          rows,
          "outside WhatsApp's 24-hour window: it has been more than a day since they wrote",
          answer.action === "confirm" ? answer.result : null,
        );
      }
    }
    const firstPlan = planOf(first);
    const plan: ConversePlan = {
      ...firstPlan,
      message: { template: { en: answer.message, [setup.language]: answer.message } },
      expectReply: answer.action !== "closing",
      automatic: !setup.perMessage,
      approvedBy: setup.perMessage ? null : firstPlan.approvedBy,
      replyTag: firstPlan.replyTag,
      converse: {
        key: place.key,
        turn: n,
        kind: answer.action === "closing" ? "closing" : answer.action,
        ...(answer.action === "confirm" ? { proposed: answer.result } : {}),
        ...usage,
      },
    };
    delete (plan as Partial<StoredPlan>).whatsappTemplate;
    const perMessage = setup.perMessage && answer.action !== "closing";
    const row = await withTenant(db, info.tenantId, async (tx) => {
      const [made] = await tx
        .insert(reachOut)
        .values({
          tenantId: info.tenantId,
          agentId: info.agentId,
          agentVersionId: info.agentVersionId,
          runId: info.id,
          stepRunId: place.stepRunId,
          nodeId: converseMessageNode(place.key, n),
          contactId: setup.contactId,
          role: setup.role,
          subject: converseSubject(info.id, place.key),
          purpose: setup.input.goal.slice(0, 500),
          urgency: "normal",
          plan: json(plan),
          status: perMessage ? "awaiting_approval" : "open",
          sources: setup.input.about,
          ...(perMessage
            ? {}
            : { dueAt: new Date(t.getTime() + parseDuration(setup.input.limits.waitPerReply)) }),
        })
        .onConflictDoNothing()
        .returning();
      if (!made) return null;
      if (!perMessage) return made;
      const sent = rows.filter((r) => sentAt(r)).length;
      const name = setup.contactName;
      const channel = CONVERSE_CHANNEL_WORDS[setup.input.channel];
      const [item] = await tx
        .insert(inboxItem)
        .values({
          tenantId: info.tenantId,
          kind: "approval",
          agentId: info.agentId,
          subjectType: "run",
          subjectId: info.id,
          runId: info.id,
          ...(await approverFor(tx, place, setup)).assignee,
          title:
            `Message ${sent + 1} of up to ${setup.input.limits.maxMessages} to ${name} on ${channel}`.slice(
              0,
              200,
            ),
          payload: {
            nodeId: converseMessageNode(place.key, n),
            reachOutId: made.id,
            converse: {
              kind: "message",
              turn: n,
              who: { id: setup.contactId, name },
              channel: setup.input.channel,
              goal: setup.input.goal,
              message: answer.message,
              transcript: transcriptOf(rows).map((l) => ({
                from: l.direction === "out" ? "agent" : "them",
                text: l.text,
                at: l.at,
              })),
              why: `${name}'s ${channel} messages need approval`,
            },
            sources: setup.input.about,
            ...(info.mode === "test" ? { testRun: true } : {}),
          } as JsonObject,
          dueAt: place.approval.timeout
            ? new Date(t.getTime() + parseDuration(place.approval.timeout))
            : null,
        })
        .returning({ id: inboxItem.id });
      if (!item) throw new Error("inbox item insert returned nothing");
      const [withItem] = await tx
        .update(reachOut)
        .set({ inboxItemId: item.id })
        .where(and(eq(reachOut.id, made.id), eq(reachOut.tenantId, made.tenantId)))
        .returning();
      return withItem ?? made;
    });
    // Made by an earlier try of this durable step: carry on from it.
    if (!row) return advance(place);
    if (row.status === "awaiting_approval") return advance(place);
    return send(place, row);
  };

  const approverFor = async (tx: Tx, place: Place, setup: ConverseSetup) => {
    const { run: info } = place;
    if (info.mode === "test") {
      return {
        assignee: { assigneeRole: "operator" as const, assigneeUserId: null },
        route: { source: "default" as const, ruleId: null },
      };
    }
    const routing = await deps.runtime.ports.store.approvalRouting(info.tenantId);
    const [a] = await tx
      .select({ approver: agent.approver, channels: agent.channels })
      .from(agent)
      .where(and(eq(agent.id, info.agentId), eq(agent.tenantId, info.tenantId)));
    const [v] = await tx
      .select({ bundle: agentVersion.bundle })
      .from(agentVersion)
      .where(
        and(eq(agentVersion.id, info.agentVersionId), eq(agentVersion.tenantId, info.tenantId)),
      );
    const connId = ((a?.channels ?? {}) as Record<string, string>)[setup.input.channel];
    const [conn] = connId
      ? await tx
          .select({ connector: connection.connector })
          .from(connection)
          .where(and(eq(connection.id, connId), eq(connection.tenantId, info.tenantId)))
      : [];
    const route = routeApproval({
      rules: routing.rules,
      facts: {
        connector: conn?.connector ?? "",
        tool:
          (conn ? channelTool(conn.connector, setup.input.channel as ReachChannel) : null) ??
          "comms.converse",
        verb: "create",
        agentId: info.agentId,
        amount: null,
      },
      step: place.stepApprover,
      agent: [v?.bundle.definition.permissions.approver, a?.approver],
      client: routing.clientDefault,
      members: routing.members,
    });
    return { assignee: route.assignee, route: { source: route.source, ruleId: route.ruleId } };
  };

  const withinWindow = (tenantId: string, setup: ConverseSetup) =>
    withTenant(db, tenantId, async (tx) => {
      const [c] = await tx
        .select({ whatsapp: contact.whatsapp })
        .from(contact)
        .where(and(eq(contact.id, setup.contactId), eq(contact.tenantId, tenantId)));
      if (!c?.whatsapp) return false;
      const last = await lastInboundAt(tx, tenantId, "whatsapp", c.whatsapp);
      return inWhatsAppWindow(last, now());
    });

  /** One turn: the model's answer, from the rows as they are. */
  const turn = async (place: Place, rows: ReachOutRow[]): Promise<ConverseTurnResult> => {
    const setup = setupOf(rows);
    const { run: info } = place;
    const [t] = await withTenant(db, info.tenantId, (tx) =>
      tx.select({ name: tenant.name }).from(tenant).where(eq(tenant.id, info.tenantId)),
    );
    const sent = rows.filter((r) => sentAt(r)).length;
    const last = rows.at(-1);
    const lastKind = last ? metaOf(last).kind : null;
    return converseTurn(deps.runtime, {
      tenantId: info.tenantId,
      runId: info.id,
      stepRunId: place.stepRunId,
      agentVersionId: info.agentVersionId,
      key: place.key,
      turn: rows.length + 1,
      model: setup.model,
      language: setup.language,
      goal: setup.input.goal,
      opening: setup.input.opening,
      result: setup.input.result as JsonSchema,
      confirm: setup.input.confirm,
      data: clip(setup.input.data),
      about: setup.input.about,
      who: { name: setup.contactName },
      channel: setup.input.channel,
      clientName: t?.name ?? "the client",
      transcript: transcriptOf(rows),
      lastAsked: lastKind === "closing" ? null : lastKind,
      messagesLeft: Math.max(0, setup.input.limits.maxMessages - sent),
      maxChars: converseMaxChars(setup.input.channel),
    });
  };

  /**
   * What the conversation does next, from its rows: the truth after any wake, approval or retry.
   * `timedOut`: the run's wait for the open message ended without its event.
   */
  const advance = async (place: Place, timedOut = false): Promise<StepOutcome> => {
    const { run: info } = place;
    const rows = await rowsOf(info.tenantId, info.id, place.key);
    const last = rows.at(-1);
    if (!last) return { kind: "failed", error: "the conversation has no messages" };
    const setup = setupOf(rows);
    const meta = metaOf(last);
    if (meta.end) return { kind: "done", output: outputOf(rows, meta.end) };
    if (meta.handover) {
      return {
        kind: "approval",
        pending: {
          inboxItemId: meta.handover.inboxItemId,
          state: { converse: { key: place.key, handover: meta.handover.inboxItemId } },
          waitingFor: "answer",
        },
      };
    }
    if (last.status === "awaiting_approval" && last.inboxItemId) {
      return {
        kind: "approval",
        pending: {
          inboxItemId: last.inboxItemId,
          state: { converse: { key: place.key, reachOutId: last.id } },
        },
      };
    }
    const t = now();
    if (last.status === "open") {
      const attempted = ((last.attempts ?? []) as unknown[]).length > 0;
      // Opened but not tried (a crash between), and not held by quiet hours: send it now.
      if (!attempted && !last.nextAttemptAt) return send(place, last);
      // The closing thank-you expects nothing back.
      if (meta.kind === "closing" && sentAt(last)) {
        await withTenant(db, last.tenantId, (tx) =>
          endReachOut(tx, last, { outcome: "no_reply", reason: "the closing message" }, t),
        );
        return advance(place);
      }
      const overdue =
        timedOut ||
        (last.dueAt !== null && last.dueAt <= t) ||
        new Date(setup.deadlineAt).getTime() <= t.getTime();
      if (!overdue) return waitFor(last, setup, place.key);
      const ended = await withTenant(db, last.tenantId, (tx) =>
        endReachOut(tx, last, { outcome: "no_reply", reason: "no reply in time" }, t),
      );
      if (!ended) return advance(place);
      return handOver(place, [...rows.slice(0, -1), ended], "no reply in time", meta.proposed);
    }

    // The last message ended.
    switch (last.outcome) {
      case "opted_out":
        return finish(rows, {
          outcome: "opted_out",
          result: null,
          confirmed: false,
          reason: "they opted out",
        });
      case "declined":
        return finish(rows, {
          outcome: "declined",
          result: null,
          confirmed: false,
          reason: last.reason ?? "not approved",
        });
      case "not_allowed": {
        if (!rows.some((r) => sentAt(r))) {
          return finish(rows, {
            outcome: "not_allowed",
            result: null,
            confirmed: false,
            reason: last.reason ?? "nothing could be sent",
          });
        }
        return handOver(place, rows, last.reason ?? "the message couldn't be sent", meta.proposed);
      }
      case "no_reply":
        if (meta.kind === "closing") {
          // Ended by the closing message: the outcome was decided before it.
          const before = rows.at(-2);
          const end = before ? metaOf(before).end : undefined;
          return finish(
            rows,
            end ?? { outcome: "completed", result: null, confirmed: false, reason: null },
          );
        }
        return handOver(place, rows, "no reply in time", meta.proposed);
      default:
        break;
    }

    // Replied: the next turn, within the limits.
    if (new Date(setup.deadlineAt).getTime() <= t.getTime()) {
      return handOver(place, rows, "the conversation's time ran out", meta.proposed);
    }
    const spent = rows.reduce((s, r) => s.plus(metaOf(r).costUsd || "0"), new Decimal(0));
    if (spent.gte(setup.input.limits.maxCostUsd)) {
      return handOver(place, rows, "it reached its spending limit", meta.proposed);
    }
    const r = await turn(place, rows);
    if (!r.ok) {
      // Kept on the last message's cost, then the step fails: oversight may retry the turn.
      await addTurnCost(last, r);
      return { kind: "failed", error: r.error };
    }
    const usage = {
      model: r.model,
      costUsd: r.costUsd,
      tokensIn: r.tokensIn,
      tokensOut: r.tokensOut,
    };
    const answer = r.answer;
    switch (answer.action) {
      case "give_up":
        await addTurnCost(last, r);
        return handOver(
          place,
          await rowsOf(info.tenantId, info.id, place.key),
          answer.reason,
          meta.proposed,
        );
      case "done": {
        await addTurnCost(last, r);
        const fresh = await rowsOf(info.tenantId, info.id, place.key);
        const end = {
          outcome: "completed" as const,
          result: answer.result,
          confirmed: setup.input.confirm ? answer.confirmed : false,
          reason: null,
        };
        if (answer.closing && !setup.perMessage) {
          // The outcome first, then the thank-you under the same rules (no reply expected).
          await finish(fresh, end);
          return nextMessage(
            place,
            await rowsOf(info.tenantId, info.id, place.key),
            {
              action: "closing",
              message: answer.closing,
            },
            { model: r.model, costUsd: "0", tokensIn: 0, tokensOut: 0 },
          );
        }
        return finish(fresh, end);
      }
      case "ask":
      case "confirm": {
        const sent = rows.filter((x) => sentAt(x)).length;
        if (sent >= setup.input.limits.maxMessages) {
          await addTurnCost(last, r);
          return handOver(
            place,
            await rowsOf(info.tenantId, info.id, place.key),
            "it reached its message limit",
            answer.action === "confirm" ? answer.result : meta.proposed,
          );
        }
        return nextMessage(place, rows, answer, usage);
      }
    }
  };

  /** A turn that wrote no message: its cost goes on the message it answered. */
  const addTurnCost = async (row: ReachOutRow, r: ConverseTurnResult) => {
    const plan = planOf(row);
    const c = plan.converse;
    await withTenant(db, row.tenantId, (tx) =>
      tx
        .update(reachOut)
        .set({
          plan: json({
            ...plan,
            converse: {
              ...c,
              costUsd: new Decimal(c.costUsd || "0").plus(r.costUsd).toFixed(4),
              tokensIn: c.tokensIn + r.tokensIn,
              tokensOut: c.tokensOut + r.tokensOut,
              ...(c.model === r.model ? {} : { model: `${c.model}, ${r.model}` }),
            },
          }),
        })
        .where(and(eq(reachOut.id, row.id), eq(reachOut.tenantId, row.tenantId))),
    );
  };

  const placeOf = (
    req: { run: RunInfo; nodeId: string; stepRunId: string; step: { approval?: unknown } },
    key: string,
    approval?: SkillStepRequest["approval"],
  ): Place => {
    const a =
      approval ??
      (req.step as { approval?: SkillStepRequest["approval"] }).approval ??
      DEFAULT_APPROVAL;
    return {
      run: req.run,
      nodeId: req.nodeId,
      stepRunId: req.stepRunId,
      key,
      approval: a,
      stepApprover: a.approver,
    };
  };

  return {
    async start(req) {
      const { run: info } = req;
      const parsed = ConverseInput.safeParse(req.input);
      if (!parsed.success) {
        return { kind: "failed", error: `invalid input: ${parsed.error.message}` };
      }
      const input = parsed.data;
      // The goal, the result and the brief become instructions: the step's own text (§1.23).
      const problem = fixedInputProblem(CONVERSE_FIXED_INPUTS, req.step.input, req.input);
      if (problem) return { kind: "failed", error: `refused: comms.converse: ${problem}` };
      // DECISION: a conversation is keyed by the step's key node, so oversight's `retry` picks it
      // up where it stopped and a `retry_with` starts a fresh one (docs/plan.md §1.66).
      const key = req.keyNode ?? req.nodeId;
      const place = placeOf(req, key, req.approval);
      const test = info.mode === "test";

      if (!test) {
        const existing = await rowsOf(info.tenantId, info.id, key);
        if (existing.length > 0) return advance(place);
      }

      if ("userId" in input.to) {
        // DECISION: the portal channel is designed (§10.12) but not built in this stream.
        return {
          kind: "done",
          output: refusedOutput(input, null, "talking in the portal isn't built yet"),
        };
      }

      const t = now();
      const started = await withTenant(db, info.tenantId, async (tx) => {
        const who = await whoFor(tx, info, input);
        if (typeof who === "string") return { kind: "refused" as const, reason: who, who: null };
        const {
          candidates,
          conditions,
          roleChannels,
          role,
          bundle,
          agentRow,
          tenantRow,
          channels,
        } = who;
        const client = {
          timezone: tenantRow.timezone,
          quietHours: clientQuietHours(tenantRow.settings),
        };
        const channel = input.channel as ReachChannel;
        let chosen: {
          who: ContactRow;
          plan: Extract<ReturnType<typeof planReachOut>, { ok: true }>;
        } | null = null;
        let refusal: {
          who: ContactRow;
          reason: string;
          outcome: "not_allowed" | "opted_out";
        } | null = null;
        for (const c of candidates) {
          // One at a time per person (§1.66): no other open reach-out or conversation to them.
          await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`reach:${c.id}`}))`);
          const [busy] = await tx
            .select({ id: reachOut.id })
            .from(reachOut)
            .where(
              and(
                eq(reachOut.tenantId, info.tenantId),
                eq(reachOut.contactId, c.id),
                ne(reachOut.status, "ended"),
              ),
            )
            .limit(1);
          if (busy) {
            refusal ??= {
              who: c,
              reason: "already waiting on them: another reach-out or conversation is open",
              outcome: "not_allowed",
            };
            continue;
          }
          const day = new Date(t.toISOString().slice(0, 10));
          const [count] = await tx
            .select({ n: sql<number>`count(*)::int` })
            .from(reachOut)
            .where(
              and(
                eq(reachOut.tenantId, info.tenantId),
                eq(reachOut.contactId, c.id),
                gte(reachOut.createdAt, day),
                sql`coalesce(${reachOut.outcome}, '') <> 'not_allowed'`,
                // A conversation counts once: its first message.
                sql`(${reachOut.subject} not like 'converse:%' or ${reachOut.nodeId} like '%:m1')`,
              ),
            );
          const plan = planReachOut({
            contact: reachContactOf(c),
            // The conversation's one channel, under the binding's other conditions.
            conditions: { ...conditions, urgency: { ...conditions.urgency, normal: [channel] } },
            roleChannels,
            urgency: "normal",
            boundChannels: new Set(
              [...channels].filter(([, x]) => x.create !== "off").map(([ch]) => ch),
            ),
            client,
            facts: { trigger: who.trigger, input: req.input },
            openForSubject: false,
            sentToday: count?.n ?? 0,
            now: t,
          });
          if (plan.ok) {
            chosen = { who: c, plan };
            break;
          }
          // DECISION: quiet hours hold a conversation's message until they end (the cron sends
          // it), rather than refuse the conversation: it is one channel, with nothing to fall to.
          if (plan.checks.length === 1 && plan.checks[0]?.block === "quiet_hours") {
            chosen = {
              who: c,
              plan: {
                ok: true,
                channels: [channel],
                escalateAfter: input.limits.waitPerReply,
                checks: plan.checks,
                needsSignature: reachContactOf(c).autonomy?.[channel] === "approval",
              },
            };
            break;
          }
          refusal ??= { who: c, reason: plan.reason, outcome: plan.outcome };
        }
        if (!chosen) {
          const r = refusal;
          return {
            kind: "refused" as const,
            reason: r?.reason ?? "nobody to talk with",
            who: r ? { id: r.who.id, name: r.who.name } : null,
            outcome: r?.outcome ?? ("not_allowed" as const),
          };
        }
        const language = (await contactLanguage(tx, chosen.who)).language as Locale;
        const definition = bundle.definition;
        const conn = channels.get(channel);
        const automatic =
          req.approval.required === "not_required" &&
          effectiveMode(definition, agentRow.stage) === "act" &&
          conn?.create === "auto" &&
          !chosen.plan.needsSignature;
        // DECISION: until the agent is live, and for a person whose channel needs approval, every
        // message is signed (invariant 8; docs/plan.md §1.42).
        const perMessage = chosen.plan.needsSignature || agentRow.stage !== "live";
        // WhatsApp's 24-hour window for the opening: a template outside it, or nothing.
        let template: StoredPlan["whatsappTemplate"];
        if (channel === "whatsapp" && chosen.who.whatsapp) {
          const last = await lastInboundAt(tx, info.tenantId, "whatsapp", chosen.who.whatsapp);
          if (!inWhatsAppWindow(last, t)) {
            if (!input.whatsappTemplate) {
              return {
                kind: "refused" as const,
                reason:
                  "outside WhatsApp's 24-hour window and no approved template for the first message",
                who: { id: chosen.who.id, name: chosen.who.name },
                outcome: "not_allowed" as const,
              };
            }
            template = input.whatsappTemplate;
          }
        }
        return {
          kind: "ready" as const,
          who: chosen.who,
          role,
          language,
          automatic,
          perMessage,
          template,
          checks: chosen.plan.checks,
          create: conn?.create,
          definitionMode: definition.permissions.mode,
          stage: agentRow.stage,
          needsSignature: chosen.plan.needsSignature,
        };
      });

      if (started.kind === "refused") {
        return {
          kind: "done",
          output: refusedOutput(
            input,
            started.who,
            started.reason,
            "outcome" in started && started.outcome === "opted_out" ? "opted_out" : "not_allowed",
          ),
        };
      }

      const setup: ConverseSetup = {
        input,
        contactId: started.who.id,
        contactName: started.who.name,
        role: started.role,
        language: started.language,
        startedAt: t.toISOString(),
        deadlineAt: new Date(t.getTime() + parseDuration(input.limits.deadline)).toISOString(),
        perMessage: started.perMessage,
        ...(req.step.model ? { model: req.step.model } : {}),
      };

      // The opening turn: the model writes the first message from the brief.
      const r = await converseTurn(deps.runtime, {
        tenantId: info.tenantId,
        runId: info.id,
        stepRunId: req.stepRunId,
        agentVersionId: info.agentVersionId,
        key,
        turn: 1,
        model: setup.model,
        language: setup.language,
        goal: input.goal,
        opening: input.opening,
        result: input.result as JsonSchema,
        confirm: input.confirm,
        data: clip(input.data),
        about: input.about,
        who: { name: setup.contactName },
        channel: input.channel,
        clientName: await withTenant(db, info.tenantId, async (tx) => {
          const [x] = await tx
            .select({ name: tenant.name })
            .from(tenant)
            .where(eq(tenant.id, info.tenantId));
          return x?.name ?? "the client";
        }),
        transcript: [],
        lastAsked: null,
        messagesLeft: input.limits.maxMessages,
        maxChars: converseMaxChars(input.channel),
      });
      if (!r.ok) return { kind: "failed", error: r.error };
      if (r.answer.action !== "ask" && r.answer.action !== "confirm") {
        return { kind: "failed", error: "turn 1: the first message must ask something" };
      }
      const opening = r.answer.message;
      if (test) {
        // Test runs never send: the first message as it would have gone.
        return {
          kind: "done",
          output: {
            ...refusedOutput(
              input,
              { id: setup.contactId, name: setup.contactName },
              "a test run: nothing was sent",
              "not_sent",
            ),
            testRun: true,
            opening,
            costUsd: r.costUsd,
          },
        };
      }

      const plan: ConversePlan = {
        channels: [input.channel as ReachChannel],
        escalateAfter: input.limits.waitPerReply,
        language: setup.language,
        message: { template: { en: opening, [setup.language]: opening } },
        emailSubject: input.goal.slice(0, 200),
        expectReply: true,
        timeout: input.limits.waitPerReply,
        urgentOutsideHours: false,
        automatic: started.automatic,
        approvedBy: null,
        replyTag: "",
        data: {},
        checks: started.checks,
        ...(started.template ? { whatsappTemplate: started.template } : {}),
        converse: {
          key,
          turn: 1,
          kind: r.answer.action,
          ...(r.answer.action === "confirm" ? { proposed: r.answer.result } : {}),
          model: r.model,
          costUsd: r.costUsd,
          tokensIn: r.tokensIn,
          tokensOut: r.tokensOut,
          setup,
        },
      };
      const made = await withTenant(db, info.tenantId, async (tx) => {
        const [row] = await tx
          .insert(reachOut)
          .values({
            tenantId: info.tenantId,
            agentId: info.agentId,
            agentVersionId: info.agentVersionId,
            runId: info.id,
            stepRunId: req.stepRunId,
            nodeId: converseMessageNode(key, 1),
            contactId: setup.contactId,
            role: setup.role,
            subject: converseSubject(info.id, key),
            purpose: input.goal.slice(0, 500),
            urgency: "normal",
            plan: json(plan),
            status: started.automatic ? "open" : "awaiting_approval",
            sources: input.about,
            ...(started.automatic
              ? { dueAt: new Date(t.getTime() + parseDuration(input.limits.waitPerReply)) }
              : {}),
          })
          .onConflictDoNothing()
          .returning();
        if (!row) return null;
        // Replies by email find the conversation by its first message's tag.
        const tagged: ConversePlan = { ...plan, replyTag: row.id.replace(/-/g, "") };
        await tx
          .update(reachOut)
          .set({ plan: json(tagged) })
          .where(and(eq(reachOut.id, row.id), eq(reachOut.tenantId, row.tenantId)));
        if (started.automatic) return { ...row, plan: json(tagged) };
        // One signature for the conversation: who, the channel, the goal, the limits and the
        // first message as written, routed like a reach-out's plan.
        const channel = CONVERSE_CHANNEL_WORDS[input.channel];
        const { assignee, route } = await approverFor(tx, place, setup);
        const [item] = await tx
          .insert(inboxItem)
          .values({
            tenantId: info.tenantId,
            kind: "approval",
            agentId: info.agentId,
            subjectType: "run",
            subjectId: info.id,
            runId: info.id,
            ...assignee,
            title: `Talk with ${setup.contactName} on ${channel}: ${input.goal}`.slice(0, 200),
            payload: {
              nodeId: converseMessageNode(key, 1),
              reachOutId: row.id,
              converse: {
                kind: "conversation",
                who: { id: setup.contactId, name: setup.contactName },
                role: setup.role,
                channel: input.channel,
                goal: input.goal,
                limits: input.limits,
                message: opening,
                language: setup.language,
                ...(started.template ? { template: started.template.id } : {}),
                eachMessageSigned: setup.perMessage,
              },
              sources: input.about,
              whyApproval: planWhyApproval({
                levels: [started.create],
                stepApproval: req.approval.required,
                definitionMode: started.definitionMode,
                stage: started.stage,
                needsSignature: started.needsSignature,
                route,
              }) as JsonObject,
            } as JsonObject,
            dueAt: req.approval.timeout
              ? new Date(t.getTime() + parseDuration(req.approval.timeout))
              : null,
          })
          .returning({ id: inboxItem.id });
        if (!item) throw new Error("inbox item insert returned nothing");
        const [withItem] = await tx
          .update(reachOut)
          .set({ inboxItemId: item.id })
          .where(and(eq(reachOut.id, row.id), eq(reachOut.tenantId, row.tenantId)))
          .returning();
        return withItem ?? row;
      });
      if (!made || made.status === "awaiting_approval") return advance(place);
      return send(place, made);
    },

    async resume(req) {
      const state = converseState(req.pending.state);
      if (!state) return { kind: "failed", error: "not a conversation" };
      const place = placeOf(req, state.key);
      const { tenantId } = req.run;
      if (state.handover) {
        const rows = await rowsOf(tenantId, req.run.id, state.key);
        const setup = setupOf(rows);
        const last = rows.at(-1) as ReachOutRow;
        const reason = metaOf(last).handover?.reason ?? "handed over";
        const answer = req.resolution.answer;
        // The person's answer is the result when it fits the goal (§1.66).
        const fits =
          answer !== undefined && checkAgainst(setup.input.result as JsonSchema, answer).ok;
        // Cleared so the end is final; a declined hand-over is the step's onReject.
        const plan = planOf(last);
        await withTenant(db, tenantId, (tx) =>
          tx
            .update(reachOut)
            .set({ plan: json({ ...plan, converse: { ...plan.converse, handover: undefined } }) })
            .where(and(eq(reachOut.id, last.id), eq(reachOut.tenantId, tenantId))),
        );
        return finish(await rowsOf(tenantId, req.run.id, state.key), {
          outcome: "handed_over",
          result: req.resolution.approved === true && fits ? answer : null,
          confirmed: false,
          reason,
        });
      }
      if (!state.reachOutId) return { kind: "failed", error: "not a conversation's message" };
      const rows = await rowsOf(tenantId, req.run.id, state.key);
      const row = rows.find((r) => r.id === state.reachOutId);
      if (!row) return { kind: "failed", error: "the conversation's message is gone" };
      if (row.status === "awaiting_approval") {
        const t = now();
        if (req.resolution.approved !== true) {
          // DECISION: a message (or the conversation) its approver turned down ends it as
          // `declined`: nothing more is sent, and the step's onReject applies.
          await withTenant(db, tenantId, (tx) =>
            endReachOut(tx, row, { outcome: "declined", reason: "not approved" }, t),
          );
          return advance(place);
        }
        const plan = planOf(row);
        const [opened] = await withTenant(db, tenantId, (tx) =>
          tx
            .update(reachOut)
            .set({
              status: "open",
              plan: json({ ...plan, approvedBy: req.resolution.by }),
              dueAt: new Date(t.getTime() + parseDuration(plan.timeout)),
            })
            .where(
              and(
                eq(reachOut.id, row.id),
                eq(reachOut.tenantId, tenantId),
                eq(reachOut.status, "awaiting_approval"),
              ),
            )
            .returning(),
        );
        if (opened) return send(place, opened);
      }
      return advance(place);
    },

    async waitDone(req) {
      const state = converseState(req.wait.state);
      if (!state?.reachOutId) return true;
      const [row] = await withTenant(db, req.run.tenantId, (tx) =>
        tx
          .select({ status: reachOut.status })
          .from(reachOut)
          .where(
            and(
              eq(reachOut.id, state.reachOutId as string),
              eq(reachOut.tenantId, req.run.tenantId),
            ),
          ),
      );
      return !row || row.status === "ended";
    },

    async afterWait(req) {
      const state = converseState(req.wait.state);
      if (!state) return { kind: "failed", error: "not a conversation" };
      return advance(placeOf(req, state.key), req.timedOut);
    },
  };

  /** Who the step talks with: the role's bound contacts in order, or the contact named. */
  async function whoFor(tx: Tx, info: RunInfo, input: ConverseInput) {
    const [agentRow] = await tx
      .select()
      .from(agent)
      .where(and(eq(agent.id, info.agentId), eq(agent.tenantId, info.tenantId)));
    const [v] = await tx
      .select({ bundle: agentVersion.bundle })
      .from(agentVersion)
      .where(
        and(eq(agentVersion.id, info.agentVersionId), eq(agentVersion.tenantId, info.tenantId)),
      );
    const [tenantRow] = await tx.select().from(tenant).where(eq(tenant.id, info.tenantId));
    const [runRow] = await tx
      .select({ trigger: run.trigger })
      .from(run)
      .where(and(eq(run.id, info.id), eq(run.tenantId, info.tenantId)));
    if (!agentRow || !v || !tenantRow) return "the agent or its client is gone";
    const bundle: AgentBundle = v.bundle;
    const people = (agentRow.people ?? {}) as Record<string, PeopleBinding>;
    let candidates: ContactRow[] = [];
    let conditions: ReachConditions = {};
    let roleChannels: ReachChannel[] | undefined;
    let role: string | null = null;
    if ("role" in input.to) {
      role = input.to.role;
      const declared = (bundle.people ?? []).find((p) => p.role === role);
      if (!declared) return `this agent has no role "${role}"`;
      roleChannels = declared.channels;
      const binding = people[role];
      conditions = ReachConditions.safeParse(binding?.conditions ?? {}).data ?? {};
      const ids = binding?.contactIds ?? [];
      if (ids.length === 0) return `nobody is bound to the role ${role}`;
      const rows = await tx.select().from(contact).where(eq(contact.tenantId, info.tenantId));
      candidates = ids.flatMap((id) => rows.filter((r) => r.id === id));
    } else if ("contactId" in input.to) {
      const id = input.to.contactId;
      if (!isUuid(id)) return "no contact to talk with";
      const [row] = await tx
        .select()
        .from(contact)
        .where(and(eq(contact.tenantId, info.tenantId), eq(contact.id, id)));
      if (!row) return "that contact is not one of this client's";
      candidates = [row];
      const found = Object.entries(people).find(([, b]) => b.contactIds.includes(row.id));
      if (found) {
        role = found[0];
        conditions = ReachConditions.safeParse(found[1].conditions ?? {}).data ?? {};
        roleChannels = (bundle.people ?? []).find((p) => p.role === role)?.channels;
      }
    }
    if (candidates.length === 0) return "no contact to talk with";
    const bound = (agentRow.channels ?? {}) as Record<string, string>;
    const conns = await tx.select().from(connection).where(eq(connection.tenantId, info.tenantId));
    const channels = new Map<ReachChannel, { id: string; connector: string; create: string }>();
    for (const [ch, id] of Object.entries(bound)) {
      const c = conns.find((x) => x.id === id);
      if (c?.status !== "connected" || !channelTool(c.connector, ch as ReachChannel)) continue;
      channels.set(ch as ReachChannel, {
        id: c.id,
        connector: c.connector,
        create: levelFor(c.permissions, "create"),
      });
    }
    return {
      agentRow,
      bundle,
      tenantRow,
      trigger: (runRow?.trigger as { payload?: unknown } | undefined)?.payload ?? null,
      candidates,
      conditions,
      roleChannels,
      role,
      channels,
    };
  }
}

/** The inbox subject of a conversation handed to a person. */
export const CONVERSE_HANDOVER_SUBJECT = "conversation_handover";

function refusedOutput(
  input: ConverseInput,
  who: { id: string; name: string } | null,
  reason: string,
  outcome: ConverseOutcome = "not_allowed",
): ConverseOutput {
  return {
    outcome,
    result: null,
    confirmed: false,
    who: who ? { kind: "contact", ...who } : null,
    channel: input.channel as ConverseChannel,
    messages: 0,
    replies: 0,
    transcript: [],
    sources: input.about,
    reason,
    costUsd: "0.0000",
  };
}
