// Sloan sees only what the portal shows the person asking (invariant 11): `knowledge.search`
// finds the client's FAQs and policies only for a client admin (the portal shows them to admins
// only), and `threads.read` opens another person's account conversation only for a client admin
// (the portal's own `canRead`). Who asks comes from the run's trigger, never from model input.

import { agent, agentVersion, message, run, thread, withTenant } from "@countersign/db";
import { createKnowledgeEntry } from "@countersign/documents";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { knowledgeSearch } from "../tools/knowledge";
import { threadsRead } from "../tools/threads";
import type { ToolInvocation } from "../tools/types";
import { createHarness, type Harness, makeBundle } from "./harness.test-helper";
import { dbKnowledgePort } from "./knowledge-port";
import { dbPlatformStore } from "./platform-store";
import { dbThreadsPort } from "./threads-port";

const h = await createHarness();

const ADMIN_RUN = "0192f7a0-0000-7000-8000-00000000d001";
const USER_RUN = "0192f7a0-0000-7000-8000-00000000d002";
const WATCH_RUN = "0192f7a0-0000-7000-8000-00000000d003";
const ADMIN_THREAD = "0192f7a0-0000-7000-8000-00000000d101";
const USER_THREAD = "0192f7a0-0000-7000-8000-00000000d102";
const ADMIN_MESSAGE = "0192f7a0-0000-7000-8000-00000000d201";
const USER_MESSAGE = "0192f7a0-0000-7000-8000-00000000d202";

describe.skipIf(!h)("Sloan reads for the person asking", () => {
  const H = h as Harness;
  let sloan = { id: "", versionId: "" };
  let other = { id: "", versionId: "" };

  const posted = (threadId: string, messageId: string, senderId: string) => ({
    type: "event",
    eventType: "thread.message_posted",
    payload: {
      threadId,
      subjectType: "account",
      subjectId: null,
      messageId,
      senderType: "user",
      senderId,
      audience: "client",
    },
  });

  beforeAll(async () => {
    for (const [slug, name, hash] of [
      ["supervisor", "Sloan", "h-sloan-reads"],
      ["front-desk", "Front desk", "h-front-desk-reads"],
    ] as const) {
      const [a] = await H.t.db
        .insert(agent)
        .values({ tenantId: H.A.tenantId, kind: "client", slug, name })
        .returning();
      const [v] = await H.t.db
        .insert(agentVersion)
        .values({
          tenantId: H.A.tenantId,
          agentId: a?.id as string,
          version: 1,
          bundle: makeBundle({}),
          bundleHash: hash,
          status: "live",
          authorType: "operator",
        })
        .returning();
      const ids = { id: a?.id as string, versionId: v?.id as string };
      if (slug === "supervisor") sloan = ids;
      else other = ids;
    }
    for (const [id, by, title] of [
      [ADMIN_THREAD, H.A.adminId, "The Ferguson bill"],
      [USER_THREAD, H.A.userId, "Payroll"],
    ] as const) {
      await H.t.db
        .insert(thread)
        .values({ id, tenantId: H.A.tenantId, subjectType: "account", title, createdBy: by });
    }
    await H.t.db.insert(message).values([
      {
        id: ADMIN_MESSAGE,
        tenantId: H.A.tenantId,
        threadId: ADMIN_THREAD,
        senderType: "user",
        senderId: H.A.adminId,
        audience: "client",
        body: { text: "Is the Ferguson bill signed yet?" },
      },
      {
        id: USER_MESSAGE,
        tenantId: H.A.tenantId,
        threadId: USER_THREAD,
        senderType: "user",
        senderId: H.A.userId,
        audience: "client",
        body: { text: "What is the rule on refunds?" },
      },
    ]);
    await H.t.db.insert(run).values([
      {
        id: ADMIN_RUN,
        tenantId: H.A.tenantId,
        agentId: sloan.id,
        agentVersionId: sloan.versionId,
        workflowSlug: "chat",
        trigger: posted(ADMIN_THREAD, ADMIN_MESSAGE, H.A.adminId),
      },
      {
        id: USER_RUN,
        tenantId: H.A.tenantId,
        agentId: sloan.id,
        agentVersionId: sloan.versionId,
        workflowSlug: "chat",
        trigger: posted(USER_THREAD, USER_MESSAGE, H.A.userId),
      },
      {
        id: WATCH_RUN,
        tenantId: H.A.tenantId,
        agentId: sloan.id,
        agentVersionId: sloan.versionId,
        workflowSlug: "watch",
        trigger: { type: "cron" },
      },
    ]);
    await withTenant(H.db, H.A.tenantId, (tx) =>
      createKnowledgeEntry(tx, H.A.tenantId, {
        kind: "policy",
        title: "Refunds",
        body: "Refunds over 500 dollars need the owner's sign-off.",
        author: { id: H.A.adminId, role: "client_admin" },
      }),
    );
  });
  afterAll(async () => {
    await H?.close();
  });

  const ctx = (
    who: { id: string; versionId: string },
    runId: string,
    threadId?: string,
  ): ToolInvocation => ({
    tenantId: H.A.tenantId,
    agentId: who.id,
    agentVersionId: who.versionId,
    runId,
    stepRunId: runId,
    stepId: "answer",
    mode: "live",
    threadId,
    platform: dbPlatformStore(H.db),
    knowledge: dbKnowledgePort(H.db),
    threads: dbThreadsPort(H.db),
  });

  const titles = async (c: ToolInvocation) => {
    const out = (await knowledgeSearch.run({ query: "refunds", limit: 5 }, c)) as {
      results: { kind: string; title: string }[];
    };
    return out.results.map((r) => `${r.kind}:${r.title}`);
  };

  it("finds the client's policies for a client admin", async () => {
    expect(await titles(ctx(sloan, ADMIN_RUN, ADMIN_THREAD))).toEqual(["policy:Refunds"]);
  });

  it("finds no FAQs or policies for a client user, as the portal shows them none", async () => {
    expect(await titles(ctx(sloan, USER_RUN, USER_THREAD))).toEqual([]);
  });

  it("finds no FAQs or policies when no person asked", async () => {
    expect(await titles(ctx(sloan, WATCH_RUN))).toEqual([]);
  });

  it("leaves other agents' searches as they were", async () => {
    expect(await titles(ctx(other, USER_RUN))).toEqual(["policy:Refunds"]);
  });

  it("reads the asker's own account conversation", async () => {
    const out = (await threadsRead.run({ limit: 10 }, ctx(sloan, USER_RUN, USER_THREAD))) as {
      messages: { id: string }[];
    };
    expect(out.messages.map((m) => m.id)).toEqual([USER_MESSAGE]);
  });

  it("never opens another person's account conversation for a client user", async () => {
    await expect(
      threadsRead.run({ threadId: ADMIN_THREAD, limit: 10 }, ctx(sloan, USER_RUN, USER_THREAD)),
    ).rejects.toThrow(/not found/i);
    await expect(
      threadsRead.run({ threadId: USER_THREAD, limit: 10 }, ctx(sloan, WATCH_RUN)),
    ).rejects.toThrow(/not found/i);
  });

  it("opens any account conversation for a client admin, as the portal does", async () => {
    const out = (await threadsRead.run(
      { threadId: USER_THREAD, limit: 10 },
      ctx(sloan, ADMIN_RUN, ADMIN_THREAD),
    )) as { messages: { id: string }[] };
    expect(out.messages.map((m) => m.id)).toEqual([USER_MESSAGE]);
  });
});
