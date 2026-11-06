// v0.12 W2-B: automations through the API against a real database (ARCHITECTURE §10.7; docs/plan.md
// §1.45, M22). "Polite follow-up" is published once, used by two client agents forked from one
// template, runs expanded in both with the same node ids (its inner write asking for approval),
// shows its clean-run rate and usage, and a template update to a newer version merges with a
// client's change to the use step's input. "Save as automation" refuses what it must.

import { TESTKIT_UPDATE_TOOL } from "@countersign/connectors";
import {
  type AgentBundle,
  AgentBundle as AgentBundleSchema,
  type UseAutomationStep,
} from "@countersign/core";
import { agentVersion, automation, inboxItem, run, stepRun } from "@countersign/db";
import { FakeModel } from "@countersign/llm";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type ApiHarness,
  admin,
  createApiHarness,
  FakeWorkflowStep,
  OPERATOR,
  OTHER_OPERATOR,
  testBundle,
} from "./api.test-helper";
import { executeRun } from "./runs/execute";
import { cloudflareStepRunner } from "./runs/step-runner";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

function followUp(over: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    slug: "polite-follow-up",
    name: "Polite follow-up",
    description: "Say a word, then correct the record",
    input: {
      type: "object",
      properties: { note: { type: "string" }, amount: { type: "string" } },
      required: ["note", "amount"],
    },
    output: { amount: "{{input.amount}}", record: "{{steps.update.output}}" },
    steps: [
      {
        id: "say",
        name: "Say it",
        kind: "notify",
        channel: "thread",
        message: "{{input.note}}",
      },
      {
        id: "update",
        name: "Correct the record",
        kind: "action",
        tool: TESTKIT_UPDATE_TOOL,
        input: { id: "r1", amount: "{{input.amount}}" },
      },
    ],
    ...over,
  };
}

/** A template whose one workflow uses the automation. */
function usingBundle(ref = "polite-follow-up@1", note = "Hello"): AgentBundle {
  const b = testBundle("Follow-up clerk");
  const wf = b.workflows[0];
  if (!wf) throw new Error("no workflow");
  wf.slug = "follow-up";
  wf.workflow.steps = [
    {
      id: "follow",
      name: "Follow up",
      kind: "use_automation",
      automation: ref,
      input: { note, amount: "12.00" },
    },
  ];
  return AgentBundleSchema.parse(b);
}

const useOf = (b: AgentBundle) => b.workflows[0]?.workflow.steps[0] as UseAutomationStep;

const h = await createApiHarness();
afterAll(() => h?.close());

describe.skipIf(!h)("automations", () => {
  const H = h as ApiHarness;
  const deps = () => ({
    db: H.db,
    platform: H.platform,
    transport: new FakeModel(),
    instances: H.instances,
    modelCallBodies: H.objects,
  });
  let automationId = "";
  let templateId = "";
  const clients: Record<"a" | "b", { agentId: string; tenantId: string; conn: string }> = {
    a: { agentId: "", tenantId: "", conn: "" },
    b: { agentId: "", tenantId: "", conn: "" },
  };

  /** Resolves the item a run waits on through the API (approve), and returns its event. */
  const approveAs = (who: string, seen: string[]) => async (_name: string, type: string) => {
    const items = await H.t.db.select().from(inboxItem).where(eq(inboxItem.status, "open"));
    const item = items.find((i) => `inbox-${i.id.replace(/-/g, "")}` === type);
    if (!item) throw new Error(`no open item for ${type}`);
    seen.push(item.kind);
    const res = await H.call(who, "POST", `/api/inbox/${item.id}/resolve`, { decision: "approve" });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    return H.instances.events.find((e) => e.event.type === type)?.event.payload;
  };

  const publishAgent = async (agentId: string, versionId: string) => {
    const res = await H.call(
      OPERATOR,
      "POST",
      `/api/ops/agents/${agentId}/versions/${versionId}/publish`,
    );
    expect(res.status, JSON.stringify(res.json)).toBe(200);
  };

  beforeAll(async () => {
    clients.a = { agentId: "", tenantId: H.A.tenantId, conn: H.A.connectionId };
    clients.b = { agentId: "", tenantId: H.B.tenantId, conn: H.B.connectionId };
    for (const c of ["a", "b"] as const) {
      await H.call(admin(c), "POST", "/api/connections/testkit/authorize");
    }
  });

  it("creates, versions and publishes a shared automation; only a valid version publishes", async () => {
    const created = await H.call(OPERATOR, "POST", "/api/ops/automations", {
      definition: followUp(),
    });
    expect(created.status, JSON.stringify(created.json)).toBe(200);
    expect(j(created.json)).toMatchObject({
      automation: {
        slug: "polite-follow-up",
        source: "shared",
        latestVersion: 1,
        latestStatus: "draft",
        inputs: ["note", "amount"],
        outputs: ["amount", "record"],
        requires: { skills: [], tools: [TESTKIT_UPDATE_TOOL], connectors: ["testkit"] },
        usedBy: 0,
        health: { uses: 0, clean: 0, cleanRunRate: null },
      },
      errors: [],
    });
    automationId = j(created.json).automation.id;
    const v1 = j(created.json).version.id;

    // The same definition again is no change; requires sent by the client is never trusted.
    const same = await H.call(OPERATOR, "POST", `/api/ops/automations/${automationId}/versions`, {
      definition: { ...followUp(), requires: { skills: [], tools: [], connectors: [] } },
    });
    expect(same.status).toBe(409);

    // A draft may be saved with errors, but it doesn't publish.
    const bad = await H.call(OPERATOR, "POST", `/api/ops/automations/${automationId}/versions`, {
      definition: followUp({ output: { x: "{{trigger.what}}" } }),
    });
    expect(bad.status).toBe(200);
    expect(j(bad.json).errors.map((e: { code: string }) => e.code)).toEqual(["template_scope"]);
    const badPublish = await H.call(
      OPERATOR,
      "POST",
      `/api/ops/automations/${automationId}/versions/${j(bad.json).version.id}/publish`,
    );
    expect(badPublish.status).toBe(422);

    const pub = await H.call(
      OPERATOR,
      "POST",
      `/api/ops/automations/${automationId}/versions/${v1}/publish`,
    );
    expect(j(pub.json)).toMatchObject({ version: { version: 1, status: "live" } });

    // A client's own automation stays with the operators who serve that client.
    const own = await H.call(OPERATOR, "POST", "/api/ops/automations", {
      clientId: H.A.tenantId,
      definition: followUp({ slug: "a-only", name: "A only" }),
    });
    const ownId = j(own.json).automation.id;
    expect(j(own.json).automation).toMatchObject({ source: "client", clientId: H.A.tenantId });
    expect((await H.call(OTHER_OPERATOR, "GET", `/api/ops/automations/${ownId}`)).status).toBe(404);
  });

  it("is used by two client agents and runs expanded in both with the same node ids", async () => {
    const tpl = await H.call(OPERATOR, "POST", "/api/ops/templates", {
      slug: "follow-up-clerk",
      bundle: usingBundle(),
    });
    expect(tpl.status, JSON.stringify(tpl.json)).toBe(200);
    templateId = j(tpl.json).agent.id;
    await publishAgent(templateId, j(tpl.json).version.id);

    // The builder catalog offers it, typed.
    const catalog = await H.call(OPERATOR, "GET", `/api/ops/agents/${templateId}/builder-catalog`);
    expect(j(catalog.json).automations).toEqual([
      expect.objectContaining({
        ref: "polite-follow-up@1",
        status: "live",
        outputSchema: expect.objectContaining({ required: ["amount", "record"] }),
      }),
    ]);

    const nodeIds: string[][] = [];
    for (const c of ["a", "b"] as const) {
      const client = clients[c];
      H.backend.seed(client.conn, [{ id: "r1", name: "Oak board", amount: "10.00" }]);
      const fork = await H.call(OPERATOR, "POST", `/api/ops/templates/${templateId}/fork`, {
        clientId: client.tenantId,
        serviceName: "Follow-ups",
      });
      expect(fork.status, JSON.stringify(fork.json)).toBe(200);
      client.agentId = j(fork.json).agent.id;
      await H.call(OPERATOR, "PATCH", `/api/ops/agents/${client.agentId}/operation`, {
        bindings: { testkit: client.conn },
      });
      await publishAgent(client.agentId, j(fork.json).version.id);

      // Publishing copied the shared automation into the client (runs see one client only).
      const copies = await H.t.db
        .select()
        .from(automation)
        .where(
          and(
            eq(automation.tenantId, client.tenantId),
            eq(automation.slug, "shared:polite-follow-up"),
          ),
        );
      expect(copies).toHaveLength(1);

      const test = await H.call(
        OPERATOR,
        "POST",
        `/api/ops/agents/${client.agentId}/versions/${j(fork.json).version.id}/test-run`,
        { workflow: "follow-up" },
      );
      const testParams = H.instances.started.get(j(test.json).runId);
      if (!testParams) throw new Error("the test run was not started");
      expect(
        await executeRun(deps(), testParams, cloudflareStepRunner(new FakeWorkflowStep())),
      ).toEqual({ status: "succeeded" });
      const act = await H.call(OPERATOR, "POST", `/api/ops/agents/${client.agentId}/activate`);
      expect(act.status, JSON.stringify(act.json)).toBe(200);

      const started = await H.call(OPERATOR, "POST", `/api/ops/agents/${client.agentId}/run`, {
        workflow: "follow-up",
      });
      expect(started.status, JSON.stringify(started.json)).toBe(200);
      const runId = j(started.json).runId as string;
      const params = H.instances.started.get(runId);
      if (!params) throw new Error("not started");
      const seen: string[] = [];
      const result = await executeRun(
        deps(),
        params,
        cloudflareStepRunner(new FakeWorkflowStep(approveAs(admin(c), seen))),
      );
      expect(result).toEqual({ status: "succeeded" });
      // The inner write kept approval on: the client approved it once.
      expect(seen).toHaveLength(1);
      expect(H.backend.company(client.conn).get("r1")).toMatchObject({ amount: "12.00" });

      const rows = await H.t.db
        .select()
        .from(stepRun)
        .where(eq(stepRun.runId, runId))
        .orderBy(stepRun.startedAt, stepRun.id);
      nodeIds.push(rows.map((r) => r.nodeId).sort());
      expect(rows.find((r) => r.nodeId === "follow")).toMatchObject({
        nodeType: "use_automation",
        skillRef: "automation:polite-follow-up@1",
        status: "succeeded",
        output: { amount: "12.00" },
      });
    }
    expect(nodeIds[0]).toEqual(["follow", "follow/say", "follow/update"]);
    expect(nodeIds[1]).toEqual(nodeIds[0]);

    const detail = await H.call(OPERATOR, "GET", `/api/ops/automations/${automationId}`);
    expect(j(detail.json).automation).toMatchObject({
      usedBy: 3,
      health: { uses: 2, clean: 2, cleanRunRate: 1 },
    });
    expect(
      j(detail.json)
        .usedBy.map((u: { kind: string; clientId: string | null }) => `${u.kind}:${u.clientId}`)
        .sort(),
    ).toEqual([`client:${H.A.tenantId}`, `client:${H.B.tenantId}`, "template:null"].sort());
    // The portal never sees the automation, only the use step as one line.
    const portal = await H.call(
      admin("a"),
      "GET",
      `/api/portal/runs/${
        (
          await H.t.db
            .select()
            .from(run)
            .where(and(eq(run.agentId, clients.a.agentId), eq(run.mode, "live")))
        )[0]?.id
      }`,
    );
    expect(JSON.stringify(portal.json)).not.toContain("polite-follow-up");
  });

  it("merges a template update to a newer version with a client's change to the input", async () => {
    // A newer version of the automation.
    const v2 = await H.call(OPERATOR, "POST", `/api/ops/automations/${automationId}/versions`, {
      definition: followUp({ description: "Say a kinder word, then correct the record" }),
    });
    expect(j(v2.json).version.version).toBe(3);
    await H.call(
      OPERATOR,
      "POST",
      `/api/ops/automations/${automationId}/versions/${j(v2.json).version.id}/publish`,
    );

    // The client changes what it says.
    const a = clients.a.agentId;
    const [live] = await H.t.db
      .select()
      .from(agentVersion)
      .where(and(eq(agentVersion.agentId, a), eq(agentVersion.status, "live")));
    const clientBundle = AgentBundleSchema.parse(live?.bundle);
    useOf(clientBundle).input.note = "Thanks for your patience";
    const saved = await H.call(OPERATOR, "POST", `/api/ops/agents/${a}/versions`, {
      bundle: clientBundle,
      parentVersionId: live?.id,
    });
    expect(saved.status, JSON.stringify(saved.json)).toBe(200);
    await publishAgent(a, j(saved.json).version.id);

    // The template moves to the newer version.
    const tv = await H.call(OPERATOR, "POST", `/api/ops/agents/${templateId}/versions`, {
      bundle: usingBundle("polite-follow-up@3"),
    });
    expect(j(tv.json).errors).toEqual([]);
    await publishAgent(templateId, j(tv.json).version.id);

    const preview = await H.call(OPERATOR, "GET", `/api/ops/agents/${a}/update-preview`);
    expect(preview.status, JSON.stringify(preview.json)).toBe(200);
    expect(j(preview.json).conflicts).toEqual([]);
    const update = await H.call(OPERATOR, "POST", `/api/ops/agents/${a}/update`, {
      resolutions: [],
    });
    expect(update.status, JSON.stringify(update.json)).toBe(200);
    const [merged] = await H.t.db
      .select()
      .from(agentVersion)
      .where(eq(agentVersion.id, j(update.json).version.id));
    const step = useOf(AgentBundleSchema.parse(merged?.bundle));
    expect(step).toMatchObject({
      id: "follow",
      automation: "polite-follow-up@3",
      input: { note: "Thanks for your patience", amount: "12.00" },
    });
  });

  it("saves steps as an automation, and refuses a selection it can't save", async () => {
    const tpl = await H.call(OPERATOR, "POST", "/api/ops/templates", {
      slug: "records-for-automation",
      bundle: testBundle(),
    });
    const agentId = j(tpl.json).agent.id;
    const versionId = j(tpl.json).version.id;
    const from = (stepIds: string[], slug = "fix-and-note") =>
      H.call(OPERATOR, "POST", "/api/ops/automations/from-steps", {
        agentId,
        versionId,
        stepIds,
        slug,
        name: "Fix and note",
      });
    const gap = await from(["update", "internal"]);
    expect(gap.status).toBe(422);
    expect(j(gap.json).error.code).toBe("not_contiguous");

    const ok = await from(["update", "confirm"]);
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect(j(ok.json)).toMatchObject({
      automation: { slug: "fix-and-note", source: "shared", latestStatus: "draft" },
      version: { version: 1, status: "draft" },
      agentVersion: { version: 2 },
    });
    const def = j(ok.json).version.definition;
    expect(def.steps.map((s: { kind: string }) => s.kind)).toEqual(["action", "person"]);
    expect(def.steps[0].id).not.toBe("update");
    expect(def.steps[0].approval.required).toBe("required");
    const [next] = await H.t.db
      .select()
      .from(agentVersion)
      .where(eq(agentVersion.id, j(ok.json).agentVersion.id));
    const steps = AgentBundleSchema.parse(next?.bundle).workflows[0]?.workflow.steps ?? [];
    expect(steps.map((s) => s.kind)).toEqual(["use_automation", "notify"]);
    expect(steps[1]?.id).toBe("internal");
    expect(useOf(AgentBundleSchema.parse(next?.bundle)).automation).toBe("fix-and-note@1");

    // A person step assigned to a named person can't travel in an automation.
    const named = testBundle("Named");
    const confirm = named.workflows[0]?.workflow.steps[1];
    if (confirm?.kind === "person") confirm.assignee = "0190a3c4-1111-7000-8000-000000000001";
    const tpl2 = await H.call(OPERATOR, "POST", "/api/ops/templates", {
      slug: "records-named",
      bundle: named,
    });
    const refused = await H.call(OPERATOR, "POST", "/api/ops/automations/from-steps", {
      agentId: j(tpl2.json).agent.id,
      versionId: j(tpl2.json).version.id,
      stepIds: ["confirm"],
      slug: "named",
      name: "Named",
    });
    expect(refused.status).toBe(422);
    expect(j(refused.json).error.code).toBe("named_person");
  });
});
