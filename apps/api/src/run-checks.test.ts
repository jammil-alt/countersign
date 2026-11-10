// R8 (docs/plan.md §1.86; ARCHITECTURE §10.14 "Checks"): a v4 process's run on the client's
// timeline, over a throwaway database: a write's confers as steps of their own (a second check's
// words never reach the portal), its approvers in the check's mode with their names, the write that
// went ahead with nobody answering, and an urgent notice waiting for its "Seen".

import { TESTKIT_UPDATE_TOOL } from "@countersign/connectors";
import {
  type AnyAgentBundle,
  type processes,
  shownOnTimeline,
  toProcessBundle,
} from "@countersign/core";
import { agent, agentVersion, inboxItem, run, stepRun } from "@countersign/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { admin, createApiHarness, OPERATOR, testBundle } from "./api.test-helper";
import { stepFinder, stepOfRow } from "./routes/run-checks";

const h = await createApiHarness();
afterAll(() => h?.close());

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

/** The test bundle as a v4 process: its write with a confer and an `any` approval; a notice. */
function bundleV4(dana: string): AnyAgentBundle {
  const b = toProcessBundle(testBundle(), {
    wrappedTool: () => null,
    sideEffect: (t) => (t === TESTKIT_UPDATE_TOOL ? "external" : null),
  });
  const p = b.workflows[0]?.workflow as processes.Process;
  const update = p.steps.find((s) => s.id === "update");
  if (update?.kind !== "write") throw new Error("fixture");
  update.checks = {
    confer: {
      with: [
        { ai: { focus: "Do the amounts add up?" } },
        {
          person: dana,
          deadline: { after: "1 day", hours: "business", ifNoAnswer: "stop" },
        },
      ],
    },
    approval: {
      required: "required",
      mode: "any",
      approvers: [{ who: "client_admin" }, { who: dana }],
      ifNoAnswer: "stop",
      onReject: "stop",
    },
  };
  p.steps.push({
    id: "tell",
    name: "Tell the team",
    kind: "notify",
    notify: {
      to: ["client_admin"],
      channel: "inbox",
      message: "Done",
      urgent: { ackWithin: "1 hour", ifNoAnswer: "stop" },
    },
  });
  // Wave 5 (web): a read that carries on when it fails, and an if the client sees, routed on how
  // the write and the read ended.
  p.steps.push({
    id: "look",
    name: "Look the record up",
    kind: "read",
    tool: "testkit.record.query",
    input: {},
    onError: "continue",
  });
  p.steps.push({
    id: "route",
    name: "Which way",
    kind: "if",
    client: { visible: true, label: "Pick the way" },
    paths: [
      {
        id: "p-done",
        name: "Corrected",
        when: {
          match: "all",
          rules: [
            { field: "{{steps.update.outcome}}", op: "=", value: "done" },
            { field: "{{steps.look.outcome}}", op: "=", value: "failed" },
          ],
        },
        steps: [],
      },
    ],
    otherwise: { id: "p-else", steps: [] },
  });
  return b;
}

describe("v4 steps on the timeline", () => {
  it("finds steps in either schema and shows v4 work by default", () => {
    const b = bundleV4("00000000-0000-4000-8000-000000000d01");
    const find = stepFinder(b.workflows[0]?.workflow);
    expect(stepOfRow(find, "update:confer:1")?.id).toBe("update");
    expect(stepOfRow(find, "tell")?.kind).toBe("notify");
    const write = find("update");
    expect(write && shownOnTimeline(write)).toBe(true);
    expect(shownOnTimeline({ kind: "wait" })).toBe(false);
    expect(shownOnTimeline({ kind: "read", client: { visible: false } })).toBe(false);
  });
});

describe.skipIf(!h)("a v4 run's checks in the portal", () => {
  const H = h as NonNullable<typeof h>;
  const db = H.t.db;
  const A = () => H.A.tenantId;
  let runId = "";

  beforeAll(async () => {
    const dana = H.A.user;
    const [a] = await db
      .insert(agent)
      .values({
        tenantId: A(),
        kind: "client",
        slug: "records-v4",
        name: "Records clerk",
        runStatus: "active",
        stage: "live",
      })
      .returning();
    if (!a) throw new Error("no agent");
    const [v] = await db
      .insert(agentVersion)
      .values({
        tenantId: A(),
        agentId: a.id,
        version: 1,
        bundle: bundleV4(dana) as never,
        bundleHash: "hash-v4-checks",
        status: "live",
        authorType: "operator",
      })
      .returning();
    if (!v) throw new Error("no version");
    const [r] = await db
      .insert(run)
      .values({
        tenantId: A(),
        agentId: a.id,
        agentVersionId: v.id,
        workflowSlug: "fix-record",
        mode: "live",
        status: "running",
        trigger: { type: "manual" },
        startedAt: new Date(),
      })
      .returning();
    if (!r) throw new Error("no run");
    runId = r.id;
    const at = (m: number) => new Date(Date.UTC(2026, 10, 10, 10, m));
    const row = (nodeId: string, nodeType: string, m: number, more: Record<string, unknown>) => ({
      tenantId: A(),
      runId,
      nodeId,
      nodeType,
      status: "succeeded" as const,
      startedAt: at(m),
      finishedAt: at(m),
      ...more,
    });
    await db.insert(stepRun).values([
      row("update:confer:0", "confer", 1, {
        input: { reviewer: "ai" },
        output: { verdict: "agree", note: "The lines add up to the total.", by: "ai" },
        summary: "A second check: agree",
      }),
      row("update:confer:1", "confer", 2, {
        input: { reviewer: dana },
        output: { verdict: "disagree", note: "Freight is missing", by: dana },
        summary: `Checked by ${dana}: disagree`,
      }),
      row("update", "write", 3, {
        output: { proceededWithoutAnswer: true, inboxItemIds: [] },
        summary: "Corrected the record",
      }),
      row("tell", "notify", 4, {
        output: { urgent: { dueAt: at(64).toISOString() } },
        summary: "Tell the team: sent",
      }),
      row("look", "read", 5, {
        status: "failed",
        error: "The record service didn't answer",
        summary: "Look the record up: failed",
      }),
      row("route", "if", 6, {
        output: { pathId: "p-done", pathName: "Corrected" },
        summary: "Pick the way: Corrected",
      }),
    ]);
    const item = (nodeId: string, m: number, more: Record<string, unknown>) => ({
      tenantId: A(),
      kind: "approval" as const,
      runId,
      agentId: a.id,
      title: "Correct the record?",
      payload: { nodeId },
      status: "expired" as const,
      createdAt: at(m),
      ...more,
    });
    await db.insert(inboxItem).values([
      item("update:approval:1", 3, { assigneeRole: "client_admin" }),
      item("update:approval:1:a1", 3, { assigneeUserId: dana }),
      item("tell", 4, {
        kind: "review",
        status: "open",
        assigneeRole: "client_admin",
        payload: { nodeId: "tell", urgent: { dueAt: at(64).toISOString() } },
      }),
    ]);
  });

  it("shows confers as steps, approvers in the mode, the no-answer outcome and the Seen", async () => {
    const res = await H.call(admin("a"), "GET", `/api/runs/${runId}`);
    expect(res.status).toBe(200);
    const steps = j(res.json).steps as Record<string, unknown>[];
    const byNode = (label: string) => steps.find((s) => s.label === label && !s.confer);
    // The two confers come first, as their own steps, then the write and the notice.
    expect(steps.map((s) => (s.confer ? `confer:${j(s.confer).reviewer}` : s.label))).toEqual([
      "confer:ai",
      "confer:person",
      "Corrected the record",
      "Tell the team",
      "Look the record up",
      "Pick the way",
    ]);
    const [ai, person] = steps;
    // A second check's words are a model's: never in the portal.
    expect(j(ai).confer).toEqual({
      reviewer: "ai",
      who: null,
      verdict: "agree",
      note: null,
      name: null,
    });
    expect(j(ai).summary).toBeNull();
    expect(j(person).confer).toMatchObject({
      reviewer: "person",
      verdict: "disagree",
      note: "Freight is missing",
      name: "Client A user",
    });
    const write = byNode("Corrected the record");
    expect(j(write).noAnswer).toBe("proceeded");
    expect(j(write).approval.mode).toBe("any");
    expect(
      j(write).approval.approvers.map((x: Record<string, unknown>) => [x.role, x.name, x.state]),
    ).toEqual([
      ["client_admin", null, "no_answer"],
      [null, "Client A user", "no_answer"],
    ]);
    expect(j(byNode("Tell the team")).urgent).toMatchObject({ state: "waiting", seenAt: null });
    // Wave 5: how each step ended, the word a later `if` routes on; a confer row has none.
    expect(j(write).outcome).toBe("done");
    expect(j(byNode("Tell the team")).outcome).toBe("sent");
    expect(j(ai).outcome).toBeUndefined();
    // Wave 5 (web): the read failed and the run carried on; the if says its route and why, in the
    // labels the client sees (never a field or a rule).
    expect(j(byNode("Look the record up"))).toMatchObject({ outcome: "failed", carriedOn: true });
    expect(j(write).carriedOn).toBeUndefined();
    expect(j(byNode("Pick the way")).route).toEqual({
      path: "Corrected",
      because: [
        { label: "Corrected the record", outcome: "done" },
        { label: "Look the record up", outcome: "failed" },
      ],
    });
    expect(JSON.stringify(res.json)).not.toContain("steps.update.outcome");
    // Nothing of a model or a cost anywhere.
    expect(JSON.stringify(res.json)).not.toContain("add up to the total");
  });

  it("gives the back office's run view each step's outcome (wave 5)", async () => {
    const res = await H.call(OPERATOR, "GET", `/api/ops/runs/${runId}`);
    expect(res.status).toBe(200);
    const steps = j(res.json).steps as { nodeId: string; outcome?: string }[];
    expect(Object.fromEntries(steps.map((s) => [s.nodeId, s.outcome ?? null]))).toEqual({
      "update:confer:0": null,
      "update:confer:1": null,
      update: "done",
      tell: "sent",
      look: "failed",
      route: null,
    });
  });
});
