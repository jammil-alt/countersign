// The supervisor's tools against a real database as cs_worker (docs/plan.md §1.28): the health
// tools see one client only; `agents.ask` runs another agent of the same client as a read-only test
// run within its budget and writes nothing; findings are reported once per open issue and reminded
// after the client's reminder time; the client admin's item carries no internals; a test run
// writes nothing; the daily check writes its summary; a connection that needs a person is marked
// and announced once.

import { TESTKIT_QUERY_TOOL, TESTKIT_UPDATE_TOOL } from "@countersign/connectors";
import {
  findingFingerprint,
  HealthSummary,
  type JsonObject,
  RunFailedPayload,
} from "@countersign/core";
import {
  agent,
  connection,
  connectionChange,
  event,
  externalAction,
  inboxItem,
  memoryNote,
  run,
  type Tx,
  tenant,
  toolCall,
} from "@countersign/db";
import { loadSeedTemplates } from "@countersign/db/seed";
import { FakeModel } from "@countersign/llm";
import { emit } from "@countersign/senses";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTemplate, fork, publish, updateOperational } from "../registry/agents";
import { SkillCatalog } from "../registry/skills";
import { callTool } from "../runtime/call-tool";
import type { RuntimeDeps, StepContext } from "../runtime/context";
import { ASK_BUDGET, askAgent, runAgent, toolName } from "../runtime/run-agent";
import { SUPERVISOR_SKILLS } from "../tools/supervisor";
import type { FindingInput } from "../tools/types";
import { dbConnectionAttention } from "./connection-attention";
import {
  ALERT_SKILL,
  type Client,
  createHarness,
  type Harness,
  LOOKUP_SKILL,
  makeBundle,
  UPDATE_SKILL,
} from "./harness.test-helper";
import { createRun, finishRun } from "./run-log";

const harness = await createHarness();
afterAll(() => harness?.close());

interface Ids {
  worker: { agentId: string; versionId: string };
  supervisor: { agentId: string; versionId: string };
}

describe.skipIf(!harness)("supervisor", () => {
  const h = harness as Harness;
  const catalog = new SkillCatalog(
    [LOOKUP_SKILL, ALERT_SKILL, UPDATE_SKILL, ...SUPERVISOR_SKILLS],
    h.tools,
  );
  const ctx = { tools: h.tools, catalog };
  const deps = (model = new FakeModel()): RuntimeDeps => ({ ...h.deps(model), catalog });
  const ids = new Map<string, Ids>();

  beforeAll(async () => {
    const seeded = (await loadSeedTemplates()).find((t) => t.slug === "supervisor");
    if (!seeded) throw new Error("no supervisor seed");
    const templates = await h.ops(async (tx) => {
      const w = await createTemplate(tx, { slug: "worker", bundle: makeBundle() });
      const s = await createTemplate(tx, { slug: "supervisor", bundle: seeded.bundle });
      return {
        worker: await publish(tx, { agentId: w.agent.id, versionId: w.version.id, ctx }),
        supervisor: await publish(tx, { agentId: s.agent.id, versionId: s.version.id, ctx }),
      };
    });
    for (const c of [h.A, h.B]) {
      const made = await h.ops(async (tx) => {
        const out = {} as Ids;
        for (const slug of ["worker", "supervisor"] as const) {
          const forked = await fork(tx, {
            tenantId: c.tenantId,
            slug,
            templateVersionId: templates[slug].id,
          });
          if (slug === "worker") {
            await updateOperational(tx, {
              agentId: forked.agent.id,
              patch: { bindings: { testkit: c.connectionId } },
            });
          }
          await publish(tx, { agentId: forked.agent.id, versionId: forked.version.id, ctx });
          await tx.update(agent).set({ runStatus: "active" }).where(eq(agent.id, forked.agent.id));
          out[slug] = { agentId: forked.agent.id, versionId: forked.version.id };
        }
        return out;
      });
      ids.set(c.tenantId, made);
    }
  });

  const of = (c: Client) => ids.get(c.tenantId) as Ids;

  async function supervisorStep(
    c: Client,
    mode: "live" | "test" = "live",
    d: RuntimeDeps = deps(),
  ): Promise<StepContext> {
    const s = of(c).supervisor;
    const r = await h.client(c, (tx) =>
      createRun(tx, {
        tenantId: c.tenantId,
        agentId: s.agentId,
        workflowSlug: "daily-check",
        mode,
      }),
    );
    const stepRunId = await d.ports.log.startStepRun(c.tenantId, {
      runId: r.id,
      nodeId: "check",
      nodeType: "skill",
      skillRef: null,
      agentVersionId: s.versionId,
      input: {},
    });
    return {
      tenantId: c.tenantId,
      agent: await d.ports.store.loadAgentVersion(c.tenantId, s.versionId),
      runId: r.id,
      stepRunId,
      stepId: "check",
      mode,
      externalIndex: { next: 0 },
    };
  }

  /** A failed live run of the client's worker, as the executor records one. */
  async function failedRun(c: Client, stepId = "step-lookup", error = "the model call failed") {
    return h.client(c, async (tx) => {
      const r = await createRun(tx, {
        tenantId: c.tenantId,
        agentId: of(c).worker.agentId,
        workflowSlug: "check-record",
        mode: "live",
      });
      await finishRun(tx, {
        tenantId: c.tenantId,
        runId: r.id,
        status: "failed",
        error: { reason: error, nodeId: stepId },
      });
      return r;
    });
  }

  /** Rows nothing in an ask may add, across both clients (the superuser looks). */
  async function writes() {
    const n = async (table: Parameters<typeof h.t.db.$count>[0]) => h.t.db.$count(table);
    return {
      inbox: await n(inboxItem),
      actions: await n(externalAction),
      events: await n(event),
      memory: await n(memoryNote),
      connectionChanges: await n(connectionChange),
      records: JSON.stringify(h.backend.writes),
    };
  }

  // ── Health tools ──────────────────────────────────────────────────────────────────────────────

  it("the health tools see only the client's own runs, connections, items and agents", async () => {
    const mine = await failedRun(h.A, "step-lookup", "A's own failure");
    const theirs = await failedRun(h.B, "step-lookup", "B's failure");
    await h.client(h.B, (tx) =>
      tx.insert(inboxItem).values({
        tenantId: h.B.tenantId,
        kind: "request",
        title: "B's question",
        assigneeRole: "client_admin",
      }),
    );
    const d = deps();
    const s = await supervisorStep(h.A, "live", d);
    const runs = await callTool(d, s, { toolId: "health.runs", input: { failedOnly: true } });
    expect(runs.status).toBe("done");
    const r = (runs as { output: { runs: { id: string; error: string; failedStep: string }[] } })
      .output;
    expect(r.runs.map((x) => x.id)).toContain(mine.id);
    expect(r.runs.map((x) => x.id)).not.toContain(theirs.id);
    expect(r.runs.find((x) => x.id === mine.id)).toMatchObject({
      error: "A's own failure",
      failedStep: "step-lookup",
    });

    const conns = await callTool(d, s, { toolId: "health.connections", input: {} });
    const c = (conns as { output: { connections: { id: string; usedBy: string[] }[] } }).output;
    expect(c.connections.map((x) => x.id)).toEqual([h.A.connectionId]);
    expect(c.connections[0]?.usedBy).toEqual(["Tester"]);

    const inbox = await callTool(d, s, { toolId: "health.inbox", input: {} });
    const i = (inbox as { output: { items: { title: string }[]; sources: string[] } }).output;
    expect(i.items.map((x) => x.title)).not.toContain("B's question");

    const agents = await callTool(d, s, { toolId: "health.agents", input: {} });
    const a = (agents as { output: { agents: { id: string; lastRun: unknown }[] } }).output;
    expect(a.agents.map((x) => x.id).sort()).toEqual(
      [of(h.A).worker.agentId, of(h.A).supervisor.agentId].sort(),
    );
    expect(a.agents.find((x) => x.id === of(h.A).worker.agentId)?.lastRun).toMatchObject({
      status: "failed",
    });
    // Every output cites its records (invariant 10).
    for (const o of [runs, conns, inbox, agents]) {
      expect(Array.isArray((o as { output: { sources: unknown } }).output.sources)).toBe(true);
    }
  });

  // ── agents.ask ────────────────────────────────────────────────────────────────────────────────

  it("asks another agent of the client: a test run that only reads and writes nothing", async () => {
    const before = await writes();
    const model = new FakeModel([
      { toolUse: { name: toolName(TESTKIT_QUERY_TOOL), input: {} } },
      // Writes are not offered to an asked agent; one it tries anyway is refused.
      {
        toolUse: { name: toolName(TESTKIT_UPDATE_TOOL), input: { id: "r1", amount: "99.00" } },
      },
      { toolUse: { name: toolName("memory.write"), input: { note: "remember me" } } },
      { toolUse: { name: "finish", input: { answer: "One record: Oak board.", sources: ["r1"] } } },
    ]);
    const d = deps(model);
    const s = await supervisorStep(h.A, "live", d);
    const answer = await askAgent(d, {
      tenantId: h.A.tenantId,
      agentId: of(h.A).supervisor.agentId,
      runId: s.runId,
      ask: { agentId: of(h.A).worker.agentId, question: "Which records are there?" },
    });
    expect(answer).toMatchObject({
      agentId: of(h.A).worker.agentId,
      status: "answered",
      answer: "One record: Oak board.",
      sources: ["r1"],
    });
    expect(await writes()).toEqual(before);
    // The question reached the asked agent as data, and it was offered only tools that read.
    const offered = (model.requests[0]?.tools ?? []).map((t) => (t as { name: string }).name);
    expect(offered).toContain(toolName(TESTKIT_QUERY_TOOL));
    expect(offered).not.toContain(toolName(TESTKIT_UPDATE_TOOL));
    expect(offered).not.toContain(toolName("memory.write"));
    expect(offered).not.toContain(toolName("agents.ask"));
    expect(model.requests[0]?.system).not.toContain("Which records are there?");
    // The ask is the asked agent's own test run, finished.
    const [askRun] = await h.client(h.A, (tx) =>
      tx.select().from(run).where(eq(run.id, answer.runId)),
    );
    expect(askRun).toMatchObject({
      agentId: of(h.A).worker.agentId,
      mode: "test",
      status: "succeeded",
      workflowSlug: "agents.ask",
    });
    expect(askRun?.trigger).toMatchObject({ askedBy: { agentId: of(h.A).supervisor.agentId } });
  });

  it("refuses another client's agent and the asking agent itself", async () => {
    const d = deps();
    const s = await supervisorStep(h.A, "live", d);
    const from = { tenantId: h.A.tenantId, agentId: of(h.A).supervisor.agentId, runId: s.runId };
    await expect(
      askAgent(d, { ...from, ask: { agentId: of(h.B).worker.agentId, question: "Hello?" } }),
    ).rejects.toThrow(/no agent .* of this client/);
    await expect(
      askAgent(d, { ...from, ask: { agentId: of(h.A).supervisor.agentId, question: "Me?" } }),
    ).rejects.toThrow(/can't ask itself/);
    // Through the tool, as a model would: the call fails with the reason, nothing runs.
    const runsBefore = await h.t.db.$count(run);
    const out = await callTool(
      d,
      { ...s, ask: (q) => askAgent(d, { ...from, ask: q }) },
      { toolId: "agents.ask", input: { agentId: of(h.B).worker.agentId, question: "Hello?" } },
    );
    expect(out).toMatchObject({ status: "failed" });
    expect(await h.t.db.$count(run)).toBe(runsBefore);
    // Without the runtime's ask (an action step, or inside an ask), the tool refuses to run.
    const bare = await callTool(d, s, {
      toolId: "agents.ask",
      input: { agentId: of(h.A).worker.agentId, question: "Hello?" },
    });
    expect(bare).toMatchObject({ status: "failed" });
  });

  it("stays within its budget: steps, then cost, with no item for a person", async () => {
    const before = await writes();
    const loop = () => ({ toolUse: { name: toolName(TESTKIT_QUERY_TOOL), input: {} } });
    const model = new FakeModel(Array.from({ length: 10 }, loop));
    const d = deps(model);
    const s = await supervisorStep(h.A, "live", d);
    const from = { tenantId: h.A.tenantId, agentId: of(h.A).supervisor.agentId, runId: s.runId };
    const ask = { agentId: of(h.A).worker.agentId, question: "Keep looking" };
    const steps = await askAgent(d, { ...from, ask });
    expect(steps).toMatchObject({ status: "no_answer", reason: "budget reached: max_steps" });
    expect(model.requests.length).toBe(ASK_BUDGET.maxSteps);

    // One expensive answer (60k tokens in on the agent's model) is over the ask's $0.10.
    const pricey = new FakeModel([
      { toolUse: { name: toolName(TESTKIT_QUERY_TOOL), input: {} }, usage: { input: 60_000 } },
      loop(),
    ]);
    const cost = await askAgent(deps(pricey), { ...from, ask });
    expect(cost).toMatchObject({ status: "no_answer", reason: "budget reached: max_cost" });
    expect(pricey.requests.length).toBe(1);
    const [r] = await h.client(h.A, (tx) => tx.select().from(run).where(eq(run.id, cost.runId)));
    expect(r?.status).toBe("failed");
    expect(Number(r?.costUsd)).toBeLessThan(0.2);
    expect(await writes()).toEqual(before);
  });

  it("the supervisor asks through its triage skill, and the answer comes back as data", async () => {
    const model = new FakeModel([
      {
        toolUse: {
          name: toolName("agents.ask"),
          input: { agentId: of(h.A).worker.agentId, question: "Why did your lookup fail?" },
        },
      },
      // The asked agent's turn.
      { toolUse: { name: "finish", input: { answer: "The tool was down.", sources: [] } } },
      (req) => {
        const last = req.messages.at(-1);
        const text = JSON.stringify(last?.content);
        expect(text).toContain("The tool was down.");
        return {
          toolUse: { name: "finish", input: { note: "The testkit was down.", sources: [] } },
        };
      },
    ]);
    const d = deps(model);
    const s = await supervisorStep(h.A, "live", d);
    const out = await runAgent(d, {
      tenantId: h.A.tenantId,
      agentVersionId: of(h.A).supervisor.versionId,
      skill: "supervisor.triage",
      input: { event: "run.failed", facts: {} },
      runId: s.runId,
      stepId: "run-triage",
    });
    expect(out).toMatchObject({ status: "succeeded", output: { note: "The testkit was down." } });
    const calls = await h.client(h.A, (tx) =>
      tx.select().from(toolCall).where(eq(toolCall.tool, "agents.ask")),
    );
    expect(calls.some((c) => c.status === "succeeded")).toBe(true);
  });

  // ── Findings ──────────────────────────────────────────────────────────────────────────────────

  function finding(c: Client, fingerprint: string): FindingInput {
    return {
      kind: "run_failed",
      fingerprint,
      subjectId: of(c).worker.agentId,
      reporterAgentId: of(c).supervisor.agentId,
      client: { params: { service: "Records clerk" } },
      operator: {
        title: "Records clerk failed at step-lookup: secret-ish error text",
        details: { agentVersionId: of(c).worker.versionId, stepId: "step-lookup" } as JsonObject,
        note: "The model said something about its prompt.",
      },
      sources: [of(c).worker.versionId],
    };
  }

  const itemsFor = (c: Client, fingerprint: string) =>
    h.client(c, (tx: Tx) =>
      tx
        .select()
        .from(inboxItem)
        .where(
          and(
            eq(inboxItem.tenantId, c.tenantId),
            sql`${inboxItem.payload}->>'fingerprint' = ${fingerprint}`,
          ),
        )
        .orderBy(inboxItem.createdAt),
    );

  it("reports an open issue once, counts it, and reminds after the reminder time", async () => {
    const port = deps().ports.findings;
    if (!port) throw new Error("no findings port");
    const fp = "run_failed:test-dedupe";
    const t0 = new Date();
    const first = await port.report(h.A.tenantId, finding(h.A, fp), t0);
    expect(first.client?.status).toBe("opened");
    expect(first.operator.status).toBe("opened");
    const again = await port.report(
      h.A.tenantId,
      finding(h.A, fp),
      new Date(t0.getTime() + 3_600_000),
    );
    expect(again.client).toEqual({ itemId: first.client?.itemId, status: "open" });
    expect(again.operator).toEqual({ itemId: first.operator.itemId, status: "open" });
    expect(await itemsFor(h.A, fp)).toHaveLength(2);

    // Default 24 hours.
    const later = await port.report(
      h.A.tenantId,
      finding(h.A, fp),
      new Date(t0.getTime() + 25 * 3_600_000),
    );
    expect(later.client?.status).toBe("reminded");
    const items = await itemsFor(h.A, fp);
    expect(items).toHaveLength(2);
    expect(items[0]?.payload).toMatchObject({ finding: { occurrences: 3, reminders: 1 } });

    // Once the client resolves theirs, the same issue seen again opens a new one for them.
    await h.client(h.A, (tx) =>
      tx
        .update(inboxItem)
        .set({ status: "resolved", resolvedAt: new Date() })
        .where(eq(inboxItem.id, first.client?.itemId as string)),
    );
    const reopened = await port.report(
      h.A.tenantId,
      finding(h.A, fp),
      new Date(t0.getTime() + 26 * 3_600_000),
    );
    expect(reopened.client?.status).toBe("opened");
    expect(reopened.operator.status).toBe("open");
  });

  it("reads the reminder time from the client's settings", async () => {
    await h.t.db
      .update(tenant)
      .set({ settings: { supervisor: { reminderHours: 2 } } })
      .where(eq(tenant.id, h.B.tenantId));
    const port = deps().ports.findings;
    if (!port) throw new Error("no findings port");
    const fp = "run_failed:test-setting";
    const t0 = new Date();
    await port.report(h.B.tenantId, finding(h.B, fp), t0);
    const soon = await port.report(
      h.B.tenantId,
      finding(h.B, fp),
      new Date(t0.getTime() + 3 * 3_600_000),
    );
    expect(soon.operator.status).toBe("reminded");
    await h.t.db.update(tenant).set({ settings: {} }).where(eq(tenant.id, h.B.tenantId));
  });

  it("gives the client admin a title and plain steps, and nothing internal", async () => {
    const fp = "run_failed:test-client-safe";
    const port = deps().ports.findings;
    if (!port) throw new Error("no findings port");
    const out = await port.report(h.A.tenantId, finding(h.A, fp), new Date());
    const items = await itemsFor(h.A, fp);
    const client = items.find((i) => i.id === out.client?.itemId);
    const operator = items.find((i) => i.id === out.operator.itemId);
    expect(client?.assigneeRole).toBe("client_admin");
    expect(client?.title).toBe("Records clerk could not finish its work");
    expect(Object.keys(client?.payload ?? {}).sort()).toEqual(["finding", "fingerprint"]);
    const text = JSON.stringify(client);
    for (const internal of [
      of(h.A).worker.versionId,
      "step-lookup",
      "secret-ish error text",
      "prompt",
      "cost",
    ]) {
      expect(text, internal).not.toContain(internal);
    }
    expect(
      Object.keys(
        (client?.payload as { finding: Record<string, unknown> } | undefined)?.finding ?? {},
      ).sort(),
    ).toEqual(["kind", "lastSeenAt", "occurrences", "remindedAt", "reminders", "steps"]);
    expect(operator?.assigneeRole).toBe("operator");
    expect(operator?.payload).toMatchObject({
      details: { stepId: "step-lookup" },
      note: "The model said something about its prompt.",
    });
  });

  it("writes the client admin's words in the client's language", async () => {
    await h.t.db
      .update(tenant)
      .set({ settings: { language: "es" } })
      .where(eq(tenant.id, h.B.tenantId));
    const port = deps().ports.findings;
    if (!port) throw new Error("no findings port");
    const out = await port.report(
      h.B.tenantId,
      {
        ...finding(h.B, "connection_signin:x"),
        kind: "connection_signin",
        client: { params: { connector: "Zoho CRM" } },
      },
      new Date(),
    );
    const [item] = await h.client(h.B, (tx) =>
      tx
        .select()
        .from(inboxItem)
        .where(eq(inboxItem.id, out.client?.itemId as string)),
    );
    expect(item?.title).toBe("Zoho CRM necesita que inicie sesión de nuevo");
    expect(
      (item?.payload as { finding?: { steps: string[] } } | undefined)?.finding?.steps[0],
    ).toBe("Vaya a Cuentas.");
    await h.t.db.update(tenant).set({ settings: {} }).where(eq(tenant.id, h.B.tenantId));
  });

  it("supervisor.report in a test run writes nothing", async () => {
    const r = await failedRun(h.A, "step-test-mode");
    const before = await writes();
    const d = deps();
    const s = await supervisorStep(h.A, "test", d);
    const facts = RunFailedPayload.parse({
      runId: r.id,
      agentId: of(h.A).worker.agentId,
      agentVersionId: of(h.A).worker.versionId,
      workflowSlug: "check-record",
      stepId: "step-test-mode",
      error: "x",
    });
    const out = await callTool(d, s, {
      toolId: "supervisor.report",
      input: { event: "run.failed", facts },
    });
    expect(out).toMatchObject({
      status: "done",
      output: {
        status: "would_report",
        kind: "run_failed",
        fingerprint: findingFingerprint({
          kind: "run_failed",
          agentId: of(h.A).worker.agentId,
          workflowSlug: "check-record",
          stepId: "step-test-mode",
        }),
      },
    });
    expect(await writes()).toEqual(before);
  });

  it("the daily check reports what needs a person and writes its summary", async () => {
    await h.t.db
      .update(connection)
      .set({ status: "error" })
      .where(eq(connection.id, h.A.connectionId));
    const d = deps();
    const s = await supervisorStep(h.A, "live", d);
    const out = await callTool(d, s, { toolId: "supervisor.check", input: {} });
    expect(out.status).toBe("done");
    const o = (out as { output: { findings: { kind: string }[]; summary: unknown } }).output;
    const kinds = new Set(o.findings.map((f) => f.kind));
    expect(kinds.has("run_failed")).toBe(true);
    expect(kinds.has("connection_signin")).toBe(true);
    const [summary] = await h.client(h.A, (tx) =>
      tx
        .select()
        .from(event)
        .where(and(eq(event.tenantId, h.A.tenantId), eq(event.type, "health.checked"))),
    );
    const parsed = HealthSummary.parse(summary?.payload);
    expect(parsed.connections.needsAttention).toBe(1);
    expect(parsed.runs.failed).toBeGreaterThan(0);
    expect(parsed.openFindings).toBeGreaterThan(0);
    // A second check the same day adds no item: everything it found is still open.
    const count = await h.t.db.$count(inboxItem);
    await callTool(d, await supervisorStep(h.A, "live", d), {
      toolId: "supervisor.check",
      input: {},
    });
    expect(await h.t.db.$count(inboxItem)).toBe(count);
    // Failures a person already closed are not reported again by the next check.
    await h.t.db
      .update(inboxItem)
      .set({ status: "resolved", resolvedAt: new Date() })
      .where(
        and(
          eq(inboxItem.tenantId, h.A.tenantId),
          eq(inboxItem.status, "open"),
          sql`${inboxItem.payload}->>'fingerprint' like 'run_failed:%'`,
        ),
      );
    const again = await callTool(d, await supervisorStep(h.A, "live", d), {
      toolId: "supervisor.check",
      input: {},
    });
    const statuses = (
      again as { output: { findings: { kind: string; operator: { status: string } }[] } }
    ).output.findings
      .filter((f) => f.kind === "run_failed")
      .map((f) => f.operator.status);
    expect(statuses.length).toBeGreaterThan(0);
    expect(new Set(statuses)).toEqual(new Set(["resolved"]));
    expect(await h.t.db.$count(inboxItem)).toBe(count);
    await h.t.db
      .update(connection)
      .set({ status: "pending" })
      .where(eq(connection.id, h.A.connectionId));
  });

  it("marks a connection that needs a person and announces it once", async () => {
    const port = dbConnectionAttention(h.db, {
      emit: async (tx, tenantId, e) => {
        await emit(tx, {
          tenantId,
          type: e.type,
          subjectType: e.subjectType,
          subjectId: e.subjectId,
          payload: e.payload as Record<string, unknown>,
        });
      },
    });
    const events = () =>
      h.t.db.$count(
        event,
        and(eq(event.tenantId, h.B.tenantId), eq(event.type, "connection.needs_attention")),
      );
    const before = await events();
    const input = {
      connectionId: h.B.connectionId,
      reason: "signin_expired" as const,
      detail: "the provider refused the refresh",
    };
    await port.needsAttention(h.B.tenantId, input);
    await port.needsAttention(h.B.tenantId, input);
    expect(await events()).toBe(before + 1);
    const [c] = await h.t.db.select().from(connection).where(eq(connection.id, h.B.connectionId));
    expect(c?.status).toBe("error");
    const changes = await h.t.db
      .select()
      .from(connectionChange)
      .where(eq(connectionChange.connectionId, h.B.connectionId));
    expect(
      changes.filter((x) => (x.change as { kind?: string }).kind === "needs_attention"),
    ).toHaveLength(1);
    // A's session can't mark B's connection.
    await port.needsAttention(h.A.tenantId, { ...input, connectionId: h.B.connectionId });
    expect(await events()).toBe(before + 1);
  });
});
