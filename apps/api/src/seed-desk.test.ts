// The seed's Demo Desk item (packages/db/src/seed.ts `seedDemoDesk`) through the real portal
// routes, as the end-to-end walkthrough uses it: the Demo client's admin sees one change waiting,
// signs it, undoes it inside the window, and it waits again. Nothing is ever written: no testkit
// write, no event sent to a run. After the window, the cron's delivery only sends the run its event
// (this run has no Workflow instance), and the change stays approved, never executed.

import { TESTKIT_CONNECTOR_ID, TESTKIT_UPDATE_TOOL } from "@countersign/connectors";
import { externalAction, inboxItem } from "@countersign/db";
import { DEMO_CONNECTOR, DEMO_TOOL, SEED_USERS, seed } from "@countersign/db/seed";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ApiHarness, createApiHarness, forbiddenKeys } from "./api.test-helper";
import { redeliverResolutions } from "./runs/resume";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

const h = await createApiHarness();
afterAll(() => h?.close());

const ADMIN = SEED_USERS.demoAdmin.email;

describe("the seeded Desk item's tool", () => {
  it("is the testkit's write, so signing it can reach nothing outside the platform", () => {
    expect(DEMO_CONNECTOR).toBe(TESTKIT_CONNECTOR_ID);
    expect(DEMO_TOOL).toBe(TESTKIT_UPDATE_TOOL);
  });
});

describe.skipIf(!h)("the seeded Desk item", () => {
  const harness = h as ApiHarness;
  let ids: Awaited<ReturnType<typeof seed>>;
  beforeAll(async () => {
    ids = await seed(harness.t.db);
  });

  const action = async () => {
    const [row] = await harness.t.db
      .select()
      .from(externalAction)
      .where(eq(externalAction.id, ids.demoDesk.actionId));
    return row;
  };

  it("waits on the Demo admin's Desk, with its before state and sources, nothing internal", async () => {
    const res = await harness.call(ADMIN, "GET", "/api/inbox?status=open");
    expect(res.status).toBe(200);
    const items = j(res.json).items;
    expect(items.map((i: { id: string }) => i.id)).toEqual([ids.demoDesk.inboxItemId]);
    const [item] = items;
    expect(item).toMatchObject({
      kind: "external_action",
      status: "open",
      runId: ids.demoDesk.runId,
      service: { id: ids.demoDesk.agentId, name: "Records clerk" },
    });
    expect(item.payload).toMatchObject({
      tool: TESTKIT_UPDATE_TOOL,
      before: { id: "R-1002", amount: "8.7500" },
      input: { id: "R-1002", amount: "9.1000" },
      sources: [ids.demoDesk.recordId],
    });
    expect(item.payload.whyApproval.reasons).toEqual(
      expect.arrayContaining(["step", "matrix", "stage"]),
    );
    expect(forbiddenKeys(res.json)).toEqual([]);
    // The record it cites opens in the portal.
    const record = await harness.call(ADMIN, "GET", `/api/records/${ids.demoDesk.recordId}`);
    expect(record.status).toBe(200);
    expect(j(record.json).record).toMatchObject({ kind: "raw_record", externalId: "R-1002" });
  });

  it("signs and undoes, writing nothing and telling the run nothing", async () => {
    const id = ids.demoDesk.inboxItemId;
    const signed = await harness.call(ADMIN, "POST", `/api/inbox/${id}/resolve`, {
      decision: "approve",
    });
    expect(signed.status).toBe(200);
    expect(j(signed.json).item).toMatchObject({ status: "resolved" });
    // The Demo client keeps the default undo window: the approval is held.
    expect(j(signed.json).item.deliverAfter).not.toBeNull();
    expect((await action())?.status).toBe("approved");

    const undone = await harness.call(ADMIN, "POST", `/api/inbox/${id}/undo`);
    expect(undone.status).toBe(200);
    expect(j(undone.json).item).toMatchObject({ status: "open", deliverAfter: null });
    expect((await action())?.status).toBe("proposed");

    await harness.settle();
    expect(harness.backend.writes).toEqual([]);
    expect(harness.instances.events).toEqual([]);
    expect(harness.instances.started.size).toBe(0);

    // Seeding again adds nothing and leaves the reopened item as it is.
    await seed(harness.t.db);
    const [count] = await harness.t.db.$client<
      { items: number }[]
    >`select count(*)::int as items from inbox_item where tenant_id = ${ids.tenants.demo}`;
    expect(count?.items).toBe(1);
  });

  it("after the window, only sends the run its event: the change is never executed", async () => {
    const id = ids.demoDesk.inboxItemId;
    const signed = await harness.call(ADMIN, "POST", `/api/inbox/${id}/resolve`, {
      decision: "approve",
    });
    expect(signed.status).toBe(200);
    await harness.t.db
      .update(inboxItem)
      .set({ deliverAfter: sql`now() - interval '1 second'` })
      .where(eq(inboxItem.id, id));
    await redeliverResolutions(
      { db: harness.db, instances: harness.instances },
      ids.tenants.demo,
      new Date(),
    );
    expect(harness.instances.events.map((e) => e.runId)).toEqual([ids.demoDesk.runId]);
    await harness.settle();
    expect(harness.backend.writes).toEqual([]);
    expect((await action())?.status).toBe("approved");
  });
});
