// Wave 5 (docs/plan.md §1.86 "Forks (wave 5)"), the re-review's N4: the ports a fork on a failure
// or an answer reads, against a real database as cs_worker. `stepWrites` (whether a failed write's
// external actions say it was made), `dbCarriedActions` (`carriedOn`, from where each run ended),
// and a retry's `resumeOf` reading real `step_run` and `inbox_item` rows (who answered, the item's
// step and node) so an `if` routes in the retry as it did in the run retried. Fix 3: a model-mode
// skill's carried write, read by `stepWrites` through this run's tool calls.

import { dbCarriedActions, getVersion, parseVersionBundle, publish } from "@countersign/agents";
import { TESTKIT_UPDATE_TOOL } from "@countersign/connectors";
import { bundleHash, processes } from "@countersign/core";
import {
  agent,
  agentVersion,
  connection,
  externalAction,
  inboxItem,
  stepRun,
  toolCall,
  withOperator,
} from "@countersign/db";
import { FakeModel } from "@countersign/llm";
import { inboxEventType } from "@countersign/workflows";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  type ApiHarness,
  admin,
  createApiHarness,
  FakeWorkflowStep,
  OPERATOR,
  storedSkill,
  testBundle,
} from "./api.test-helper";
import { executeRun } from "./runs/execute";
import type { RunParams } from "./runs/instances";
import { cloudflareStepRunner } from "./runs/step-runner";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

const TIMEOUT = () =>
  Object.assign(new Error("Execution timed out after 1ms"), { name: "WorkflowTimeoutError" });

const h = await createApiHarness();
afterAll(() => h?.close());

describe.skipIf(!h)("forks on a failure or an answer, against the database", () => {
  const H = h as ApiHarness;
  let agentId = "";
  const deps = (transport = new FakeModel()) => ({
    db: H.db,
    platform: H.platform,
    transport,
    instances: H.instances,
  });

  /** A new client version of the agent whose one workflow is `steps`, as stored. */
  async function processVersion(
    steps: unknown[],
    mode: "act" | "suggest_only",
    skills: string[] = [],
  ): Promise<string> {
    const bundle = testBundle();
    bundle.definition.permissions.mode = mode;
    for (const skill of skills) bundle.definition.skills.push({ skill, settings: {} });
    const stored = {
      ...bundle,
      workflows: [
        {
          slug: "fix-record",
          name: "Fix a record",
          workflow: {
            schemaVersion: 4,
            triggers: [{ id: "trg-manual", on: { type: "manual", input: {} } }],
            steps,
          },
        },
      ],
    };
    const versions = await H.t.db
      .select({ version: agentVersion.version })
      .from(agentVersion)
      .where(eq(agentVersion.agentId, agentId));
    const next = Math.max(0, ...versions.map((v) => v.version)) + 1;
    const [row] = await H.t.db
      .insert(agentVersion)
      .values({
        tenantId: H.A.tenantId,
        agentId,
        version: next,
        // biome-ignore lint/suspicious/noExplicitAny: a v4 process is stored as written.
        bundle: stored as any,
        bundleHash: await bundleHash(stored),
        authorType: "operator",
      })
      .returning({ id: agentVersion.id });
    if (!row) throw new Error("no version");
    return row.id;
  }

  function params(versionId: string): RunParams {
    return {
      runId: crypto.randomUUID(),
      tenantId: H.A.tenantId,
      agentId,
      agentVersionId: versionId,
      workflowSlug: "fix-record",
      mode: "live",
      trigger: { type: "manual" },
      payload: {},
    } as RunParams;
  }

  /** The retry the API starts for a failed run, from the step it failed in. */
  async function retry(runId: string) {
    const res = await H.call(OPERATOR, "POST", `/api/ops/runs/${runId}/retry`);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const p = H.instances.started.get(j(res.json).runId as string);
    if (!p) throw new Error("the retry was not started");
    return { params: p, resumeFrom: j(res.json).resumeFrom as string | null };
  }

  async function setMatrix(update: "auto" | "approval") {
    await H.t.db
      .update(connection)
      .set({
        status: "connected",
        permissions: { read: "auto", create: "approval", update, delete: "off" },
      })
      .where(eq(connection.id, H.A.connectionId));
  }

  const rows = (runId: string) => H.t.db.select().from(stepRun).where(eq(stepRun.runId, runId));
  const actions = (runId: string) =>
    H.t.db.select().from(externalAction).where(eq(externalAction.runId, runId));
  const carried = (retryOf: string, nodeId: string) =>
    dbCarriedActions(H.db).candidates(H.A.tenantId, { retryOf, nodeId });
  const noWaits = () =>
    cloudflareStepRunner(
      new FakeWorkflowStep(async () => {
        throw new Error("this run should wait on nobody");
      }),
    );

  /** A write the connection lets run unsigned (matrix `auto`, act mode, `not_required`). */
  const write = (id: string, record: string, more: Record<string, unknown> = {}) => ({
    id,
    kind: "write",
    name: `Update ${record}`,
    tool: TESTKIT_UPDATE_TOOL,
    input: { id: record, amount: "12.00" },
    checks: { approval: { required: "not_required" } },
    ...more,
  });
  const onFailed = (stepId: string, steps: unknown[]) => ({
    id: "route",
    kind: "if",
    name: "If it failed",
    paths: [
      {
        id: "yes",
        name: "Failed",
        when: {
          match: "all",
          rules: [{ field: `{{steps.${stepId}.outcome}}`, op: "=", value: "failed" }],
        },
        steps,
      },
    ],
    otherwise: { id: "no", steps: [] },
  });

  beforeAll(async () => {
    const tpl = await H.call(OPERATOR, "POST", "/api/ops/templates", {
      slug: "records-clerk",
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
    agentId = j(fork.json).agent.id;
    const v1 = j(fork.json).version.id;
    await H.call(OPERATOR, "PATCH", `/api/ops/agents/${agentId}/operation`, {
      bindings: { testkit: H.A.connectionId },
    });
    const pub = await H.call(OPERATOR, "POST", `/api/ops/agents/${agentId}/versions/${v1}/publish`);
    expect(pub.status, JSON.stringify(pub.json)).toBe(200);
    // Live and switched on: the go-live path itself is tested elsewhere (runs.test.ts).
    await H.t.db
      .update(agent)
      .set({ runStatus: "active", stage: "live", liveVersionId: v1 })
      .where(eq(agent.id, agentId));
  });

  beforeEach(async () => {
    await setMatrix("auto");
    H.backend.writes.length = 0;
    H.instances.events.length = 0;
    const company = H.backend.company(H.A.connectionId);
    company.clear();
    H.backend.seed(H.A.connectionId, [{ id: "r1", name: "Oak board", amount: "10.00" }]);
  });

  it("goes on past a write that failed before sending; a retry from later reuses it and proposes nothing", async () => {
    // `update` names a record the provider doesn't have: it says no and writes nothing. The
    // route's `later` fails too (its record is missing), so the run fails there.
    const version = await processVersion(
      [
        write("update", "gone", { onError: "continue" }),
        onFailed("update", [write("later", "r2")]),
      ],
      "act",
    );
    const first = params(version);
    const result = await executeRun(deps(), first, noWaits());
    expect(result).toMatchObject({ status: "failed", nodeId: "later" });
    // `stepWrites` read the update's action as not written: the run went on to its route.
    const [update] = await actions(first.runId).then((a) =>
      a.filter((x) => x.idempotencyKey === `${first.runId}:update:0`),
    );
    expect(update).toMatchObject({ status: "failed", error: { notWritten: true } });
    const firstRows = await rows(first.runId);
    expect(firstRows.find((r) => r.nodeId === "update")?.status).toBe("failed");
    expect(firstRows.find((r) => r.nodeId === "route")?.output).toMatchObject({ pathId: "yes" });
    // The run ended at `later`, not at `update`: the update's failure was gone on past.
    expect(await carried(first.runId, "update")).toEqual([
      expect.objectContaining({ id: update?.id, carriedOn: true }),
    ]);
    expect(await carried(first.runId, "later")).toEqual([
      expect.objectContaining({ carriedOn: false }),
    ]);

    H.backend.seed(H.A.connectionId, [{ id: "r2", name: "Pine board", amount: "4.00" }]);
    const again = await retry(first.runId);
    expect(again.resumeFrom).toBe("route");
    const second = await executeRun(deps(), again.params, noWaits());
    expect(second).toEqual({ status: "succeeded" });
    // The update was reused as it failed, never run again: the retry proposed nothing of its
    // own, and the route took the same path, where `later` made its write once, under its key.
    expect(await actions(again.params.runId)).toEqual([]);
    const secondRows = await rows(again.params.runId);
    expect(secondRows.find((r) => r.nodeId === "update")).toMatchObject({ status: "failed" });
    expect(secondRows.find((r) => r.nodeId === "route")?.output).toMatchObject({ pathId: "yes" });
    expect(H.backend.writes.map((w) => [w.record.id, w.idempotencyKey])).toEqual([
      ["r2", `${first.runId}:later:0`],
    ]);
  });

  it("ends the run at a write that failed after sending, and a retry whose carried write fails so too", async () => {
    // The provider took the request and answered with an error: the write may be there.
    const update = H.backend.update.bind(H.backend);
    H.backend.update = () => {
      throw new Error("HTTP 502 from the provider");
    };
    try {
      const version = await processVersion(
        [
          {
            id: "look",
            kind: "read",
            name: "Look",
            tool: "testkit.record.query",
            input: { ids: ["r1"] },
          },
          write("update", "r1", { onError: "continue" }),
          onFailed("update", []),
        ],
        "act",
      );
      const first = params(version);
      const result = await executeRun(deps(), first, noWaits());
      expect(result).toMatchObject({ status: "failed", nodeId: "update" });
      const [action] = await actions(first.runId);
      expect(action?.status).toBe("failed");
      expect(action?.error).not.toMatchObject({ notWritten: true });
      expect((await rows(first.runId)).some((r) => r.nodeId === "route")).toBe(false);
      // The run ended at the write: a retry may carry it.
      expect(await carried(first.runId, "update")).toEqual([
        expect.objectContaining({ id: action?.id, carriedOn: false }),
      ]);

      // The retry carries the write (the system approved it, the gate would still run it) and
      // it fails after sending again, on the first run's action: still never gone on past.
      const again = await retry(first.runId);
      expect(again.resumeFrom).toBe("update");
      const second = await executeRun(deps(), again.params, noWaits());
      expect(second).toMatchObject({ status: "failed", nodeId: "update" });
      expect(processes.writeMayHaveHappened(second.reason ?? "")).toBe(true);
      expect(await actions(again.params.runId)).toEqual([]);
      expect((await rows(again.params.runId)).some((r) => r.nodeId === "route")).toBe(false);
      expect(H.backend.writes).toEqual([]);
    } finally {
      H.backend.update = update;
    }
  });

  it("ends a retry at a model skill that asked for help after its carried write failed after sending", async () => {
    // A model-mode skill that pays: it makes the write itself, then asks for help, and nobody
    // answers. The route goes on past `failed` or `needs_help`.
    // Skill model (2026-11-10): a new agent-mode skill is refused; this one was stored before,
    // and a stored version keeps running (invariant 3).
    await storedSkill(H, {
      schemaVersion: 1,
      id: "custom:pay-vendor",
      name: "Pay vendor",
      description: "Pays the vendor's record",
      category: "writing",
      mode: "agent",
      instructions: "Update the record to pay it.",
      tools: [TESTKIT_UPDATE_TOOL],
      input: { type: "object", properties: { id: { type: "string" } } },
      output: {
        type: "object",
        properties: { paid: { type: "boolean" }, needsHelp: { type: "object" } },
      },
    });
    const update = H.backend.update.bind(H.backend);
    H.backend.update = () => {
      throw new Error("HTTP 502 from the provider");
    };
    /** The model pays the record, sees the write fail, and asks for help. */
    const model = () =>
      new FakeModel().push(
        {
          toolUse: {
            name: TESTKIT_UPDATE_TOOL.replaceAll(".", "__"),
            input: { id: "r1", amount: "12.00" },
          },
        },
        {
          toolUse: {
            name: "finish",
            input: { needsHelp: { question: "Did the payment go out?", tried: ["paid it"] } },
          },
        },
      );
    try {
      const version = await processVersion(
        [
          {
            id: "pay",
            kind: "skill",
            name: "Pay vendor",
            skill: "custom:pay-vendor",
            input: { id: "r1" },
            onError: "continue",
            checks: { approval: { required: "not_required" } },
          },
          {
            id: "route",
            kind: "if",
            name: "If it didn't pay",
            paths: [
              {
                id: "yes",
                name: "Didn't pay",
                when: {
                  match: "any",
                  rules: [
                    { field: "{{steps.pay.outcome}}", op: "=", value: "failed" },
                    { field: "{{steps.pay.outcome}}", op: "=", value: "needs_help" },
                  ],
                },
                steps: [],
              },
            ],
            otherwise: { id: "no", steps: [] },
          },
        ],
        "act",
        ["custom:pay-vendor"],
      );
      // Publishing copies the shared skill into the client, where its runs read it. The version
      // stands for one published before the skill model: its steps are already there (review: a
      // version never published is new work, so the API's publish would refuse its step).
      await withOperator(H.db, [H.A.tenantId], async (tx) =>
        publish(tx, {
          agentId,
          versionId: version,
          ctx: H.platform.ctx,
          existingFrom: parseVersionBundle((await getVersion(tx, version)).bundle),
        }),
      );
      // Nobody answers the request for help (the default wait times out).
      const first = params(version);
      const result = await executeRun(
        deps(model()),
        first,
        cloudflareStepRunner(new FakeWorkflowStep()),
      );
      expect(result).toMatchObject({ status: "failed", nodeId: "pay" });
      const [action] = await actions(first.runId);
      expect(action).toMatchObject({ status: "failed", idempotencyKey: `${first.runId}:pay:0` });
      expect(action?.error).not.toMatchObject({ notWritten: true });
      expect((await rows(first.runId)).some((r) => r.nodeId === "route")).toBe(false);

      // The retry's model makes the same write: the first run's action is carried, and fails
      // after sending again. The skill asks for help, nobody answers: the run still ends there.
      const again = await retry(first.runId);
      expect(again.resumeFrom).toBe("pay");
      const second = await executeRun(
        deps(model()),
        again.params,
        cloudflareStepRunner(new FakeWorkflowStep()),
      );
      expect(second).toMatchObject({ status: "failed", nodeId: "pay" });
      expect(await actions(again.params.runId)).toEqual([]);
      const calls = await H.t.db
        .select({ actionId: toolCall.externalActionId, status: toolCall.status })
        .from(toolCall)
        .innerJoin(stepRun, eq(stepRun.id, toolCall.stepRunId))
        .where(eq(stepRun.runId, again.params.runId));
      expect(calls).toEqual([{ actionId: action?.id, status: "failed" }]);
      expect((await rows(again.params.runId)).some((r) => r.nodeId === "route")).toBe(false);
      expect(H.backend.writes).toEqual([]);
    } finally {
      H.backend.update = update;
    }
  });

  it("routes a retry as the run retried did on a quick answer and a rejection", async () => {
    await setMatrix("approval");
    // `ask` gets "Drop it", `fix` is rejected and the run goes on; the if routes on both, and on
    // who rejected it, to `boom`, which is signed and fails (its record is missing).
    const version = await processVersion(
      [
        {
          id: "ask",
          kind: "person",
          name: "Ask",
          mode: "ask",
          assignee: "client_admin",
          title: "Keep the record?",
          deadline: { after: "1 day" },
          choices: [
            { value: "keep", label: "Keep it" },
            { value: "drop", label: "Drop it" },
          ],
        },
        {
          id: "fix",
          kind: "write",
          name: "Fix",
          tool: TESTKIT_UPDATE_TOOL,
          input: { id: "r1", amount: "1.00" },
          checks: { approval: { onReject: "continue" } },
        },
        {
          id: "route",
          kind: "if",
          name: "If dropped and turned down",
          paths: [
            {
              id: "yes",
              name: "Dropped",
              when: {
                match: "all",
                rules: [
                  { field: "{{steps.ask.choice}}", op: "=", value: "drop" },
                  { field: "{{steps.ask.outcome}}", op: "=", value: "answered" },
                  { field: "{{steps.fix.outcome}}", op: "=", value: "rejected" },
                  { field: "{{steps.fix.approval.outcome}}", op: "=", value: "rejected" },
                  { field: "{{steps.fix.approval.by}}", op: "=", value: H.A.admin },
                ],
              },
              steps: [
                {
                  id: "boom",
                  kind: "write",
                  name: "Boom",
                  tool: TESTKIT_UPDATE_TOOL,
                  input: { id: "r3", amount: "3.00" },
                },
              ],
            },
          ],
          otherwise: { id: "no", steps: [] },
        },
      ],
      "suggest_only",
    );
    const answered: string[] = [];
    const step = new FakeWorkflowStep(async (_name, type) => {
      const items = await H.t.db.select().from(inboxItem).where(eq(inboxItem.status, "open"));
      const item = items.find((i) => inboxEventType(i.id) === type);
      if (!item) throw TIMEOUT();
      let body: Record<string, unknown> = { answer: "drop" };
      if (item.kind === "external_action") {
        const [action] = await H.t.db
          .select()
          .from(externalAction)
          .where(eq(externalAction.id, item.subjectId ?? ""));
        const node = action?.idempotencyKey.split(":")[1] ?? "";
        body = { decision: node === "fix" ? "reject" : "approve" };
        answered.push(`${node}:${body.decision}`);
      } else answered.push(`ask:${body.answer}`);
      const res = await H.call(admin("a"), "POST", `/api/inbox/${item.id}/resolve`, body);
      expect(res.status, JSON.stringify(res.json)).toBe(200);
      const sent = H.instances.events.find((e) => e.event.type === type);
      if (!sent) throw new Error(`no event ${type} was sent`);
      return sent.event.payload;
    });
    const first = params(version);
    const result = await executeRun(deps(), first, cloudflareStepRunner(step));
    expect(result).toMatchObject({ status: "failed", nodeId: "boom" });
    expect(answered).toEqual(["ask:drop", "fix:reject", "boom:approve"]);
    expect((await rows(first.runId)).find((r) => r.nodeId === "route")?.output).toMatchObject({
      pathId: "yes",
    });
    // What the retry reads: the items' own shapes, as the portal left them (a question names its
    // step as `nodeId`, a change's card as `stepId`), each with who answered it.
    const items = await H.t.db.select().from(inboxItem).where(eq(inboxItem.runId, first.runId));
    const answers = items
      .filter((i) => i.kind !== "review")
      .map((i) => {
        const payload = i.payload as { nodeId?: string; stepId?: string };
        return [i.kind, payload.nodeId ?? payload.stepId, i.status, i.resolvedBy];
      });
    expect(answers.sort()).toEqual(
      [
        ["external_action", "boom", "resolved", H.A.admin],
        ["external_action", "fix", "resolved", H.A.admin],
        ["request", "ask", "resolved", H.A.admin],
      ].sort(),
    );

    H.backend.seed(H.A.connectionId, [{ id: "r3", name: "Ash board", amount: "2.00" }]);
    const again = await retry(first.runId);
    expect(again.resumeFrom).toBe("route");
    const second = await executeRun(deps(), again.params, noWaits());
    expect(second).toEqual({ status: "succeeded" });
    // The if read the quick answer, the rejection and who made it back from the rows and items:
    // it took the same path, and `boom` made its signed write once, under its first key.
    const secondRows = await rows(again.params.runId);
    expect(secondRows.find((r) => r.nodeId === "route")?.output).toMatchObject({ pathId: "yes" });
    expect(secondRows.find((r) => r.nodeId === "ask")?.status).toBe("succeeded");
    expect(secondRows.find((r) => r.nodeId === "fix")?.status).toBe("skipped");
    expect(H.backend.writes.map((w) => [w.record.id, w.idempotencyKey])).toEqual([
      ["r3", `${first.runId}:boom:0`],
    ]);
    expect(await actions(again.params.runId)).toEqual([]);
    const fixed = await H.t.db
      .select()
      .from(externalAction)
      .where(
        and(
          eq(externalAction.runId, first.runId),
          eq(externalAction.idempotencyKey, `${first.runId}:fix:0`),
        ),
      );
    expect(fixed[0]?.status).toBe("rejected");
  });
});
