// QA round 1: the client's status model, the one function per kind every portal screen calls.
import { describe, expect, it } from "vitest";
import { createTranslator } from "../i18n/catalog";
import {
  agentChip,
  agentState,
  portalRunPollMs,
  portalRunsPollMs,
  runChip,
  runOpen,
  runState,
  workedMs,
} from "./status";

const t = createTranslator("en");

describe("a run's state", () => {
  it("is never Running while it waits on you, whatever its stored status", () => {
    expect(runState({ status: "running", waitingOnYou: true })).toBe("waiting");
    expect(runState({ status: "queued", waitingOnYou: true })).toBe("waiting");
    expect(runState({ status: "waiting" })).toBe("waiting");
    expect(runChip({ status: "running", waitingOnYou: true }, t)).toEqual({
      state: "waiting",
      label: "Waiting on you",
    });
  });

  it("reads Running, Done, Failed and Stopped in the client's words", () => {
    expect(runChip({ status: "running" }, t)).toEqual({ state: "running", label: "Running" });
    expect(runChip({ status: "queued" }, t).label).toBe("Running");
    expect(runChip({ status: "succeeded" }, t)).toEqual({ state: "done", label: "Done" });
    expect(runChip({ status: "failed" }, t)).toEqual({ state: "failed", label: "Failed" });
    expect(runChip({ status: "cancelled" }, t)).toEqual({ state: "paused", label: "Stopped" });
    expect(runOpen({ status: "running", waitingOnYou: true })).toBe(true);
    expect(runOpen({ status: "succeeded" })).toBe(false);
  });

  it("took its working time: start to finish less the time it waited on you", () => {
    const run = {
      startedAt: "2026-11-05T00:00:00.000Z",
      finishedAt: "2026-11-05T22:00:00.000Z",
      waitedMs: 21 * 3_600_000,
    };
    expect(workedMs(run)).toBe(3_600_000);
    expect(workedMs({ ...run, waitedMs: undefined })).toBe(22 * 3_600_000);
    // Not finished: nothing to show yet ("—").
    expect(workedMs({ ...run, finishedAt: null })).toBeNull();
  });
});

describe("how often a run's screens ask again (docs/audit-plan.md 2.2)", () => {
  it("fast while it works, every 30 s while it waits on you, never once it is over", () => {
    expect(portalRunPollMs({ status: "queued" }, 2_000)).toBe(2_000);
    expect(portalRunPollMs({ status: "running" }, 2_000)).toBe(2_000);
    expect(portalRunPollMs({ status: "waiting" }, 2_000)).toBe(30_000);
    expect(portalRunPollMs({ status: "running", waitingOnYou: true }, 2_000)).toBe(30_000);
    for (const status of ["succeeded", "failed", "cancelled"]) {
      expect(portalRunPollMs({ status }, 2_000)).toBeNull();
    }
  });

  it("does not change what a waiting run is shown as", () => {
    const waiting = { status: "running", waitingOnYou: true };
    expect(runOpen(waiting)).toBe(true);
    expect(runChip(waiting, t).state).toBe("waiting");
  });

  it("polls a list at the rate of its busiest run", () => {
    expect(portalRunsPollMs([{ status: "succeeded" }], 5_000)).toBeNull();
    expect(portalRunsPollMs([{ status: "succeeded" }, { status: "waiting" }], 5_000)).toBe(30_000);
    expect(
      portalRunsPollMs([{ status: "running", waitingOnYou: true }, { status: "queued" }], 5_000),
    ).toBe(5_000);
  });
});

describe("an agent's state", () => {
  const live = { status: "active", stage: "live" };

  it("is Waiting on you when any of its runs waits on you, else Working, else Ready", () => {
    expect(agentState({ ...live, runsNow: { running: 1, waitingOnYou: 1 } })).toBe("waiting");
    expect(agentState({ ...live, runsNow: { running: 1, waitingOnYou: 0 } })).toBe("working");
    expect(agentState({ ...live, runsNow: { running: 0, waitingOnYou: 0 } })).toBe("ready");
    // Without the counts, its latest run decides; a waiting run is never "working".
    expect(agentState({ ...live, now: { status: "running", waitingOnYou: true } })).toBe("waiting");
    expect(agentState({ ...live, now: { status: "succeeded", waitingOnYou: false } })).toBe(
      "ready",
    );
  });

  it("is Paused, or Setting up before it is live", () => {
    expect(agentState({ status: "paused", runsNow: { running: 1, waitingOnYou: 1 } })).toBe(
      "paused",
    );
    expect(agentState({ status: "active", stage: "bench" })).toBe("setup");
    expect(agentState({ status: "draft" })).toBe("setup");
    expect(agentChip({ ...live }, t)).toEqual({ state: "idle", label: "Ready" });
    expect(agentChip({ ...live, runsNow: { running: 1, waitingOnYou: 0 } }, t).label).toBe(
      "Working",
    );
  });
});
