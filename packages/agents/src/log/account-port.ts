// The AccountPort behind Sloan's `account.*` tools (ARCHITECTURE §9.8; docs/plan.md §1.47). Each
// call is one client-scoped transaction (invariant 1), so a second client's records are never
// visible. Before anything is read or written the port checks, from the database and never from
// model input:
//
// - the caller is the client's account agent (the supervisor's fork, `platform` kind);
// - who is asking: the person whose message started the run (`thread.message_posted` in an
//   account thread, in the run's trigger), and their role in this client;
// - that the role allows the action (reads and passing to the lead: any client person; pausing
//   and drafting: the client admin).
//
// A test run reads as the client admin would and writes nothing. The views and writes themselves
// are the portal's own code, handed in by apps/api (AccountViews), so Sloan sees and does exactly
// what the portal would.

import {
  ACCOUNT_AGENT_SLUG,
  type AccountAction,
  type AccountChange,
  type AccountRunSummary,
  type AccountRunsQuery,
  type AccountRunView,
  type AccountService,
  type AccountWaitExplanation,
  isPlainObject,
  mayAskFor,
  ThreadMessagePostedPayload,
} from "@countersign/core";
import { agent, appUser, type Db, membership, run, type Tx, withTenant } from "@countersign/db";
import { and, eq } from "drizzle-orm";
import { AgentsError } from "../errors";
import type {
  AccountCall,
  AccountDraftOutcome,
  AccountPassInput,
  AccountPassOutcome,
  AccountPauseOutcome,
  AccountPort,
  AccountWaiting,
} from "../tools/account";

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
export interface AccountViews {
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

export function dbAccountPort(db: Db, views: AccountViews): AccountPort {
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
  };
}
