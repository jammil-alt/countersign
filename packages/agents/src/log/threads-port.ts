// The threads behind `threads.post` and `threads.read` (ThreadsPort), over packages/threads: each
// call one client-scoped transaction, so only that client's threads are visible (invariant 1).
// Posting emits `thread.message_posted` through the runtime's emitter (nothing for a test run).
//
// The account agent (Sloan, ARCHITECTURE §9.8) is the only agent that writes to the client, only
// in an account thread, and it reads only what the portal shows: client-facing messages of the
// client's own thread kinds, with operators other than the lead named "Mezonas".

import {
  ACCOUNT_AGENT_SLUG,
  isClientThreadKind,
  type JsonObject,
  type MessageAudience,
} from "@countersign/core";
import {
  agent,
  agentVersion,
  appUser,
  type Db,
  membership,
  type Tx,
  thread as threadTable,
  withTenant,
} from "@countersign/db";
import {
  agentThread,
  type EmitPosted,
  findThread,
  leadOf,
  leadThread,
  listMessages,
  messageText,
  postMessage,
  type ThreadRow,
} from "@countersign/threads";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { AgentsError, notFound } from "../errors";
import type { ThreadMessageForTool, ThreadsPort } from "../tools/threads";
import type { Emit } from "./external-actions";

async function isAccountAgent(tx: Tx, tenantId: string, agentId: string): Promise<boolean> {
  const [a] = await tx
    .select({ slug: agent.slug, kind: agent.kind })
    .from(agent)
    .where(and(eq(agent.id, agentId), eq(agent.tenantId, tenantId)));
  return a?.kind === "client" && a.slug === ACCOUNT_AGENT_SLUG;
}

/** The thread a post goes to: by id, else found or opened for its subject. */
async function threadFor(
  tx: Tx,
  tenantId: string,
  threadId: string | undefined,
  subject: { type: string; id: string | null; title: string } | undefined,
): Promise<ThreadRow> {
  if (threadId) {
    const t = await findThread(tx, [tenantId], threadId);
    if (!t) throw notFound(`thread ${threadId}`);
    return t;
  }
  if (!subject) throw new AgentsError("invalid_state", "a message needs a thread or subject");
  if (subject.type === "lead") return leadThread(tx, tenantId);
  if (subject.type === "agent") {
    if (!subject.id) throw new AgentsError("invalid_state", "an agent thread needs the agent's id");
    return agentThread(tx, tenantId, { id: subject.id, name: subject.title });
  }
  // Account threads are a person's conversations: an agent never starts one.
  if (subject.type === "account") {
    throw new AgentsError("invalid_state", "an account thread is started by a person");
  }
  const [found] = await tx
    .select()
    .from(threadTable)
    .where(
      and(
        eq(threadTable.tenantId, tenantId),
        eq(threadTable.subjectType, subject.type),
        subject.id === null ? isNull(threadTable.subjectId) : eq(threadTable.subjectId, subject.id),
      ),
    )
    .limit(1);
  if (found) return found;
  const [made] = await tx
    .insert(threadTable)
    .values({ tenantId, subjectType: subject.type, subjectId: subject.id, title: subject.title })
    .returning();
  if (!made) throw new Error("thread insert returned nothing");
  return made;
}

export function dbThreadsPort(db: Db, options: { emit?: Emit } = {}): ThreadsPort {
  const emitPosted = (testRun: boolean): EmitPosted | undefined => {
    const { emit } = options;
    if (!emit || testRun) return undefined;
    return (tx, event) =>
      emit(tx, event.tenantId, {
        type: event.type,
        subjectType: event.subjectType,
        subjectId: event.subjectId,
        payload: event.payload as unknown as JsonObject,
      });
  };

  return {
    post(tenantId, input) {
      return withTenant(db, tenantId, async (tx) => {
        const t = await threadFor(tx, tenantId, input.threadId, input.subject);
        if (input.audience === "client") {
          // Model text reaches a client thread only from Sloan, in an account thread, live (§11.2).
          if (input.mode === "test") {
            throw new AgentsError("test_run", "a test run never writes to the client");
          }
          if (!(await isAccountAgent(tx, tenantId, input.agentId))) {
            throw new AgentsError(
              "invalid_state",
              "only the account agent writes to the client; post a note for the operator",
            );
          }
          if (t.subjectType !== "account") {
            throw new AgentsError("invalid_state", "the account agent answers in account threads");
          }
        }
        const posted = await postMessage(
          tx,
          {
            tenantId,
            thread: t,
            senderType: "agent",
            senderId: input.agentId,
            agentVersionId: input.agentVersionId,
            kind: "text",
            body: {
              text: input.text,
              stepId: input.stepId,
              runId: input.runId,
              ...(input.mode === "test" ? { testRunId: input.runId } : {}),
            },
            sources: input.sources,
            audience: input.audience,
          },
          emitPosted(input.mode === "test"),
        );
        return { messageId: posted.id, threadId: t.id };
      });
    },

    read(tenantId, input) {
      return withTenant(db, tenantId, async (tx) => {
        const t = await findThread(tx, [tenantId], input.threadId);
        if (!t) throw notFound(`thread ${input.threadId}`);
        const account = await isAccountAgent(tx, tenantId, input.agentId);
        // Sloan sees only what the portal shows: the client's own kinds, client-facing messages.
        if (account && !isClientThreadKind(t.subjectType))
          throw notFound(`thread ${input.threadId}`);
        const audiences: MessageAudience[] = account ? ["client"] : ["client", "operator"];
        const rows = await listMessages(tx, t, { audiences, limit: input.limit });

        const userIds = [
          ...new Set(
            rows
              .filter((r) => r.senderType === "user" && r.senderId)
              .map((r) => r.senderId as string),
          ),
        ];
        const users = userIds.length
          ? await tx
              .select({ id: appUser.id, name: appUser.name, email: appUser.email })
              .from(appUser)
              .where(inArray(appUser.id, userIds))
          : [];
        const operators = new Set(
          userIds.length
            ? (
                await tx
                  .select({ userId: membership.userId })
                  .from(membership)
                  .where(
                    and(
                      eq(membership.tenantId, tenantId),
                      eq(membership.role, "operator"),
                      inArray(membership.userId, userIds),
                    ),
                  )
              ).map((m) => m.userId)
            : [],
        );
        const lead = account ? await leadOf(tx, tenantId) : null;
        const versionIds = [
          ...new Set(rows.filter((r) => r.agentVersionId).map((r) => r.agentVersionId as string)),
        ];
        const agents = versionIds.length
          ? await tx
              .select({
                versionId: agentVersion.id,
                name: agent.name,
                serviceName: agent.serviceName,
              })
              .from(agentVersion)
              .innerJoin(agent, eq(agent.id, agentVersion.agentId))
              .where(and(inArray(agentVersion.id, versionIds), eq(agentVersion.tenantId, tenantId)))
          : [];

        const nameOf = (r: (typeof rows)[number]): string | null => {
          if (r.senderType === "user" && r.senderId) {
            const u = users.find((x) => x.id === r.senderId);
            if (!u) return null;
            if (account && operators.has(u.id) && lead?.userId !== u.id) return "Mezonas";
            return u.name ?? null;
          }
          if (r.senderType === "agent" && r.agentVersionId) {
            const a = agents.find((x) => x.versionId === r.agentVersionId);
            return a ? (a.serviceName ?? a.name) : null;
          }
          return null;
        };
        const messages = rows.map(
          (r): ThreadMessageForTool => ({
            id: r.id,
            at: r.createdAt.toISOString(),
            from: r.senderType === "user" ? "person" : r.senderType,
            name: nameOf(r),
            kind: r.kind,
            command: r.command,
            text: messageText(r),
            sources: r.sources,
          }),
        );
        return { threadId: t.id, subjectType: t.subjectType, messages };
      });
    },
  };
}
