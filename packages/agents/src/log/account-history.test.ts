// v0.17 O6 (ARCHITECTURE §10.15 "Conversation history"): Sloan's `account.history` reads only the
// asker's own summaries and their own account threads' messages, never another person's, and
// `account.ideas` names the areas the client doesn't use yet. `account.help` answers from the
// portal's guide.

import { agent, agentVersion, areaOwner, memoryNote, message, run, thread } from "@countersign/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type AccountHistory,
  accountHelp,
  accountHistory,
  accountIdeas,
  accountReplyAs,
} from "../tools/account";
import type { ToolInvocation } from "../tools/types";
import { type AccountViews, dbAccountPort } from "./account-port";
import { createHarness, type Harness, makeBundle } from "./harness.test-helper";
import { dbPlatformStore } from "./platform-store";
import { dbThreadsPort } from "./threads-port";

const h = await createHarness();

const ADMIN_RUN = "0192f7a0-0000-7000-8000-00000000c001";
const ADMIN_THREAD = "0192f7a0-0000-7000-8000-00000000c101";
const USER_THREAD = "0192f7a0-0000-7000-8000-00000000c102";
const ADMIN_MESSAGE = "0192f7a0-0000-7000-8000-00000000c201";
const USER_MESSAGE = "0192f7a0-0000-7000-8000-00000000c202";

describe.skipIf(!h)("Sloan's history, ideas and guide", () => {
  const H = h as Harness;
  let sloan = { id: "", versionId: "" };

  beforeAll(async () => {
    const [a] = await H.t.db
      .insert(agent)
      .values({ tenantId: H.A.tenantId, kind: "client", slug: "supervisor", name: "Sloan" })
      .returning();
    const [v] = await H.t.db
      .insert(agentVersion)
      .values({
        tenantId: H.A.tenantId,
        agentId: a?.id as string,
        version: 1,
        bundle: makeBundle({}),
        bundleHash: "h-sloan-history",
        status: "live",
        authorType: "operator",
      })
      .returning();
    sloan = { id: a?.id as string, versionId: v?.id as string };
    await H.t.db
      .update(agent)
      .set({ liveVersionId: sloan.versionId })
      .where(eq(agent.id, sloan.id));
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
        body: { text: "Is the Ferguson bill signed yet?" },
      },
      {
        id: USER_MESSAGE,
        tenantId: H.A.tenantId,
        threadId: USER_THREAD,
        senderType: "user",
        senderId: H.A.userId,
        body: { text: "When does the Ferguson payroll run?" },
      },
    ]);
    await H.t.db.insert(memoryNote).values([
      {
        tenantId: H.A.tenantId,
        agentId: sloan.id,
        scope: "person",
        personId: H.A.adminId,
        note: "Asked whether the Ferguson bill was signed; it was.",
        sourceMessageId: ADMIN_MESSAGE,
      },
      {
        tenantId: H.A.tenantId,
        agentId: sloan.id,
        scope: "person",
        personId: H.A.userId,
        note: "Asked about payroll dates.",
        sourceMessageId: USER_MESSAGE,
      },
    ]);
    await H.t.db
      .insert(areaOwner)
      .values({ tenantId: H.A.tenantId, area: "purchasing", name: "Pia" });
    await H.t.db.insert(run).values({
      id: ADMIN_RUN,
      tenantId: H.A.tenantId,
      agentId: sloan.id,
      agentVersionId: sloan.versionId,
      workflowSlug: "chat",
      trigger: {
        type: "event",
        eventType: "thread.message_posted",
        payload: {
          threadId: ADMIN_THREAD,
          subjectType: "account",
          subjectId: null,
          messageId: ADMIN_MESSAGE,
          senderType: "user",
          senderId: H.A.adminId,
          audience: "client",
        },
      },
    });
  });
  afterAll(async () => {
    await H?.close();
  });

  const ctx = (): ToolInvocation => ({
    tenantId: H.A.tenantId,
    agentId: sloan.id,
    agentVersionId: sloan.versionId,
    runId: ADMIN_RUN,
    stepRunId: ADMIN_RUN,
    stepId: "answer",
    mode: "live",
    platform: dbPlatformStore(H.db),
    account: dbAccountPort(H.db, {} as AccountViews),
  });

  it("reads only the asker's own summaries and messages", async () => {
    const out = (await accountHistory.run(
      { query: "Ferguson", limit: 10 },
      ctx(),
    )) as AccountHistory;
    expect(out.summaries.map((s) => s.note)).toEqual([
      "Asked whether the Ferguson bill was signed; it was.",
    ]);
    expect(out.summaries[0]?.threadId).toBe(ADMIN_THREAD);
    // "Ferguson" is in the other person's message too: it never shows.
    expect(out.messages.map((m) => [m.threadId, m.text])).toEqual([
      [ADMIN_THREAD, "Is the Ferguson bill signed yet?"],
    ]);
  });

  it("names the areas the client doesn't use yet, never one it does", async () => {
    const { ideas } = (await accountIdeas.run({}, ctx())) as { ideas: { area: string }[] };
    const areas = ideas.map((i) => i.area);
    expect(areas).not.toContain("purchasing");
    expect(areas).not.toContain("general");
    expect(areas).toEqual(["sales", "receivables", "bookkeeping", "marketing"]);
  });

  it("answers 'how do I' from the portal's guide", async () => {
    const out = (await accountHelp.run(
      { question: "How do I upload a list of vendors?" },
      ctx(),
    )) as { entries: { id: string; path: string }[] };
    expect(out.entries[0]).toMatchObject({ id: "directory-import", path: "/contacts?import=1" });
  });

  // v0.17 O7 (§10.15 "Talking to an owner"): Sloan answers as the client's own area owner.
  it("answers as the client's owner, under its name, and never as another client's", async () => {
    const [pia] = await H.t.db
      .select({ id: areaOwner.id })
      .from(areaOwner)
      .where(eq(areaOwner.tenantId, H.A.tenantId));
    const [theirs] = await H.t.db
      .insert(areaOwner)
      .values({ tenantId: H.B.tenantId, area: "purchasing", name: "Teo" })
      .returning({ id: areaOwner.id });
    const withThreads = { ...ctx(), threadId: ADMIN_THREAD, threads: dbThreadsPort(H.db) };
    const out = (await accountReplyAs.run(
      { ownerId: pia?.id as string, text: "It was signed this morning.", sources: [ADMIN_MESSAGE] },
      withThreads,
    )) as { messageId: string };
    const [row] = await H.t.db.select().from(message).where(eq(message.id, out.messageId));
    expect(row?.body).toMatchObject({ text: "It was signed this morning.", as: { name: "Pia" } });
    await expect(
      accountReplyAs.run(
        { ownerId: theirs?.id as string, text: "Hello", sources: [ADMIN_MESSAGE] },
        withThreads,
      ),
    ).rejects.toThrow("isn't this client's");
  });
});
