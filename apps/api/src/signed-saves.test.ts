// Signed record saves (step model §10f, follow-up to #687; invariant 8): an agent in its trial
// stage saves to our own records only once a person signs. Its run waits on an approval card that
// shows the change; a yes writes it once (its key: a run tried again writes nothing more), a no
// writes nothing. The card is the client's to sign, in the client's own records only.

import { agent, customField, inboxItem, recordWrite, vendor } from "@countersign/db";
import { FakeModel } from "@countersign/llm";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type ApiHarness,
  admin,
  createApiHarness,
  FakeWorkflowStep,
  OPERATOR,
} from "./api.test-helper";
import { executeRun } from "./runs/execute";
import { cloudflareStepRunner } from "./runs/step-runner";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

const h = await createApiHarness();
afterAll(() => h?.close());

const bundleFor = (vendorId: string) => ({
  schemaVersion: 1,
  definition: {
    schemaVersion: 2,
    identity: { name: "Vendor tagger", role: "tags vendors", mission: "Vendors tagged by region." },
    kind: "functional",
    model: { id: "claude-opus-5-5", maxTokens: 1024 },
    instructions: "Only do what the workflow says.",
    skills: [],
    extraTools: [],
    canCommand: [],
    // Acts, but in its trial stage every save waits for a person (invariant 8).
    permissions: { mode: "act" },
    budgets: { maxSteps: 4, maxCostUsd: "0.10" },
    memory: { enabled: false },
    data: {
      grants: [],
      sets: [
        {
          id: "vendors",
          name: "Vendors",
          on: true,
          grants: [{ recordType: "vendor", read: true, create: false, update: true }],
        },
      ],
    },
  },
  workflows: [
    {
      slug: "main",
      name: "Main",
      workflow: {
        schemaVersion: 5,
        triggers: [{ id: "trg-manual", on: { type: "manual", input: {} } }],
        outputs: [
          {
            id: "o_save",
            name: "Region saved",
            kind: "save",
            action: {
              action: "records.vendor.update",
              input: { id: vendorId, region: "West", sources: [vendorId] },
            },
          },
        ],
        steps: [{ id: "s_end", kind: "end", name: "Saved", outputs: ["o_save"] }],
      },
    },
  ],
});

describe.skipIf(!h)("signed saves to our records", () => {
  const H = h as ApiHarness;
  let vendorId = "";
  let agentId = "";

  /** Answers the run's approval card as the client admin: yes or no. */
  const signer = (decision: "approve" | "reject") =>
    new FakeWorkflowStep(async (_name, type) => {
      const res = await H.call(admin("a"), "GET", "/api/inbox");
      const item = j(res.json).items.find(
        (i: { id: string }) => `inbox-${i.id.replace(/-/g, "")}` === type,
      );
      if (!item) throw new Error(`no open item for ${type}`);
      const done = await H.call(admin("a"), "POST", `/api/inbox/${item.id}/resolve`, { decision });
      expect(done.status, JSON.stringify(done.json)).toBe(200);
      return H.instances.events.find((e) => e.event.type === type)?.event.payload;
    });

  const run = async (decision: "approve" | "reject") => {
    const res = await H.call(OPERATOR, "POST", `/api/ops/agents/${agentId}/run`, {
      workflow: "main",
    });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const params = H.instances.started.get(j(res.json).runId);
    if (!params) throw new Error("not started");
    const deps = {
      db: H.db,
      platform: H.platform,
      transport: new FakeModel(),
      instances: H.instances,
    };
    const result = await executeRun(deps, params, cloudflareStepRunner(signer(decision)));
    return { params, deps, result };
  };

  const writesOf = (runId: string) =>
    H.t.db.select().from(recordWrite).where(eq(recordWrite.runId, runId));

  beforeAll(async () => {
    const [v] = await H.t.db
      .insert(vendor)
      .values({
        tenantId: H.A.tenantId,
        name: "Acme Lumber",
        normalizedName: "acme lumber signed",
        ext: { domains: ["acme.example"] },
      })
      .returning();
    vendorId = v?.id ?? "";
    await H.t.db.insert(customField).values({
      tenantId: H.A.tenantId,
      recordType: "vendor",
      name: "region",
      label: "Region",
      type: "text",
    });
    const created = await H.call(OPERATOR, "POST", `/api/ops/clients/${H.A.tenantId}/agents`, {
      slug: "vendor-tagger",
      bundle: bundleFor(vendorId),
    });
    expect(created.status, JSON.stringify(created.json)).toBe(200);
    agentId = j(created.json).agent.id;
    const pub = await H.call(
      OPERATOR,
      "POST",
      `/api/ops/agents/${agentId}/versions/${j(created.json).version.id}/publish`,
    );
    expect(pub.status, JSON.stringify(pub.json)).toBe(200);
    await H.t.db
      .update(agent)
      .set({ runStatus: "active", stage: "trial" })
      .where(eq(agent.id, agentId));
  });

  it("waits for a signature, then writes the save once", async () => {
    const { params, deps, result } = await run("approve");
    expect(result).toMatchObject({ status: "succeeded", nodeId: "s_end" });
    // The card the client signed: the change in words, the client admin's.
    const [card] = await H.t.db
      .select()
      .from(inboxItem)
      .where(and(eq(inboxItem.runId, params.runId), eq(inboxItem.subjectType, "record_save")));
    expect(card).toMatchObject({
      kind: "approval",
      status: "resolved",
      title: "Change the vendor Acme Lumber in our records",
      assigneeRole: "client_admin",
      resolvedBy: H.A.admin,
    });
    expect(j(card?.payload).recordSave).toMatchObject({
      recordType: "vendor",
      action: "update",
      id: vendorId,
      why: "This agent is in its trial stage: every save waits for you.",
      changes: [{ field: "region", label: "Region", before: null, after: "West" }],
    });
    // Written once, by the agent's version, with its evidence; the area's own ext keys kept.
    const writes = await writesOf(params.runId);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      recordType: "vendor",
      recordId: vendorId,
      op: "update",
      sources: [vendorId],
    });
    expect(writes[0]?.agentVersionId).toBeTruthy();
    const [v] = await H.t.db.select().from(vendor).where(eq(vendor.id, vendorId));
    expect(v?.ext).toEqual({ domains: ["acme.example"], custom: { region: "West" } });
    // The run tried again from the start: the signed save's key finds its write; nothing more.
    await executeRun(deps, params, cloudflareStepRunner(signer("approve")));
    expect(await writesOf(params.runId)).toHaveLength(1);
  });

  it("writes nothing when the save is turned down", async () => {
    await H.t.db
      .update(vendor)
      .set({ ext: { domains: ["acme.example"] } })
      .where(eq(vendor.id, vendorId));
    const { params, result } = await run("reject");
    expect(result.status).not.toBe("succeeded");
    expect(await writesOf(params.runId)).toEqual([]);
    const [v] = await H.t.db.select().from(vendor).where(eq(vendor.id, vendorId));
    expect(v?.ext).toEqual({ domains: ["acme.example"] });
  });

  it("never shows another client the card", async () => {
    const res = await H.call(admin("b"), "GET", "/api/inbox");
    const titles = j(res.json).items.map((i: { title: string }) => i.title);
    expect(titles).not.toContain("Change the vendor Acme Lumber in our records");
  });
});
