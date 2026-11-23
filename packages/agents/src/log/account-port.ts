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
  documentEventsOf,
  isPlainObject,
  mayAskFor,
  OWNER_AREAS,
  passToAgentEvent,
  type SopView,
  ThreadMessagePostedPayload,
} from "@countersign/core";
import {
  agent,
  agentVersion,
  appUser,
  areaOwner,
  type Db,
  document,
  event,
  membership,
  memoryNote,
  message,
  run,
  type Tx,
  tenant,
  thread,
  withTenant,
} from "@countersign/db";
import { extractDocument } from "@countersign/documents";
import { createLlmClient } from "@countersign/llm";
import { messageDocuments } from "@countersign/threads";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
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
import type { DbDocumentsOptions } from "./documents-port";
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
/** v0.19: one of the client's area owners, as Sloan may name it in the chat (§10.15). */
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
   * v0.19: the client's owner of that name (any case), or with no name the owner the asker's
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
  /** S2: one of the client's agents' SOP, the portal's own view for the asker. */
  sop?(s: AccountScope, serviceId: string): Promise<SopView>;
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

const LIMITED_WORDS =
  "Sloan isn't open to people who work on only some services: ask your admin or the lead";

/** The run's asker, from its trigger: the person who posted in an account thread. */
async function askerOf(
  tx: Tx,
  tenantId: string,
  call: Pick<AccountCall, "agentId" | "runId" | "mode">,
): Promise<AccountAsker> {
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
    .select({ role: membership.role, name: appUser.name, agentIds: membership.agentIds })
    .from(membership)
    .innerJoin(appUser, eq(appUser.id, membership.userId))
    .where(and(eq(membership.tenantId, tenantId), eq(membership.userId, userId)));
  if (m?.role !== "client_admin" && m?.role !== "client_user") {
    throw new AccountRefusal(ROLE_WORDS.read);
  }
  // DECISION (SEC-8): a client user limited to some agents has no Sloan (plan §1.122), so every
  // account view and write is refused for them here, rather than each view narrowed to their
  // agents: Sloan never shows them more than the portal does.
  if (m.agentIds !== null) throw new AccountRefusal(LIMITED_WORDS);
  return {
    userId,
    role: m.role,
    name: m.name,
    threadId: posted.data.threadId,
    messageId: posted.data.messageId,
    test: false,
  };
}

/** Whom the account agent reads for in the knowledge and threads ports (invariant 11). */
export interface AccountReader {
  role: "client_admin" | "client_user";
  /** Null when no person asked (a test run reads as the client admin; any other run as nobody). */
  userId: string | null;
}

/**
 * Whom a read is for when the caller is the client's account agent: the person who asked, with
 * their role, so Sloan's knowledge and thread reads match what the portal shows that person.
 * Null for any other agent, whose reads stay as they are.
 */
// DECISION: a run of the account agent with no person behind it (not started by a message in an
// account conversation) reads as the narrowest client view, a client user who is nobody: it has
// no portal of its own to match, and nothing it reads there can reach a person.
export async function accountReaderOf(
  tx: Tx,
  tenantId: string,
  call: Pick<AccountCall, "agentId" | "runId" | "mode">,
): Promise<AccountReader | null> {
  const [a] = await tx
    .select({ kind: agent.kind, slug: agent.slug })
    .from(agent)
    .where(and(eq(agent.id, call.agentId), eq(agent.tenantId, tenantId)));
  if (a?.kind !== "client" || a.slug !== ACCOUNT_AGENT_SLUG) return null;
  try {
    const asker = await askerOf(tx, tenantId, call);
    return { role: asker.role, userId: asker.userId };
  } catch (e) {
    if (e instanceof AccountRefusal) return { role: "client_user", userId: null };
    throw e;
  }
}

const NOT_ACCEPTED = {
  self: "Sloan can't pass a request to itself",
  noFiles: "that service doesn't take files or requests from Sloan: offer to pass it to the lead",
  cantRead: "we can't read files for that service here: offer to pass it to the lead",
  notLive: "that service isn't running now, so it can't take a request",
  noSloan: "that service doesn't take requests from Sloan: offer to pass it to the lead",
  notForAsker: "that service doesn't take requests from you: ask your admin or the lead",
} as const;

const notAccepted = (reason: string): AccountPassToAgentOutcome => ({
  status: "not_accepted",
  reason,
  messageId: null,
  files: [],
});

/**
 * Passes the asker's own message to one agent of this client (ARCHITECTURE §9.8, §10.8), then
 * emits `account.request_passed` in the port's transaction. An agent takes it when its live
 * version has a message trigger on channel `sloan` whose People filter takes the asker (the
 * router checks the filter again when it starts the run), or, for a message with files, when it
 * starts on documents (§1.110): the files are then handed to it as if they had just arrived,
 * addressed to it alone. Returns the files still to read for it, after commit.
 */
async function passToAgent(
  s: AccountScope,
  serviceId: string,
  emit: Emit | undefined,
  canRead: boolean,
): Promise<{
  outcome: AccountPassToAgentOutcome;
  read: { agentId: string; ids: string[] } | null;
}> {
  const no = (reason: string) => ({ outcome: notAccepted(reason), read: null });
  if (serviceId === s.call.agentId) return no(NOT_ACCEPTED.self);
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
  if (target.slug === ACCOUNT_AGENT_SLUG) return no(NOT_ACCEPTED.self);
  if (!target.bundle) return no(NOT_ACCEPTED.notLive);

  // §1.110: the files attached to the person's message go with it.
  const { messageId } = s.asker;
  const [asked] = messageId
    ? await s.tx
        .select({ body: message.body })
        .from(message)
        .where(and(eq(message.id, messageId), eq(message.tenantId, s.tenantId)))
    : [];
  const documents = asked ? messageDocuments(asked) : [];
  // DECISION (§1.110): an agent that starts on documents takes files from Sloan without a
  // `sloan` trigger, from any of the client's people, as an upload in the portal would reach it.
  // `document.extracted` needs the files read first, which this port can do only with a reader.
  const onDocs = documents.length > 0 ? documentEventsOf(target.bundle) : [];
  const handover = onDocs.filter((e) => e === "document.received" || canRead);
  const takesRequests = acceptsSloan(target.bundle);
  if (!takesRequests && handover.length === 0) {
    if (onDocs.length > 0) return no(NOT_ACCEPTED.cantRead);
    return no(documents.length > 0 ? NOT_ACCEPTED.noFiles : NOT_ACCEPTED.noSloan);
  }
  // A test run asks as the client admin would (the asker's role); a live one as the person.
  const sender = { kind: "user" as const, userId: s.asker.userId ?? "", role: s.asker.role };
  if (handover.length === 0 && acceptingTriggers(target.bundle, "sloan", sender).length === 0) {
    return no(NOT_ACCEPTED.notForAsker);
  }
  // Paused, draft or retired agents start nothing (the router's `isRunnable`).
  if (target.status !== "active" || target.runStatus !== "active") return no(NOT_ACCEPTED.notLive);
  if (s.asker.test) {
    return {
      outcome: { status: "test_run", reason: null, messageId: null, files: [] },
      read: null,
    };
  }

  const { userId, threadId } = s.asker;
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
  if (before) {
    return {
      outcome: { status: "already_passed", reason: null, messageId, files: [] },
      read: null,
    };
  }
  await emit(
    s.tx,
    s.tenantId,
    passToAgentEvent({ agentId: target.id, threadId, messageId, userId, documents }),
  );
  const files = documents.length
    ? await s.tx
        .select({
          id: document.id,
          name: document.filename,
          source: document.source,
          mimeType: document.mimeType,
          sha256: document.sha256,
          status: document.status,
          meta: document.meta,
        })
        .from(document)
        .where(and(eq(document.tenantId, s.tenantId), inArray(document.id, documents)))
    : [];
  // Only a file attached here and not yet announced is handed over: one that came in another way
  // (an upload, an email) already reached the agents that start on documents.
  const quiet = files.filter(
    (f) => f.status === "stored" && (f.meta as { via?: unknown } | null)?.via === "chat",
  );
  if (handover.includes("document.received")) {
    for (const f of quiet) {
      await emit(s.tx, s.tenantId, {
        type: "document.received",
        subjectType: "document",
        subjectId: f.id,
        payload: {
          documentId: f.id,
          source: f.source,
          filename: f.name,
          mimeType: f.mimeType,
          sha256: f.sha256,
          forAgentId: target.id,
        },
      });
    }
  }
  const toRead = handover.includes("document.extracted") ? quiet.map((f) => f.id) : [];
  return {
    outcome: {
      status: "passed",
      reason: null,
      messageId,
      files: files.map((f) => ({ id: f.id, name: f.name })),
    },
    read: toRead.length > 0 ? { agentId: target.id, ids: toRead } : null,
  };
}

export function dbAccountPort(
  db: Db,
  views: AccountViews,
  options: { emit?: Emit; documents?: DbDocumentsOptions } = {},
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
    // v0.19 (ARCHITECTURE §10.15 "Conversation history"): the asker's own, never anyone else's.
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
    // v0.19: the areas this client doesn't use yet (an area is in use once it has an owner).
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
    passToAgent: async (tenantId, call, input) => {
      const reader = options.documents;
      const { outcome, read } = await scoped(tenantId, call, "pass", (s) =>
        passToAgent(s, input.serviceId, options.emit, !!reader),
      );
      // §1.110: after commit, each handed-over file is read for that agent alone; its
      // `document.extracted` (addressed to it) starts it. A file already here as another copy of
      // the same invoice starts nothing, as on upload.
      if (read && reader) {
        const llm = createLlmClient({ transport: reader.transport });
        for (const documentId of read.ids) {
          await extractDocument(
            { db, content: reader.content, llm },
            { tenantId, documentId, agentVersionId: null, forAgentId: read.agentId },
          );
        }
      }
      return outcome;
    },
    // S2: a limited client user has no Sloan at all (askerOf), so no SOP of an agent off their
    // list is ever read for them.
    sop: (tenantId, call, input) =>
      scoped(tenantId, call, "read", (s) => {
        if (!views.sop) throw new AccountRefusal("SOPs can't be read here");
        return views.sop(s, input.serviceId);
      }),
    owner: (tenantId, call, input) =>
      scoped(tenantId, call, "read", async (s) =>
        views.owner ? views.owner(s, input.name) : null,
      ),
    // S2.3, S2.6: the client Sloan serves and its time zone, for the person asking.
    client: (tenantId, call) =>
      scoped(tenantId, call, "read", async (s) => {
        const [t] = await s.tx
          .select({ name: tenant.name, timeZone: tenant.timezone })
          .from(tenant)
          .where(eq(tenant.id, tenantId));
        if (!t) throw new AccountRefusal("the client isn't here");
        return { name: t.name, timeZone: t.timeZone };
      }),
  };
}
