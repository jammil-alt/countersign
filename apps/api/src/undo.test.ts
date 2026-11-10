// R5 (docs/plan.md §1.86, §9): an approval answered after its run went ahead (`ifNoAnswer:
// proceed`), and the undo a late no is offered. The executor marks the step it passed on
// (`step_run.output.proceededWithoutAnswer`, with the write's `externalActionId`); here the rows
// are seeded as it leaves them. Contract: the portal reaches only its own client's items and
// changes, only the people the offer names may press, the back office's route is the operator's.

import { checkRouteContract, forbiddenPortalFields, type RouteSpec } from "@countersign/core";
import {
  agent,
  agentVersion,
  auditEvent,
  externalAction,
  inboxItem,
  run,
  stepRun,
  tenant,
} from "@countersign/db";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  admin,
  type Client,
  createApiHarness,
  OPERATOR,
  OTHER_OPERATOR,
  testBundle,
  user,
} from "./api.test-helper";
import { undoRoutes } from "./undo/routes";

describe("undo routes (static)", () => {
  it("hold to the route contract", () => {
    expect(checkRouteContract(undoRoutes as unknown as Record<string, RouteSpec>)).toEqual([]);
    expect(forbiddenPortalFields(undoRoutes.portalUndoChange.response)).toEqual([]);
  });
});

const h = await createApiHarness();
afterAll(() => h?.close());

describe.skipIf(!h)("a late answer and its undo", () => {
  const H = h as NonNullable<typeof h>;
  const { A, B } = H;
  const agents = new Map<string, { agentId: string; versionId: string }>();

  beforeAll(async () => {
    for (const c of [A, B]) {
      const [ag] = await H.t.db
        .insert(agent)
        .values({
          tenantId: c.tenantId,
          kind: "client",
          slug: "records-clerk",
          name: "Records clerk",
          serviceName: "Record keeping",
          runStatus: "active",
        })
        .returning();
      const [av] = await H.t.db
        .insert(agentVersion)
        .values({
          tenantId: c.tenantId,
          agentId: ag?.id as string,
          version: 1,
          bundle: testBundle(),
          bundleHash: "h",
          status: "live",
          authorType: "operator",
        })
        .returning();
      agents.set(c.tenantId, { agentId: ag?.id as string, versionId: av?.id as string });
    }
    // Client A's lead is the operator.
    await H.t.db
      .update(tenant)
      .set({
        settings: sql`${tenant.settings} || ${JSON.stringify({ lead: { userId: H.operator } })}::jsonb`,
      })
      .where(eq(tenant.id, A.tenantId));
  });

  /**
   * A write the run went ahead with before anyone answered its approval: the run, the step the
   * executor marked, the done action (the testkit's record changed from 10.00 to 12.00) and its
   * still open approval item.
   */
  async function proceeded(
    c: Client,
    options: {
      mode?: "live" | "test";
      assigneeRole?: "client_admin" | "client_user";
      marker?: boolean;
      tool?: string;
    } = {},
  ) {
    const { agentId, versionId } = agents.get(c.tenantId) as { agentId: string; versionId: string };
    const [r] = await H.t.db
      .insert(run)
      .values({
        tenantId: c.tenantId,
        agentId,
        agentVersionId: versionId,
        workflowSlug: "fix-record",
        mode: options.mode ?? "live",
        status: "running",
        trigger: { type: "manual" },
      })
      .returning();
    const runId = r?.id as string;
    const key = `${runId}:write:0`;
    const [ea] = await H.t.db
      .insert(externalAction)
      .values({
        tenantId: c.tenantId,
        connectionId: c.connectionId,
        tool: options.tool ?? "testkit.record.update",
        runId,
        agentVersionId: versionId,
        input: { id: "r1", amount: "12.00", syncToken: "0" },
        before: { id: "r1", name: "Oak board", amount: "10.00", syncToken: "0" },
        result: { record: { id: "r1", name: "Oak board", amount: "12.00", syncToken: "1" } },
        idempotencyKey: key,
        // Approved by nobody: the deadline let it go ahead.
        status: "done",
        approvedAt: new Date(),
        executedAt: new Date(),
      })
      .returning();
    const actionId = ea?.id as string;
    const [item] = await H.t.db
      .insert(inboxItem)
      .values({
        tenantId: c.tenantId,
        kind: "external_action",
        agentId,
        subjectType: "external_action",
        subjectId: actionId,
        runId,
        assigneeRole: options.assigneeRole ?? "client_admin",
        title: "Change record r1's amount to 12.00",
        payload: { actionId },
      })
      .returning();
    const itemId = item?.id as string;
    await H.t.db
      .update(externalAction)
      .set({ inboxItemId: itemId })
      .where(eq(externalAction.id, actionId));
    if (options.marker !== false) {
      await H.t.db.insert(stepRun).values({
        tenantId: c.tenantId,
        runId,
        nodeId: "write",
        nodeType: "write",
        agentVersionId: versionId,
        output: { proceededWithoutAnswer: true, externalActionId: actionId, inboxItemId: itemId },
        status: "succeeded",
      });
    }
    return { runId, actionId, itemId };
  }

  const item = async (id: string) => {
    const [row] = await H.t.db.select().from(inboxItem).where(eq(inboxItem.id, id));
    return row as typeof inboxItem.$inferSelect;
  };
  const leadItems = async (actionId: string) =>
    H.t.db
      .select()
      .from(inboxItem)
      .where(and(eq(inboxItem.kind, "review"), eq(inboxItem.subjectId, actionId)));

  it("records a late no with who and when, tells the lead, and offers an undo", async () => {
    const w = await proceeded(A);
    const sent = H.instances.events.length;
    const res = await H.call(admin("a"), "POST", `/api/inbox/${w.itemId}/resolve`, {
      decision: "reject",
      note: "Wrong amount",
    });
    expect(res.status).toBe(200);
    const row = await item(w.itemId);
    expect(row.status).toBe("resolved");
    expect(row.resolvedBy).toBe(A.admin);
    expect(row.resolution).toMatchObject({
      decision: "reject",
      approved: false,
      by: A.admin,
      late: { proceededWithoutAnswer: true, externalActionId: w.actionId, actionStatus: "done" },
    });
    // The run went ahead and waits for nothing: nothing is sent, and the cron won't re-send.
    expect(H.instances.events.length).toBe(sent);
    expect(row.runReceivedAt).not.toBeNull();
    expect(row.payload).toMatchObject({
      lateAnswer: { by: A.admin, approved: false, actionId: w.actionId },
      undo: { actionId: w.actionId, status: "offered", for: [A.admin], lead: true },
    });
    // The write itself is never rewritten by a late answer.
    const [ea] = await H.t.db
      .select()
      .from(externalAction)
      .where(eq(externalAction.id, w.actionId));
    expect(ea).toMatchObject({ status: "done", approvedBy: null });
    // The lead hears, with the same offer.
    const [lead] = await leadItems(w.actionId);
    expect(lead).toMatchObject({
      assigneeRole: "operator",
      assigneeUserId: H.operator,
      status: "open",
      title: "Answered after we went ahead: Change record r1's amount to 12.00",
      payload: { sourceItemId: w.itemId, undo: { actionId: w.actionId, status: "offered" } },
    });
    // Audited: who answered, after we went ahead (the row's time is when).
    const audits = await H.t.db
      .select()
      .from(auditEvent)
      .where(eq(auditEvent.action, "inbox.answered_after_proceeding"));
    expect(audits.find((a) => a.target.item === w.itemId)).toMatchObject({
      actorUserId: A.admin,
      actorRole: "client_admin",
      outcome: "ok",
      target: { item: w.itemId, answer: "no", action: w.actionId, undo: "offered" },
    });
    // The portal's card shows it (and a repeated click changes nothing).
    const again = await H.call(admin("a"), "POST", `/api/inbox/${w.itemId}/resolve`, {
      decision: "reject",
    });
    expect(again.status).toBe(200);
    expect((again.json as { item: { payload: unknown } }).item.payload).toMatchObject({
      undo: { status: "offered" },
    });
    expect(await leadItems(w.actionId)).toHaveLength(1);
  });

  it("records a late yes and offers nothing to undo", async () => {
    const w = await proceeded(A);
    const res = await H.call(admin("a"), "POST", `/api/inbox/${w.itemId}/resolve`, {
      decision: "approve",
    });
    expect(res.status).toBe(200);
    const row = await item(w.itemId);
    expect(row.resolution).toMatchObject({
      approved: true,
      late: { externalActionId: w.actionId },
    });
    expect((row.payload as { undo?: unknown }).undo).toBeUndefined();
    const [lead] = await leadItems(w.actionId);
    expect((lead?.payload as { reason?: string } | undefined)?.reason).toMatch(/said yes/);
  });

  it("finds a write that went ahead unsigned even without the executor's mark", async () => {
    const w = await proceeded(A, { marker: false });
    const res = await H.call(admin("a"), "POST", `/api/inbox/${w.itemId}/resolve`, {
      decision: "reject",
    });
    expect(res.status).toBe(200);
    expect((await item(w.itemId)).payload).toMatchObject({ undo: { status: "offered" } });
  });

  it("offers no undo for a write that can't be taken back", async () => {
    const w = await proceeded(A, { tool: "website.publish" });
    await H.call(admin("a"), "POST", `/api/inbox/${w.itemId}/resolve`, { decision: "reject" });
    const row = await item(w.itemId);
    expect(row.payload).toMatchObject({ lateAnswer: { approved: false } });
    expect((row.payload as { undo?: unknown }).undo).toBeUndefined();
    const [lead] = await leadItems(w.actionId);
    expect((lead?.payload as { reason?: string } | undefined)?.reason).toMatch(/can't be undone/);
  });

  it("in a test run, records the answer and tells nobody else", async () => {
    const w = await proceeded(A, { mode: "test" });
    const asked = await H.call(admin("a"), "POST", `/api/inbox/${w.itemId}/resolve`, {
      decision: "reject",
    });
    expect(asked.status).toBe(200);
    expect((await item(w.itemId)).payload).toMatchObject({ lateAnswer: { approved: false } });
    expect(((await item(w.itemId)).payload as { undo?: unknown }).undo).toBeUndefined();
    expect(await leadItems(w.actionId)).toHaveLength(0);
  });

  it("refuses a late answer from someone the item isn't assigned to", async () => {
    const w = await proceeded(A);
    const res = await H.call(OPERATOR, "POST", `/api/ops/inbox/${w.itemId}/resolve`, {
      decision: "reject",
    });
    expect(res.status).toBe(403);
    expect((await item(w.itemId)).status).toBe("open");
  });

  describe("the undo", () => {
    let w: { runId: string; actionId: string; itemId: string };
    let leadItem: string;

    beforeAll(async () => {
      // Offered to client A's user, who said no, and to the lead.
      w = await proceeded(A, { assigneeRole: "client_user" });
      H.backend.update(A.connectionId, "seed-write", { id: "r1", amount: "12.00" });
      const res = await H.call(user("a"), "POST", `/api/inbox/${w.itemId}/resolve`, {
        decision: "reject",
      });
      expect(res.status).toBe(200);
      leadItem = (await leadItems(w.actionId))[0]?.id as string;
    });

    it("is pressed only by the people it names", async () => {
      // Client A's admin sees the item, but it wasn't their no.
      const notTheirs = await H.call(admin("a"), "POST", `/api/inbox/${w.itemId}/undo-change`);
      expect(notTheirs.status).toBe(403);
      // The portal's card names nobody of ours: the lead is a flag, not an id.
      const card = await H.call(user("a"), "GET", "/api/inbox?status=resolved");
      expect(card.status).toBe(200);
      const items = (card.json as { items: { id: string; payload: unknown }[] }).items;
      expect(items.find((i) => i.id === w.itemId)?.payload).toMatchObject({
        undo: { status: "offered", lead: true },
      });
      expect(JSON.stringify(card.json)).not.toContain(H.operator);
      // An operator serving the client who isn't its lead may not press.
      await H.t.db
        .update(tenant)
        .set({ settings: sql`${tenant.settings} - 'lead'` })
        .where(eq(tenant.id, A.tenantId));
      try {
        const notLead = await H.call(OPERATOR, "POST", `/api/ops/inbox/${leadItem}/undo-change`);
        expect(notLead.status).toBe(403);
      } finally {
        await H.t.db
          .update(tenant)
          .set({
            settings: sql`${tenant.settings} || ${JSON.stringify({ lead: { userId: H.operator } })}::jsonb`,
          })
          .where(eq(tenant.id, A.tenantId));
      }
    });

    it("keeps each client's undo to that client", async () => {
      for (const who of [admin("b"), user("b")]) {
        const res = await H.call(who, "POST", `/api/inbox/${w.itemId}/undo-change`);
        expect(res.status, who).toBe(404);
      }
      // An operator who doesn't serve client A can't reach its item.
      const other = await H.call(OTHER_OPERATOR, "POST", `/api/ops/inbox/${leadItem}/undo-change`);
      expect(other.status).toBe(404);
      // The lead's own item is the back office's: the portal never sees it.
      const portal = await H.call(user("a"), "POST", `/api/inbox/${leadItem}/undo-change`);
      expect(portal.status).toBe(404);
    });

    it("keeps the back office's route to the operator", async () => {
      for (const who of [admin("a"), user("a")]) {
        const res = await H.call(who, "POST", `/api/ops/inbox/${leadItem}/undo-change`, undefined, {
          "x-countersign-client": A.tenantId,
        });
        expect(res.status, who).toBe(403);
      }
      expect((await H.call(null, "POST", `/api/ops/inbox/${leadItem}/undo-change`)).status).toBe(
        401,
      );
    });

    it("refuses with a plain reason when it can't tell the record is as we left it", async () => {
      // Production keeps no after state until external_action has its column: a person decides.
      const res = await H.call(user("a"), "POST", `/api/inbox/${w.itemId}/undo-change`);
      expect(res.status).toBe(200);
      expect(res.json).toMatchObject({
        itemId: w.itemId,
        undo: { status: "refused", code: "after_unknown" },
      });
      const lead = await H.call(OPERATOR, "POST", `/api/ops/inbox/${leadItem}/undo-change`);
      expect(lead.status).toBe(200);
      expect(lead.json).toMatchObject({ undo: { status: "refused", code: "after_unknown" } });
      // Nothing written, nothing recorded, the offer still open; the refusal audited.
      expect(H.backend.get(A.connectionId, "r1")?.amount).toBe("12.00");
      const undos = await H.t.db
        .select()
        .from(externalAction)
        .where(eq(externalAction.idempotencyKey, `undo:${w.actionId}`));
      expect(undos).toHaveLength(0);
      expect((await item(w.itemId)).payload).toMatchObject({ undo: { status: "offered" } });
      const audits = await H.t.db
        .select()
        .from(auditEvent)
        .where(eq(auditEvent.action, "external_action.undo"));
      expect(audits.filter((a) => a.target.action === w.actionId)).toHaveLength(2);
      expect(audits.every((a) => a.outcome === "refused")).toBe(true);
    });

    it("refuses an item with nothing offered", async () => {
      const plain = await proceeded(A);
      const res = await H.call(admin("a"), "POST", `/api/inbox/${plain.itemId}/undo-change`);
      expect(res.status).toBe(409);
    });

    it("never writes for a test run", async () => {
      const t = await proceeded(A, { mode: "test" });
      // No offer is made in a test run; one planted by hand is still refused by the runtime.
      await H.t.db
        .update(inboxItem)
        .set({
          status: "resolved",
          payload: {
            actionId: t.actionId,
            undo: {
              actionId: t.actionId,
              tool: "testkit.record.update",
              text: "x",
              for: [A.admin],
              lead: false,
              status: "offered",
            },
          },
        })
        .where(eq(inboxItem.id, t.itemId));
      const res = await H.call(admin("a"), "POST", `/api/inbox/${t.itemId}/undo-change`);
      expect(res.json).toMatchObject({ undo: { status: "refused", code: "test_run" } });
    });
  });
});
