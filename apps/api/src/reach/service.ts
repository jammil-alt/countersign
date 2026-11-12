// Reach out (docs/plan.md §1.25): the `comms.reach-out` step, carried out over the database and the
// runtime. A step plans the reach-out in code (who, which channels in what order, escalation) from
// the person's role binding, the contact's consent and hours, and the agent's bound channels; one
// approval covers that plan (routed like any write's approval); each attempt then runs as its own
// external action with its own key; the run waits for the reply or the timeout like a person step,
// with escalation driven by the cron. The reach-out row is the truth: events only wake the run.
// Replies are untrusted data (invariants 9 and 12); every attempt and reply is written in the
// contact's thread with the run, the agent version and the sources (invariant 10). Test runs never
// send. Every transaction is withTenant for the run's own client (invariant 1).

import {
  composeReachMessage,
  type PinnedAgent,
  type RuntimeDeps,
  runPlannedAction,
  type StepContext,
} from "@countersign/agents";
import {
  type AgentMode,
  type AnyAgentBundle,
  type ApprovalRequirement,
  type ApprovalSource,
  // P-3: attachments both ways
  type AttachmentSummary,
  channelAddress,
  channelTool,
  consentBlockFor,
  contactHours,
  DEFAULT_QUIET_HOURS,
  type Duration,
  effectiveMode,
  explainWrite,
  fixedInputProblem,
  hoursBlock,
  // P-4
  isConverseSubject,
  isPlainObject,
  isSendableType,
  type JsonObject,
  type Locale,
  type ModelChoice,
  nextEscalation,
  ownerSignature,
  type PeopleBinding,
  parseDuration,
  pickMessage,
  planReachOut,
  QuietHours,
  quietHoursEnd,
  REACH_OUT_FIXED_INPUTS,
  REACH_OUT_SKILL,
  type ReachChannel,
  ReachConditions,
  type ReachLanguage,
  ReachOutInput,
  type ReachOutOutput,
  type ReachPlan,
  type ReachReply,
  reachSubject,
  routeApproval,
  type Urgency,
  type WhyApproval,
} from "@countersign/core";
import {
  agent,
  agentVersion,
  connection,
  contact,
  type Db,
  document,
  inboxItem,
  message,
  reachOut,
  run,
  type Tx,
  tenant,
  withTenant,
} from "@countersign/db";
import type {
  ResumeRequest,
  SkillStepRequest,
  StepOutcome,
  WaitRequest,
} from "@countersign/workflows";
import { and, eq, gte, inArray, isNull, lte, ne, sql } from "drizzle-orm";
import { accountBindings, pickChannel, sendingChannels } from "../channels/resolve";
// R7
import { conversationEventOfSubject, sendWithConversation } from "../converse/wake";
import {
  type ContactRow,
  contactLanguage,
  contactThread,
  reachContactOf,
  type ThreadMessageBody,
} from "../messaging/contacts";
import { reportHandled } from "../observability/report";
import { areaOfAgent, ensureAreaOwner } from "../owners/store";
import type { RunInstances } from "../runs/instances";
// P-3: attachments both ways
import {
  pendingReplies,
  REPLY_MEDIA_WAIT_MS,
  replyOverdue,
  replyPending,
  settlePendingReply,
} from "./reply-media";

export type ReachOutRow = typeof reachOut.$inferSelect;

export interface ReachDeps {
  db: Db;
  runtime: RuntimeDeps;
  /** Wakes a run whose reach-out ended; without it the cron's redelivery does. */
  instances?: RunInstances;
  now?: () => Date;
}

/** What `reach_out.plan` keeps: everything the attempts need, fixed when the plan is made. */
export interface StoredPlan {
  channels: ReachChannel[];
  escalateAfter: Duration;
  language: ReachLanguage;
  message: ReachOutInput["message"];
  emailSubject: string;
  expectReply: boolean;
  timeout: Duration;
  urgentOutsideHours: boolean;
  automatic: boolean;
  approvedBy: string | null;
  /** In the reply-to address of emails, so a reply finds this reach-out. */
  replyTag: string;
  /** The record's data a composed message is written from (data, never instructions). */
  data: JsonObject;
  /** Why each channel the urgency asked for passed or not, when planned. */
  checks: { channel: ReachChannel; block: string | null }[];
  /** v0.13: the step's model override for composed messages (absent: the agent's). */
  model?: ModelChoice;
  // P-4: conversations (docs/plan.md §1.66)
  /** WhatsApp: an approved template, sent when the person hasn't written in 24 hours. */
  whatsappTemplate?: { id: string; variables: Record<string, string> };
  // P-3
  /** The documents sent with each attempt, checked as this client's when the plan was made. */
  attachments?: AttachmentSummary[];
}

export interface Attempt {
  index: number;
  channel: ReachChannel;
  at: string;
  status: "sent" | "failed";
  actionId?: string;
  /** The provider's id: SM…, CA… or the email's. */
  ref?: string;
  error?: string;
}

/** The event a run waits on for one reach-out. */
export function reachOutEventType(id: string): string {
  return `reachout-${id.replace(/-/g, "")}`;
}

function planOf(row: ReachOutRow): StoredPlan {
  return row.plan as unknown as StoredPlan;
}
function attemptsOf(row: ReachOutRow): Attempt[] {
  return (row.attempts ?? []) as unknown as Attempt[];
}

const CHANNEL_WORDS: Record<ReachChannel, string> = {
  email: "email",
  sms: "text",
  whatsapp: "WhatsApp",
  voice: "call",
};

/**
 * The longest message a reach-out writes on a channel (a WhatsApp file's caption is at most 1024
 * characters). P-6: a person's edit of a message before approving it is held to the same.
 */
export function reachMaxChars(channel: ReachChannel, withAttachments: boolean): number {
  if (channel === "sms") return 320;
  if (channel === "voice") return 300;
  if (channel === "whatsapp" && withAttachments) return 1000;
  return 1500;
}

// ── Thread lines ────────────────────────────────────────────────────────────────────────────────

async function threadLine(
  tx: Tx,
  row: Pick<ReachOutRow, "id" | "runId" | "agentVersionId" | "sources">,
  who: ContactRow,
  line: { direction: "in" | "out"; channel: ReachChannel; text: string; status: string },
  senderType: "agent" | "contact" | "system" = "agent",
) {
  const threadId = await contactThread(tx, who);
  const body: ThreadMessageBody = {
    direction: line.direction,
    channel: line.channel === "voice" ? "voice" : line.channel,
    text: line.text,
    sid: "",
    rawRecordId: "",
    status: line.status,
    reachOut: {
      id: row.id,
      runId: row.runId,
      agentVersionId: row.agentVersionId,
      sources: row.sources ?? [],
    },
  };
  await tx.insert(message).values({
    tenantId: who.tenantId,
    threadId,
    senderType,
    ...(senderType === "contact" ? { senderId: who.id } : {}),
    agentVersionId: senderType === "agent" ? row.agentVersionId : null,
    body: body as unknown as Record<string, unknown>,
    sources: row.sources ?? [],
  });
}

// ── Output ──────────────────────────────────────────────────────────────────────────────────────

function outputOf(row: ReachOutRow, who: { id: string; name: string } | null): ReachOutOutput {
  const attempts = attemptsOf(row);
  const sent = attempts.filter((a) => a.status === "sent");
  // P-3: the reply's documents for later steps (none on replies stored before them).
  const stored = (row.reply as ReachReply | null) ?? null;
  const reply = stored ? replyForStep(stored) : null;
  return {
    outcome: row.outcome ?? "no_reply",
    channel: reply?.channel ?? sent.at(-1)?.channel ?? null,
    reply,
    contact: who,
    reason: row.reason,
    attempts: sent.length,
    sources: row.sources ?? [],
    reachOutId: row.id,
  };
}

// P-3: the reply as a step's output: its documents always a list, never `pending`.
function replyForStep(stored: ReachReply): ReachReply {
  const { pending: _pending, ...rest } = stored;
  return { ...rest, documents: stored.documents ?? [] };
}

/** P-3: the documents a reach-out sends, each this client's PDF or image; else why not. */
async function attachmentsOf(
  tx: Tx,
  tenantId: string,
  ids: readonly string[] | undefined,
): Promise<AttachmentSummary[] | string> {
  if (!ids?.length) return [];
  const rows = await tx
    .select({
      id: document.id,
      filename: document.filename,
      mimeType: document.mimeType,
      sizeBytes: document.sizeBytes,
    })
    .from(document)
    .where(and(eq(document.tenantId, tenantId), inArray(document.id, [...ids])));
  const out: AttachmentSummary[] = [];
  for (const id of ids) {
    const d = rows.find((r) => r.id === id);
    // The same answer for an unknown id and another client's.
    if (!d) return `document ${id} is not this client's`;
    if (!isSendableType(d.mimeType)) return `${d.filename} is not a PDF or an image`;
    out.push({
      documentId: d.id,
      filename: d.filename,
      mimeType: d.mimeType,
      sizeBytes: d.sizeBytes,
    });
  }
  return out;
}

function notAllowed(
  reason: string,
  who: { id: string; name: string } | null,
  sources: string[],
  outcome: "not_allowed" | "opted_out" = "not_allowed",
  reachOutId: string | null = null,
): ReachOutOutput {
  return {
    outcome,
    channel: null,
    reply: null,
    contact: who,
    reason,
    attempts: 0,
    sources,
    reachOutId,
  };
}

// ── Ending ──────────────────────────────────────────────────────────────────────────────────────

/** Ends an open (or awaiting) reach-out once; returns the row as it now is. */
export async function endReachOut(
  tx: Tx,
  row: ReachOutRow,
  end: {
    outcome: NonNullable<ReachOutRow["outcome"]>;
    reason?: string | null;
    reply?: ReachReply | null;
  },
  now: Date,
): Promise<ReachOutRow | null> {
  const [updated] = await tx
    .update(reachOut)
    .set({
      status: "ended",
      outcome: end.outcome,
      reason: end.reason ?? null,
      ...(end.reply ? { reply: end.reply as unknown as Record<string, unknown> } : {}),
      nextAttemptAt: null,
      endedAt: now,
    })
    .where(
      and(
        eq(reachOut.id, row.id),
        eq(reachOut.tenantId, row.tenantId),
        ne(reachOut.status, "ended"),
      ),
    )
    .returning();
  return updated ?? null;
}

/** Wakes the run (best effort: the cron re-sends until the run takes it). */
async function wake(
  deps: Pick<ReachDeps, "instances">,
  row: Pick<ReachOutRow, "id" | "runId" | "subject">,
) {
  if (!deps.instances) return;
  try {
    // R7: a conversation's message wakes a v4 conversation step too (its own event).
    await sendWithConversation(
      deps.instances,
      row.runId,
      { type: reachOutEventType(row.id), payload: { reachOutId: row.id } },
      conversationEventOfSubject(row.subject),
    );
  } catch (error) {
    reportHandled(`waking run ${row.runId} for reach-out ${row.id} failed`, error, {
      job: "reach",
    });
  }
}

// ── Planning (the step starts) ──────────────────────────────────────────────────────────────────

interface Loaded {
  agentRow: typeof agent.$inferSelect;
  bundle: AnyAgentBundle;
  tenantRow: typeof tenant.$inferSelect;
  trigger: unknown;
  candidates: ContactRow[];
  conditions: ReachConditions;
  roleChannels: ReachChannel[] | undefined;
  role: string | null;
  /** channel → [connection id, connector, its create level]. */
  channels: Map<ReachChannel, { id: string; connector: string; create: string }>;
}

function clientQuietHours(settings: unknown) {
  const q = QuietHours.safeParse(
    (settings as { messaging?: { quietHours?: unknown } } | null)?.messaging?.quietHours,
  );
  return q.success ? q.data : DEFAULT_QUIET_HOURS;
}

async function load(tx: Tx, req: SkillStepRequest, input: ReachOutInput): Promise<Loaded | string> {
  const { run: info } = req;
  const [agentRow] = await tx
    .select()
    .from(agent)
    .where(and(eq(agent.id, info.agentId), eq(agent.tenantId, info.tenantId)));
  const [v] = await tx
    .select({ bundle: agentVersion.bundle })
    .from(agentVersion)
    .where(and(eq(agentVersion.id, info.agentVersionId), eq(agentVersion.tenantId, info.tenantId)));
  const [tenantRow] = await tx.select().from(tenant).where(eq(tenant.id, info.tenantId));
  const [runRow] = await tx
    .select({ trigger: run.trigger })
    .from(run)
    .where(and(eq(run.id, info.id), eq(run.tenantId, info.tenantId)));
  if (!agentRow || !v || !tenantRow) return "the agent or its client is gone";

  let candidates: ContactRow[] = [];
  let conditions: ReachConditions = {};
  let roleChannels: ReachChannel[] | undefined;
  let role: string | null = null;
  const people = (agentRow.people ?? {}) as Record<string, PeopleBinding>;
  if ("role" in input.to) {
    role = input.to.role;
    const declared = (v.bundle.people ?? []).find((p) => p.role === role);
    if (!declared) return `this agent has no role "${role}"`;
    roleChannels = declared.channels;
    const binding = people[role];
    conditions = ReachConditions.safeParse(binding?.conditions ?? {}).data ?? {};
    const ids = binding?.contactIds ?? [];
    if (ids.length) {
      const rows = await tx
        .select()
        .from(contact)
        .where(and(eq(contact.tenantId, info.tenantId), inArray(contact.id, ids)));
      candidates = ids.flatMap((id) => rows.filter((r) => r.id === id));
    }
  } else {
    const contactId = input.to.contactId;
    const [row] = await tx
      .select()
      .from(contact)
      .where(and(eq(contact.tenantId, info.tenantId), eq(contact.id, contactId)));
    if (!row) return "that contact is not one of this client's";
    candidates = [row];
    // A contact bound to one of the agent's roles is reached under that binding's conditions.
    const found = Object.entries(people).find(([, b]) => b.contactIds.includes(row.id));
    if (found) {
      role = found[0];
      conditions = ReachConditions.safeParse(found[1].conditions ?? {}).data ?? {};
      roleChannels = (v.bundle.people ?? []).find((p) => p.role === role)?.channels;
    }
  }

  // R4: the agent's own channels, else the account's (../channels/resolve.ts), as the portal shows.
  const conns = await tx.select().from(connection).where(eq(connection.tenantId, info.tenantId));
  const channels = sendingChannels(
    agentRow.channels as Record<string, string> | null,
    accountBindings(tenantRow.settings),
    conns,
  );
  return {
    agentRow,
    bundle: v.bundle,
    tenantRow,
    trigger: (runRow?.trigger as { payload?: unknown } | undefined)?.payload ?? null,
    candidates,
    conditions,
    roleChannels,
    role,
    channels,
  };
}

/** One open reach-out per contact and subject, and how many today, for the evaluator. */
async function contactLoad(
  tx: Tx,
  tenantId: string,
  contactId: string,
  subject: string,
  now: Date,
) {
  const day = new Date(now.toISOString().slice(0, 10));
  const [open] = await tx
    .select({ id: reachOut.id })
    .from(reachOut)
    .where(
      and(
        eq(reachOut.tenantId, tenantId),
        eq(reachOut.contactId, contactId),
        eq(reachOut.subject, subject),
        ne(reachOut.status, "ended"),
      ),
    )
    .limit(1);
  const [count] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(reachOut)
    .where(
      and(
        eq(reachOut.tenantId, tenantId),
        eq(reachOut.contactId, contactId),
        gte(reachOut.createdAt, day),
        sql`coalesce(${reachOut.outcome}, '') <> 'not_allowed'`,
        // P-4: a conversation counts once toward the daily cap: its first message.
        sql`(${reachOut.subject} not like 'converse:%' or ${reachOut.nodeId} like '%:m1')`,
      ),
    );
  // P-4: one at a time per person (§1.66): someone in an open conversation isn't reached.
  const [talking] = await tx
    .select({ id: reachOut.id })
    .from(reachOut)
    .where(
      and(
        eq(reachOut.tenantId, tenantId),
        eq(reachOut.contactId, contactId),
        ne(reachOut.status, "ended"),
        sql`${reachOut.subject} like 'converse:%'`,
      ),
    )
    .limit(1);
  return {
    openForSubject: Boolean(open),
    sentToday: count?.n ?? 0,
    inConversation: Boolean(talking),
  };
}

function hexId(id: string): string {
  return id.replace(/-/g, "");
}

function truncateData(value: unknown): JsonObject {
  const s = JSON.stringify(value ?? null);
  if (s.length <= 8000) return { value: JSON.parse(s) };
  return { value: `${s.slice(0, 8000)}…` };
}

export interface ReachPort {
  start(req: SkillStepRequest): Promise<StepOutcome>;
  resume(req: ResumeRequest): Promise<StepOutcome>;
  waitDone(req: WaitRequest): Promise<boolean>;
  afterWait(req: WaitRequest & { timedOut: boolean }): Promise<StepOutcome>;
}

/**
 * Why a reach-out's plan waits for a person (ARCHITECTURE §11.1), over the inputs its decision
 * used: the step, each planned channel's `create` level, the agent's mode and go-live stage, and
 * the person's own autonomy (`person`). Stored as the plan approval's `payload.whyApproval`.
 */
// DECISION: a plan is one approval over several channels, so `matrix` is named when any planned
// channel's connection allows `create` only with approval (the plan runs on its own only when every
// one is `auto`), and `person` when the contact set any planned channel to `approval`. A plan has
// no grant (reach out uses the agent's bound channels).
export function planWhyApproval(input: {
  levels: readonly (string | undefined)[];
  stepApproval: ApprovalRequirement | undefined;
  definitionMode: AgentMode;
  stage: string | null | undefined;
  needsSignature: boolean;
  /** Where the approval went; left out when only the reasons are wanted (`unsignedSendRefusal`). */
  route?: { source: ApprovalSource; ruleId: string | null };
}): WhyApproval {
  return explainWrite({
    verb: "create",
    matrix: { create: input.levels.every((l) => l === "auto") ? "auto" : "approval" },
    stepApproval: input.stepApproval,
    agentMode: effectiveMode({ permissions: { mode: input.definitionMode } }, input.stage),
    definitionMode: input.definitionMode,
    stage: input.stage,
    person: input.needsSignature ? "approval" : null,
    ...(input.route ? { route: input.route } : {}),
  });
}

/**
 * Why a reach-out's plan, or a conversation's message (each a reach-out row), may not go out with
 * nobody's signature now, or null when it would have gone out unsigned: the step's approval
 * `not_required` (what `ifNoAnswer: proceed` stands for once nobody answered), every planned
 * channel's `create` at `auto`, the agent's own mode `act` at the `live` stage and no planned
 * channel the person set to `approval`, each read fresh, as a plan is decided when it is made.
 */
// DECISION (wave 2c): a message nobody signed is decided again by the gate before it goes, as an
// external action is (packages/agents `unsignedRefusal`), with the inputs the plan's own decision
// used (`planWhyApproval`): a client who tightened a channel, a person set to `approval`, or an
// agent no longer live keeps it from going.
export async function unsignedSendRefusal(tx: Tx, row: ReachOutRow): Promise<string | null> {
  const { tenantId } = row;
  const [agentRow] = await tx
    .select({ stage: agent.stage, channels: agent.channels })
    .from(agent)
    .where(and(eq(agent.id, row.agentId), eq(agent.tenantId, tenantId)));
  const [v] = await tx
    .select({ bundle: agentVersion.bundle })
    .from(agentVersion)
    .where(and(eq(agentVersion.id, row.agentVersionId), eq(agentVersion.tenantId, tenantId)));
  const [tenantRow] = await tx
    .select({ settings: tenant.settings })
    .from(tenant)
    .where(eq(tenant.id, tenantId));
  const [who] = await tx
    .select()
    .from(contact)
    .where(and(eq(contact.id, row.contactId), eq(contact.tenantId, tenantId)));
  if (!agentRow || !v || !tenantRow || !who) return "the agent or the person is gone";
  const conns = await tx.select().from(connection).where(eq(connection.tenantId, tenantId));
  const sending = sendingChannels(
    agentRow.channels as Record<string, string> | null,
    accountBindings(tenantRow.settings),
    conns,
  );
  const channels = planOf(row).channels ?? [];
  if (channels.length === 0) return "the message has no channel";
  const autonomy = reachContactOf(who).autonomy;
  const why = planWhyApproval({
    levels: channels.map((ch) => sending.get(ch)?.create),
    stepApproval: "not_required",
    definitionMode: v.bundle.definition.permissions.mode,
    stage: agentRow.stage,
    needsSignature: channels.some((ch) => autonomy?.[ch] === "approval"),
  });
  return why.reasons.length === 0
    ? null
    : `a message to ${who.name} needs a person's signature now`;
}

/** Whether a resume's pending state is a reach-out's plan approval. */
export function reachOutState(state: unknown): string | null {
  const id = isPlainObject(state) ? state.reachOutId : undefined;
  return typeof id === "string" ? id : null;
}

export function reachPort(deps: ReachDeps): ReachPort {
  const now = () => deps.now?.() ?? deps.runtime.now?.() ?? new Date();
  const { db } = deps;

  const getRow = (tenantId: string, id: string) =>
    withTenant(db, tenantId, async (tx) => {
      const [row] = await tx
        .select()
        .from(reachOut)
        .where(and(eq(reachOut.id, id), eq(reachOut.tenantId, tenantId)));
      const [who] = row
        ? await tx
            .select({ id: contact.id, name: contact.name })
            .from(contact)
            .where(and(eq(contact.id, row.contactId), eq(contact.tenantId, tenantId)))
        : [];
      return { row: row ?? null, who: who ?? null };
    });

  const done = async (row: ReachOutRow, who: { id: string; name: string } | null) => {
    await withTenant(db, row.tenantId, (tx) =>
      tx
        .update(reachOut)
        .set({ runReceivedAt: now() })
        .where(and(eq(reachOut.id, row.id), eq(reachOut.tenantId, row.tenantId))),
    );
    return { kind: "done", output: outputOf(row, who) } satisfies StepOutcome;
  };

  // P-3: a reply whose files are still coming (a text's or WhatsApp's): settled once each has an
  // outcome, or after REPLY_MEDIA_WAIT_MS with what was filed; the step waits on the same event.
  const finish = async (
    row: ReachOutRow,
    who: { id: string; name: string } | null,
  ): Promise<StepOutcome> => {
    if (!replyPending(row)) return done(row, who);
    const settled = await withTenant(db, row.tenantId, (tx) =>
      settlePendingReply(tx, row, replyOverdue(row, now())),
    );
    if (settled) return done(settled, who);
    const again = await getRow(row.tenantId, row.id);
    if (again.row && !replyPending(again.row)) return done(again.row, again.who);
    const ends = (row.endedAt?.getTime() ?? now().getTime()) + REPLY_MEDIA_WAIT_MS;
    const left = Math.max(60_000, ends - now().getTime());
    return {
      kind: "waiting",
      wait: {
        eventType: reachOutEventType(row.id),
        timeout: `${Math.ceil(left / 60_000)} minutes`,
        state: { reachOutId: row.id },
      },
    };
  };

  /** What an open reach-out means for the step now. */
  const settleOpen = async (id: string, tenantId: string): Promise<StepOutcome> => {
    const { row, who } = await getRow(tenantId, id);
    if (!row) return { kind: "failed", error: "the reach-out is gone" };
    if (row.status === "ended") return finish(row, who);
    const plan = planOf(row);
    if (!plan.expectReply && attemptsOf(row).some((a) => a.status === "sent")) {
      // DECISION: a reach-out that expects no reply ends at its first sent attempt, as no_reply
      // (nothing was waited for); the channel used is in the output.
      const ended = await withTenant(db, tenantId, (tx) =>
        endReachOut(tx, row, { outcome: "no_reply", reason: "no reply expected" }, now()),
      );
      return done(ended ?? row, who);
    }
    const remaining = Math.max(60_000, (row.dueAt?.getTime() ?? now().getTime()) - now().getTime());
    return {
      kind: "waiting",
      wait: {
        eventType: reachOutEventType(row.id),
        timeout: `${Math.ceil(remaining / 60_000)} minutes`,
        state: { reachOutId: row.id },
      },
    };
  };

  const open = async (row: ReachOutRow, approvedBy: string | null): Promise<StepOutcome> => {
    const plan = planOf(row);
    await withTenant(db, row.tenantId, (tx) =>
      tx
        .update(reachOut)
        .set({
          status: "open",
          plan: { ...plan, approvedBy } as unknown as Record<string, unknown>,
          dueAt: row.dueAt ?? new Date(now().getTime() + parseDuration(plan.timeout)),
        })
        .where(
          and(
            eq(reachOut.id, row.id),
            eq(reachOut.tenantId, row.tenantId),
            eq(reachOut.status, "awaiting_approval"),
          ),
        ),
    );
    if (attemptsOf(row).length === 0) await attemptFrom(deps, row.tenantId, row.id, now);
    return settleOpen(row.id, row.tenantId);
  };

  return {
    async start(req) {
      const { run: info } = req;
      const parsed = ReachOutInput.safeParse(req.input);
      if (!parsed.success) {
        return { kind: "failed", error: `invalid input: ${parsed.error.message}` };
      }
      const input = parsed.data;
      // The purpose becomes instructions (a call's purpose, a composed message's brief): it must be
      // the step's own text (§1.23's rule).
      const problem = fixedInputProblem(REACH_OUT_FIXED_INPUTS, req.step.input, req.input);
      if (problem) return { kind: "failed", error: `refused: comms.reach-out: ${problem}` };

      const t = now();
      const subject = reachSubject(input.about, input.purpose);
      const test = info.mode === "test";

      // A retried step finds its reach-out.
      if (!test) {
        const [existing] = await withTenant(db, info.tenantId, (tx) =>
          tx
            .select()
            .from(reachOut)
            .where(
              and(
                eq(reachOut.tenantId, info.tenantId),
                eq(reachOut.runId, info.id),
                eq(reachOut.nodeId, req.nodeId),
              ),
            ),
        );
        if (existing) {
          if (existing.status === "awaiting_approval" && existing.inboxItemId) {
            return {
              kind: "approval",
              pending: { inboxItemId: existing.inboxItemId, state: { reachOutId: existing.id } },
            };
          }
          if (existing.status === "open" && attemptsOf(existing).length === 0) {
            return open(existing, planOf(existing).approvedBy);
          }
          return settleOpen(existing.id, info.tenantId);
        }
      }

      // Who approves the plan: the client's approver rules first (docs/plan.md §1.20), then the
      // step's, the agent's and the client's default, read fresh like every other approval.
      const routing = await deps.runtime.ports.store.approvalRouting(info.tenantId);
      const outcome = await withTenant(db, info.tenantId, async (tx) => {
        const loaded = await load(tx, req, input);
        if (typeof loaded === "string") {
          return { kind: "refused" as const, output: notAllowed(loaded, null, input.about) };
        }
        const { tenantRow, conditions } = loaded;
        // P-3: the documents it sends: this client's PDFs and images, named by the step's input.
        const attachments = await attachmentsOf(tx, info.tenantId, input.attachments);
        if (typeof attachments === "string") {
          return { kind: "refused" as const, output: notAllowed(attachments, null, input.about) };
        }
        if (loaded.candidates.length === 0) {
          return {
            kind: "refused" as const,
            output: notAllowed(
              loaded.role ? `nobody is bound to the role ${loaded.role}` : "no contact to reach",
              null,
              input.about,
            ),
          };
        }
        const client = {
          timezone: tenantRow.timezone,
          quietHours: clientQuietHours(tenantRow.settings),
        };
        const facts = { trigger: loaded.trigger, input: req.input };
        let chosen: { who: ContactRow; plan: Extract<ReachPlan, { ok: true }> } | null = null;
        let firstRefusal: { who: ContactRow; plan: Extract<ReachPlan, { ok: false }> } | null =
          null;
        // DECISION: a role's contacts are tried in the order they were bound; the first one with a
        // channel that passes is reached (one contact per reach-out).
        for (const who of loaded.candidates) {
          const { inConversation, ...counts } = await contactLoad(
            tx,
            info.tenantId,
            who.id,
            subject,
            t,
          );
          // P-4: a person in an open conversation is not reached until it ends (§1.66).
          if (inConversation) {
            firstRefusal ??= {
              who,
              plan: {
                ok: false,
                outcome: "not_allowed",
                reason: "they are in a conversation with an agent",
                checks: [],
              },
            };
            continue;
          }
          const plan = planReachOut({
            contact: reachContactOf(who),
            conditions,
            roleChannels: loaded.roleChannels,
            urgency: input.urgency,
            // A channel whose connection has `create` off can't be used at all.
            boundChannels: new Set(
              [...loaded.channels].filter(([, c]) => c.create !== "off").map(([ch]) => ch),
            ),
            client,
            facts,
            ...counts,
            now: t,
            // P-3: a channel that can't carry them is left out, with the reason.
            attachments: attachments.length,
          });
          if (plan.ok) {
            chosen = { who, plan };
            break;
          }
          firstRefusal ??= { who, plan };
        }
        const sources = input.about;
        if (!chosen) {
          const r = firstRefusal as NonNullable<typeof firstRefusal>;
          const who = { id: r.who.id, name: r.who.name };
          if (test) {
            return {
              kind: "refused" as const,
              output: { ...notAllowed(r.plan.reason, who, sources, r.plan.outcome), testRun: true },
            };
          }
          // Recorded with its reason, nothing sent.
          const [row] = await tx
            .insert(reachOut)
            .values({
              tenantId: info.tenantId,
              agentId: info.agentId,
              agentVersionId: info.agentVersionId,
              runId: info.id,
              stepRunId: req.stepRunId,
              nodeId: req.nodeId,
              contactId: r.who.id,
              role: loaded.role,
              subject: `refused:${subject}`.slice(0, 500),
              purpose: input.purpose,
              urgency: input.urgency,
              plan: { checks: r.plan.checks } as unknown as Record<string, unknown>,
              status: "ended",
              outcome: r.plan.outcome,
              reason: r.plan.reason,
              sources,
              endedAt: t,
              runReceivedAt: t,
            })
            .onConflictDoNothing()
            .returning();
          if (row) {
            await threadLine(tx, row, r.who, {
              direction: "out",
              channel: "email",
              text: `Not sent: ${r.plan.reason}. About: ${input.purpose}`,
              status: "not_sent",
            });
          }
          return {
            kind: "refused" as const,
            output: notAllowed(r.plan.reason, who, sources, r.plan.outcome, row?.id ?? null),
          };
        }

        const { who, plan } = chosen;
        const whoView = { id: who.id, name: who.name };
        if (test) {
          // Test runs never send: what would have gone out, and the quietest outcome.
          return {
            kind: "refused" as const,
            output: {
              outcome: "no_reply" as const,
              channel: plan.channels[0] ?? null,
              reply: null,
              contact: whoView,
              reason: "a test run: nothing was sent",
              attempts: 0,
              sources,
              reachOutId: null,
              testRun: true,
              plan: plan.channels,
            },
          };
        }
        const definition = loaded.bundle.definition;
        const automatic =
          req.approval.required === "not_required" &&
          // v0.12 W1-A: in trial and signoff the plan always needs a signature (§10.9).
          effectiveMode(definition, loaded.agentRow.stage) === "act" &&
          plan.channels.every((ch) => loaded.channels.get(ch)?.create === "auto") &&
          // v0.12 W1-G: the person's `approval` on a planned channel asks for a sign (§1.42).
          !plan.needsSignature;
        // The person's language, else their organization's, else the client's (§1.27).
        const language = (await contactLanguage(tx, who)).language;
        const stored: StoredPlan = {
          channels: plan.channels,
          escalateAfter: plan.escalateAfter,
          language,
          message: input.message,
          emailSubject: input.subject ?? input.purpose.slice(0, 200),
          expectReply: input.expectReply,
          timeout: input.timeout,
          urgentOutsideHours: conditions.urgentOutsideHours === true,
          automatic,
          approvedBy: null,
          replyTag: "",
          data: truncateData({ about: input.about, trigger: loaded.trigger }),
          checks: plan.checks,
          ...(req.step.model ? { model: req.step.model } : {}),
          ...(attachments.length ? { attachments } : {}),
        };
        let row: ReachOutRow | undefined;
        try {
          [row] = await tx
            .insert(reachOut)
            .values({
              tenantId: info.tenantId,
              agentId: info.agentId,
              agentVersionId: info.agentVersionId,
              runId: info.id,
              stepRunId: req.stepRunId,
              nodeId: req.nodeId,
              contactId: who.id,
              role: loaded.role,
              subject,
              purpose: input.purpose,
              urgency: input.urgency,
              plan: stored as unknown as Record<string, unknown>,
              status: automatic ? "open" : "awaiting_approval",
              sources,
              ...(automatic ? { dueAt: new Date(t.getTime() + parseDuration(input.timeout)) } : {}),
            })
            .returning();
        } catch (error) {
          // Another step opened one for this contact and subject between our check and insert.
          if (String((error as { code?: unknown })?.code) === "23505") {
            return {
              kind: "refused" as const,
              output: notAllowed(
                "a reach-out to this contact about this is already open",
                whoView,
                sources,
              ),
            };
          }
          throw error;
        }
        if (!row) throw new Error("reach_out insert returned nothing");
        const replyTag = hexId(row.id);
        stored.replyTag = replyTag;
        await tx
          .update(reachOut)
          .set({ plan: stored as unknown as Record<string, unknown> })
          .where(and(eq(reachOut.id, row.id), eq(reachOut.tenantId, row.tenantId)));
        row = { ...row, plan: stored as unknown as Record<string, unknown> };

        if (automatic) return { kind: "open" as const, row };

        // One approval covers the plan: who, why, which channels, how many attempts.
        // DECISION: a reach-out plan is matched by approver rules as a create through its first
        // channel's send tool (e.g. sms.send on twilio), for this agent; it carries no amount.
        const first = plan.channels[0];
        const firstConnector = first ? (loaded.channels.get(first)?.connector ?? null) : null;
        const route = routeApproval({
          rules: routing.rules,
          facts: {
            connector: firstConnector ?? "",
            tool:
              (first && firstConnector ? channelTool(firstConnector, first) : null) ??
              REACH_OUT_SKILL,
            verb: "create",
            agentId: info.agentId,
            amount: null,
          },
          step: req.approval.approver,
          agent: [definition.permissions.approver, loaded.agentRow.approver],
          client: routing.clientDefault,
          members: routing.members,
        });
        const assignee = route.assignee;
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
            title: `Reach ${who.name}: ${input.purpose}`.slice(0, 200),
            payload: {
              nodeId: req.nodeId,
              reachOutId: row.id,
              reachOut: {
                contact: whoView,
                role: loaded.role,
                purpose: input.purpose,
                urgency: input.urgency,
                channels: plan.channels,
                attempts: plan.channels.length,
                escalateAfter: plan.escalateAfter,
                expectReply: input.expectReply,
                timeout: input.timeout,
                language,
                message:
                  "template" in input.message
                    ? pickMessage(input.message.template, language)
                    : "Written for them when it is sent, from the purpose and the record",
                // P-3: what goes with it, by name and size.
                ...(attachments.length ? { attachments } : {}),
              },
              sources,
              // v0.12 W1-D: why the plan waits, with the reasons a tool proposal gives.
              whyApproval: planWhyApproval({
                levels: plan.channels.map((ch) => loaded.channels.get(ch)?.create),
                stepApproval: req.approval.required,
                definitionMode: definition.permissions.mode,
                stage: loaded.agentRow.stage,
                needsSignature: plan.needsSignature,
                route: { source: route.source, ruleId: route.ruleId },
              }) as JsonObject,
            },
            dueAt: req.approval.timeout
              ? new Date(t.getTime() + parseDuration(req.approval.timeout))
              : null,
          })
          .returning({ id: inboxItem.id });
        if (!item) throw new Error("inbox item insert returned nothing");
        await tx
          .update(reachOut)
          .set({ inboxItemId: item.id })
          .where(and(eq(reachOut.id, row.id), eq(reachOut.tenantId, row.tenantId)));
        return { kind: "approval" as const, row, inboxItemId: item.id };
      });

      switch (outcome.kind) {
        case "refused":
          return { kind: "done", output: outcome.output };
        case "approval":
          return {
            kind: "approval",
            pending: { inboxItemId: outcome.inboxItemId, state: { reachOutId: outcome.row.id } },
          };
        case "open":
          return open({ ...outcome.row, status: "awaiting_approval" }, null);
      }
    },

    async resume(req) {
      const id = reachOutState(req.pending.state);
      if (!id) return { kind: "failed", error: "not a reach-out" };
      const { row, who } = await getRow(req.run.tenantId, id);
      if (!row) return { kind: "failed", error: "the reach-out is gone" };
      if (row.status === "awaiting_approval") {
        if (req.resolution.approved === true && req.resolution.proceeded === true) {
          // Wave 2c: nobody answered and `ifNoAnswer` is proceed: the gate decides it again, and a
          // plan it would make wait ends unsent (invariant 8).
          const refused = await withTenant(db, row.tenantId, async (tx) => {
            const why = await unsignedSendRefusal(tx, row);
            if (why) await endReachOut(tx, row, { outcome: "declined", reason: why }, now());
            return why;
          });
          if (refused) return { kind: "failed", error: `nobody answered in time, and ${refused}` };
        }
        if (req.resolution.approved === true) return open(row, req.resolution.by);
        // DECISION: a plan its approver rejected ends as `declined`: nothing was sent.
        const ended = await withTenant(db, row.tenantId, (tx) =>
          endReachOut(tx, row, { outcome: "declined", reason: "the plan was not approved" }, now()),
        );
        return done(ended ?? row, who);
      }
      if (row.status === "open" && attemptsOf(row).length === 0) {
        return open(row, planOf(row).approvedBy);
      }
      return settleOpen(row.id, row.tenantId);
    },

    async waitDone(req) {
      const id = reachOutState(req.wait.state);
      if (!id) return true;
      const { row } = await getRow(req.run.tenantId, id);
      // P-3: a reply's files still coming keep the step waiting.
      return !row || (row.status === "ended" && !replyPending(row));
    },

    async afterWait(req) {
      const id = reachOutState(req.wait.state);
      if (!id) return { kind: "failed", error: "not a reach-out" };
      const { row, who } = await getRow(req.run.tenantId, id);
      if (!row) return { kind: "failed", error: "the reach-out is gone" };
      if (row.status === "ended") return finish(row, who);
      if (req.timedOut || (row.dueAt && row.dueAt <= now())) {
        const ended = await withTenant(db, row.tenantId, async (tx) => {
          const e = await endReachOut(
            tx,
            row,
            { outcome: "no_reply", reason: "no reply in time" },
            now(),
          );
          const [c] = await tx
            .select()
            .from(contact)
            .where(and(eq(contact.id, row.contactId), eq(contact.tenantId, row.tenantId)));
          if (e && c) {
            await threadLine(tx, e, c, {
              direction: "out",
              channel: attemptsOf(row).at(-1)?.channel ?? "email",
              text: `No reply in time. About: ${row.purpose}`,
              status: "no_reply",
            });
          }
          return e;
        });
        if (ended) return done(ended, who);
        const again = await getRow(row.tenantId, row.id);
        return again.row ? finish(again.row, again.who) : { kind: "failed", error: "gone" };
      }
      return settleOpen(row.id, row.tenantId);
    },
  };
}

// ── Attempts ────────────────────────────────────────────────────────────────────────────────────

async function pinned(deps: ReachDeps, row: ReachOutRow): Promise<PinnedAgent> {
  return deps.runtime.ports.store.loadAgentVersion(row.tenantId, row.agentVersionId);
}

/**
 * Sends the next attempts of an open reach-out, from the first not yet made: each channel's attempt
 * is its own external action; a channel that fails (consent withdrawn, refused, provider error)
 * moves on to the next at once; quiet hours defer the attempt to when they end. Returns how many
 * were sent now.
 */
export async function attemptFrom(
  deps: ReachDeps,
  tenantId: string,
  reachOutId: string,
  now: () => Date,
): Promise<number> {
  const { db } = deps;
  let sentNow = 0;
  for (let guard = 0; guard < 8; guard++) {
    const state = await withTenant(db, tenantId, async (tx) => {
      const [row] = await tx
        .select()
        .from(reachOut)
        .where(and(eq(reachOut.id, reachOutId), eq(reachOut.tenantId, tenantId)))
        .for("update");
      if (row?.status !== "open") return null;
      const [who] = await tx
        .select()
        .from(contact)
        .where(and(eq(contact.id, row.contactId), eq(contact.tenantId, tenantId)));
      const [a] = await tx
        .select({ channels: agent.channels })
        .from(agent)
        .where(and(eq(agent.id, row.agentId), eq(agent.tenantId, tenantId)));
      const [t] = await tx.select().from(tenant).where(eq(tenant.id, tenantId));
      const conns = await tx.select().from(connection).where(eq(connection.tenantId, tenantId));
      return { row, who, channels: (a?.channels ?? {}) as Record<string, string>, t, conns };
    });
    if (!state?.who || !state.t) return sentNow;
    const { row, who } = state;
    const plan = planOf(row);
    const attempts = attemptsOf(row);
    const index = attempts.length;
    const t = now();

    const record = async (attempt: Attempt, extra: { nextAttemptAt: Date | null }) => {
      await withTenant(db, tenantId, async (tx) => {
        const [fresh] = await tx
          .update(reachOut)
          .set({
            attempts: [...attempts, attempt] as unknown as Record<string, unknown>[],
            nextAttemptAt: extra.nextAttemptAt,
          })
          .where(and(eq(reachOut.id, row.id), eq(reachOut.tenantId, tenantId)))
          .returning();
        await threadLine(tx, fresh ?? row, who, {
          direction: "out",
          channel: attempt.channel,
          text:
            // P-4: a conversation's line is the message itself (§1.66).
            attempt.status === "sent" && isConverseSubject(row.subject)
              ? `${"template" in plan.message ? pickMessage(plan.message.template, plan.language) : row.purpose}`
              : attempt.status === "sent"
                ? `Reached out by ${CHANNEL_WORDS[attempt.channel]} (attempt ${attempt.index + 1} of ${plan.channels.length}): ${row.purpose}`
                : `Couldn't reach by ${CHANNEL_WORDS[attempt.channel]}: ${attempt.error ?? "failed"}`,
          status: attempt.status,
        });
      });
    };

    if (index >= plan.channels.length) {
      if (!attempts.some((a) => a.status === "sent")) {
        const reasons = attempts.map((a) => `${a.channel}: ${a.error ?? a.status}`).join("; ");
        const ended = await withTenant(db, tenantId, (tx) =>
          endReachOut(
            tx,
            row,
            { outcome: "not_allowed", reason: `nothing could be sent: ${reasons}` },
            t,
          ),
        );
        if (ended) await wake(deps, ended);
      } else {
        await withTenant(db, tenantId, (tx) =>
          tx
            .update(reachOut)
            .set({ nextAttemptAt: null })
            .where(and(eq(reachOut.id, row.id), eq(reachOut.tenantId, tenantId))),
        );
      }
      return sentNow;
    }
    const channel = plan.channels[index] as ReachChannel;
    const reach = reachContactOf(who);
    if (reach.optedOutAt) {
      const ended = await withTenant(db, tenantId, (tx) =>
        endReachOut(tx, row, { outcome: "opted_out", reason: "the contact opted out" }, t),
      );
      if (ended) await wake(deps, ended);
      return sentNow;
    }
    const failed = (error: string) =>
      record(
        { index, channel, at: t.toISOString(), status: "failed", error },
        { nextAttemptAt: null },
      );

    const block = consentBlockFor(reach, channel);
    if (block) {
      await failed(block.replace(/_/g, " "));
      continue;
    }
    const hours = contactHours(reach, {
      timezone: state.t.timezone,
      quietHours: clientQuietHours(state.t.settings),
    });
    if (
      hoursBlock(
        channel,
        row.urgency as Urgency,
        hours,
        { urgentOutsideHours: plan.urgentOutsideHours },
        t,
      )
    ) {
      // Held until the contact's quiet hours end; the cron sends it then.

      await withTenant(db, tenantId, (tx) =>
        tx
          .update(reachOut)
          .set({ nextAttemptAt: quietHoursEnd(hours, t) })
          .where(and(eq(reachOut.id, row.id), eq(reachOut.tenantId, tenantId))),
      );
      return sentNow;
    }
    // R4: resolved again when sent (the agent's own, else the account's), as when it was planned.
    const connectionId = pickChannel({
      kind: channel,
      agent: state.channels,
      account: accountBindings(state.t.settings),
      connections: state.conns,
    })?.connectionId;
    const conn = state.conns.find((c) => c.id === connectionId);
    const toolId = conn ? channelTool(conn.connector, channel) : null;
    if (!conn || !toolId) {
      await failed(`the agent has no ${CHANNEL_WORDS[channel]} channel`);
      continue;
    }

    const agentPinned = await pinned(deps, row);
    const step: StepContext = {
      tenantId,
      agent: agentPinned,
      runId: row.runId,
      stepRunId: row.stepRunId ?? "",
      stepId: row.nodeId,
      mode: "live",
      approval: { required: "required", onReject: "stop" },
      // The purpose is the step's fixed text: a call's purpose may only be that.
      literalInput: { purpose: row.purpose },
      externalIndex: { next: 0 },
    };
    let text: string;
    try {
      text =
        "template" in plan.message
          ? pickMessage(plan.message.template, plan.language)
          : await composeReachMessage(deps.runtime, step, {
              purpose: row.purpose,
              data: plan.data,
              language: plan.language,
              channel,
              contactName: who.name,
              clientName: state.t.name,
              // P-3: a WhatsApp file's caption is at most 1024 characters.
              maxChars: reachMaxChars(channel, !!plan.attachments?.length),
              model: plan.model,
            });
    } catch (error) {
      await failed(`couldn't write the message: ${error instanceof Error ? error.message : error}`);
      continue;
    }
    // v0.17 (ARCHITECTURE §10.15 "Signature"): a message to someone outside the client is signed
    // by the area owner of the agent sending it, with "Powered by mezonas.com" under it.
    if (channel !== "voice" && who.relationship !== "employee") {
      text = await signed(deps, {
        tenantId,
        agentId: row.agentId,
        definition: agentPinned.bundle.definition,
        client: state.t.name,
        locale: plan.language,
        channel,
        first: !isConverseSubject(row.subject) || row.nodeId.endsWith(":m1"),
        text,
      });
    }
    const address = channelAddress(reach, channel) as string;
    // P-3: the plan's documents go with the email, the text (MMS) or the WhatsApp message.
    const files = plan.attachments?.length
      ? { attachments: plan.attachments.map((a) => ({ documentId: a.documentId })) }
      : {};
    const input =
      channel === "email"
        ? { to: address, subject: plan.emailSubject, text, replyTag: plan.replyTag, ...files }
        : channel === "voice"
          ? { to: address, purpose: row.purpose, tools: [] }
          : // P-4: a conversation's opening may carry a template for outside the 24-hour window.
            channel === "whatsapp" && plan.whatsappTemplate
            ? { to: address, text, template: plan.whatsappTemplate, ...files }
            : { to: address, text, ...files };
    const r = await runPlannedAction(deps.runtime, step, {
      toolId,
      connectionId: conn.id,
      input,
      idempotencyKey: `${row.runId}:${row.nodeId}:reach:${index}`,
    });
    if (r.status !== "done") {
      await failed(r.status === "refused" ? r.reason : r.status === "failed" ? r.error : r.status);
      continue;
    }
    const out = (r.output ?? {}) as { sid?: string; callSid?: string; id?: string };
    const more = index + 1 < plan.channels.length && plan.expectReply;
    await record(
      {
        index,
        channel,
        at: t.toISOString(),
        status: "sent",
        ...(r.actionId ? { actionId: r.actionId } : {}),
        ...((out.sid ?? out.callSid ?? out.id) ? { ref: out.sid ?? out.callSid ?? out.id } : {}),
      },
      { nextAttemptAt: more ? new Date(t.getTime() + parseDuration(plan.escalateAfter)) : null },
    );
    sentNow++;
    return sentNow;
  }
  return sentNow;
}

// ── The cron ────────────────────────────────────────────────────────────────────────────────────

// DECISION: an ended reach-out's event is re-sent for a day, as inbox resolutions are (§1.5); a run
// that reaches its wait later reads the row in its check before waiting.
const REDELIVER_WINDOW_MS = 24 * 60 * 60_000;
const REDELIVER_AFTER_MS = 60_000;

/**
 * One client's reach-outs, each minute: end those past their timeout (no reply), send each next
 * attempt that is due (escalation), and re-send the event of each ended one its run hasn't taken.
 */
export async function reachOutTick(
  deps: ReachDeps,
  tenantId: string,
  at: Date,
): Promise<{ escalated: number; timedOut: number; woken: number }> {
  const { db } = deps;
  const now = () => at;
  const result = { escalated: 0, timedOut: 0, woken: 0 };

  const overdue = await withTenant(db, tenantId, async (tx) => {
    const rows = await tx
      .select()
      .from(reachOut)
      .where(
        and(eq(reachOut.tenantId, tenantId), eq(reachOut.status, "open"), lte(reachOut.dueAt, at)),
      )
      .limit(200);
    const ended: ReachOutRow[] = [];
    for (const row of rows) {
      const e = await endReachOut(tx, row, { outcome: "no_reply", reason: "no reply in time" }, at);
      if (e) ended.push(e);
    }
    return ended;
  });
  for (const row of overdue) {
    result.timedOut++;
    await wake(deps, row);
  }

  const due = await withTenant(db, tenantId, (tx) =>
    tx
      .select()
      .from(reachOut)
      .where(
        and(
          eq(reachOut.tenantId, tenantId),
          eq(reachOut.status, "open"),
          lte(reachOut.nextAttemptAt, at),
        ),
      )
      .limit(100),
  );
  for (const row of due) {
    const plan = planOf(row);
    const attempts = attemptsOf(row);
    const lastSent = [...attempts].reverse().find((a) => a.status === "sent");
    const step = nextEscalation(
      {
        channels: plan.channels,
        attempts: attempts.length,
        lastAttemptAt: lastSent ? new Date(lastSent.at) : null,
        escalateAfter: plan.escalateAfter,
        replied: false,
        optedOut: false,
      },
      at,
    );
    // Quiet hours may have deferred an attempt past escalateAfter: nextAttemptAt is the truth.
    if (step.kind === "stop") continue;
    try {
      result.escalated += await attemptFrom(deps, tenantId, row.id, now);
    } catch (error) {
      reportHandled(`reach-out ${row.id}: escalation failed`, error, { job: "reach" });
    }
  }

  // P-3: replies whose files are in (or whose wait is over) are settled, and their runs woken.
  const settled = await withTenant(db, tenantId, async (tx) => {
    const out: ReachOutRow[] = [];
    for (const row of await pendingReplies(tx, tenantId)) {
      const s = await settlePendingReply(tx, row, replyOverdue(row, at));
      if (s) out.push(s);
    }
    return out;
  });
  for (const row of settled) {
    result.woken++;
    await wake(deps, row);
  }

  const pending = await withTenant(db, tenantId, (tx) =>
    tx
      .select({ id: reachOut.id, runId: reachOut.runId, subject: reachOut.subject })
      .from(reachOut)
      .innerJoin(run, and(eq(run.id, reachOut.runId), eq(run.tenantId, reachOut.tenantId)))
      .where(
        and(
          eq(reachOut.tenantId, tenantId),
          eq(reachOut.status, "ended"),
          isNull(reachOut.runReceivedAt),
          lte(reachOut.endedAt, new Date(at.getTime() - REDELIVER_AFTER_MS)),
          gte(reachOut.endedAt, new Date(at.getTime() - REDELIVER_WINDOW_MS)),
          inArray(run.status, ["queued", "running", "waiting"]),
          // P-3: not while a reply's files are still coming (settled above when they are in).
          sql`coalesce(${reachOut.reply}->>'pending', 'false') <> 'true'`,
        ),
      )
      .limit(200),
  );
  for (const row of pending) {
    result.woken++;
    await wake(deps, row);
  }
  return result;
}

// ── v0.17: the area owner's signature (ARCHITECTURE §10.15) ──────────────────────────────────────

/**
 * The message with the sending agent's area owner's signature under it: "Pia, purchasing agent
 * for Acme Supply", then "Powered by mezonas.com" (on a text or WhatsApp message, only on a
 * conversation's first). The owner is created if the client has none for the area yet.
 */
// DECISION (O3): added when the message is sent, in the platform's words, so no model writes it
// and no edit removes it; the person who signs a message sees it without the two fixed lines.
async function signed(
  deps: ReachDeps,
  input: {
    tenantId: string;
    agentId: string;
    definition: { area?: string | undefined; skills?: readonly { skill: string }[] };
    client: string;
    locale: Locale;
    channel: ReachChannel;
    first: boolean;
    text: string;
  },
): Promise<string> {
  const owner = await withTenant(deps.db, input.tenantId, async (tx) => {
    const area = await areaOfAgent(tx, input.tenantId, input.agentId, input.definition, (id) =>
      deps.runtime.catalog.get(id),
    );
    return ensureAreaOwner(tx, input.tenantId, area);
  });
  const lines = ownerSignature({
    name: owner.name,
    area: owner.area,
    client: input.client,
    locale: input.locale,
    channel:
      input.channel === "email" || input.channel === "sms" || input.channel === "whatsapp"
        ? input.channel
        : "other",
    first: input.first,
  });
  return [
    input.text.trimEnd(),
    "",
    lines.signature,
    ...(lines.poweredBy ? [lines.poweredBy] : []),
  ].join("\n");
}
