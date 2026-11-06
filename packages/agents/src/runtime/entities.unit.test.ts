// v0.12 W2-A: the gate with per-entity permissions (docs/plan.md §1.44), through callTool with the
// testkit connector (entity `record`) and fake ports: an entity off refuses in its own words, an
// entity that asks for approval makes the write wait and is named in `whyApproval`, and a
// connection's other entities still work.

import {
  ConnectorRegistry,
  createTestkitConnector,
  TESTKIT_UPDATE_TOOL,
} from "@countersign/connectors";
import type { PermissionMatrix } from "@countersign/core";
import { describe, expect, it } from "vitest";
import { ToolRegistry } from "../registry/tools";
import { PLATFORM_TOOLS } from "../tools/platform";
import { callTool } from "./call-tool";
import type { RuntimeDeps, StepContext } from "./context";

function harness(permissions: Partial<PermissionMatrix>, grant: unknown = null) {
  const proposed: { status: string; inbox: { payload: Record<string, unknown> } | null }[] = [];
  const conn = {
    id: "c1",
    tenantId: "t1",
    connector: "testkit",
    status: "connected" as const,
    externalAccountId: null,
    config: {},
    permissions,
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
        grant: async () => grant,
        agentStage: async () => "live",
        approvalRouting: async () => ({
          revision: 0,
          rules: [],
          clientDefault: null,
          members: [],
        }),
      },
      actions: {
        byKey: async () => null,
        propose: async (_t: string, p: (typeof proposed)[number]) => {
          proposed.push(p);
          return {
            action: {
              id: "act1",
              status: p.status,
              inboxItemId: "in1",
              before: null,
            },
          };
        },
      },
    },
  } as unknown as RuntimeDeps;
  const step = {
    tenantId: "t1",
    runId: "r1",
    stepRunId: "s1",
    stepId: "x",
    mode: "live",
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
  return { update, proposed };
}

const BASE = { read: "auto", create: "approval", update: "auto", delete: "off" } as const;

describe("callTool with entities", () => {
  it("refuses a write whose entity is off on the connection, in its own words", async () => {
    const h = harness({ ...BASE, entities: { record: { update: "off" } } });
    expect(await h.update()).toEqual({
      status: "refused",
      reason: "testkit.record.update is off for record on the testkit connection",
    });
    expect(h.proposed).toEqual([]);
  });

  it("refuses when the agent's grant turns the entity off", async () => {
    const h = harness(BASE, { entities: { record: { update: "off" } } });
    expect(await h.update()).toEqual({
      status: "refused",
      reason: "update is off in this agent's access to the testkit connection",
    });
  });

  it("makes a write wait when the entity asks, and names it in whyApproval", async () => {
    const h = harness({ ...BASE, entities: { record: { update: "approval" } } });
    expect(await h.update()).toMatchObject({ status: "awaiting_approval" });
    expect(h.proposed).toHaveLength(1);
    expect(h.proposed[0]?.status).toBe("proposed");
    expect(h.proposed[0]?.inbox?.payload.whyApproval).toMatchObject({
      reasons: ["matrix"],
      entity: "record",
    });
  });

  it("an old matrix (no entities) lets the write run as before", async () => {
    const h = harness(BASE);
    const out = await h.update();
    // Approved automatically: proposed as `approved`, then executed (the fake has no executor,
    // so what counts is that it wasn't held for a person).
    expect(h.proposed[0]?.status).toBe("approved");
    expect(out.status).not.toBe("refused");
  });
});
