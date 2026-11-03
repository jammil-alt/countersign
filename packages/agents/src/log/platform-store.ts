// The platform's own records that platform tools and the runtime write (PlatformStore): inbox
// items, thread messages and memory notes, each in one client-scoped transaction.

import { type Db, inboxItem, memoryNote, message, thread, withTenant } from "@countersign/db";
import { and, eq, isNull } from "drizzle-orm";
import { AgentsError } from "../errors";
import type { PlatformStore } from "../tools/types";

export function dbPlatformStore(db: Db): PlatformStore {
  return {
    createInboxItem(tenantId, item) {
      return withTenant(db, tenantId, async (tx) => {
        const [row] = await tx
          .insert(inboxItem)
          .values({
            tenantId,
            kind: item.kind,
            title: item.title,
            payload: item.payload,
            agentId: item.agentId ?? null,
            runId: item.runId ?? null,
            subjectType: item.subjectType ?? null,
            subjectId: item.subjectId ?? null,
            assigneeRole: item.assigneeRole ?? null,
            assigneeUserId: item.assigneeUserId ?? null,
            dueAt: item.dueAt ?? null,
          })
          .returning({ id: inboxItem.id });
        if (!row) throw new Error("inbox item insert returned nothing");
        return row;
      });
    },

    postMessage(tenantId, input) {
      return withTenant(db, tenantId, async (tx) => {
        let threadId = input.threadId;
        if (threadId) {
          const [t] = await tx
            .select({ id: thread.id })
            .from(thread)
            .where(and(eq(thread.id, threadId), eq(thread.tenantId, tenantId)));
          if (!t) throw new AgentsError("not_found", `thread ${threadId} not found`);
        } else if (input.subject) {
          const s = input.subject;
          const [t] = await tx
            .select({ id: thread.id })
            .from(thread)
            .where(
              and(
                eq(thread.tenantId, tenantId),
                eq(thread.subjectType, s.type),
                s.id === null ? isNull(thread.subjectId) : eq(thread.subjectId, s.id),
              ),
            )
            .limit(1);
          threadId =
            t?.id ??
            (
              await tx
                .insert(thread)
                .values({ tenantId, subjectType: s.type, subjectId: s.id, title: s.title })
                .returning({ id: thread.id })
            )[0]?.id;
        }
        if (!threadId)
          throw new AgentsError("invalid_state", "a message needs a thread or subject");
        const [m] = await tx
          .insert(message)
          .values({
            tenantId,
            threadId,
            senderType: "agent",
            agentVersionId: input.agentVersionId,
            kind: "text",
            body: input.body,
            sources: input.sources,
            audience: input.audience,
          })
          .returning({ id: message.id });
        if (!m) throw new Error("message insert returned nothing");
        return { id: m.id, threadId };
      });
    },

    writeMemory(tenantId, note) {
      return withTenant(db, tenantId, async (tx) => {
        const [row] = await tx
          .insert(memoryNote)
          .values({ tenantId, agentId: note.agentId, note: note.note, scope: note.scope })
          .returning({ id: memoryNote.id });
        if (!row) throw new Error("memory note insert returned nothing");
        return row;
      });
    },
  };
}
