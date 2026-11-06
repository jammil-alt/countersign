// Threads against a throwaway Postgres, acting as the Worker's role (cs_worker) so RLS holds:
// one lead thread per client under concurrency, isolation between clients, read marks and unread
// counts, `/commands`, and the event that never carries the text.

import type { AgentBundle } from "@countersign/core";
import {
  agent,
  agentVersion,
  appUser,
  event,
  membership,
  message,
  type Tx,
  tenant,
  thread,
  withTenant,
  withTenants,
} from "@countersign/db";
import {
  asWorker,
  createTestDatabase,
  databaseAvailable,
  type TestDatabase,
} from "@countersign/db/testing";
import type { EventRow } from "@countersign/senses";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { canPost, canRead, visibleAudiences } from "./access";
import { senseEmitPosted } from "./index";
import { leadOf, servesClient, setLead } from "./lead";
import { postAsPerson } from "./post";
import {
  agentThread,
  findThread,
  leadThread,
  listMessages,
  listThreads,
  markRead,
  messageText,
  postMessage,
  startAccountThread,
  threadActivity,
} from "./store";

const online = await databaseAvailable();

function bundle(name: string, skills: string[] = []): AgentBundle {
  return {
    schemaVersion: 1,
    definition: {
      schemaVersion: 2,
      identity: { name, role: "tests", mission: "be tested" },
      kind: "functional",
      model: { id: "claude-opus-5-5", maxTokens: 1024 },
      instructions: "Do nothing.",
      skills: skills.map((skill) => ({ skill, settings: {} })),
      extraTools: [],
      canCommand: [],
      permissions: { mode: "suggest_only" },
      budgets: { maxSteps: 3, maxCostUsd: "0.10" },
      memory: { enabled: false },
    },
    workflows: [],
  } as AgentBundle;
}

describe.skipIf(!online)("threads store", () => {
  let t: TestDatabase;
  let A: string;
  let B: string;
  let ana: string; // operator, serves A and B
  let carl: string; // client admin of A
  let una: string; // client user of A
  let remy: string; // A's active agent "Remy"
  let pia: string; // A's paused agent "Pia"

  const asClient = <T>(tenantId: string, fn: (tx: Tx) => Promise<T>) =>
    withTenant(t.db, tenantId, async (tx) => {
      await asWorker(tx);
      return fn(tx);
    });

  async function clientAgent(
    tenantId: string,
    slug: string,
    name: string,
    runStatus: "active" | "paused",
    skills: string[] = [],
  ): Promise<string> {
    const [a] = await t.db
      .insert(agent)
      .values({ tenantId, kind: "client", slug, name, runStatus })
      .returning();
    const [v] = await t.db
      .insert(agentVersion)
      .values({
        tenantId,
        agentId: a?.id as string,
        version: 1,
        bundle: bundle(name, skills),
        bundleHash: `hash-${slug}`,
        status: "live",
        authorType: "operator",
      })
      .returning();
    await t.db
      .update(agent)
      .set({ liveVersionId: v?.id as string })
      .where(eq(agent.id, a?.id as string));
    return a?.id as string;
  }

  beforeAll(async () => {
    const created = await createTestDatabase();
    if (!created) throw new Error("database vanished");
    t = created;
    const rows = await t.db
      .insert(tenant)
      .values([{ name: "A" }, { name: "B" }])
      .returning();
    A = rows[0]?.id as string;
    B = rows[1]?.id as string;
    const users = await t.db
      .insert(appUser)
      .values([
        { email: "ana@mezonas.test", name: "Ana Souza" },
        { email: "carl@a.test", name: "Carl" },
        { email: "una@a.test", name: "Una" },
      ])
      .returning();
    [ana, carl, una] = users.map((u) => u.id) as [string, string, string];
    await t.db.insert(membership).values([
      { tenantId: A, userId: ana, role: "operator" },
      { tenantId: B, userId: ana, role: "operator" },
      { tenantId: A, userId: carl, role: "client_admin" },
      { tenantId: A, userId: una, role: "client_user" },
    ]);
    remy = await clientAgent(A, "remy-collections", "Remy", "active", [
      "materials.match-lines",
      "docs.extract",
    ]);
    pia = await clientAgent(A, "pia", "Pia", "paused");
  });
  afterAll(async () => {
    await t?.drop();
  });

  it("opens one lead thread per client, even when asked at once", async () => {
    const ids = await Promise.all(
      Array.from({ length: 8 }, () => asClient(A, (tx) => leadThread(tx, A).then((r) => r.id))),
    );
    expect(new Set(ids).size).toBe(1);
    const rows = await t.db
      .select()
      .from(thread)
      .where(and(eq(thread.tenantId, A), eq(thread.subjectType, "lead")));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.subjectId).toBe(A);
    // The database refuses a second one outright.
    await expect(
      t.db
        .insert(thread)
        .values({ tenantId: A, subjectType: "lead", subjectId: A, title: "again" }),
    ).rejects.toThrow();
    const b = await asClient(B, (tx) => leadThread(tx, B));
    expect(b.id).not.toBe(ids[0]);
  });

  it("opens one agent thread per agent", async () => {
    const ids = await Promise.all(
      Array.from({ length: 5 }, () =>
        asClient(A, (tx) => agentThread(tx, A, { id: remy, name: "Remy" }).then((r) => r.id)),
      ),
    );
    expect(new Set(ids).size).toBe(1);
  });

  it("keeps each client's threads to itself", async () => {
    const lead = await asClient(A, (tx) => leadThread(tx, A));
    expect(await asClient(B, (tx) => findThread(tx, [B], lead.id))).toBeUndefined();
    // Even asking for A's id by name, B's scope sees nothing (RLS), and listing shows only B's.
    expect(await asClient(B, (tx) => findThread(tx, [A, B], lead.id))).toBeUndefined();
    const bThreads = await asClient(B, (tx) => listThreads(tx, B));
    expect(bThreads.every((x) => x.tenantId === B)).toBe(true);
    // Posting into A's thread from B's scope is refused.
    await expect(
      asClient(B, (tx) =>
        postMessage(tx, {
          tenantId: B,
          thread: lead,
          senderType: "user",
          senderId: ana,
          kind: "text",
          body: { text: "wrong client" },
          sources: [],
          audience: "client",
        }),
      ),
    ).rejects.toThrow();
    await expect(
      asClient(B, (tx) =>
        tx.insert(message).values({
          tenantId: A,
          threadId: lead.id,
          senderType: "user",
          senderId: ana,
          body: { text: "x" },
          audience: "client",
        }),
      ),
    ).rejects.toThrow();
  });

  it("counts unread per person, never their own, and moves the read mark forward", async () => {
    const lead = await asClient(A, (tx) => leadThread(tx, A));
    const post = (userId: string, text: string, audience: "client" | "operator" = "client") =>
      asClient(A, (tx) =>
        postAsPerson(tx, {
          tenantId: A,
          thread: lead,
          userId,
          operator: userId === ana,
          text,
          sources: [],
          audience,
          locale: "en",
        }),
      );
    await post(carl, "Hello Ana, a question about March.");
    await post(carl, "And one more.");
    await post(ana, "Internal: check the March bills first.", "operator");
    const unread = (userId: string, audiences: ("client" | "operator")[]) =>
      asClient(A, (tx) => threadActivity(tx, A, [lead.id], userId, audiences)).then(
        (m) => m.get(lead.id)?.unread ?? 0,
      );
    expect(await unread(carl, ["client"])).toBe(0);
    // The note is never counted for the client.
    expect(await unread(una, ["client"])).toBe(2);
    expect(await unread(ana, ["client", "operator"])).toBe(2);

    await asClient(A, (tx) => markRead(tx, lead, ana));
    expect(await unread(ana, ["client", "operator"])).toBe(0);
    await post(una, "Thanks.");
    expect(await unread(ana, ["client", "operator"])).toBe(1);
    expect(await unread(carl, ["client"])).toBe(1);
    // Marking read twice is fine, and a client's read mark is theirs alone.
    await asClient(A, (tx) => markRead(tx, lead, carl));
    await asClient(A, (tx) => markRead(tx, lead, carl));
    expect(await unread(carl, ["client"])).toBe(0);
    expect(await unread(una, ["client"])).toBe(2);

    const clientView = await asClient(A, (tx) =>
      listMessages(tx, lead, {
        audiences: visibleAudiences({ kind: "client", role: "client_user", userId: una }),
      }),
    );
    expect(clientView.map(messageText)).not.toContain("Internal: check the March bills first.");
    const opsView = await asClient(A, (tx) =>
      listMessages(tx, lead, { audiences: ["client", "operator"] }),
    );
    expect(opsView.map(messageText)).toContain("Internal: check the March bills first.");
    // Oldest first, and a page of the newest.
    const last = await asClient(A, (tx) =>
      listMessages(tx, lead, { audiences: ["client"], limit: 1 }),
    );
    expect(last.map(messageText)).toEqual(["Thanks."]);
  });

  it("posts /remy as a command naming the agent, and emits ids only", async () => {
    const lead = await asClient(A, (tx) => leadThread(tx, A));
    const collect: EventRow[] = [];
    const posted = await asClient(A, (tx) =>
      postAsPerson(
        tx,
        {
          tenantId: A,
          thread: lead,
          userId: carl,
          operator: false,
          text: "/remy hello, chase invoice 1042",
          sources: [],
          audience: "client",
          locale: "en",
        },
        senseEmitPosted({ collect }),
      ),
    );
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ kind: "command", command: "remy", senderType: "user" });
    expect(posted[0]?.body).toEqual({
      text: "/remy hello, chase invoice 1042",
      args: "hello, chase invoice 1042",
    });
    expect(collect).toHaveLength(1);
    const ev = collect[0] as EventRow;
    expect(ev.type).toBe("thread.message_posted");
    expect(ev.subjectId).toBe(lead.id);
    expect(ev.payload).toEqual({
      threadId: lead.id,
      subjectType: "lead",
      subjectId: A,
      messageId: posted[0]?.id,
      senderType: "user",
      senderId: carl,
      audience: "client",
      command: { name: "remy", agentId: remy },
    });
    expect(JSON.stringify(ev.payload)).not.toContain("invoice 1042");
    const [stored] = await t.db.select().from(event).where(eq(event.id, ev.id));
    expect(stored?.tenantId).toBe(A);
  });

  it("answers an unknown or paused agent's command with a system message and names no agent", async () => {
    const lead = await asClient(A, (tx) => leadThread(tx, A));
    await t.db
      .update(tenant)
      .set({ settings: { language: "es" } })
      .where(eq(tenant.id, A));
    for (const name of ["nobody", "pia"]) {
      const collect: EventRow[] = [];
      const posted = await asClient(A, (tx) =>
        postAsPerson(
          tx,
          {
            tenantId: A,
            thread: lead,
            userId: una,
            operator: false,
            text: `/${name} are you there?`,
            sources: [],
            audience: "client",
            locale: "es",
          },
          senseEmitPosted({ collect }),
        ),
      );
      expect(posted.map((m) => [m.senderType, m.kind])).toEqual([
        ["user", "text"],
        ["system", "text"],
      ]);
      expect(messageText(posted[1] as never)).toBe(`Aquí no hay ningún agente llamado /${name}.`);
      expect(collect.some((e) => "command" in (e.payload as object))).toBe(false);
    }
    expect(pia).toBeTruthy();
  });

  it("lets an operator name a skill with /skill on an agent's thread", async () => {
    const at = await asClient(A, (tx) => agentThread(tx, A, { id: remy, name: "Remy" }));
    const collect: EventRow[] = [];
    const [posted] = await asClient(A, (tx) =>
      postAsPerson(
        tx,
        {
          tenantId: A,
          thread: at,
          userId: ana,
          operator: true,
          text: "/match-lines bill 1042",
          sources: [],
          audience: "operator",
          locale: "en",
        },
        senseEmitPosted({ collect }),
      ),
    );
    expect(posted).toMatchObject({ kind: "command", command: "match-lines", audience: "operator" });
    expect((collect[0] as EventRow).payload).toMatchObject({
      command: {
        name: "match-lines",
        agentId: remy,
        skill: "materials.match-lines",
      },
    });
    // A client on the same thread names agents, not skills.
    const [client] = await asClient(A, (tx) =>
      postAsPerson(tx, {
        tenantId: A,
        thread: at,
        userId: carl,
        operator: false,
        text: "/match-lines please",
        sources: [],
        audience: "client",
        locale: "en",
      }),
    );
    expect(client).toMatchObject({ kind: "text", command: null });
  });

  it("starts account threads per person and lists a client user's own only", async () => {
    const mine = await asClient(A, (tx) => startAccountThread(tx, A, una));
    const theirs = await asClient(A, (tx) => startAccountThread(tx, A, carl));
    expect(mine.createdBy).toBe(una);
    const unaList = await asClient(A, (tx) =>
      listThreads(tx, A, { subjectType: "account", accountCreatedBy: una }),
    );
    expect(unaList.map((x) => x.id)).toEqual([mine.id]);
    const all = await asClient(A, (tx) => listThreads(tx, A, { subjectType: "account" }));
    expect(all.map((x) => x.id).sort()).toEqual([mine.id, theirs.id].sort());
  });

  it("sets the lead to an operator who serves the client", async () => {
    expect(await asClient(A, (tx) => leadOf(tx, A))).toBeNull();
    expect(await withTenants(t.db, [A], (tx) => servesClient(tx, A, ana))).toBe(true);
    expect(await withTenants(t.db, [A], (tx) => servesClient(tx, A, carl))).toBe(false);
    await t.db
      .update(tenant)
      .set({ settings: { language: "es", other: 1 } })
      .where(eq(tenant.id, A));
    const before = await asClient(A, (tx) => setLead(tx, A, ana));
    expect(before).toBeNull();
    expect(await asClient(A, (tx) => leadOf(tx, A))).toEqual({
      userId: ana,
      name: "Ana Souza",
      email: "ana@mezonas.test",
    });
    const [row] = await t.db.select().from(tenant).where(eq(tenant.id, A));
    expect(row?.settings).toEqual({ language: "es", other: 1, lead: { userId: ana } });
    expect(await asClient(A, (tx) => setLead(tx, A, null))).toBe(ana);
    expect(await asClient(A, (tx) => leadOf(tx, A))).toBeNull();
  });
});

describe("who reads and posts", () => {
  const op = { kind: "operator" as const, userId: "o" };
  const admin = { kind: "client" as const, role: "client_admin" as const, userId: "a" };
  const user = { kind: "client" as const, role: "client_user" as const, userId: "u" };
  const other = { kind: "client" as const, role: "client_user" as const, userId: "x" };

  it("follows ARCHITECTURE §11.2", () => {
    const lead = { subjectType: "lead", createdBy: null };
    const agentT = { subjectType: "agent", createdBy: null };
    const account = { subjectType: "account", createdBy: "u" };
    const run = { subjectType: "run", createdBy: null };
    const contact = { subjectType: "contact", createdBy: null };
    for (const v of [op, admin, user, other]) {
      expect(canRead(v, lead)).toBe(true);
      expect(canPost(v, lead)).toBe(true);
      expect(canRead(v, agentT)).toBe(true);
    }
    expect(canRead(user, account)).toBe(true);
    expect(canRead(admin, account)).toBe(true);
    expect(canRead(op, account)).toBe(true);
    expect(canRead(other, account)).toBe(false);
    expect(canPost(other, account)).toBe(false);
    expect(canRead(admin, run)).toBe(false);
    expect(canRead(op, run)).toBe(true);
    expect(canPost(op, run)).toBe(true);
    expect(canRead(op, contact)).toBe(true);
    expect(canPost(op, contact)).toBe(false);
    expect(visibleAudiences(user)).toEqual(["client"]);
    expect(visibleAudiences(op)).toEqual(["client", "operator"]);
  });
});
