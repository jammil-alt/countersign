// v0.16 (docs/plan.md §1.86): the agent port keeps the lead's answer to a browsing skill's help
// request as the platform's own note in the browse scope (never the agent's memory, which its
// model can write), logged on the step's row; a test run keeps nothing.

import type { RuntimeDeps } from "@countersign/agents";
import type { RunInfo } from "@countersign/workflows";
import { describe, expect, it } from "vitest";
import { agentPort } from "./ports";

function setUp() {
  const notes: { agentId: string; note: string; scope: string }[] = [];
  const calls: { stepRunId: string; tool: string; input: unknown }[] = [];
  const deps = {
    ports: {
      store: {
        loadAgentVersion: async () => ({ agentId: "a1", agentVersionId: "v1", bindings: {} }),
      },
      log: {
        startToolCall: async (_t: string, call: { stepRunId: string; tool: string }) => {
          calls.push(call as (typeof calls)[number]);
          return "tc1";
        },
        finishToolCall: async () => undefined,
      },
      platform: {
        writeMemory: async (_t: string, n: (typeof notes)[number]) => {
          notes.push(n);
          return { id: `m${notes.length}` };
        },
      },
    },
  } as unknown as RuntimeDeps;
  const run = (mode: "live" | "test") =>
    ({ id: "r1", tenantId: "t1", agentVersionId: "v1", mode }) as unknown as RunInfo;
  return { port: agentPort(deps), notes, calls, run };
}

const HELP = {
  stepRunId: "s1",
  nodeId: "find:help:memory",
  remember: "[browse-help skill=custom:find-invoice sites=supplier]",
  question: "Where are invoices?",
  answer: "Under Invoices.",
};

describe("agentPort.keepHelp", () => {
  it("keeps the answer in the browse scope, logged on the step", async () => {
    const t = setUp();
    await t.port.keepHelp?.({ run: t.run("live"), ...HELP });
    expect(t.notes).toEqual([
      {
        agentId: "a1",
        scope: "browse",
        note: "[browse-help skill=custom:find-invoice sites=supplier] Asked: Where are invoices? Answer: Under Invoices.",
      },
    ]);
    expect(t.calls).toEqual([expect.objectContaining({ stepRunId: "s1", tool: "memory.write" })]);
  });

  it("refuses a tag that isn't a help request's, and keeps nothing from a test run", async () => {
    const t = setUp();
    await expect(
      t.port.keepHelp?.({ run: t.run("live"), ...HELP, remember: "[anything]" }),
    ).rejects.toThrow(/not a help request's tag/);
    await t.port.keepHelp?.({ run: t.run("test"), ...HELP });
    expect(t.notes).toEqual([]);
  });
});
