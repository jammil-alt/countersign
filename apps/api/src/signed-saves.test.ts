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

const bundleFor = (vendorId: string, checks?: Record<string, unknown>) => ({
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
            ...(checks ? { checks } : {}),
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
  const signer = (decision: "approve" | "reject", afterSigning?: () => Promise<void>) =>
    new FakeWorkflowStep(async (_name, type) => {
      const res = await H.call(admin("a"), "GET", "/api/inbox");
      const item = j(res.json).items.find(
        (i: { id: string }) => `inbox-${i.id.replace(/-/g, "")}` === type,
      );
      if (!item) throw new Error(`no open item for ${type}`);
      const done = await H.call(admin("a"), "POST", `/api/inbox/${item.id}/resolve`, { decision });
      expect(done.status, JSON.stringify(done.json)).toBe(200);
      await afterSigning?.();
      return H.instances.events.find((e) => e.event.type === type)?.event.payload;
    });

  /** A client agent with the vendor tagging workflow, published and switched on at `stage`. */
  const newAgent = async (
    slug: string,
    stage: "trial" | "live",
    checks?: Record<string, unknown>,
  ) => {
    const created = await H.call(OPERATOR, "POST", `/api/ops/clients/${H.A.tenantId}/agents`, {
      slug,
      bundle: bundleFor(vendorId, checks),
    });
    expect(created.status, JSON.stringify(created.json)).toBe(200);
    const id = j(created.json).agent.id as string;
    const pub = await H.call(
      OPERATOR,
      "POST",
      `/api/ops/agents/${id}/versions/${j(created.json).version.id}/publish`,
    );
    expect(pub.status, JSON.stringify(pub.json)).toBe(200);
    await H.t.db.update(agent).set({ runStatus: "active", stage }).where(eq(agent.id, id));
    return id;
  };

  const cardsOf = (runId: string) =>
    H.t.db
      .select()
      .from(inboxItem)
      .where(and(eq(inboxItem.runId, runId), eq(inboxItem.subjectType, "record_save")));

  const run = async (
    decision: "approve" | "reject",
    who = agentId,
    afterSigning?: () => Promise<void>,
  ) => {
    const res = await H.call(OPERATOR, "POST", `/api/ops/agents/${who}/run`, {
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
    const result = await executeRun(
      deps,
      params,
      cloudflareStepRunner(signer(decision, afterSigning)),
    );
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
    agentId = await newAgent("vendor-tagger", "trial");
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

  it("saves at once, with no card, for an agent that acts and is live on a step with no approver", async () => {
    const live = await newAgent("vendor-tagger-live", "live");
    const { params, result } = await run("approve", live);
    expect(result).toMatchObject({ status: "succeeded" });
    expect(await cardsOf(params.runId)).toEqual([]);
    expect(await writesOf(params.runId)).toHaveLength(1);
  });

  it("waits for a card when the step adds its own approver, live and acting", async () => {
    const asks = await newAgent("vendor-tagger-asks", "live", {
      approval: { required: "required" },
    });
    const { params, result } = await run("approve", asks);
    expect(result).toMatchObject({ status: "succeeded" });
    const [card] = await cardsOf(params.runId);
    expect(card).toMatchObject({ status: "resolved", resolvedBy: H.A.admin });
    expect(j(card?.payload).recordSave.why).toBe("This step asks for an approval before it saves.");
    expect(await writesOf(params.runId)).toHaveLength(1);
  });

  it("writes nothing when a safety hold lands between the signature and the write", async () => {
    const held = await newAgent("vendor-tagger-held", "trial");
    const { params, result } = await run("approve", held, async () => {
      await H.t.db
        .update(agent)
        .set({
          hold: {
            issueId: "",
            by: "operator",
            userId: null,
            at: new Date().toISOString(),
            reason: "checking",
          },
        })
        .where(eq(agent.id, held));
    });
    expect(result.status).not.toBe("succeeded");
    const [card] = await cardsOf(params.runId);
    expect(card).toMatchObject({ status: "resolved" });
    expect(await writesOf(params.runId)).toEqual([]);
  });

  it("never shows another client the card", async () => {
    const res = await H.call(admin("b"), "GET", "/api/inbox");
    const titles = j(res.json).items.map((i: { title: string }) => i.title);
    expect(titles).not.toContain("Change the vendor Acme Lumber in our records");
  });
});
