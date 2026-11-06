// Threads, the lead and `/commands` through the API (docs/plan.md §1.38, M15): a client member and
// the lead talk in the lead thread with unread counts; who reads and posts each kind; operator
// notes never reach the portal and no operator but the lead is named there; sources are checked
// to be this client's; `/remy` posts a command and emits the event (ids only), `/nobody` gets a
// system answer; a lead check goes to the lead, or the operator role without one.

import {
  type AgentBundle,
  type AgentBundleInput,
  AgentBundle as AgentBundleSchema,
  type PersonStep,
} from "@countersign/core";
import {
  agent,
  agentVersion,
  appUser,
  event,
  inboxItem,
  membership,
  run,
  stepRun,
  tenantChange,
  thread,
  vendor,
} from "@countersign/db";
import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import {
  admin,
  createApiHarness,
  forbiddenKeys,
  OPERATOR,
  OTHER_OPERATOR,
  testBundle,
  user,
} from "./api.test-helper";
import { dbInboxPort } from "./runs/ports";

const h = await createApiHarness();
afterAll(() => h?.close());

type Json = Record<string, unknown>;
type Msg = Json & {
  id: string;
  kind: string;
  text: string;
  command: string | null;
  sender: Json & { type: string; name: string | null; you?: boolean; lead?: boolean };
};
type Thr = Json & { id: string; unread: number; subject?: string };

/** A bundle whose workflow has a lead check ("Check new matches", assignee `lead`). */
function leadCheckBundle(): AgentBundle {
  const base = testBundle("Remy");
  const workflows = [
    {
      slug: "check",
      name: "Check",
      workflow: {
        schemaVersion: 3,
        trigger: { id: "trg-manual", on: { type: "manual", input: {} } },
        steps: [
          {
            id: "lead-check",
            name: "Lead check",
            kind: "person",
            mode: "approve",
            assignee: "lead",
            title: "Check the new matches",
            timeout: "1 day",
            onTimeout: "stop",
            client: { visible: true, label: "Check new matches" },
          },
        ],
      },
    },
  ];
  return AgentBundleSchema.parse({ ...base, workflows } as unknown as AgentBundleInput);
}

describe.skipIf(!h)("threads and the lead", () => {
  const H = h as NonNullable<typeof h>;
  const call = H.call.bind(H);
  let leadThreadId: string;
  let remy: { id: string; versionId: string };

  async function activeAgent(tenantId: string, slug: string, bundle: AgentBundle) {
    const created = await call(OPERATOR, "POST", `/api/ops/clients/${tenantId}/agents`, {
      slug,
      bundle,
    });
    expect(created.status).toBe(200);
    const body = created.json as { agent: Json; version: Json };
    const id = body.agent.id as string;
    const versionId = body.version.id as string;
    await H.t.db
      .update(agent)
      .set({ runStatus: "active", liveVersionId: versionId, serviceName: `${slug} service` })
      .where(eq(agent.id, id));
    return { id, versionId };
  }

  it("sets the lead to an operator who serves the client, logged, and names them to the client", async () => {
    const none = await call(admin("a"), "GET", "/api/threads?subject=lead");
    expect(none.status).toBe(200);
    expect((none.json as { lead: unknown }).lead).toBeNull();

    const path = `/api/ops/clients/${H.A.tenantId}/lead`;
    // Someone who doesn't serve the client, or a client member, can't be the lead.
    expect((await call(OPERATOR, "PUT", path, { userId: H.otherOperator })).status).toBe(422);
    expect((await call(OPERATOR, "PUT", path, { userId: H.A.admin })).status).toBe(422);
    // Clients don't set it; an operator who doesn't serve the client doesn't either.
    expect((await call(admin("a"), "PUT", path, { userId: H.operator })).status).toBe(403);
    expect((await call(OTHER_OPERATOR, "PUT", path, { userId: H.operator })).status).toBe(404);

    const set = await call(OPERATOR, "PUT", path, { userId: H.operator, reason: "Ana leads A" });
    expect(set.status).toBe(200);
    expect(set.json).toEqual({
      lead: { userId: H.operator, name: "Operator", email: OPERATOR },
    });
    const log = await H.t.db
      .select()
      .from(tenantChange)
      .where(eq(tenantChange.tenantId, H.A.tenantId));
    expect(log.map((l) => l.change)).toContainEqual({
      setting: "lead",
      from: null,
      to: H.operator,
    });

    const session = await call(admin("a"), "GET", "/api/session");
    expect((session.json as { lead: unknown }).lead).toEqual({ name: "Operator" });
    const sessionB = await call(admin("b"), "GET", "/api/session");
    expect((sessionB.json as { lead: unknown }).lead).toBeNull();
  });

  it("lets a client member and the lead talk in the lead thread, with unread counts", async () => {
    const opened = await call(user("a"), "GET", "/api/threads?subject=lead");
    expect(opened.status).toBe(200);
    const body = opened.json as { lead: unknown; threads: Thr[] };
    expect(body.lead).toEqual({ name: "Operator" });
    expect(body.threads).toHaveLength(1);
    leadThreadId = (body.threads[0] as Thr).id;
    // Asking again opens nothing new.
    const again = await call(admin("a"), "GET", "/api/threads?subject=lead");
    expect(((again.json as { threads: Thr[] }).threads[0] as Thr).id).toBe(leadThreadId);

    const posted = await call(admin("a"), "POST", `/api/threads/${leadThreadId}/messages`, {
      text: "Can you look at the March bills?",
    });
    expect(posted.status).toBe(200);
    const [mine] = (posted.json as { messages: Msg[] }).messages;
    expect(mine).toMatchObject({
      kind: "text",
      text: "Can you look at the March bills?",
      sender: { type: "user", name: "Client A admin", you: true, lead: false },
    });

    // The lead sees one unread message in the back office.
    const ops = await call(
      OPERATOR,
      "GET",
      `/api/ops/clients/${H.A.tenantId}/threads?subject=lead`,
    );
    expect(ops.status).toBe(200);
    expect((ops.json as { threads: Thr[] }).threads[0]).toMatchObject({
      id: leadThreadId,
      subjectType: "lead",
      unread: 1,
    });

    // The lead answers the client, and leaves a note for operators.
    const reply = await call(OPERATOR, "POST", `/api/ops/threads/${leadThreadId}/messages`, {
      text: "Yes, I'll check them today.",
      audience: "client",
    });
    expect(reply.status).toBe(200);
    const note = await call(OPERATOR, "POST", `/api/ops/threads/${leadThreadId}/messages`, {
      text: "Internal: March has two duplicates.",
      audience: "operator",
    });
    expect(note.status).toBe(200);
    // An operator must say who reads it.
    expect(
      (await call(OPERATOR, "POST", `/api/ops/threads/${leadThreadId}/messages`, { text: "x" }))
        .status,
    ).toBe(400);

    const list = await call(user("a"), "GET", `/api/threads/${leadThreadId}/messages`);
    expect(list.status).toBe(200);
    const msgs = (list.json as { messages: Msg[]; thread: Thr }).messages;
    expect(msgs.map((m) => m.text)).toEqual([
      "Can you look at the March bills?",
      "Yes, I'll check them today.",
    ]);
    expect(msgs[1]?.sender).toEqual({ type: "user", name: "Operator", you: false, lead: true });
    expect(forbiddenKeys(list.json)).toEqual([]);
    expect(JSON.stringify(list.json)).not.toContain("audience");
    expect((list.json as { thread: Thr }).thread.unread).toBe(2);

    // Read marks are per person.
    expect((await call(user("a"), "POST", `/api/threads/${leadThreadId}/read`)).status).toBe(200);
    const after = await call(user("a"), "GET", "/api/threads");
    const lead = (after.json as { threads: Thr[] }).threads.find((t) => t.id === leadThreadId);
    expect(lead?.unread).toBe(0);
    const adminView = await call(admin("a"), "GET", "/api/threads?subject=lead");
    expect(((adminView.json as { threads: Thr[] }).threads[0] as Thr).unread).toBe(1);
    expect((await call(OPERATOR, "POST", `/api/ops/threads/${leadThreadId}/read`)).status).toBe(
      200,
    );
    const opsAfter = await call(
      OPERATOR,
      "GET",
      `/api/ops/clients/${H.A.tenantId}/threads?subject=lead`,
    );
    expect(((opsAfter.json as { threads: Thr[] }).threads[0] as Thr).unread).toBe(0);

    // The back office reads the note too.
    const opsMsgs = await call(OPERATOR, "GET", `/api/ops/threads/${leadThreadId}/messages`);
    expect((opsMsgs.json as { messages: Msg[] }).messages.map((m) => m.text)).toContain(
      "Internal: March has two duplicates.",
    );

    // Posting emitted the event, with ids only.
    const events = await H.t.db
      .select()
      .from(event)
      .where(and(eq(event.tenantId, H.A.tenantId), eq(event.type, "thread.message_posted")));
    expect(events.length).toBeGreaterThanOrEqual(3);
    for (const e of events) expect(JSON.stringify(e.payload)).not.toMatch(/March|check them/);
  });

  it("names no operator but the lead to the client", async () => {
    // Another operator who serves A posts to the client: the portal says only "Mezonas" (null).
    const [other] = await H.t.db
      .insert(appUser)
      .values({ email: "third-operator@example.com", name: "Third Operator" })
      .returning();
    await H.t.db
      .insert(membership)
      .values({ tenantId: H.A.tenantId, userId: other?.id as string, role: "operator" });
    const posted = await call(
      "third-operator@example.com",
      "POST",
      `/api/ops/threads/${leadThreadId}/messages`,
      { text: "Covering for Ana today.", audience: "client" },
    );
    expect(posted.status).toBe(200);
    const list = await call(admin("a"), "GET", `/api/threads/${leadThreadId}/messages`);
    const last = (list.json as { messages: Msg[] }).messages.at(-1);
    expect(last).toMatchObject({
      text: "Covering for Ana today.",
      sender: { type: "user", name: null, lead: false },
    });
  });

  it("keeps each client's threads to itself", async () => {
    expect((await call(admin("b"), "GET", `/api/threads/${leadThreadId}/messages`)).status).toBe(
      404,
    );
    expect(
      (await call(admin("b"), "POST", `/api/threads/${leadThreadId}/messages`, { text: "hi" }))
        .status,
    ).toBe(404);
    expect((await call(admin("b"), "POST", `/api/threads/${leadThreadId}/read`)).status).toBe(404);
    // An operator who doesn't serve A sees nothing of it.
    expect(
      (await call(OTHER_OPERATOR, "GET", `/api/ops/threads/${leadThreadId}/messages`)).status,
    ).toBe(404);
    expect(
      (await call(OTHER_OPERATOR, "GET", `/api/ops/clients/${H.A.tenantId}/threads`)).status,
    ).toBe(404);
    const bList = await call(admin("b"), "GET", "/api/threads");
    expect((bList.json as { threads: Thr[] }).threads.some((t) => t.id === leadThreadId)).toBe(
      false,
    );
    // Portal routes are for client members; the back office's for operators.
    expect((await call(OPERATOR, "GET", "/api/threads")).status).toBe(403);
    expect(
      (await call(admin("a"), "GET", `/api/ops/threads/${leadThreadId}/messages`)).status,
    ).toBe(403);
  });

  it("shows an account thread to its person, the client admins and operators only", async () => {
    // A second client user of A.
    const [second] = await H.t.db
      .insert(appUser)
      .values({ email: "second@a.example.com", name: "Second user" })
      .returning();
    await H.t.db
      .insert(membership)
      .values({ tenantId: H.A.tenantId, userId: second?.id as string, role: "client_user" });

    const started = await call(user("a"), "POST", "/api/threads", { subject: "account" });
    expect(started.status).toBe(200);
    const account = (started.json as { thread: Thr }).thread;
    expect(account).toMatchObject({
      subject: "account",
      startedBy: { id: H.A.user, name: "Client A user" },
    });
    expect(
      (
        await call(user("a"), "POST", `/api/threads/${account.id}/messages`, {
          text: "Why is the Acme bill waiting?",
        })
      ).status,
    ).toBe(200);

    // The other client user can't read or post in it, or see it listed.
    expect(
      (await call("second@a.example.com", "GET", `/api/threads/${account.id}/messages`)).status,
    ).toBe(404);
    expect(
      (
        await call("second@a.example.com", "POST", `/api/threads/${account.id}/messages`, {
          text: "me too",
        })
      ).status,
    ).toBe(404);
    const theirs = await call("second@a.example.com", "GET", "/api/threads?subject=account");
    expect((theirs.json as { threads: Thr[] }).threads).toEqual([]);
    // The client admin and the operators can.
    expect((await call(admin("a"), "GET", `/api/threads/${account.id}/messages`)).status).toBe(200);
    const adminList = await call(admin("a"), "GET", "/api/threads?subject=account");
    expect((adminList.json as { threads: Thr[] }).threads.map((t) => t.id)).toContain(account.id);
    expect((await call(OPERATOR, "GET", `/api/ops/threads/${account.id}/messages`)).status).toBe(
      200,
    );
    const [row] = await H.t.db.select().from(thread).where(eq(thread.id, account.id));
    expect(row?.createdBy).toBe(H.A.user);
  });

  it("checks that a message's sources are this client's records", async () => {
    const [own] = await H.t.db
      .insert(vendor)
      .values({ tenantId: H.A.tenantId, name: "Acme Lumber", normalizedName: "acme lumber" })
      .returning();
    const [theirs] = await H.t.db
      .insert(vendor)
      .values({ tenantId: H.B.tenantId, name: "Other Lumber", normalizedName: "other lumber" })
      .returning();
    const path = `/api/threads/${leadThreadId}/messages`;
    const bad = await call(admin("a"), "POST", path, {
      text: "See this vendor",
      sources: [theirs?.id],
    });
    expect(bad.status).toBe(422);
    expect((bad.json as { error: { code: string } }).error.code).toBe("invalid_source");
    const good = await call(admin("a"), "POST", path, {
      text: "See this vendor",
      sources: [own?.id],
    });
    expect(good.status).toBe(200);
    expect((good.json as { messages: Msg[] }).messages[0]?.sources).toEqual([own?.id]);
    // Text limits.
    expect((await call(admin("a"), "POST", path, { text: "   " })).status).toBe(400);
    expect((await call(admin("a"), "POST", path, { text: "x".repeat(4001) })).status).toBe(400);
  });

  it("posts /remy as a command and answers /nobody with a system message", async () => {
    remy = await activeAgent(H.A.tenantId, "remy-ar", leadCheckBundle());
    const path = `/api/threads/${leadThreadId}/messages`;
    const cmd = await call(admin("a"), "POST", path, { text: "/remy hello, chase Acme" });
    expect(cmd.status).toBe(200);
    const [m] = (cmd.json as { messages: Msg[] }).messages;
    expect(m).toMatchObject({ kind: "command", command: "remy", text: "/remy hello, chase Acme" });
    const [ev] = await H.t.db
      .select()
      .from(event)
      .where(
        and(
          eq(event.tenantId, H.A.tenantId),
          eq(event.type, "thread.message_posted"),
          eq(event.subjectId, leadThreadId),
        ),
      )
      .orderBy(event.createdAt)
      .then((rows) =>
        rows.filter((r) => (r.payload as { messageId?: string }).messageId === m?.id),
      );
    expect(ev?.payload).toMatchObject({
      messageId: m?.id,
      senderType: "user",
      senderId: H.A.admin,
      command: { name: "remy", agentId: remy.id },
    });
    expect(JSON.stringify(ev?.payload)).not.toContain("chase Acme");

    const unknown = await call(admin("a"), "POST", path, { text: "/nobody are you there" });
    expect(unknown.status).toBe(200);
    const pair = (unknown.json as { messages: Msg[] }).messages;
    expect(pair.map((x) => [x.sender.type, x.kind])).toEqual([
      ["user", "text"],
      ["system", "text"],
    ]);
    expect(pair[1]?.text).toBe("No agent called /nobody here.");

    // The service's own thread ("Message Remy") opens on first ask, for client members only.
    const svc = await call(user("a"), "GET", `/api/threads?subject=agent&service=${remy.id}`);
    expect(svc.status).toBe(200);
    const agentThreadRow = (svc.json as { threads: Thr[] }).threads[0];
    expect(agentThreadRow).toMatchObject({
      subject: "agent",
      service: { id: remy.id, name: "remy-ar service" },
    });
    expect(
      (await call(admin("b"), "GET", `/api/threads?subject=agent&service=${remy.id}`)).status,
    ).toBe(404);
  });

  it("keeps the back office's own threads out of the portal; no notes in contact threads", async () => {
    const [runThread] = await H.t.db
      .insert(thread)
      .values({ tenantId: H.A.tenantId, subjectType: "run", subjectId: null, title: "Run" })
      .returning();
    const [contactThread] = await H.t.db
      .insert(thread)
      .values({ tenantId: H.A.tenantId, subjectType: "contact", subjectId: null, title: "Texts" })
      .returning();
    expect((await call(admin("a"), "GET", `/api/threads/${runThread?.id}/messages`)).status).toBe(
      404,
    );
    const listed = await call(admin("a"), "GET", "/api/threads");
    expect(
      (listed.json as { threads: Thr[] }).threads.every((t) =>
        ["lead", "account", "agent"].includes(t.subject as string),
      ),
    ).toBe(true);
    expect(
      (
        await call(OPERATOR, "POST", `/api/ops/threads/${runThread?.id}/messages`, {
          text: "Looked at this run.",
          audience: "operator",
        })
      ).status,
    ).toBe(200);
    const contact = await call(OPERATOR, "POST", `/api/ops/threads/${contactThread?.id}/messages`, {
      text: "x",
      audience: "operator",
    });
    expect(contact.status).toBe(409);
  });

  it("assigns a lead check to the lead, or to the operator role without one", async () => {
    const step = leadCheckBundle().workflows[0]?.workflow.steps[0] as PersonStep;
    const [r] = await H.t.db
      .insert(run)
      .values({
        tenantId: H.A.tenantId,
        agentId: remy.id,
        agentVersionId: remy.versionId,
        workflowSlug: "check",
        mode: "live",
        status: "running",
      })
      .returning();
    const info = {
      id: r?.id as string,
      tenantId: H.A.tenantId,
      agentId: remy.id,
      agentVersionId: remy.versionId,
      workflowSlug: "check",
      mode: "live" as const,
    };
    const item = await dbInboxPort(H.db, info).createForPerson({
      run: info,
      step,
      nodeId: "lead-check",
      stepRunId: r?.id as string,
      kind: "approval",
      title: "Check the new matches",
      payload: {},
      dueAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    const [row] = await H.t.db.select().from(inboxItem).where(eq(inboxItem.id, item.id));
    expect(row).toMatchObject({ assigneeRole: "operator", assigneeUserId: H.operator });

    // The client's timeline names the lead on the check.
    await H.t.db.insert(stepRun).values({
      tenantId: H.A.tenantId,
      runId: r?.id as string,
      nodeId: "lead-check",
      nodeType: "person",
      status: "waiting",
      summary: "Check new matches: waiting for approval",
      startedAt: new Date(),
    });
    const timeline = await call(admin("a"), "GET", `/api/runs/${r?.id}`);
    expect(timeline.status).toBe(200);
    expect((timeline.json as { steps: Json[] }).steps[0]).toMatchObject({
      label: "Operator: Check new matches",
    });

    // Without a lead, the operator role.
    expect(
      (await call(OPERATOR, "PUT", `/api/ops/clients/${H.A.tenantId}/lead`, { userId: null }))
        .status,
    ).toBe(200);
    const item2 = await dbInboxPort(H.db, info).createForPerson({
      run: info,
      step,
      nodeId: "lead-check-2",
      stepRunId: r?.id as string,
      kind: "approval",
      title: "Check again",
      payload: {},
      dueAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    const [row2] = await H.t.db.select().from(inboxItem).where(eq(inboxItem.id, item2.id));
    expect(row2).toMatchObject({ assigneeRole: "operator", assigneeUserId: null });
    const plain = await call(admin("a"), "GET", `/api/runs/${r?.id}`);
    expect((plain.json as { steps: Json[] }).steps[0]).toMatchObject({
      label: "Check new matches",
    });
    const session = await call(admin("a"), "GET", "/api/session");
    expect((session.json as { lead: unknown }).lead).toBeNull();
    // Ensure no leftover agent version reference problems.
    expect(
      (await H.t.db.select().from(agentVersion).where(eq(agentVersion.id, remy.versionId))).length,
    ).toBe(1);
  });
});
