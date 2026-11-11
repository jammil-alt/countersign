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
  defineConnector,
  defineWriteTool,
  MESSAGES_SEARCH_TOOL,
  TESTKIT_QUERY_TOOL,
  TESTKIT_UPDATE_TOOL,
} from "@countersign/connectors";
import {
  type AnyAgentBundle,
  AnyAgentBundle as AnyAgentBundleSchema,
  bundleHash,
  DecimalString,
  type ProcessAgentBundle,
  type processes,
  toProcessBundle,
} from "@countersign/core";
import {
  agent,
  agentVersion,
  connection,
  externalAction,
  inboxItem,
  run,
  stepRun,
  tenant,
  withOperator,
  withTenant,
} from "@countersign/db";
import { FakeModel } from "@countersign/llm";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  type ApiHarness,
  admin,
  createApiHarness,
  FakeWorkflowStep,
  OPERATOR,
  testBundle,
  user,
} from "./api.test-helper";
import { answeringStep } from "./calls/answer";
import { clientTitles } from "./change-display";
import { EXPORT_TABLES } from "./exports/tables";
import { HttpError } from "./http";
import { startable } from "./lifecycle/runs";
import { bundleWrites } from "./lifecycle/stages";
import { inputSchemaOf } from "./oversight/views";
import { executeRun } from "./runs/execute";
import { cloudflareStepRunner } from "./runs/step-runner";
import { agentTriggers } from "./triggers/list";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

/** Wave 3c: a fake bill system whose one write has a total a person may edit before signing. */
const EDIT_TOOL = "editkit.bill.update";
const editkit = defineConnector({
  id: "editkit",
  name: "Editkit",
  description: "A fake bill system for editing a change before signing.",
  icon: "box",
  auth: "none",
  entities: ["Bill"],
  tools: [
    defineWriteTool({
      id: EDIT_TOOL,
      description: "Change a bill's total.",
      verb: "update",
      amount: { path: "total", currency: "USD" },
      display: {
        name: "Bill",
        fields: [
          { label: "Bill", kind: "text", after: "input.billId" },
          { label: "Total", kind: "money", after: "input.total", currency: "USD", editable: true },
        ],
      },
      input: z.object({ billId: z.string().min(1), total: DecimalString }),
      output: z.object({ id: z.string() }),
      beforeSchema: z.object({}),
      async before() {
        return null;
      },
      async run(_input, ctx) {
        return { id: ctx.idempotencyKey };
      },
    }),
  ],
});

const h = await createApiHarness({ connectors: () => [editkit] });
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
  async function liveAgent(
    slug: string,
    bundle: AnyAgentBundle,
    bindings: Record<string, string> = {},
  ) {
    const ids = await withOperator(H.db, [A()], async (tx) => {
      const made = await createClientAgent(tx, {
        tenantId: A(),
        slug,
        bundle: testBundle(),
        authorType: "operator",
      });
      await updateOperational(tx, {
        agentId: made.agent.id,
        patch: { bindings: { testkit: H.A.connectionId, ...bindings } },
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

  // ── Wave 3c: the tests the wave 3b review asked for ─────────────────────────────────────────

  /** A client A agent stored live with `bundle` as its one version, as published (unvalidated). */
  async function storedAgent(slug: string, bundle: AnyAgentBundle) {
    const [a] = await H.t.db
      .insert(agent)
      .values({
        tenantId: A(),
        kind: "client",
        slug,
        name: bundle.definition.identity.name,
        runStatus: "active",
        stage: "live",
      })
      .returning();
    if (!a) throw new Error("no agent");
    const [v] = await H.t.db
      .insert(agentVersion)
      .values({
        tenantId: A(),
        agentId: a.id,
        version: 1,
        bundle,
        bundleHash: await bundleHash(bundle),
        status: "live",
        authorType: "operator",
      })
      .returning();
    if (!v) throw new Error("no version");
    await H.t.db.update(agent).set({ liveVersionId: v.id }).where(eq(agent.id, a.id));
    return { agentId: a.id, versionId: v.id };
  }

  it("takes an edit before signing from each named approver of a v4 write, and refuses one that reroutes", async () => {
    const [t] = await H.t.db.select().from(tenant).where(eq(tenant.id, A()));
    await H.t.db
      .update(tenant)
      .set({ settings: { ...(t?.settings ?? {}), connectors_offered: ["testkit", "editkit"] } })
      .where(eq(tenant.id, A()));
    const [conn] = await H.t.db
      .insert(connection)
      .values({ tenantId: A(), connector: "editkit", status: "connected" })
      .returning();
    if (!conn) throw new Error("no connection");
    const fix: processes.Step = {
      id: "fix-total",
      name: "Fix the bill's total",
      kind: "write",
      tool: EDIT_TOOL,
      input: { billId: "B-1", total: "100.00" },
      checks: {
        approval: {
          required: "required",
          mode: "in_turn",
          approvers: [{ who: H.A.admin }, { who: H.A.user }],
          ifNoAnswer: "stop",
          onReject: "stop",
        },
      },
    };
    const live = await liveAgent(
      "v4-desk-edit",
      v4Clerk((b) => {
        b.definition.extraTools.push(EDIT_TOOL);
        processOf(b).steps = [fix];
      }),
      { editkit: conn.id },
    );
    // A bill over 500 USD goes to the client admins, whoever the step names.
    const rules = await H.call(OPERATOR, "PUT", `/api/ops/clients/${A()}/approver-rules`, {
      revision: 0,
      rules: [
        {
          match: { connector: "editkit", amountOver: { value: "500", currency: "USD" } },
          approver: { kind: "client_admin" },
        },
      ],
      reason: "Big bills go to the admins",
    });
    expect(rules.status, JSON.stringify(rules.json)).toBe(200);

    const started = await H.call(
      admin("a"),
      "POST",
      `/api/services/${live.agentId}/workflows/fix-record/run`,
      { input: {} },
    );
    expect(started.status, JSON.stringify(started.json)).toBe(200);
    const runId = j(started.json).runId as string;
    const params = H.instances.started.get(runId);
    if (!params) throw new Error("not started");
    let checked = false;
    const step = new FakeWorkflowStep(async (_name, type) => {
      const item = (await H.t.db.select().from(inboxItem)).find(
        (i) => `inbox-${i.id.replace(/-/g, "")}` === type,
      );
      if (!item) throw new Error(`no item for ${type}`);
      // The first approver named is asked first.
      expect(item).toMatchObject({ kind: "external_action", assigneeUserId: H.A.admin });
      const [proposed] = await H.t.db
        .select()
        .from(externalAction)
        .where(eq(externalAction.inboxItemId, item.id));
      const original = proposed?.input as Record<string, unknown>;
      const edit = (total: string, who: Parameters<typeof H.call>[0]) =>
        H.call(who, "PUT", `/api/inbox/${item.id}/edit`, { input: { ...original, total } });
      const first = await edit("120.00", admin("a"));
      expect(first.status, JSON.stringify(first.json)).toBe(200);
      // The executor asks the second in turn (the first is away): theirs to edit now.
      await H.t.db
        .update(inboxItem)
        .set({ assigneeRole: null, assigneeUserId: H.A.user })
        .where(eq(inboxItem.id, item.id));
      const second = await edit("130.00", user("a"));
      expect(second.status, JSON.stringify(second.json)).toBe(200);
      // Over 500 USD it would go to the client admins instead.
      const away = await edit("600.00", user("a"));
      expect(away.status, JSON.stringify(away.json)).toBe(409);
      expect(j(away.json).error.code).toBe("reroute");
      const signed = await H.call(user("a"), "POST", `/api/inbox/${item.id}/resolve`, {
        decision: "approve",
      });
      expect(signed.status, JSON.stringify(signed.json)).toBe(200);
      checked = true;
      return H.instances.events.find((e) => e.event.type === type)?.event.payload;
    });
    const deps = {
      db: H.db,
      platform: H.platform,
      transport: new FakeModel(),
      instances: H.instances,
    };
    expect(await executeRun(deps, params, cloudflareStepRunner(step))).toEqual({
      status: "succeeded",
    });
    expect(checked).toBe(true);
    const [done] = await H.t.db
      .select()
      .from(externalAction)
      .where(eq(externalAction.runId, runId));
    expect(done).toMatchObject({ status: "done", editedInput: { total: "130.00" } });
  });

  /** A process with a read, an if around a write, a loop around a read and a hidden note. */
  function tidyBundle(): AnyAgentBundle {
    return AnyAgentBundleSchema.parse({
      ...testBundle("Tidy clerk"),
      workflows: [
        {
          slug: "tidy",
          name: "Tidy",
          workflow: {
            schemaVersion: 4,
            triggers: [{ id: "trg-manual", on: { type: "manual", input: {} } }],
            steps: [
              {
                id: "look",
                name: "Look up the records",
                kind: "read",
                tool: TESTKIT_QUERY_TOOL,
                client: { visible: true, label: "Looked up the records" },
              },
              {
                id: "check",
                name: "Any to fix?",
                kind: "if",
                paths: [
                  {
                    id: "some",
                    name: "Some to fix",
                    when: {
                      match: "all",
                      rules: [{ field: "{{steps.look.output.records}}", op: "exists" }],
                    },
                    steps: [
                      {
                        id: "fix",
                        name: "Update the record",
                        kind: "write",
                        tool: TESTKIT_UPDATE_TOOL,
                        input: { id: "r1", amount: "12.00" },
                        client: { visible: true, label: "Corrected the record" },
                        checks: {
                          confer: { with: [{ ai: { focus: "Is the amount right?" } }] },
                        },
                      },
                    ],
                  },
                ],
                otherwise: { id: "none", steps: [] },
              },
              {
                id: "each",
                name: "Each record",
                kind: "for_each",
                over: "{{steps.look.output.records}}",
                steps: [
                  {
                    id: "recheck",
                    name: "Read it again",
                    kind: "read",
                    tool: TESTKIT_QUERY_TOOL,
                    client: { visible: true, label: "Read it again" },
                  },
                ],
              },
              {
                id: "note",
                name: "Operator note",
                kind: "notify",
                notify: { to: ["operator"], message: "Tidied" },
                client: { visible: false },
              },
            ],
          },
        },
      ],
    });
  }

  /** A finished live run of `tidyBundle` with a step log, inserted as the executor writes it. */
  async function tidyRun(
    s: { agentId: string; versionId: string },
    error?: Record<string, unknown>,
  ) {
    const [r] = await H.t.db
      .insert(run)
      .values({
        tenantId: A(),
        agentId: s.agentId,
        agentVersionId: s.versionId,
        workflowSlug: "tidy",
        mode: "live",
        status: error ? "failed" : "succeeded",
        trigger: { triggerId: "trg-manual", type: "manual" },
        ...(error ? { error } : {}),
        startedAt: new Date(),
        finishedAt: new Date(),
      })
      .returning();
    if (!r) throw new Error("no run");
    // In the future, so the Table's recent steps (newest first, five) are this run's.
    const at = (m: number) => new Date(Date.now() + 3_600_000 + m * 60_000);
    const rows: [string, string][] = [
      ["look", "read"],
      ["check", "if"],
      ["fix:confer:1", "confer"],
      ["fix", "write"],
      ["fix:approval:1:a1", "approval"],
      ["each", "for_each"],
      ["each:0:recheck", "read"],
      ["note", "notify"],
    ];
    await H.t.db.insert(stepRun).values(
      rows.map(([nodeId, nodeType], i) => ({
        tenantId: A(),
        runId: r.id,
        nodeId,
        nodeType,
        status: "succeeded" as const,
        summary: `Row ${nodeId}`,
        startedAt: at(i),
        finishedAt: at(i),
      })),
    );
    return r.id;
  }

  it("lists in the client export and on the Table exactly the steps the portal's timeline shows", async () => {
    const s = await storedAgent("v4-timeline", tidyBundle());
    const runId = await tidyRun(s);
    const portal = await H.call(admin("a"), "GET", `/api/runs/${runId}`);
    expect(portal.status, JSON.stringify(portal.json)).toBe(200);
    const shown = j(portal.json).steps.map((x: { id: string; label: string }) => [x.id, x.label]);
    // The work, by its client label: never the if, the loop, the hidden note or a check's row.
    expect(shown.map((x: string[]) => x[1])).toEqual([
      "Looked up the records",
      "Corrected the record",
      "Read it again",
    ]);

    const steps = EXPORT_TABLES.find((t) => t.file === "steps.csv");
    if (!steps) throw new Error("no steps table");
    const page = await withTenant(H.db, A(), (tx) => steps.page(tx, A(), null, 1000));
    // The export pages by row id, the timeline goes by time: the same rows, by the same names.
    const byId = (a: unknown[], b: unknown[]) => String(a[0]).localeCompare(String(b[0]));
    expect(
      page.rows
        .filter((row) => row[1] === runId)
        .map((row) => [row[0], row[2]])
        .sort(byId),
    ).toEqual([...shown].sort(byId));

    const table = await H.call(admin("a"), "GET", "/api/table");
    expect(table.status, JSON.stringify(table.json)).toBe(200);
    const recent = j(table.json).recent.filter((x: { runId: string }) => x.runId === runId);
    expect(recent.map((x: { label: string }) => x.label).sort()).toEqual(
      shown.map((x: string[]) => x[1]).sort(),
    );
  });

  it("names a v4 step by its client label for the client and by its name for the back office", async () => {
    const s = await storedAgent("v4-names", tidyBundle());
    const runId = await tidyRun(s);
    // An approval card's title: the step's client label, inside an if as at the top.
    const titles = await withTenant(H.db, A(), (tx) =>
      clientTitles(
        tx,
        [
          {
            id: "item-1",
            kind: "external_action",
            tenantId: A(),
            runId,
            title: "Approve a change",
            payload: { tool: TESTKIT_UPDATE_TOOL, stepId: "fix" },
          },
          {
            id: "item-2",
            kind: "external_action",
            tenantId: A(),
            runId,
            title: "Approve a change",
            payload: { tool: TESTKIT_UPDATE_TOOL, stepId: "each:0:recheck" },
          },
          // A write retried with a corrected input, or run again after help, keeps its step.
          {
            id: "item-3",
            kind: "external_action",
            tenantId: A(),
            runId,
            title: "Approve a change",
            payload: { tool: TESTKIT_UPDATE_TOOL, stepId: "fix:o1" },
          },
          {
            id: "item-4",
            kind: "external_action",
            tenantId: A(),
            runId,
            title: "Approve a change",
            payload: { tool: TESTKIT_UPDATE_TOOL, stepId: "each:0:recheck:h1" },
          },
        ],
        H.platform,
      ),
    );
    expect(Object.fromEntries(titles)).toEqual({
      "item-1": "Corrected the record",
      "item-2": "Read it again",
      "item-3": "Corrected the record",
      "item-4": "Read it again",
    });

    // The back office's run lists name the step a run failed at, a check of it too.
    const failedAt = async (nodeId: string) => {
      const id = await tidyRun(s, { nodeId, reason: "timeout" });
      const res = await H.call(OPERATOR, "GET", `/api/ops/runs/${id}`);
      expect(res.status, JSON.stringify(res.json)).toBe(200);
      return j(res.json).run.errorStep;
    };
    expect(await failedAt("each:0:recheck")).toBe("Read it again");
    expect(await failedAt("fix")).toBe("Update the record");
    // A confer that nobody answered in time stops the run at the step it checks.
    expect(await failedAt("fix:confer:1")).toBe("Update the record");
  });

  it("compares a v3 base version with a v4 live version on the lineage routes", async () => {
    const tpl = await H.call(OPERATOR, "POST", "/api/ops/templates", {
      slug: "v4-lineage",
      bundle: testBundle(),
    });
    expect(tpl.status, JSON.stringify(tpl.json)).toBe(200);
    const tid = j(tpl.json).agent.id as string;
    const pub = await H.call(
      OPERATOR,
      "POST",
      `/api/ops/agents/${tid}/versions/${j(tpl.json).version.id}/publish`,
    );
    expect(pub.status, JSON.stringify(pub.json)).toBe(200);
    const fork = await H.call(OPERATOR, "POST", `/api/ops/templates/${tid}/fork`, {
      clientId: A(),
      serviceName: "Lineage",
    });
    expect(fork.status, JSON.stringify(fork.json)).toBe(200);
    const id = j(fork.json).agent.id as string;
    const v1 = j(fork.json).version.id as string;
    const bound = await H.call(OPERATOR, "PATCH", `/api/ops/agents/${id}/operation`, {
      bindings: { testkit: H.A.connectionId },
    });
    expect(bound.status, JSON.stringify(bound.json)).toBe(200);
    // The client's copy saved as a process, on the template's v3 version.
    const saved = await H.call(OPERATOR, "POST", `/api/ops/agents/${id}/versions`, {
      bundle: v4Clerk(),
      parentVersionId: v1,
    });
    expect(saved.status, JSON.stringify(saved.json)).toBe(200);
    const v2 = j(saved.json).version.id as string;
    const live = await H.call(OPERATOR, "POST", `/api/ops/agents/${id}/versions/${v2}/publish`);
    expect(live.status, JSON.stringify(live.json)).toBe(200);
    // The template moves on (still v3), so the copy is behind and a merge is tried.
    const next = testBundle();
    next.definition.instructions = "Change records only when asked, and say what changed.";
    const tv2 = await H.call(OPERATOR, "POST", `/api/ops/agents/${tid}/versions`, {
      bundle: next,
      parentVersionId: j(tpl.json).version.id,
    });
    expect(tv2.status, JSON.stringify(tv2.json)).toBe(200);
    const tpub = await H.call(
      OPERATOR,
      "POST",
      `/api/ops/agents/${tid}/versions/${j(tv2.json).version.id}/publish`,
    );
    expect(tpub.status, JSON.stringify(tpub.json)).toBe(200);

    const diff = await H.call(OPERATOR, "GET", `/api/ops/agents/${id}/versions/${v2}/diff`);
    expect(diff.status, JSON.stringify(diff.json)).toBe(200);
    expect(j(diff.json).from).toMatchObject({ id: v1 });
    const against = await H.call(
      OPERATOR,
      "GET",
      `/api/ops/agents/${id}/versions/${v2}/diff?against=${v1}`,
    );
    expect(against.status, JSON.stringify(against.json)).toBe(200);
    const usedBy = await H.call(OPERATOR, "GET", `/api/ops/templates/${tid}/used-by`);
    expect(usedBy.status, JSON.stringify(usedBy.json)).toBe(200);
    expect(j(usedBy.json)).toMatchObject({
      templateLiveVersion: 2,
      agents: [{ agent: { id }, version: 2, baseVersion: 1, behind: 1 }],
    });
  });
});
