// R3 (docs/plan.md §1.86, §9): stored v4 processes run end to end in Node, through the API with the
// real agents runtime, the testkit connector and a fake WorkflowStep: an approval in mode `all`
// with two approvers (each signs their own item for the same change), an approval nobody answers
// that proceeds on a connection at `auto` in act mode (and refuses once the client tightened it),
// an urgent notice that waits for its "Seen", and a converted v3 workflow running exactly as before.

import { dbOversightStore } from "@countersign/agents";
import { TESTKIT_UPDATE_TOOL } from "@countersign/connectors";
import { bundleHash, processes, SkillDefinition } from "@countersign/core";
import {
  agent,
  agentVersion,
  connection,
  externalAction,
  inboxItem,
  run,
  stepRun,
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
  testBundle,
  user,
} from "./api.test-helper";
import { executeRun } from "./runs/execute";
import type { RunParams } from "./runs/instances";
import { cloudflareStepRunner } from "./runs/step-runner";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

const TIMEOUT = () =>
  Object.assign(new Error("Execution timed out after 1ms"), { name: "WorkflowTimeoutError" });

/** An agent-mode Library skill a v4 step customizes. */
const CHECK_SKILL = SkillDefinition.parse({
  schemaVersion: 1,
  id: "test.check-record",
  name: "Check a record",
  description: "Checks one record",
  category: "test",
  mode: "agent",
  instructions: "Check the record you are given.",
  tools: [],
  input: { type: "object" },
  output: { type: "object", properties: { ok: { type: "boolean" } } },
  settings: [],
});

const h = await createApiHarness({ skills: [CHECK_SKILL] });
afterAll(() => h?.close());

describe.skipIf(!h)("v4 processes in apps/api", () => {
  const H = h as ApiHarness;
  let agentId = "";
  let v3Version = "";
  let model = new FakeModel();
  const deps = () => ({
    db: H.db,
    platform: H.platform,
    transport: model,
    instances: H.instances,
  });

  /** A new client version of the agent whose one workflow is `process`, as stored. */
  async function processVersion(
    process: unknown,
    options: { mode?: "act" | "suggest_only" } = {},
  ): Promise<string> {
    const bundle = testBundle();
    bundle.definition.permissions.mode = options.mode ?? "suggest_only";
    bundle.definition.skills = [{ skill: CHECK_SKILL.id, settings: {} }];
    const stored = {
      ...bundle,
      workflows: [{ slug: "fix-record", name: "Fix a record", workflow: process }],
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

  function params(versionId: string, payload: unknown = {}): RunParams {
    return {
      runId: crypto.randomUUID(),
      tenantId: H.A.tenantId,
      agentId,
      agentVersionId: versionId,
      workflowSlug: "fix-record",
      mode: "live",
      trigger: { type: "manual" },
      payload,
    } as RunParams;
  }

  /** The open item a wait of `type` waits on. */
  async function itemFor(type: string) {
    const items = await H.t.db.select().from(inboxItem).where(eq(inboxItem.status, "open"));
    return items.find((i) => inboxEventType(i.id) === type) ?? null;
  }

  /** Resolves the item a wait is for, through the portal, as whoever it is assigned to. */
  async function resolveAs(type: string, decide: (item: typeof inboxItem.$inferSelect) => unknown) {
    const item = await itemFor(type);
    if (!item) throw TIMEOUT();
    const answer = decide(item);
    if (answer === "timeout") throw TIMEOUT();
    const who = item.assigneeUserId === H.A.user ? user("a") : admin("a");
    const res = await H.call(who, "POST", `/api/inbox/${item.id}/resolve`, answer);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const sent = H.instances.events.find((e) => e.event.type === type);
    if (!sent) throw new Error(`no event ${type} was sent`);
    return sent.event.payload;
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
    v3Version = j(fork.json).version.id;
    await H.call(OPERATOR, "PATCH", `/api/ops/agents/${agentId}/operation`, {
      bindings: { testkit: H.A.connectionId },
    });
    const pub = await H.call(
      OPERATOR,
      "POST",
      `/api/ops/agents/${agentId}/versions/${v3Version}/publish`,
    );
    expect(pub.status, JSON.stringify(pub.json)).toBe(200);
    // Live and switched on: the go-live path itself is tested elsewhere (runs.test.ts).
    await H.t.db
      .update(agent)
      .set({ runStatus: "active", stage: "live", liveVersionId: v3Version })
      .where(eq(agent.id, agentId));
  });

  beforeEach(async () => {
    await setMatrix("approval");
    H.backend.writes.length = 0;
    H.instances.events.length = 0;
  });

  const writeStep = (approval: Record<string, unknown>) => ({
    id: "update",
    kind: "write",
    name: "Update the record",
    tool: TESTKIT_UPDATE_TOOL,
    input: { id: "r1", amount: "12.00" },
    checks: { approval },
  });
  const proc = (steps: unknown[]) => ({
    schemaVersion: 4,
    triggers: [{ id: "trg-manual", on: { type: "manual", input: {} } }],
    steps,
  });

  describe("an approval in mode `all` with two approvers", () => {
    const approval = () => ({
      mode: "all",
      approvers: [
        { who: H.A.admin, deadline: { after: "1 day" } },
        { who: H.A.user, deadline: { after: "1 day" } },
      ],
    });

    it("asks each on their own item for the same change, and writes once both said yes", async () => {
      const version = await processVersion(proc([writeStep(approval())]));
      const p = params(version);
      const seen: string[] = [];
      const step = new FakeWorkflowStep((_name, type) =>
        resolveAs(type, (item) => {
          seen.push(item.assigneeUserId ?? item.assigneeRole ?? "");
          return { decision: "approve" };
        }),
      );
      const result = await executeRun(deps(), p, cloudflareStepRunner(step));
      expect(result).toEqual({ status: "succeeded" });
      expect(H.backend.writes).toHaveLength(1);

      const [action] = await H.t.db
        .select()
        .from(externalAction)
        .where(eq(externalAction.runId, p.runId));
      expect(action?.status).toBe("done");
      expect([H.A.admin, H.A.user]).toContain(action?.approvedBy);
      // Two cards for the one change: the gate's for the first approver, one more for the second.
      const items = await H.t.db
        .select()
        .from(inboxItem)
        .where(and(eq(inboxItem.runId, p.runId), eq(inboxItem.kind, "external_action")));
      expect(items).toHaveLength(2);
      expect(items.map((i) => i.assigneeUserId).sort()).toEqual([H.A.admin, H.A.user].sort());
      expect(items.every((i) => i.status === "resolved")).toBe(true);
      expect(items.every((i) => i.subjectId === action?.id)).toBe(true);
      expect(new Set(seen)).toEqual(new Set([H.A.admin, H.A.user]));
      // The client's portal shows the second card like the first (no cost, no prompts).
      const asUser = await H.call(user("a"), "GET", "/api/inbox?status=resolved");
      expect(j(asUser.json).items.some((i: { kind: string }) => i.kind === "external_action")).toBe(
        true,
      );
    });

    it("a no from either signer rejects the change and ends the run; nothing is written", async () => {
      const version = await processVersion(proc([writeStep(approval())]));
      const p = params(version);
      const step = new FakeWorkflowStep((_name, type) =>
        resolveAs(type, (item) => ({
          decision: item.assigneeUserId === H.A.user ? "reject" : "approve",
        })),
      );
      const result = await executeRun(deps(), p, cloudflareStepRunner(step));
      expect(result).toMatchObject({ status: "cancelled", reason: "rejected", nodeId: "update" });
      expect(H.backend.writes).toHaveLength(0);
      const [action] = await H.t.db
        .select()
        .from(externalAction)
        .where(eq(externalAction.runId, p.runId));
      expect(action?.status).not.toBe("done");
      expect(action?.status).not.toBe("approved");
    });

    it("refuses an edit once two people sign: nothing is written on a signature for another input", async () => {
      const version = await processVersion(proc([writeStep(approval())]));
      const p = params(version);
      const tried: number[] = [];
      const userCard = async () => {
        const [row] = await H.t.db
          .select()
          .from(inboxItem)
          .where(
            and(
              eq(inboxItem.runId, p.runId),
              eq(inboxItem.kind, "external_action"),
              eq(inboxItem.assigneeUserId, H.A.user),
            ),
          );
        return row ?? null;
      };
      const step = new FakeWorkflowStep(async (_name, type) => {
        const item = await itemFor(type);
        if (!item) {
          // Answered already (the user's, below): its event was sent then.
          const sent = H.instances.events.find((e) => e.event.type === type);
          if (sent) return sent.event.payload;
          throw TIMEOUT();
        }
        if (item.assigneeUserId === H.A.admin) {
          // The user says yes first; then the admin tries to change the amount on their card.
          const theirs = await userCard();
          if (theirs?.status === "open") {
            const yes = await H.call(user("a"), "POST", `/api/inbox/${theirs.id}/resolve`, {
              decision: "approve",
            });
            expect(yes.status, JSON.stringify(yes.json)).toBe(200);
          }
          const edit = await H.call(admin("a"), "PUT", `/api/inbox/${item.id}/edit`, {
            input: { id: "r1", amount: "99.00" },
          });
          tried.push(edit.status);
          expect(j(edit.json).error).toMatchObject({ code: "invalid_state" });
          expect(j(edit.json).error.message).toMatch(/others are signing this change/);
        }
        return resolveAs(type, () => ({ decision: "approve" }));
      });
      const result = await executeRun(deps(), p, cloudflareStepRunner(step));
      expect(result).toEqual({ status: "succeeded" });
      expect(tried).toEqual([409]);
      // Written once, with the input both signed.
      expect(H.backend.writes.map((w) => w.record.amount)).toEqual(["12.00"]);
      const [action] = await H.t.db
        .select()
        .from(externalAction)
        .where(eq(externalAction.runId, p.runId));
      expect(action?.editedInput).toBeNull();
    });

    it("one yes leaves the change proposed while the other signer's card is open", async () => {
      const version = await processVersion(proc([writeStep(approval())]));
      const p = params(version);
      let checked = false;
      const step = new FakeWorkflowStep(async (_name, type) => {
        const item = await itemFor(type);
        if (item?.assigneeUserId === H.A.admin && !checked) {
          checked = true;
          const out = await resolveAs(type, () => ({ decision: "approve" }));
          const [action] = await H.t.db
            .select()
            .from(externalAction)
            .where(eq(externalAction.runId, p.runId));
          // Amy's yes alone never approves a change that needs both.
          expect(action?.status).toBe("proposed");
          return out;
        }
        throw TIMEOUT();
      });
      const result = await executeRun(deps(), p, cloudflareStepRunner(step));
      // The other never answered: `ifNoAnswer` stop, so not approved.
      expect(result).toMatchObject({ status: "cancelled", reason: "rejected" });
      expect(checked).toBe(true);
      expect(H.backend.writes).toHaveLength(0);
    });
  });

  describe("an approval nobody answers, with ifNoAnswer proceed", () => {
    const step = () =>
      writeStep({
        approvers: [{ who: H.A.admin, deadline: { after: "1 hour" } }],
        ifNoAnswer: "proceed",
      });

    it("goes ahead on a connection at auto in act mode, marked for a late answer", async () => {
      await setMatrix("auto");
      const version = await processVersion(proc([step()]), { mode: "act" });
      const p = params(version);
      const result = await executeRun(
        deps(),
        p,
        cloudflareStepRunner(
          new FakeWorkflowStep(async () => {
            throw TIMEOUT();
          }),
        ),
      );
      expect(result).toEqual({ status: "succeeded" });
      expect(H.backend.writes).toHaveLength(1);
      const [action] = await H.t.db
        .select()
        .from(externalAction)
        .where(eq(externalAction.runId, p.runId));
      // Approved by its deadline: nobody signed it.
      expect(action).toMatchObject({ status: "done", approvedBy: null });
      const [row] = await H.t.db
        .select()
        .from(stepRun)
        .where(and(eq(stepRun.runId, p.runId), eq(stepRun.nodeId, "update")));
      expect(row?.status).toBe("succeeded");
      const items = await H.t.db
        .select()
        .from(inboxItem)
        .where(and(eq(inboxItem.runId, p.runId), eq(inboxItem.kind, "external_action")));
      expect(row?.output).toMatchObject({
        proceededWithoutAnswer: true,
        externalActionId: action?.id,
        inboxItemIds: items.map((i) => i.id),
      });
      expect(items[0]?.status).toBe("expired");

      // The answer that comes late is recorded as late; the run, which went ahead, isn't told.
      const late = await H.call(admin("a"), "POST", `/api/inbox/${items[0]?.id}/resolve`, {
        decision: "approve",
      });
      expect(late.status, JSON.stringify(late.json)).toBe(200);
      const [after] = await H.t.db
        .select()
        .from(inboxItem)
        .where(eq(inboxItem.id, items[0]?.id ?? ""));
      expect(after?.resolution).toMatchObject({ late: { proceededWithoutAnswer: true } });
    });

    it("never goes ahead once the client set the verb back to approval", async () => {
      await setMatrix("approval");
      const version = await processVersion(proc([step()]), { mode: "act" });
      const p = params(version);
      const result = await executeRun(
        deps(),
        p,
        cloudflareStepRunner(
          new FakeWorkflowStep(async () => {
            throw TIMEOUT();
          }),
        ),
      );
      expect(result).toMatchObject({ status: "failed", nodeId: "update" });
      expect(result.reason).toMatch(/nobody answered in time/);
      expect(H.backend.writes).toHaveLength(0);
      const [action] = await H.t.db
        .select()
        .from(externalAction)
        .where(eq(externalAction.runId, p.runId));
      expect(action?.status).toBe("proposed");
    });

    it("never goes ahead for an agent that only suggests", async () => {
      await setMatrix("auto");
      const version = await processVersion(proc([step()]), { mode: "suggest_only" });
      const result = await executeRun(
        deps(),
        params(version),
        cloudflareStepRunner(
          new FakeWorkflowStep(async () => {
            throw TIMEOUT();
          }),
        ),
      );
      expect(result).toMatchObject({ status: "failed", nodeId: "update" });
      expect(H.backend.writes).toHaveLength(0);
    });
  });

  describe("an urgent notice", () => {
    const notice = () =>
      proc([
        {
          id: "warn",
          kind: "notify",
          name: "Warn the admin",
          notify: {
            to: [H.A.admin],
            channel: "sms",
            message: "The record {{trigger.id}} changed",
            urgent: { ackWithin: "15 minutes" },
          },
        },
      ]);

    it("opens a Seen card for its first recipient, and the run waits for it", async () => {
      const version = await processVersion(notice());
      const p = params(version, { id: "r1" });
      const waited: string[] = [];
      const step = new FakeWorkflowStep(async (name, type) => {
        waited.push(name);
        const item = await itemFor(type);
        expect(item).toMatchObject({
          kind: "request",
          assigneeUserId: H.A.admin,
          title: "The record r1 changed",
        });
        expect(item?.dueAt).not.toBeNull();
        return resolveAs(type, () => ({ answer: "Seen" }));
      });
      const result = await executeRun(deps(), p, cloudflareStepRunner(step));
      expect(result).toEqual({ status: "succeeded" });
      expect(waited).toEqual(["warn:seen:wait"]);
    });

    it("stops the run when nobody says Seen in time", async () => {
      const version = await processVersion(notice());
      const p = params(version, { id: "r1" });
      const result = await executeRun(
        deps(),
        p,
        cloudflareStepRunner(
          new FakeWorkflowStep(async () => {
            throw TIMEOUT();
          }),
        ),
      );
      expect(result).toMatchObject({ status: "failed", reason: "not_seen", nodeId: "warn" });
      const [item] = await H.t.db
        .select()
        .from(inboxItem)
        .where(and(eq(inboxItem.runId, p.runId), eq(inboxItem.kind, "request")));
      expect(item?.status).toBe("expired");
    });
  });

  describe("a deadline's tell", () => {
    it("tells each person and role it names, the operator as before", async () => {
      const version = await processVersion(
        proc([
          {
            id: "ask",
            kind: "person",
            name: "Ask",
            mode: "approve",
            assignee: H.A.admin,
            title: "Is it right?",
            deadline: { after: "1 day", tell: ["operator", "client_user"] },
          },
        ]),
      );
      const p = params(version);
      const result = await executeRun(
        deps(),
        p,
        cloudflareStepRunner(
          new FakeWorkflowStep(async () => {
            throw TIMEOUT();
          }),
        ),
      );
      expect(result).toMatchObject({ status: "failed", reason: "timeout" });
      const told = await H.t.db
        .select()
        .from(inboxItem)
        .where(and(eq(inboxItem.runId, p.runId), eq(inboxItem.kind, "review")));
      expect(told.map((i) => i.assigneeRole).sort()).toEqual(["client_user", "operator"]);
    });
  });

  describe("a skill step's customization", () => {
    it("reaches the skill's run: the added instructions after the skill's own", async () => {
      const version = await processVersion(
        proc([
          {
            id: "check",
            kind: "skill",
            name: "Check the record",
            skill: CHECK_SKILL.id,
            input: { id: "r1" },
            customize: { addInstructions: "Also check that the amount is in dollars." },
          },
        ]),
      );
      model = new FakeModel([{ toolUse: { name: "finish", input: { ok: true } } }]);
      const result = await executeRun(
        deps(),
        params(version),
        cloudflareStepRunner(new FakeWorkflowStep()),
      );
      expect(result).toEqual({ status: "succeeded" });
      const system = String(model.requests[0]?.system);
      expect(system).toContain("Check the record you are given.");
      expect(system).toContain("Also check that the amount is in dollars.");
      expect(system.indexOf("Check the record you are given.")).toBeLessThan(
        system.indexOf("Also check that the amount is in dollars."),
      );
    });
  });

  describe("a converted v3 workflow", () => {
    it("runs exactly as before: one card, the stored approver, no owner history step", async () => {
      const p = params(v3Version);
      const step = new FakeWorkflowStep((_name, type) =>
        resolveAs(type, () => ({ decision: "approve" })),
      );
      const result = await executeRun(deps(), p, cloudflareStepRunner(step));
      expect(result).toEqual({ status: "succeeded" });
      expect(H.backend.writes).toHaveLength(1);
      const items = await H.t.db.select().from(inboxItem).where(eq(inboxItem.runId, p.runId));
      expect(items.map((i) => i.kind).sort()).toEqual(["approval", "external_action"]);
      const [action] = await H.t.db
        .select()
        .from(externalAction)
        .where(eq(externalAction.runId, p.runId));
      expect(action).toMatchObject({ status: "done", approvedBy: H.A.admin });
      const steps = await H.t.db.select().from(stepRun).where(eq(stepRun.runId, p.runId));
      expect(Object.fromEntries(steps.map((s) => [s.nodeId, [s.nodeType, s.status]]))).toEqual({
        update: ["action", "succeeded"],
        confirm: ["person", "succeeded"],
        internal: ["notify", "succeeded"],
      });
      // No marker on a write somebody signed, and no durable step a v3 run didn't have.
      expect(steps.find((s) => s.nodeId === "update")?.output).not.toHaveProperty(
        "proceededWithoutAnswer",
      );
      expect([...step.results.keys()].some((k) => k.includes("owner-history"))).toBe(false);
      const [r] = await H.t.db.select().from(run).where(eq(run.id, p.runId));
      expect(r?.status).toBe("succeeded");
    });
  });

  it("the owner's watch reads this agent's earlier live outputs, newest first, this client only", async () => {
    const rows = await dbOversightStore(H.db).recentOutputs?.(H.A.tenantId, {
      agentId,
      workflowSlug: "fix-record",
      limit: 50,
    });
    expect(rows?.length).toBeGreaterThan(0);
    expect(rows?.some((r) => r.nodeId === "update")).toBe(true);
    expect(
      await dbOversightStore(H.db).recentOutputs?.(H.B.tenantId, {
        agentId,
        workflowSlug: "fix-record",
        limit: 50,
      }),
    ).toEqual([]);
  });

  it("reads a stored process as v4 (the converter's view is only for v3)", () => {
    expect(processes.Process.safeParse(proc([writeStep({})])).success).toBe(true);
  });
});
