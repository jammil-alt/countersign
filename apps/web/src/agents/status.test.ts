// A client agent's status in words, one derivation for every back-office screen (QA, 2026-11-22:
// the AP bill clerk read "Idle · In trial", "In trial", "Running · Live" and "Live · v4 · Active"
// on four screens), and the client's agents counted one way.
import { describe, expect, it } from "vitest";
import { clientLine } from "../ops/client/ClientFrame";
import { AGENT_SUMMARY } from "../test/fixtures";
import { agentActivity, agentStage, agentStatusLine } from "./status";

describe("an agent's status in words", () => {
  it("reads the AP bill clerk the same way everywhere: in trial, its version, then its runs", () => {
    // Switched on, in trial, v4 published: "Live" is the live stage only, never a version.
    const stage = agentStage({ runStatus: "active", stage: "trial" });
    expect(stage).toEqual({ key: "trial", state: "running", words: "In trial" });
    expect(agentStatusLine({ stage, version: 4, activity: agentActivity({ openRuns: 0 }) })).toBe(
      "In trial · v4 · Idle",
    );
    expect(agentStatusLine({ stage, version: 4 })).toBe("In trial · v4");
    expect(agentStatusLine({ stage })).toBe("In trial");
  });

  it("names each stage, and a switched-off agent before its stage", () => {
    const words = (runStatus: string | null, stage: string | null, paused?: boolean) =>
      agentStage({ runStatus, stage, paused }).words;
    expect(words("active", "live")).toBe("Live");
    expect(words("active", "signoff")).toBe("Waiting on the client's sign-off");
    expect(words("active", "bench")).toBe("Not started");
    expect(words("active", null)).toBe("Not started");
    expect(words("draft", "bench")).toBe("Not started");
    expect(words("testing", "bench")).toBe("Not started");
    expect(words(null, null)).toBe("Not started");
    expect(words("paused", "live")).toBe("Paused");
    expect(words("active", "live", true)).toBe("Paused");
    expect(words("retired", "live")).toBe("Retired");
    // Signal for the sign-off it waits on, positive for live: never "Running" for the agent.
    expect(agentStage({ runStatus: "active", stage: "signoff" }).state).toBe("waiting");
    expect(agentStage({ runStatus: "active", stage: "live" }).state).toBe("done");
  });

  it("says what its runs are doing only while it is switched on", () => {
    expect(agentActivity({ openRuns: 2, waitingRuns: 1 }).words).toBe("Waiting for approval");
    expect(agentActivity({ openRuns: 1 }).words).toBe("Running");
    expect(agentActivity({ openRuns: 0, lastRunStatus: "failed" }).words).toBe("Last run failed");
    expect(agentActivity({ openRuns: 0, lastRunStatus: "done" }).words).toBe("Idle");
    const paused = agentStage({ runStatus: "paused", stage: "live" });
    expect(
      agentStatusLine({ stage: paused, version: 2, activity: agentActivity({ openRuns: 1 }) }),
    ).toBe("Paused · v2");
  });
});

describe("a client's agents, counted one way", () => {
  it("leaves out test copies, retired and discarded agents in the client page's line", () => {
    const agent = (over: Partial<typeof AGENT_SUMMARY> & { stage?: string | null }) => ({
      ...AGENT_SUMMARY,
      ...over,
    });
    const data = {
      client: { id: "c", name: "Demo client", timezone: "UTC", settings: {}, createdAt: "" },
      agents: [
        agent({ id: "1", slug: "sloan", stage: "live" }),
        agent({ id: "2", slug: "ap-bill-clerk", stage: "trial" }),
        agent({ id: "3", slug: "demo", stage: "trial" }),
        agent({ id: "4", slug: "copy", stage: "bench", testCopy: true }),
        agent({ id: "5", slug: "old", stage: "live", runStatus: "retired" }),
      ],
      connections: [],
      members: [],
    };
    // Before: "1 of 4 agents live", while Home's card said 3.
    expect(clientLine(data)).toBe("1 of 3 agents live · 2 in trial");
  });
});
