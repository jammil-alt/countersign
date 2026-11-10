// Wave 3b (docs/plan.md §1.86, readers): the server's readers of a stored bundle read a published
// v4 version (processes) as they read a v3 one: Run now and its forms, inbound call routing, the
// triggers list, whether a version writes, the field names of oversight lines, the back office's
// workflow check, and the Builder chat and "Save as automation", which refuse a process in plain
// words instead of failing. Against a real database through the app.

import {
  convertLookup,
  createClientAgent,
  createVersion,
  publish,
  updateOperational,
} from "@countersign/agents";
import {
  CALL_ANSWER_TOOL,
  MESSAGES_SEARCH_TOOL,
  TESTKIT_UPDATE_TOOL,
} from "@countersign/connectors";
import {
  type AnyAgentBundle,
  AnyAgentBundle as AnyAgentBundleSchema,
  bundleHash,
  type ProcessAgentBundle,
  type processes,
  toProcessBundle,
} from "@countersign/core";
import { agent, agentVersion, run, withOperator, withTenant } from "@countersign/db";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { type ApiHarness, admin, createApiHarness, OPERATOR, testBundle } from "./api.test-helper";
import { answeringStep } from "./calls/answer";
import { HttpError } from "./http";
import { startable } from "./lifecycle/runs";
import { bundleWrites } from "./lifecycle/stages";
import { inputSchemaOf } from "./oversight/views";
import { agentTriggers } from "./triggers/list";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

const h = await createApiHarness();
afterAll(() => h?.close());

function processOf(b: AnyAgentBundle): processes.Process {
  const w = b.workflows[0]?.workflow;
  if (w?.schemaVersion !== 4) throw new Error("fixture: expected a process");
  return w;
}

describe.skipIf(!h)("readers of a published v4 version", () => {
  const H = h as ApiHarness;
  const A = () => H.A.tenantId;

  /** The helper's Records clerk read as v4 processes, as the builder saves it, client-runnable. */
  function v4Clerk(edit?: (b: ProcessAgentBundle) => void): ProcessAgentBundle {
    const b = toProcessBundle(testBundle(), convertLookup(H.platform.catalog, H.platform.tools));
    const first = processOf(b).triggers[0];
    if (first?.on.type !== "manual") throw new Error("fixture");
    first.on.client = { canRun: true, label: "Fix a record" };
    edit?.(b);
    return b;
  }

  /** A client A agent whose live version is `bundle` (v1 is the v3 clerk), running live. */
  async function liveAgent(slug: string, bundle: AnyAgentBundle) {
    const ids = await withOperator(H.db, [A()], async (tx) => {
      const made = await createClientAgent(tx, {
        tenantId: A(),
        slug,
        bundle: testBundle(),
        authorType: "operator",
      });
      await updateOperational(tx, {
        agentId: made.agent.id,
        patch: { bindings: { testkit: H.A.connectionId } },
      });
      const v2 = await createVersion(tx, { agentId: made.agent.id, bundle });
      await publish(tx, { agentId: made.agent.id, versionId: v2.id, ctx: H.platform.ctx });
      return { agentId: made.agent.id, versionId: v2.id };
    });
    await H.t.db
      .update(agent)
      .set({ runStatus: "active", stage: "live" })
      .where(eq(agent.id, ids.agentId));
    return ids;
  }

  it("offers Run now from a process's trigger and starts the run on it", async () => {
    const live = await liveAgent("v4-run-now", v4Clerk());
    const forms = await H.call(admin("a"), "GET", `/api/services/${live.agentId}/run-forms`);
    expect(forms.status, JSON.stringify(forms.json)).toBe(200);
    expect(j(forms.json).forms).toEqual([
      expect.objectContaining({ workflow: "fix-record", label: "Fix a record" }),
    ]);
    const started = await H.call(
      admin("a"),
      "POST",
      `/api/services/${live.agentId}/workflows/fix-record/run`,
      { input: {} },
    );
    expect(started.status, JSON.stringify(started.json)).toBe(200);
    const [row] = await H.t.db
      .select()
      .from(run)
      .where(eq(run.id, j(started.json).runId));
    expect(row?.agentVersionId).toBe(live.versionId);
    expect(row?.trigger).toMatchObject({ triggerId: "trg-manual", type: "manual" });
  });

  it("refuses to start a workflow with no trigger rather than record one without it", () => {
    const b = v4Clerk();
    // A stored draft can hold one; the schema's minimum is bypassed on purpose here.
    processOf(b).triggers = [];
    const refused = (() => {
      try {
        startable(b, "fix-record");
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(refused).toBeInstanceOf(HttpError);
    expect(refused).toMatchObject({ status: 422, code: "no_trigger" });
  });

  it("answers calls with a v4 agent whose process writes call.answer, its approval read as v4", async () => {
    const twilio = crypto.randomUUID();
    const answerer = AnyAgentBundleSchema.parse({
      ...testBundle("Reception"),
      definition: {
        ...testBundle("Reception").definition,
        extraTools: [CALL_ANSWER_TOOL, MESSAGES_SEARCH_TOOL],
      },
      workflows: [
        {
          slug: "answer",
          name: "Answer",
          workflow: {
            schemaVersion: 4,
            triggers: [
              { id: "trg-manual", on: { type: "manual", input: {} } },
              { id: "trg-call", on: { type: "event", event: "call.received" } },
            ],
            steps: [
              {
                id: "answer",
                name: "Answer the call",
                kind: "write",
                tool: CALL_ANSWER_TOOL,
                input: { callSid: "{{trigger.callSid}}", purpose: "Answer questions" },
                checks: { approval: { required: "not_required" } },
              },
            ],
          },
        },
      ],
    });
    // Stored as published, bound to a Twilio connection id (routing reads the binding only).
    const [a] = await H.t.db
      .insert(agent)
      .values({
        tenantId: A(),
        kind: "client",
        slug: "v4-reception",
        name: "Reception",
        runStatus: "active",
        stage: "live",
        bindings: { twilio },
      })
      .returning();
    if (!a) throw new Error("no agent");
    const [v] = await H.t.db
      .insert(agentVersion)
      .values({
        tenantId: A(),
        agentId: a.id,
        version: 1,
        bundle: answerer,
        bundleHash: await bundleHash(answerer),
        status: "live",
        authorType: "operator",
      })
      .returning();
    if (!v) throw new Error("no version");
    await H.t.db.update(agent).set({ liveVersionId: v.id }).where(eq(agent.id, a.id));

    const found = await withTenant(H.db, A(), (tx) => answeringStep(tx, A(), twilio));
    expect(found).toMatchObject({
      agentId: a.id,
      agentVersionId: v.id,
      step: { id: "answer", approval: { required: "not_required" } },
    });
    expect(found?.step.input).toMatchObject({ purpose: "Answer questions" });

    // A condition on its approval can't be tested before the call: it counts as required.
    const conditional = structuredClone(answerer);
    const step = processOf(conditional).steps[0];
    if (step?.kind !== "write") throw new Error("fixture");
    step.checks = {
      approval: {
        required: "not_required",
        when: { match: "all", rules: [{ field: "trigger.from", op: "exists" }] },
        mode: "in_turn",
        ifNoAnswer: "stop",
        onReject: "stop",
      },
    };
    await H.t.db.update(agentVersion).set({ status: "retired" }).where(eq(agentVersion.id, v.id));
    const [v2] = await H.t.db
      .insert(agentVersion)
      .values({
        tenantId: A(),
        agentId: a.id,
        version: 2,
        bundle: conditional,
        bundleHash: await bundleHash(conditional),
        status: "live",
        authorType: "operator",
      })
      .returning();
    await H.t.db.update(agent).set({ liveVersionId: v2?.id }).where(eq(agent.id, a.id));
    const strict = await withTenant(H.db, A(), (tx) => answeringStep(tx, A(), twilio));
    expect(strict?.step.approval).toEqual({ required: "required" });
  });

  it("lists a process's triggers, and counts its write steps as writing to a client's tool", async () => {
    const daily = v4Clerk((b) => {
      processOf(b).triggers.push({
        id: "trg-daily",
        on: { type: "schedule", cron: "0 9 * * *", tz: "UTC" },
      });
    });
    const live = await liveAgent("v4-triggers", daily);
    const listed = await withTenant(H.db, A(), (tx) =>
      agentTriggers(tx, { id: live.agentId, tenantId: A(), liveVersionId: live.versionId }, null),
    );
    expect(listed.triggers.map((t) => [t.triggerId, t.type, t.first])).toEqual([
      ["trg-manual", "manual", true],
      ["trg-daily", "schedule", false],
    ]);
    // Nothing in the definition names the testkit (a draft): only the process's write does.
    const quiet = structuredClone(daily);
    quiet.definition.extraTools = [];
    const writes = await withOperator(H.db, [A()], (tx) =>
      bundleWrites(tx, A(), quiet, H.platform.ctx),
    );
    expect(writes).toBe(true);
  });

  it("names a corrected field from a v4 write step's tool", () => {
    const b = v4Clerk();
    const schema = inputSchemaOf("update", null, H.platform, processOf(b));
    expect(schema).toEqual(H.platform.tools.get(TESTKIT_UPDATE_TOOL)?.spec.input);
  });

  it("checks a workflow against an agent whose live version holds processes", async () => {
    const live = await liveAgent("v4-validate", v4Clerk());
    const res = await H.call(OPERATOR, "POST", "/api/ops/workflows/validate", {
      agentId: live.agentId,
      workflow: testBundle().workflows[0]?.workflow,
    });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(j(res.json).valid).toBe(true);
  });

  // Wave 3b (builder-chat): the Builder chat and Save as automation now read a process.
  it("starts the Builder chat from a process and saves a process's steps as an automation", async () => {
    const live = await liveAgent("v4-builder", v4Clerk());
    const chat = await H.call(OPERATOR, "POST", "/api/ops/builder/sessions", {
      kind: "agent",
      agentId: live.agentId,
    });
    expect(chat.status, JSON.stringify(chat.json)).toBeLessThan(300);
    const save = await H.call(OPERATOR, "POST", "/api/ops/automations/from-steps", {
      agentId: live.agentId,
      versionId: live.versionId,
      stepIds: ["update"],
      slug: "v4-steps",
      name: "Steps",
    });
    expect(save.status, JSON.stringify(save.json)).toBeLessThan(300);
  });
});
