// Connectors C4 (docs/connectors-plan.md §5.4, §6, §7; docs/plan.md §9 item 4): the contract
// tests for who may change a client's connection, through the running API. A client admin can
// turn writes on to Ask me first, never On its own by themselves; a client can't see another
// client's custom connector; we can't loosen a real client's connection without an approved
// request or the client's go-ahead that covers it, never set On its own under one, and can't set
// the go-ahead; an ended go-ahead covers nothing; approving a stale request changes nothing; a
// client user reads but neither approves nor edits; no portal response carries a bundle, prompt,
// cost or credential.

import {
  CONNECTION_NOTICE_SUBJECT,
  CONNECTION_REQUEST_SUBJECT,
  type PermissionMatrix,
} from "@countersign/core";
import {
  connection,
  connectionChange,
  connectionChangeRequest,
  connectorSetting,
  inboxItem,
  tenant,
} from "@countersign/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type ApiHarness,
  admin,
  createApiHarness,
  forbiddenKeys,
  OPERATOR,
  testBundle,
  user,
} from "./api.test-helper";

// biome-ignore lint/suspicious/noExplicitAny: test responses are read loosely.
const j = (v: unknown) => v as any;

const h = await createApiHarness();
afterAll(async () => {
  await h?.close();
});

const WRITES_OFF: PermissionMatrix = { read: "auto", create: "off", update: "off", delete: "off" };

describe.skipIf(!h)("connectors C4: who may change a client's connection", () => {
  const H = h as ApiHarness;
  let agentId = "";
  const conn = () => H.A.connectionId;

  const matrixOf = async (id: string) => {
    const [row] = await H.t.db.select().from(connection).where(eq(connection.id, id));
    return row?.permissions;
  };
  const setMatrix = (id: string, permissions: PermissionMatrix) =>
    H.t.db.update(connection).set({ permissions }).where(eq(connection.id, id));
  const opsChange = (body: unknown, id = conn(), client = H.A.tenantId) =>
    H.call(OPERATOR, "POST", `/api/ops/clients/${client}/connections/${id}/changes`, body);
  const openRequests = () =>
    H.t.db
      .select()
      .from(connectionChangeRequest)
      .where(
        and(
          eq(connectionChangeRequest.connectionId, conn()),
          eq(connectionChangeRequest.status, "open"),
        ),
      );

  beforeAll(async () => {
    const tpl = await H.call(OPERATOR, "POST", "/api/ops/templates", {
      slug: "records-clerk-c4",
      bundle: testBundle(),
    });
    const tid = j(tpl.json).agent.id;
    await H.call(
      OPERATOR,
      "POST",
      `/api/ops/agents/${tid}/versions/${j(tpl.json).version.id}/publish`,
    );
    const fork = await H.call(OPERATOR, "POST", `/api/ops/templates/${tid}/fork`, {
      clientId: H.A.tenantId,
      serviceName: "Record keeping",
    });
    expect(fork.status, JSON.stringify(fork.json)).toBe(200);
    agentId = j(fork.json).agent.id;
    const bound = await H.call(OPERATOR, "PATCH", `/api/ops/agents/${agentId}/operation`, {
      bindings: { testkit: conn() },
    });
    expect(bound.status, JSON.stringify(bound.json)).toBe(200);
    // A connection with every write off: the agent's update of records is a gap.
    await setMatrix(conn(), WRITES_OFF);
  });

  it("lists the client's connectors and what its agent is waiting on, with nothing forbidden", async () => {
    const res = await H.call(admin("a"), "GET", "/api/portal/connectors");
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const body = j(res.json);
    expect(body.browse.map((c: { connector: string }) => c.connector)).toContain("testkit");
    expect(body.waiting).toContainEqual(
      expect.objectContaining({
        agent: { id: agentId, name: "Record keeping" },
        connector: "testkit",
        kind: "off_on_connection",
        words: "Record keeping: allow update records",
      }),
    );
    expect(forbiddenKeys(res.json)).toEqual([]);
    expect(JSON.stringify(res.json)).not.toMatch(/credential|token|prompt|instructions|cost/i);

    const page = await H.call(admin("a"), "GET", `/api/portal/connectors/testkit?for=${agentId}`);
    expect(page.status, JSON.stringify(page.json)).toBe(200);
    const p = j(page.json);
    expect(p.mayEdit).toBe(true);
    expect(p.forAgent).toMatchObject({ ready: false });
    const [c] = p.connections;
    const updateRecords = c.change.find(
      (r: { verb: string; entity: string | null }) => r.verb === "update" && r.entity === "record",
    );
    expect(updateRecords).toMatchObject({
      label: "Update records",
      level: "off",
      choices: ["approval", "off"],
      neededBy: [{ id: agentId, name: "Record keeping" }],
    });
    expect(c.usedBy[0]).toMatchObject({ ready: false, agent: { id: agentId } });
    expect(forbiddenKeys(page.json)).toEqual([]);
    expect(JSON.stringify(page.json)).not.toMatch(/credentials|prompt|instructions|cost/i);
  });

  it("a client user reads, but neither edits nor approves", async () => {
    expect((await H.call(user("a"), "GET", "/api/portal/connectors/testkit")).status).toBe(200);
    const page = j((await H.call(user("a"), "GET", "/api/portal/connectors/testkit")).json);
    expect(page.mayEdit).toBe(false);
    expect(
      page.connections[0].change.every((r: { choices: unknown[] }) => r.choices.length === 0),
    ).toBe(true);
    const put = await H.call(user("a"), "PUT", `/api/portal/connections/${conn()}/access`, {
      permissions: { update: "approval" },
    });
    expect(put.status).toBe(403);
    const allow = await H.call(
      user("a"),
      "POST",
      `/api/portal/connections/${conn()}/allow-for/${agentId}`,
      {},
    );
    expect(allow.status).toBe(403);
    const may = await H.call(user("a"), "PUT", `/api/portal/connections/${conn()}/mezonas-may`, {
      choice: "any",
    });
    expect(may.status).toBe(403);
    expect(await matrixOf(conn())).toEqual(WRITES_OFF);
  });

  it("a client admin can't set On its own by themselves, but can turn a write on to ask first", async () => {
    const auto = await H.call(admin("a"), "PUT", `/api/portal/connections/${conn()}/access`, {
      permissions: { update: "auto" },
    });
    expect(auto.status).toBe(422);
    expect(j(auto.json).error.code).toBe("not_allowed");
    expect(j(auto.json).error.details.refused[0].row).toMatchObject({ verb: "update", to: "auto" });
    expect(await matrixOf(conn())).toEqual(WRITES_OFF);
    // Delete stays off for everyone.
    const del = await H.call(admin("a"), "PUT", `/api/portal/connections/${conn()}/access`, {
      permissions: { delete: "approval" },
    });
    expect(del.status).toBe(422);

    const ok = await H.call(admin("a"), "PUT", `/api/portal/connections/${conn()}/access`, {
      permissions: { create: "approval" },
    });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect(j(ok.json).rows.map((r: { label: string }) => r.label)).toContain(
      "Create: Off → Ask me first",
    );
    expect((await matrixOf(conn()))?.create).toBe("approval");
    const [last] = await H.t.db
      .select()
      .from(connectionChange)
      .where(eq(connectionChange.connectionId, conn()))
      .orderBy(connectionChange.createdAt)
      .then((rows) => rows.slice(-1));
    expect(last?.actorId).toBe(H.A.admin);
    expect(last?.change).toMatchObject({ kind: "settings", by: "client" });
    await setMatrix(conn(), WRITES_OFF);
  });

  it("allows exactly what an agent needs, at once, as the client admin's own change", async () => {
    const res = await H.call(
      admin("a"),
      "POST",
      `/api/portal/connections/${conn()}/allow-for/${agentId}`,
      {},
    );
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const m = await matrixOf(conn());
    // Updates of records ask first; creates stay off; nothing runs on its own.
    expect(m).toMatchObject({ read: "auto", create: "off", update: "approval", delete: "off" });
    expect(j(res.json).connection.usedBy[0]).toMatchObject({ ready: true });
    expect(JSON.stringify(m)).not.toContain('auto","create":"auto');
    await setMatrix(conn(), WRITES_OFF);
  });

  it("refuses our looser edit through the old route, and sends it as a request instead", async () => {
    const patch = await H.call(OPERATOR, "PATCH", `/api/ops/connections/${conn()}`, {
      permissions: { update: "approval" },
    });
    expect(patch.status).toBe(409);
    expect(j(patch.json).error.code).toBe("send_for_approval");
    expect(await matrixOf(conn())).toEqual(WRITES_OFF);

    const preview = await H.call(
      OPERATOR,
      "POST",
      `/api/ops/clients/${H.A.tenantId}/connections/${conn()}/changes/preview`,
      { permissions: { update: "approval" } },
    );
    expect(j(preview.json)).toMatchObject({ direction: "looser", outcome: "request" });

    const sent = await opsChange({
      permissions: { update: "approval" },
      reason: "The record keeper corrects records.",
      forAgentId: agentId,
    });
    expect(sent.status, JSON.stringify(sent.json)).toBe(200);
    expect(j(sent.json)).toMatchObject({
      outcome: "request_sent",
      request: { status: "open", direction: "looser", forAgent: { id: agentId } },
    });
    // Nothing changed yet.
    expect(await matrixOf(conn())).toEqual(WRITES_OFF);
    const [item] = await H.t.db
      .select()
      .from(inboxItem)
      .where(
        and(
          eq(inboxItem.subjectType, CONNECTION_REQUEST_SUBJECT),
          eq(inboxItem.subjectId, j(sent.json).request.id),
        ),
      );
    expect(item).toMatchObject({ kind: "approval", assigneeRole: "client_admin", status: "open" });
    // The inbox's generic answer can't approve it, and we can't step in on our own ask.
    const generic = await H.call(admin("a"), "POST", `/api/inbox/${item?.id}/resolve`, {
      decision: "approve",
    });
    expect(generic.status).toBe(409);
    for (const action of ["approve", "reassign"]) {
      const stepIn = await H.call(
        OPERATOR,
        "POST",
        `/api/ops/clients/${H.A.tenantId}/inbox/${item?.id}/step-in`,
        {
          action,
          reason: "The client is away this week.",
          ...(action === "reassign" ? { to: { kind: "role", role: "client_user" } } : {}),
        },
      );
      expect([stepIn.status, j(stepIn.json).error?.code]).toEqual([409, "client_approves"]);
    }
    expect(await matrixOf(conn())).toEqual(WRITES_OFF);
    // A client user sees it but can't answer it.
    const listed = await H.call(user("a"), "GET", "/api/portal/connection-requests");
    expect(j(listed.json).requests).toHaveLength(1);
    const userApprove = await H.call(
      user("a"),
      "POST",
      `/api/portal/connection-requests/${j(sent.json).request.id}/approve`,
      {},
    );
    expect(userApprove.status).toBe(403);
  });

  it("approving a stale request changes nothing; a fresh one applies exactly what it asked", async () => {
    const [stale] = await openRequests();
    // The client changes something meanwhile: the request is out of date.
    await H.call(admin("a"), "PUT", `/api/portal/connections/${conn()}/access`, {
      permissions: { create: "approval" },
    });
    const before = await matrixOf(conn());
    const listed = await H.call(admin("a"), "GET", "/api/portal/connection-requests");
    expect(j(listed.json).requests[0]).toMatchObject({ id: stale?.id, outOfDate: true });
    const refused = await H.call(
      admin("a"),
      "POST",
      `/api/portal/connection-requests/${stale?.id}/approve`,
      {},
    );
    expect(refused.status).toBe(409);
    expect(j(refused.json).error.code).toBe("out_of_date");
    expect(await matrixOf(conn())).toEqual(before);
    const applied = await H.t.db
      .select()
      .from(connectionChange)
      .where(eq(connectionChange.requestId, stale?.id as string));
    expect(applied).toEqual([]);

    // We send a new one: it replaces the old.
    const sent = await opsChange({
      permissions: { update: "approval" },
      reason: "Again, current.",
    });
    expect(j(sent.json)).toMatchObject({ outcome: "request_sent", replaced: stale?.id });
    const [old] = await H.t.db
      .select()
      .from(connectionChangeRequest)
      .where(eq(connectionChangeRequest.id, stale?.id as string));
    expect(old?.status).toBe("replaced");

    const id = j(sent.json).request.id;
    const ok = await H.call(admin("a"), "POST", `/api/portal/connection-requests/${id}/approve`, {
      note: "Fine.",
    });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect(j(ok.json).request).toMatchObject({ status: "approved", answerNote: "Fine." });
    expect(await matrixOf(conn())).toMatchObject({ create: "approval", update: "approval" });
    const [change] = await H.t.db
      .select()
      .from(connectionChange)
      .where(eq(connectionChange.requestId, id));
    // One change naming who asked and who approved.
    expect(change?.actorId).toBe(H.A.admin);
    expect(change?.change).toMatchObject({ kind: "settings", requestedBy: H.operator });
    const [item] = await H.t.db.select().from(inboxItem).where(eq(inboxItem.subjectId, id));
    expect(item?.status).toBe("resolved");
    // Answered once.
    const again = await H.call(
      admin("a"),
      "POST",
      `/api/portal/connection-requests/${id}/approve`,
      {},
    );
    expect([again.status, j(again.json).error.code]).toEqual([409, "closed"]);
    await setMatrix(conn(), WRITES_OFF);
  });

  it("only a client admin sets Changes by Mezonas; under it we apply what agents need, never On its own", async () => {
    const ours = await H.call(OPERATOR, "PUT", `/api/portal/connections/${conn()}/mezonas-may`, {
      choice: "any",
    });
    expect(ours.status).toBe(403);
    const set = await H.call(admin("a"), "PUT", `/api/portal/connections/${conn()}/mezonas-may`, {
      choice: "needs",
      duration: "30_days",
    });
    expect(set.status, JSON.stringify(set.json)).toBe(200);
    expect(j(set.json).mezonasMay).toMatchObject({ choice: "needs", active: true });

    // What the agent needs fits: it applies, and the client is told.
    const fits = await opsChange({
      permissions: { update: "approval" },
      reason: "Records need it.",
    });
    expect(j(fits.json)).toMatchObject({
      outcome: "applied_under_authorization",
      authorization: { choice: "needs" },
    });
    expect((await matrixOf(conn()))?.update).toBe("approval");
    const notices = await H.t.db
      .select()
      .from(inboxItem)
      .where(eq(inboxItem.subjectType, CONNECTION_NOTICE_SUBJECT));
    expect(notices.at(-1)).toMatchObject({ kind: "review", assigneeRole: "client_admin" });
    expect(notices.at(-1)?.payload).toMatchObject({ because: "authorized" });

    // Something no agent needs goes to the client.
    const create = await opsChange({
      permissions: { create: "approval" },
      reason: "Just in case.",
    });
    expect(j(create.json)).toMatchObject({ outcome: "request_sent" });
    expect(j(create.json).whyNot).toMatch(/isn't something an agent needs/);
    // On its own is always a request, even with the go-ahead set to any change.
    await H.call(admin("a"), "PUT", `/api/portal/connections/${conn()}/mezonas-may`, {
      choice: "any",
    });
    const auto = await opsChange({ permissions: { update: "auto" }, reason: "Let it run." });
    expect(j(auto.json)).toMatchObject({ outcome: "request_sent" });
    expect((await matrixOf(conn()))?.update).toBe("approval");
  });

  it("an ended go-ahead covers nothing", async () => {
    await setMatrix(conn(), WRITES_OFF);
    await H.t.db
      .update(connection)
      .set({
        mezonasMay: {
          choice: "any",
          until: "2026-01-01T00:00:00.000Z",
          setBy: H.A.admin,
          setAt: "2025-12-01T00:00:00.000Z",
        },
      })
      .where(eq(connection.id, conn()));
    const res = await opsChange({ permissions: { update: "approval" }, reason: "Needed." });
    expect(j(res.json)).toMatchObject({ outcome: "request_sent" });
    expect(j(res.json).whyNot).toMatch(/ended/);
    expect(await matrixOf(conn())).toEqual(WRITES_OFF);
  });

  it("our tighter edit applies at once and tells the client", async () => {
    const res = await opsChange({ permissions: { read: "off" }, reason: "Pausing reads." });
    expect(j(res.json)).toMatchObject({ outcome: "applied" });
    expect((await matrixOf(conn()))?.read).toBe("off");
    const [notice] = await H.t.db
      .select()
      .from(inboxItem)
      .where(eq(inboxItem.subjectType, CONNECTION_NOTICE_SUBJECT))
      .then((rows) => rows.slice(-1));
    expect(notice?.payload).toMatchObject({ because: "tightened", reason: "Pausing reads." });
    // A notice waits on nobody: the client admin closes it with Done through the inbox's answer.
    const done = await H.call(admin("a"), "POST", `/api/inbox/${notice?.id}/resolve`, {
      decision: "approve",
    });
    expect(done.status, JSON.stringify(done.json)).toBe(200);
    const [closed] = await H.t.db
      .select()
      .from(inboxItem)
      .where(eq(inboxItem.id, notice?.id as string));
    expect(closed?.status).toBe("resolved");
    await setMatrix(conn(), WRITES_OFF);
  });

  it("declines with a note, withdraws, and expires requests past their end", async () => {
    await H.t.db.update(connection).set({ mezonasMay: null }).where(eq(connection.id, conn()));
    const a = j((await opsChange({ permissions: { update: "approval" }, reason: "One." })).json);
    const declined = await H.call(
      admin("a"),
      "POST",
      `/api/portal/connection-requests/${a.request.id}/decline`,
      { note: "Not now." },
    );
    expect(j(declined.json).request).toMatchObject({ status: "declined", answerNote: "Not now." });

    const b = j((await opsChange({ permissions: { update: "approval" }, reason: "Two." })).json);
    const withdrawn = await H.call(
      OPERATOR,
      "POST",
      `/api/ops/clients/${H.A.tenantId}/connection-requests/${b.request.id}/withdraw`,
      {},
    );
    expect(j(withdrawn.json).request).toMatchObject({ status: "withdrawn" });
    const twice = await H.call(
      OPERATOR,
      "POST",
      `/api/ops/clients/${H.A.tenantId}/connection-requests/${b.request.id}/withdraw`,
      {},
    );
    expect(twice.status).toBe(409);

    // One made 15 days ago is past its 14 days.
    const [old] = await H.t.db
      .insert(connectionChangeRequest)
      .values({
        tenantId: H.A.tenantId,
        connectionId: conn(),
        against: { permissions: WRITES_OFF, config: {} },
        proposed: { permissions: { ...WRITES_OFF, update: "approval" }, config: {} },
        reason: "Old.",
        requestedBy: H.operator,
        createdAt: new Date(Date.now() - 15 * 24 * 60 * 60 * 1000),
        expiresAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
      })
      .returning();
    const listed = await H.call(admin("a"), "GET", "/api/portal/connection-requests");
    expect(j(listed.json).requests).toEqual([]);
    const [after] = await H.t.db
      .select()
      .from(connectionChangeRequest)
      .where(eq(connectionChangeRequest.id, old?.id as string));
    expect(after?.status).toBe("expired");
    const late = await H.call(
      admin("a"),
      "POST",
      `/api/portal/connection-requests/${old?.id}/approve`,
      {},
    );
    expect([late.status, j(late.json).error.code]).toEqual([409, "closed"]);
    expect(await matrixOf(conn())).toEqual(WRITES_OFF);
  });

  it("shows the back office the client's tab, the agent's needs and readiness, and sends what's missing", async () => {
    const tab = await H.call(OPERATOR, "GET", `/api/ops/clients/${H.A.tenantId}/connectors`);
    expect(tab.status, JSON.stringify(tab.json)).toBe(200);
    expect(j(tab.json).agents[0]).toMatchObject({ agent: { id: agentId }, ready: false });
    expect(JSON.stringify(tab.json)).not.toMatch(/credentials_?encrypted|access_?token/i);

    const needs = await H.call(OPERATOR, "GET", `/api/ops/agents/${agentId}/needs`);
    expect(j(needs.json).connectors).toContainEqual(
      expect.objectContaining({
        connector: "testkit",
        needs: expect.arrayContaining([
          expect.objectContaining({ verb: "update", entity: "record", level: "ask" }),
        ]),
      }),
    );
    const ready = await H.call(OPERATOR, "GET", `/api/ops/agents/${agentId}/readiness`);
    expect(j(ready.json)).toMatchObject({ ready: false, clientId: H.A.tenantId });
    expect(j(ready.json).connectors).toContainEqual(
      expect.objectContaining({
        connector: "testkit",
        state: "needs_access",
        connectionId: conn(),
      }),
    );
    const send = await H.call(OPERATOR, "POST", `/api/ops/agents/${agentId}/readiness/send`, {
      connectionId: conn(),
      reason: "The record keeper corrects records.",
    });
    expect(send.status, JSON.stringify(send.json)).toBe(200);
    expect(j(send.json)).toMatchObject({
      outcome: "request_sent",
      request: { forAgent: { id: agentId } },
    });
    expect(j(send.json).request.rows.map((r: { label: string }) => r.label)).toContain(
      "Update: Off → Ask me first",
    );
    // Client roles never reach the back office's routes.
    expect((await H.call(admin("a"), "GET", `/api/ops/agents/${agentId}/needs`)).status).toBe(403);
  });

  it("hides a custom connector from every other client, and never connects it for them", async () => {
    await H.t.db.insert(connectorSetting).values({
      connector: "linkedin",
      status: "live",
      clients: [H.B.tenantId],
    });
    const a = j((await H.call(admin("a"), "GET", "/api/portal/connectors")).json);
    const ids = [...a.browse, ...a.builtForYou, ...a.connected].map(
      (c: { connector: string }) => c.connector,
    );
    expect(ids).not.toContain("linkedin");
    expect((await H.call(admin("a"), "GET", "/api/portal/connectors/linkedin")).status).toBe(404);
    expect((await H.call(admin("a"), "POST", "/api/connections/linkedin/authorize")).status).toBe(
      404,
    );
    const opsA = await H.call(
      OPERATOR,
      "GET",
      `/api/ops/clients/${H.A.tenantId}/connectors/linkedin`,
    );
    expect(opsA.status).toBe(404);
    const b = j((await H.call(admin("b"), "GET", "/api/portal/connectors")).json);
    expect(b.builtForYou.map((c: { connector: string }) => c.connector)).toContain("linkedin");
    expect(b.browse.map((c: { connector: string }) => c.connector)).not.toContain("linkedin");
  });

  it("applies our edits in the Sandbox directly", async () => {
    await H.t.db
      .update(tenant)
      .set({ settings: { connectors_offered: ["testkit"], sandbox: true } })
      .where(eq(tenant.id, H.B.tenantId));
    await setMatrix(H.B.connectionId, WRITES_OFF);
    const res = await opsChange(
      { permissions: { update: "auto" }, reason: "Our own test client." },
      H.B.connectionId,
      H.B.tenantId,
    );
    expect(j(res.json)).toMatchObject({ outcome: "applied" });
    expect((await matrixOf(H.B.connectionId))?.update).toBe("auto");
    const patch = await H.call(OPERATOR, "PATCH", `/api/ops/connections/${H.B.connectionId}`, {
      permissions: { create: "approval" },
    });
    expect(patch.status).toBe(200);
  });
});
