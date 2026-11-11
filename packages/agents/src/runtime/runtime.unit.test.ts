// Pieces of the runtime that need no database: registries, approver resolution, schema checks.

import {
  type ConnectionRef,
  ConnectorRegistry,
  createTestkitConnector,
  ReconnectRequiredError,
  TESTKIT_UPDATE_TOOL,
} from "@countersign/connectors";
import { FakeModel } from "@countersign/llm";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { type ModelCallInput, modelCallBody, modelCallBodyKey } from "../log/model-calls";
import { SkillCatalog } from "../registry/skills";
import { ToolRegistry, ToolRegistryError } from "../registry/tools";
import { inboxCreate, PLATFORM_TOOLS } from "../tools/platform";
import { defineInternalTool } from "../tools/types";
import { executeAction } from "./actions";
import { noteReconnect } from "./attention";
import { callTool, releaseGate } from "./call-tool";
import { type RuntimeDeps, resolveApprover, type StepContext } from "./context";
import { checkAgainst, objectSchema } from "./json-schema";
import { composeReachMessage, runPlannedAction } from "./planned";
import { toolName } from "./run-agent";

const connectors = () => new ConnectorRegistry([createTestkitConnector()]);

describe("tool registry", () => {
  it("holds platform, connector and pack tools", () => {
    const packTool = defineInternalTool({
      id: "demo.thing.find",
      description: "Find a thing",
      sideEffect: "none",
      source: "demo",
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      run: async () => ({ ok: true }),
    });
    const tools = new ToolRegistry({
      platform: PLATFORM_TOOLS,
      connectors: connectors(),
      packs: [
        {
          manifest: { id: "demo", tools: [packTool.spec] },
          handlers: { [packTool.spec.id]: packTool },
        },
      ],
    });
    expect(Object.keys(tools.specs()).sort()).toEqual([
      // v0.12 W2-D: Sloan's account tools
      "account.draft_change",
      "account.explain_wait",
      "account.pass_to_agent",
      "account.pass_to_lead",
      "account.pause_agent",
      "account.resume_agent",
      "account.run",
      "account.runs",
      "account.services",
      "account.waiting",
      "agents.ask",
      // P-4
      "comms.converse",
      "comms.reach_out",
      // P-7
      "comms.translate",
      // Reshape data (2026-11-11): its pure handler.
      "data.reshape",
      "demo.thing.find",
      "directory.get",
      "directory.search",
      "directory.suggest",
      // Review: Check bill.
      "docs.bill.check",
      "docs.bill_lines",
      "docs.extract",
      "docs.find_support",
      "docs.get",
      "docs.match_bill",
      "docs.plan_bill",
      // P-9
      "docs.read",
      "docs.reading.record",
      "docs.totals.check",
      "health.agents",
      "health.connections",
      "health.inbox",
      "health.runs",
      "inbound.get",
      "inbox.create",
      "knowledge.search",
      "knowledge.voice_samples",
      // B-2 (docs/plan.md §1.79)
      "ledger.accounts.list",
      "ledger.dimensions.list",
      "memory.write",
      "supervisor.check",
      "supervisor.report",
      "testkit.record.query",
      "testkit.record.update",
      "threads.post",
      "threads.read",
      // §1.77: web research
      "web.fetch",
      "web.search",
    ]);
    expect(tools.get(TESTKIT_UPDATE_TOOL)?.kind).toBe("connector");
    expect(tools.get("memory.write")?.spec.sideEffect).toBe("internal");
  });

  it("refuses duplicates, pack tools without handlers and pack writes to client tools", () => {
    expect(() => new ToolRegistry({ platform: [...PLATFORM_TOOLS, ...PLATFORM_TOOLS] })).toThrow(
      ToolRegistryError,
    );
    const spec = { ...inboxCreate.spec, id: "demo.x.update", source: "demo" };
    expect(
      () =>
        new ToolRegistry({ packs: [{ manifest: { id: "demo", tools: [spec] }, handlers: {} }] }),
    ).toThrow(/no handler/);
    const external = {
      ...spec,
      sideEffect: "external" as const,
      verb: "update" as const,
      connector: "x",
    };
    expect(
      () =>
        new ToolRegistry({
          packs: [
            {
              manifest: { id: "demo", tools: [external] },
              handlers: { [external.id]: inboxCreate },
            },
          ],
        }),
    ).toThrow(/via connectors/);
  });
});

describe("skill catalog", () => {
  it("refuses built-ins whose tools are not registered", () => {
    const tools = new ToolRegistry({ platform: PLATFORM_TOOLS });
    expect(
      () =>
        new SkillCatalog(
          [
            {
              schemaVersion: 1,
              id: "demo.do",
              name: "Do",
              description: "",
              category: "demo",
              mode: "tool",
              handler: "demo.missing",
              tools: [],
              input: {},
              output: {},
              settings: [],
              requiresConnectors: [],
              requiresPacks: [],
              producesAlerts: false,
            },
          ],
          tools,
        ),
    ).toThrow(/unknown tool demo.missing/);
  });
});

describe("approvers", () => {
  it("takes the step's, then the agent's, then the client's, else the client admin", () => {
    const user = "01a1a29f-2195-7f01-b490-3e9a675c8770";
    expect(resolveApprover([undefined, "operator", "client_admin"])).toEqual({
      assigneeRole: "operator",
      assigneeUserId: null,
    });
    expect(resolveApprover([user, "operator"])).toEqual({
      assigneeRole: null,
      assigneeUserId: user,
    });
    expect(resolveApprover([null, undefined, "nonsense"])).toEqual({
      assigneeRole: "client_admin",
      assigneeUserId: null,
    });
  });
});

describe("schemas", () => {
  it("checks values against JSON Schema and builds object tool schemas", () => {
    const schema = { type: "object", properties: { n: { type: "integer" } }, required: ["n"] };
    expect(checkAgainst(schema, { n: 2 }).ok).toBe(true);
    expect(checkAgainst(schema, { n: "2" }).ok).toBe(false);
    expect(checkAgainst({}, "anything").ok).toBe(true);
    expect(objectSchema({ type: "string" })).toMatchObject({ type: "object" });
    expect(toolName("testkit.record.query")).toBe("testkit__record__query");
  });
});

describe("the human release gate", () => {
  const PERSON = "01a1a29f-2195-7f01-b490-3e9a675c8770";
  const conn = (release?: unknown) => ({
    id: "c1",
    tenantId: "t1",
    connector: "testkit",
    status: "connected" as const,
    externalAccountId: null,
    config: release === undefined ? {} : { release: release as never },
    permissions: {},
  });
  const step = {
    tenantId: "t1",
    runId: "r1",
    stepRunId: "s1",
    mode: "test",
    agent: { agentId: "a1" },
  };
  const on = { mode: "code", personId: PERSON, channel: "email", window: "run" };
  function deps(covers: boolean | null) {
    const asked: unknown[] = [];
    const d = {
      ports: {
        ...(covers === null
          ? {}
          : {
              release: {
                covers: async () => covers,
                request: async (_t: string, ask: unknown) => {
                  asked.push(ask);
                  return { releaseId: "rel1", inboxItemId: "in1" };
                },
              },
            }),
      },
    } as unknown as RuntimeDeps;
    return { d, asked };
  }
  const gate = (d: RuntimeDeps, c: ReturnType<typeof conn>) =>
    releaseGate(d, step as unknown as StepContext, c, TESTKIT_UPDATE_TOOL);

  it("lets calls through when release is off", async () => {
    expect(await gate(deps(false).d, conn())).toBeNull();
    expect(await gate(deps(null).d, conn({ mode: "off" }))).toBeNull();
  });

  it("asks for a release when none covers the call, test runs too", async () => {
    const { d, asked } = deps(false);
    expect(await gate(d, conn(on))).toEqual({
      status: "awaiting_release",
      releaseId: "rel1",
      inboxItemId: "in1",
      connectionId: "c1",
    });
    expect(asked).toMatchObject([{ agentId: "a1", runId: "r1", test: true }]);
  });

  it("goes on under a live release", async () => {
    expect(await gate(deps(true).d, conn(on))).toBeNull();
  });

  it("fails closed: no port, nobody named, or a setting that no longer parses", async () => {
    expect(await gate(deps(null).d, conn(on))).toMatchObject({ status: "refused" });
    expect(await gate(deps(true).d, conn({ mode: "code" }))).toMatchObject({ status: "refused" });
    expect(await gate(deps(true).d, conn({ mode: "code", window: { hours: 99 } }))).toMatchObject({
      status: "refused",
    });
  });
});

describe("human release outside the gate: approved writes and reach-out attempts", () => {
  const PERSON = "01a1a29f-2195-7f01-b490-3e9a675c8770";
  const conn = {
    id: "c1",
    tenantId: "t1",
    connector: "testkit",
    status: "connected" as const,
    externalAccountId: null,
    config: {
      release: { mode: "code", personId: PERSON, channel: "email", window: { hours: 2 } },
    } as never,
    permissions: { read: "auto", create: "auto", update: "auto", delete: "off" } as const,
  };
  const action = {
    id: "act1",
    tenantId: "t1",
    connectionId: "c1",
    tool: TESTKIT_UPDATE_TOOL,
    runId: "r1",
    stepRunId: "s1",
    agentVersionId: "v1",
    input: { id: "r1", amount: "1.00" },
    idempotencyKey: "r1:x:0",
    status: "approved" as const,
    inboxItemId: null,
    approvedBy: null,
    result: null,
    error: null,
    before: null,
  };
  function deps(covers: boolean | null) {
    const seen = { claimed: 0, failed: [] as unknown[], asked: 0, covers: [] as unknown[] };
    const d = {
      tools: new ToolRegistry({ platform: PLATFORM_TOOLS, connectors: connectors() }),
      ports: {
        store: {
          connection: async () => conn,
          run: async () => ({ mode: "live", agentId: "a1" }),
          grant: async () => null,
        },
        actions: {
          get: async () => action,
          byKey: async () => null,
          claim: async () => {
            seen.claimed += 1;
            return { action, claimed: true };
          },
          fail: async (_t: string, _id: string, error: unknown) => {
            seen.failed.push(error);
            return { ...action, status: "failed" };
          },
        },
        log: { startToolCall: async () => "tc1", finishToolCall: async () => {} },
        ...(covers === null
          ? {}
          : {
              release: {
                covers: async (_t: string, ask: unknown) => {
                  seen.covers.push(ask);
                  return covers;
                },
                request: async () => {
                  seen.asked += 1;
                  return { refused: "never" };
                },
              },
            }),
      },
    } as unknown as RuntimeDeps;
    return { d, seen };
  }

  it("runs an approved write only under a live release for its agent and run", async () => {
    const blocked = deps(false);
    const out = await executeAction(blocked.d, { tenantId: "t1", actionId: "act1" });
    expect(out.status).toBe("failed");
    expect(blocked.seen.claimed).toBe(0);
    expect(blocked.seen.failed).toMatchObject([{ release: true }]);
    expect(blocked.seen.covers).toMatchObject([{ agentId: "a1", runId: "r1" }]);
    // No port: refused too, never asked.
    const none = deps(null);
    expect((await executeAction(none.d, { tenantId: "t1", actionId: "act1" })).status).toBe(
      "failed",
    );
    expect(none.seen.claimed).toBe(0);
    // Released: it goes on to claim and write.
    const ok = deps(true);
    await executeAction(ok.d, { tenantId: "t1", actionId: "act1" }).catch(() => null);
    expect(ok.seen.claimed).toBe(1);
    expect(blocked.seen.asked + none.seen.asked + ok.seen.asked).toBe(0);
  });

  it("refuses a reach-out attempt without a live release, and never asks for one", async () => {
    const step = {
      tenantId: "t1",
      runId: "r1",
      stepRunId: "s1",
      stepId: "reach",
      mode: "live",
      agent: { agentId: "a1" },
      externalIndex: { next: 0 },
    } as unknown as StepContext;
    for (const covers of [false, null] as const) {
      const { d, seen } = deps(covers);
      const out = await runPlannedAction(d, step, {
        toolId: TESTKIT_UPDATE_TOOL,
        connectionId: "c1",
        input: { id: "r1", amount: "1.00" },
        idempotencyKey: "r1:reach:reach:0",
      });
      expect(out).toMatchObject({ status: "refused" });
      expect((out as { reason: string }).reason).toContain("needs a person to release it");
      expect(seen.asked).toBe(0);
    }
  });
});

describe("noteReconnect", () => {
  it("marks the connection only when the connector says to sign in again", async () => {
    const marked: unknown[] = [];
    const deps = {
      ports: { attention: { needsAttention: async (...a: unknown[]) => void marked.push(a) } },
    } as unknown as RuntimeDeps;
    const conn = { id: "c1", tenantId: "t1", connector: "zoho_crm" } as ConnectionRef;
    await noteReconnect(deps, "t1", conn, new Error("timeout"));
    expect(marked).toEqual([]);
    await noteReconnect(deps, "t1", conn, new ReconnectRequiredError("Zoho refused the refresh"));
    expect(marked).toEqual([
      ["t1", { connectionId: "c1", reason: "signin_expired", detail: "Zoho refused the refresh" }],
    ]);
    // Without the port (a call's tools) nothing happens, and nothing throws.
    await noteReconnect({ ports: {} } as RuntimeDeps, "t1", conn, new ReconnectRequiredError());
  });
});

describe("the platform's tool policy", () => {
  it("refuses a call the policy names, logs it as refused, and never dispatches it", async () => {
    const finished: unknown[] = [];
    const asked: unknown[] = [];
    const d = {
      tools: new ToolRegistry({ platform: PLATFORM_TOOLS, connectors: connectors() }),
      ports: {
        log: {
          startToolCall: async () => "tc1",
          finishToolCall: async (_t: string, _id: string, done: unknown) => {
            finished.push(done);
          },
        },
      },
      policy: {
        refuseTool: (call: unknown) => {
          asked.push(call);
          return "sends data to Twilio, which has no signed BAA";
        },
      },
    } as unknown as RuntimeDeps;
    const step = {
      tenantId: "t1",
      runId: "r1",
      stepRunId: "s1",
      stepId: "x",
      mode: "live",
      agent: { agentId: "a1" },
      externalIndex: { next: 0 },
    } as unknown as StepContext;
    const out = await callTool(d, step, {
      toolId: TESTKIT_UPDATE_TOOL,
      input: { connectionId: "c1", id: "r1", amount: "1.00" },
    });
    expect(out).toEqual({
      status: "refused",
      reason: "sends data to Twilio, which has no signed BAA",
    });
    expect(asked).toEqual([
      { tenantId: "t1", toolId: TESTKIT_UPDATE_TOOL, connectorId: "testkit" },
    ]);
    expect(finished).toMatchObject([{ status: "refused" }]);
  });
});

// v0.12 W1-E: a reach-out's message is a model call of its step, recorded like the agent loop's.
describe("composeReachMessage", () => {
  const RUN = "01a1b2c3-0000-7000-8000-000000000001";
  const STEP_RUN = "01a1b2c3-0000-7000-8000-000000000002";
  const VERSION = "01a1b2c3-0000-7000-8000-000000000003";
  const setup = (stepRunId: string) => {
    const usage: unknown[] = [];
    const calls: { tenantId: string; call: ModelCallInput }[] = [];
    const transport = new FakeModel([
      { toolUse: { name: "message", input: { text: "Can you confirm Friday?" } } },
    ]);
    const d = {
      transport,
      ports: {
        log: { addUsage: async (...a: unknown[]) => void usage.push(a) },
        modelCalls: {
          record: async (tenantId: string, call: ModelCallInput) =>
            void calls.push({ tenantId, call }),
        },
      },
    } as unknown as RuntimeDeps;
    const step = {
      tenantId: "t1",
      runId: RUN,
      stepRunId,
      stepId: "reach",
      mode: "live",
      agent: {
        agentId: "a1",
        agentVersionId: VERSION,
        bundle: {
          definition: { identity: { name: "Pia" }, model: { id: "claude-haiku-4-5" } },
        },
      },
      externalIndex: { next: 0 },
    } as unknown as StepContext;
    const input = {
      purpose: "Confirm Friday's delivery",
      data: { order: "PO-1042", card: "4242 4242 4242 4242" },
      language: "en" as const,
      channel: "sms",
      contactName: "Pat Lee",
      clientName: "Acme Millwork",
      maxChars: 320,
    };
    return { d, step, input, usage, calls };
  };

  it("records the call on the step, with its request and answer, cards redacted in the body", async () => {
    const { d, step, input, usage, calls } = setup(STEP_RUN);
    expect(await composeReachMessage(d, step, input)).toBe("Can you confirm Friday?");
    expect(usage).toHaveLength(1);
    expect(calls).toHaveLength(1);
    const [{ tenantId, call }] = calls as [{ tenantId: string; call: ModelCallInput }];
    expect(tenantId).toBe("t1");
    expect(call).toMatchObject({
      runId: RUN,
      stepRunId: STEP_RUN,
      agentVersionId: VERSION,
      provider: "anthropic",
      model: "claude-haiku-4-5",
      tokensIn: 100,
      tokensOut: 20,
      stopReason: "tool_use",
    });
    expect(JSON.stringify(call.request)).toContain("4242 4242 4242 4242");
    // What the writer stores: the client's prefix, and no card number.
    expect(modelCallBodyKey("t1", "x")).toBe("tenants/t1/model-calls/x.json");
    const body = JSON.stringify(modelCallBody(call));
    expect(body).not.toContain("4242 4242 4242 4242");
    expect(body).toContain("[card ending 4242]");
  });

  it("records nothing when the reach-out has no step to belong to", async () => {
    const { d, step, input, usage, calls } = setup("");
    expect(await composeReachMessage(d, step, input)).toBe("Can you confirm Friday?");
    expect(usage).toHaveLength(1);
    expect(calls).toEqual([]);
  });
});
