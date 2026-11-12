// The AccountPort behind Sloan's `account.*` tools (ARCHITECTURE §9.8; docs/plan.md §1.47). Each
// call is one client-scoped transaction (invariant 1), so a second client's records are never
// visible. Before anything is read or written the port checks, from the database and never from
// model input:
//
// - the caller is the client's account agent (the supervisor's fork, `platform` kind);
// - who is asking: the person whose message started the run (`thread.message_posted` in an
//   account thread, in the run's trigger), and their role in this client;
// - that the role allows the action (reads and passing to the lead or to an agent: any client
//   person; pausing and drafting: the client admin).
//
// A test run reads as the client admin would and writes nothing. The views and writes themselves
// are the portal's own code, handed in by apps/api (AccountViews), so Sloan sees and does exactly
// what the portal would. Passing a request to an agent has no portal twin: the port emits
// `account.request_passed` itself, through the runtime's emitter in the same transaction, and the
// router starts the agent's `sloan` message triggers (ARCHITECTURE §10.8).

import {
  ACCOUNT_AGENT_SLUG,
  ACCOUNT_REQUEST_PASSED_EVENT,
  type AccountAction,
  type AccountChange,
  type AccountRunSummary,
  type AccountRunsQuery,
  type AccountRunView,
  type AccountService,
  type AccountWaitExplanation,
  AREA_IDEAS,
  acceptingTriggers,
  acceptsSloan,
  isPlainObject,
  mayAskFor,
  OWNER_AREAS,
  passToAgentEvent,
  ThreadMessagePostedPayload,
} from "@countersign/core";
import {
  agent,
  agentVersion,
  appUser,
  areaOwner,
  type Db,
  event,
  membership,
  memoryNote,
  message,
  run,
  type Tx,
  thread,
  withTenant,
} from "@countersign/db";
import { and, desc, eq, sql } from "drizzle-orm";
import { AgentsError } from "../errors";
import type {
  AccountCall,
  AccountDraftOutcome,
  AccountPassInput,
  AccountPassOutcome,
  AccountPassToAgentOutcome,
  AccountPauseOutcome,
  AccountPort,
  AccountWaiting,
} from "../tools/account";
import type { Emit } from "./external-actions";

/** The person Sloan acts for in this call. */
export interface AccountAsker {
  /** Null in a test run: there is no person, and nothing is written. */
  userId: string | null;
  role: "client_admin" | "client_user";
  name: string | null;
  /** The account thread and message the run answers; null in a test run. */
  threadId: string | null;
  messageId: string | null;
  test: boolean;
}

/** One call's scope: inside the client's transaction, for the person asking. */
export interface AccountScope {
  tx: Tx;
  tenantId: string;
  asker: AccountAsker;
  call: AccountCall;
}

/**
 * The portal's views and writes, from apps/api (`apps/api/src/account/views.ts`). Each runs in the
 * port's transaction, for the asker, and returns the portal's own shapes.
 */
/** v0.17: one of the client's area owners, as Sloan may name it in the chat (§10.15). */
export interface AccountOwner {
  id: string;
  name: string;
  area: string;
  /** Its role in the client's language ("purchasing agent"). */
  role: string;
  /** The services (processes) in its area: what it may talk about. */
  services: { id: string; name: string }[];
  /** What it did lately, in the portal's words, newest first. */
  recent: string[];
}

export interface AccountViews {
  /**
   * v0.17: the client's owner of that name (any case), or with no name the owner the asker's
   * conversation is with; with its area's services and what it did lately. Null if none.
   */
  owner?(s: AccountScope, name: string | undefined): Promise<AccountOwner | null>;
  services(s: AccountScope): Promise<AccountService[]>;
  runs(s: AccountScope, query: AccountRunsQuery): Promise<AccountRunSummary[]>;
  run(s: AccountScope, runId: string): Promise<AccountRunView>;
  waiting(s: AccountScope, input: { limit: number }): Promise<AccountWaiting[]>;
  explainWait(s: AccountScope, itemId: string): Promise<AccountWaitExplanation>;
  pause(
    s: AccountScope,
    input: { serviceId: string; reason: string; until?: string | undefined },
  ): Promise<AccountPauseOutcome>;
  resume(s: AccountScope, input: { serviceId: string }): Promise<AccountPauseOutcome>;
  draftChange(
    s: AccountScope,
    input: { change: AccountChange; sources: string[] },
  ): Promise<AccountDraftOutcome>;
  passToLead(s: AccountScope, input: AccountPassInput): Promise<AccountPassOutcome>;
}

/** Refused for the person asking: the model reads the reason and says it plainly. */
export class AccountRefusal extends AgentsError {
  constructor(message: string) {
    super("invalid_state", message);
  }
}

const ROLE_WORDS: Record<AccountAction, string> = {
  read: "only people of this client can ask Sloan",
  pause: "only a client admin can pause or resume a service: ask your admin",
  draft: "only a client admin can ask for a change to the account: ask your admin",
  pass: "only people of this client can pass a request to the lead",
};

/** The run's asker, from its trigger: the person who posted in an account thread. */
async function askerOf(tx: Tx, tenantId: string, call: AccountCall): Promise<AccountAsker> {
  const [a] = await tx
    .select({ kind: agent.kind, slug: agent.slug })
    .from(agent)
    .where(and(eq(agent.id, call.agentId), eq(agent.tenantId, tenantId)));
  if (a?.kind !== "client" || a.slug !== ACCOUNT_AGENT_SLUG) {
    throw new AccountRefusal("only the account agent reads the account");
  }
  const [r] = await tx
    .select({ agentId: run.agentId, mode: run.mode, trigger: run.trigger })
    .from(run)
    .where(and(eq(run.id, call.runId), eq(run.tenantId, tenantId)));
  if (!r || r.agentId !== call.agentId) throw new AccountRefusal("this run is not the agent's");
  if (r.mode === "test" || call.mode === "test") {
    // DECISION: a test run (the operator's, in the back office) reads as the client admin would
    // see the portal, and every write answers `test_run` without being made.
    return {
      userId: null,
      role: "client_admin",
      name: null,
      threadId: null,
      messageId: null,
      test: true,
    };
  }
  const trigger = isPlainObject(r.trigger) ? r.trigger : {};
  const posted =
    trigger.type === "event" && trigger.eventType === "thread.message_posted"
      ? ThreadMessagePostedPayload.safeParse(trigger.payload)
      : null;
  if (
    !posted?.success ||
    posted.data.subjectType !== "account" ||
    posted.data.senderType !== "user" ||
    posted.data.audience !== "client" ||
    !posted.data.senderId
  ) {
    throw new AccountRefusal("Sloan acts only for the person who wrote in an account conversation");
  }
  const userId = posted.data.senderId;
  const [m] = await tx
    .select({ role: membership.role, name: appUser.name })
    .from(membership)
    .innerJoin(appUser, eq(appUser.id, membership.userId))
    .where(and(eq(membership.tenantId, tenantId), eq(membership.userId, userId)));
  if (m?.role !== "client_admin" && m?.role !== "client_user") {
    throw new AccountRefusal(ROLE_WORDS.read);
  }
  return {
    userId,
    role: m.role,
    name: m.name,
    threadId: posted.data.threadId,
    messageId: posted.data.messageId,
    test: false,
  };
}

const NOT_ACCEPTED = {
  self: "Sloan can't pass a request to itself",
  notLive: "that service isn't running now, so it can't take a request",
  noSloan: "that service doesn't take requests from Sloan: offer to pass it to the lead",
  notForAsker: "that service doesn't take requests from you: ask your admin or the lead",
} as const;

const notAccepted = (reason: string): AccountPassToAgentOutcome => ({
  status: "not_accepted",
  reason,
  messageId: null,
});

/**
 * Passes the asker's own message to one agent of this client (ARCHITECTURE §9.8, §10.8): checks
 * that the agent's live version has a message trigger on channel `sloan` whose People filter
 * takes the asker, then emits `account.request_passed` in the port's transaction. The router
 * checks the same filter again when it starts the run.
 */
async function passToAgent(
  s: AccountScope,
  serviceId: string,
  emit: Emit | undefined,
): Promise<AccountPassToAgentOutcome> {
  if (serviceId === s.call.agentId) return notAccepted(NOT_ACCEPTED.self);
  // Only an agent of this client (RLS and the filter both): another client's is not found.
  const [target] = await s.tx
    .select({
      id: agent.id,
      slug: agent.slug,
      status: agent.status,
      runStatus: agent.runStatus,
      bundle: agentVersion.bundle,
    })
    .from(agent)
    .leftJoin(
      agentVersion,
      and(eq(agentVersion.id, agent.liveVersionId), eq(agentVersion.tenantId, agent.tenantId)),
    )
    .where(and(eq(agent.id, serviceId), eq(agent.tenantId, s.tenantId), eq(agent.kind, "client")));
  if (!target) throw new AccountRefusal("there is no such service for this client");
  if (target.slug === ACCOUNT_AGENT_SLUG) return notAccepted(NOT_ACCEPTED.self);
  if (!target.bundle) return notAccepted(NOT_ACCEPTED.notLive);
  if (!acceptsSloan(target.bundle)) return notAccepted(NOT_ACCEPTED.noSloan);
  // A test run asks as the client admin would (the asker's role); a live one as the person.
  const sender = { kind: "user" as const, userId: s.asker.userId ?? "", role: s.asker.role };
  if (acceptingTriggers(target.bundle, "sloan", sender).length === 0) {
    return notAccepted(NOT_ACCEPTED.notForAsker);
  }
  // Paused, draft or retired agents start nothing (the router's `isRunnable`).
  if (target.status !== "active" || target.runStatus !== "active") {
    return notAccepted(NOT_ACCEPTED.notLive);
  }
  if (s.asker.test) return { status: "test_run", reason: null, messageId: null };

  const { userId, threadId, messageId } = s.asker;
  if (!userId || !threadId || !messageId) {
    throw new AccountRefusal("Sloan passes only a person's message in an account conversation");
  }
  if (!emit) throw new Error("passing a request to a service is not available here");
  // DECISION: a message goes to an agent once: a second pass (a retried step, the model asking
  // twice) answers `already_passed` instead of starting the agent again.
  const [before] = await s.tx
    .select({ id: event.id })
    .from(event)
    .where(
      and(
        eq(event.tenantId, s.tenantId),
        eq(event.type, ACCOUNT_REQUEST_PASSED_EVENT),
        eq(event.subjectId, threadId),
        sql`${event.payload}->>'agentId' = ${target.id}`,
        sql`${event.payload}->>'messageId' = ${messageId}`,
      ),
    )
    .limit(1);
  if (before) return { status: "already_passed", reason: null, messageId };
  await emit(
    s.tx,
    s.tenantId,
    passToAgentEvent({ agentId: target.id, threadId, messageId, userId }),
  );
  return { status: "passed", reason: null, messageId };
}

export function dbAccountPort(
  db: Db,
  views: AccountViews,
  options: { emit?: Emit } = {},
): AccountPort {
  /** Runs `body` for the asker in the client's transaction, once their role allows `action`. */
  const scoped = <T>(
    tenantId: string,
    call: AccountCall,
    action: AccountAction,
    body: (s: AccountScope) => Promise<T>,
  ): Promise<T> =>
    withTenant(db, tenantId, async (tx) => {
      const asker = await askerOf(tx, tenantId, call);
      if (!mayAskFor(asker.role, action)) throw new AccountRefusal(ROLE_WORDS[action]);
      return body({ tx, tenantId, asker, call });
    });

  const paused: AccountPauseOutcome = { status: "test_run", service: null };

  return {
    // v0.17 (ARCHITECTURE §10.15 "Conversation history"): the asker's own, never anyone else's.
    history: (tenantId, call, input) =>
      scoped(tenantId, call, "read", async (s) => {
        const userId = s.asker.userId;
        if (!userId) return { summaries: [], messages: [] };
        const summaries = await s.tx
          .select({ note: memoryNote.note, at: memoryNote.createdAt, threadId: message.threadId })
          .from(memoryNote)
          .leftJoin(
            message,
            and(
              eq(message.id, memoryNote.sourceMessageId),
              eq(message.tenantId, memoryNote.tenantId),
            ),
          )
          .where(
            and(
              eq(memoryNote.tenantId, tenantId),
              eq(memoryNote.scope, "person"),
              eq(memoryNote.personId, userId),
            ),
          )
          .orderBy(desc(memoryNote.createdAt))
          .limit(input.limit);
        const words = input.query?.trim();
        const messages = words
          ? await s.tx
              .select({
                threadId: message.threadId,
                title: thread.title,
                body: message.body,
                at: message.createdAt,
              })
              .from(message)
              .innerJoin(
                thread,
                and(eq(thread.id, message.threadId), eq(thread.tenantId, message.tenantId)),
              )
              .where(
                and(
                  eq(message.tenantId, tenantId),
                  eq(thread.subjectType, "account"),
                  eq(thread.createdBy, userId),
                  sql`${message.body}->>'text' ilike ${`%${words.replace(/[%_]/g, "")}%`}`,
                ),
              )
              .orderBy(desc(message.createdAt))
              .limit(input.limit)
          : [];
        return {
          summaries: summaries.map((r) => ({
            note: r.note,
            at: r.at.toISOString(),
            threadId: r.threadId ?? null,
          })),
          messages: messages.map((m) => ({
            threadId: m.threadId,
            title: m.title,
            text: String((m.body as { text?: unknown }).text ?? "").slice(0, 500),
            at: m.at.toISOString(),
          })),
        };
      }),
    // v0.17: the areas this client doesn't use yet (an area is in use once it has an owner).
    ideas: (tenantId, call) =>
      scoped(tenantId, call, "read", async (s) => {
        const used = new Set(
          (
            await s.tx
              .select({ area: areaOwner.area })
              .from(areaOwner)
              .where(eq(areaOwner.tenantId, tenantId))
          ).map((r) => r.area),
        );
        return OWNER_AREAS.filter((a) => a !== "general" && !used.has(a)).map((a) => ({
          area: a,
          ...AREA_IDEAS[a],
        }));
      }),
    services: (tenantId, call) => scoped(tenantId, call, "read", (s) => views.services(s)),
    runs: (tenantId, call, query) => scoped(tenantId, call, "read", (s) => views.runs(s, query)),
    run: (tenantId, call, runId) => scoped(tenantId, call, "read", (s) => views.run(s, runId)),
    waiting: (tenantId, call, input) =>
      scoped(tenantId, call, "read", (s) => views.waiting(s, input)),
    explainWait: (tenantId, call, itemId) =>
      scoped(tenantId, call, "read", (s) => views.explainWait(s, itemId)),
    pause: (tenantId, call, input) =>
      scoped(tenantId, call, "pause", (s) =>
        s.asker.test ? Promise.resolve(paused) : views.pause(s, input),
      ),
    resume: (tenantId, call, input) =>
      scoped(tenantId, call, "pause", (s) =>
        s.asker.test ? Promise.resolve(paused) : views.resume(s, input),
      ),
    draftChange: (tenantId, call, input) =>
      scoped(tenantId, call, "draft", (s) =>
        s.asker.test
          ? Promise.resolve({
              status: "test_run" as const,
              loosens: false,
              problems: [],
              inboxItemId: null,
              title: null,
              now: [],
              after: [],
            })
          : views.draftChange(s, input),
      ),
    passToLead: (tenantId, call, input) =>
      scoped(tenantId, call, "pass", (s) =>
        s.asker.test
          ? Promise.resolve({ status: "test_run" as const, requestId: null })
          : views.passToLead(s, input),
      ),
    passToAgent: (tenantId, call, input) =>
      scoped(tenantId, call, "pass", (s) => passToAgent(s, input.serviceId, options.emit)),
    owner: (tenantId, call, input) =>
      scoped(tenantId, call, "read", async (s) =>
        views.owner ? views.owner(s, input.name) : null,
      ),
  };
}
