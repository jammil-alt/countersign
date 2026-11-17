// docs/plan.md §1.123: the safety hold in the gate. A write the gate would run unsigned (step not
// required, matrix auto, mode act, live) waits for a person while the agent is held, with `held`
// in whyApproval; a test run is unchanged; executing an approved write of a held agent fails
// closed, never written.

import {
  ConnectorRegistry,
  createTestkitConnector,
  TESTKIT_UPDATE_TOOL,
} from "@countersign/connectors";
import { describe, expect, it } from "vitest";
import { ToolRegistry } from "../registry/tools";
import { PLATFORM_TOOLS } from "../tools/platform";
import { executeAction } from "./actions";
import { callTool } from "./call-tool";
import type { RuntimeDeps, StepContext } from "./context";

function harness(held: boolean, mode: "live" | "test" = "live") {
  const proposed: { status: string; inbox: { payload: Record<string, unknown> } | null }[] = [];
  const failed: unknown[] = [];
  const conn = {
    id: "c1",
    tenantId: "t1",
    connector: "testkit",
    status: "connected" as const,
    externalAccountId: null,
    config: {},
    permissions: { read: "auto", create: "auto", update: "auto", delete: "off" },
  };
  const deps = {
    tools: new ToolRegistry({
      platform: PLATFORM_TOOLS,
      connectors: new ConnectorRegistry([createTestkitConnector()]),
    }),
    ports: {
      log: { startToolCall: async () => "tc1", finishToolCall: async () => {} },
      store: {
        connection: async () => conn,
        grant: async () => null,
        agentStage: async () => "live",
        agentHold: async () => held,
        run: async () => ({ mode, agentId: "a1" }),
        approvalRouting: async () => ({ revision: 0, rules: [], clientDefault: null, members: [] }),
      },
      actions: {
        byKey: async () => null,
        get: async () => ({
          id: "act1",
          status: "approved",
          runId: "r1",
          tool: TESTKIT_UPDATE_TOOL,
        }),
        fail: async (_t: string, _id: string, error: unknown) => {
          failed.push(error);
          return { id: "act1", status: "failed" };
        },
        claim: async () => {
          throw new Error("a held write is never claimed");
        },
        propose: async (_t: string, p: (typeof proposed)[number]) => {
          proposed.push(p);
          return { action: { id: "act1", status: p.status, inboxItemId: "in1", before: null } };
        },
      },
    },
  } as unknown as RuntimeDeps;
  const step = {
    tenantId: "t1",
    runId: "r1",
    stepRunId: "s1",
    stepId: "x",
    mode,
    literalInput: {},
    approval: { required: "not_required" },
    agent: {
      agentId: "a1",
      agentVersionId: "v1",
      bindings: { testkit: "c1" },
      bundle: { definition: { permissions: { mode: "act" } } },
    },
    externalIndex: { next: 0 },
  } as unknown as StepContext;
  const update = () =>
    callTool(deps, step, { toolId: TESTKIT_UPDATE_TOOL, input: { id: "R-1", amount: "2.00" } });
  return { deps, update, proposed, failed };
}

describe("the safety hold in the gate", () => {
  it("makes a write that would run unsigned wait for a person, and says why", async () => {
    const h = harness(true);
    expect(await h.update()).toMatchObject({ status: "awaiting_approval" });
    expect(h.proposed[0]?.status).toBe("proposed");
    expect(h.proposed[0]?.inbox?.payload.whyApproval).toMatchObject({ reasons: ["held"] });
  });

  it("lets the same write run when the agent isn't held", async () => {
    const h = harness(false);
    await h.update();
    expect(h.proposed[0]?.status).toBe("approved");
  });

  it("fails an approved write of a held agent closed, before it is claimed", async () => {
    const h = harness(true);
    const out = await executeAction(h.deps, { tenantId: "t1", actionId: "act1" });
    expect(out.status).toBe("failed");
    expect(h.failed[0]).toMatchObject({ held: true, notWritten: true });
  });
});
