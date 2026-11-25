// Step model E: an action the operator turned off on its connector's page is refused by the gate,
// whatever the matrix, the grant, the step and the mode say; it only ever narrows. Web's actions
// (built into Mezonas, no connection) are refused the same way. Nothing runs and nothing is proposed.

import {
  ConnectorRegistry,
  createTestkitConnector,
  TESTKIT_QUERY_TOOL,
  TESTKIT_UPDATE_TOOL,
} from "@countersign/connectors";
import { describe, expect, it } from "vitest";
import { ToolRegistry } from "../registry/tools";
import { PLATFORM_TOOLS } from "../tools/platform";
import { callTool } from "./call-tool";
import type { RuntimeDeps, StepContext } from "./context";

function harness(opts: {
  switches?: Record<string, boolean> | null;
  webSwitches?: Record<string, boolean> | null;
}) {
  const proposed: unknown[] = [];
  const conn = {
    id: "c1",
    tenantId: "t1",
    connector: "testkit",
    status: "connected" as const,
    externalAccountId: null,
    config: {},
    permissions: { read: "auto", create: "auto", update: "auto", delete: "off" },
    ...(opts.switches === undefined ? {} : { actionSwitches: opts.switches }),
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
        agentHold: async () => false,
        run: async () => ({ mode: "live", agentId: "a1" }),
        actionSwitches: async () => opts.webSwitches ?? null,
        approvalRouting: async () => ({ revision: 0, rules: [], clientDefault: null, members: [] }),
      },
      actions: {
        byKey: async () => null,
        propose: async (_t: string, p: unknown) => {
          proposed.push(p);
          return { action: { id: "act1", status: "proposed", inboxItemId: "in1", before: null } };
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
  return { deps, step, proposed };
}

describe("a connector's action turned off", () => {
  it("is refused as a write, with nothing proposed", async () => {
    const h = harness({ switches: { [TESTKIT_UPDATE_TOOL]: false } });
    const out = await callTool(h.deps, h.step, {
      toolId: TESTKIT_UPDATE_TOOL,
      input: { id: "R-1", amount: "2.00" },
    });
    expect(out).toMatchObject({ status: "refused" });
    expect((out as { reason: string }).reason).toMatch(/turned off/);
    expect(h.proposed).toEqual([]);
  });

  it("is refused as a read", async () => {
    const h = harness({ switches: { [TESTKIT_QUERY_TOOL]: false } });
    const out = await callTool(h.deps, h.step, { toolId: TESTKIT_QUERY_TOOL, input: {} });
    expect(out).toMatchObject({ status: "refused" });
  });

  it("leaves the others alone, and the matrix still decides them", async () => {
    const h = harness({ switches: { [TESTKIT_QUERY_TOOL]: false } });
    // The update is on: with the matrix at auto and the step not requiring approval it is proposed
    // through the external-action path as ever (the gate did not loosen or tighten it).
    const out = await callTool(h.deps, h.step, {
      toolId: TESTKIT_UPDATE_TOOL,
      input: { id: "R-1", amount: "2.00" },
    });
    expect((out as { status: string }).status).not.toBe("refused");
  });
});

describe("Web's actions turned off", () => {
  it("are refused, search and page read alike, whatever the step says", async () => {
    const h = harness({ webSwitches: { "web.search": false, "web.fetch": false } });
    for (const [toolId, input] of [
      ["web.search", { query: "oak plywood price" }],
      ["web.fetch", { url: "https://example.com/" }],
    ] as const) {
      const out = await callTool(h.deps, h.step, { toolId, input });
      expect(out, toolId).toMatchObject({ status: "refused" });
    }
  });

  it("run when they are on (here the deployment has research off, so the tool says so)", async () => {
    const h = harness({ webSwitches: { "web.fetch": false } });
    const out = await callTool(h.deps, h.step, {
      toolId: "web.search",
      input: { query: "oak plywood price" },
    });
    expect(out).toMatchObject({ status: "done", output: { status: "off" } });
  });
});
