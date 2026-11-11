// A run waiting on a person is polled slowly (docs/audit-plan.md 2.2), and still shown as open.
import { describe, expect, it } from "vitest";
import { isRunGoing, runPollMs, runStatusTone, runsPollMs, WAITING_POLL_MS } from "./format";

const wait = {
  on: "client_admin" as const,
  person: null,
  since: "2026-11-11T09:00:00.000Z",
  items: 1,
  nobodyToAct: null,
  emailOff: false,
};

describe("runPollMs", () => {
  it("polls fast only while a run is queued or running", () => {
    expect(runPollMs({ status: "queued" }, 2_000)).toBe(2_000);
    expect(runPollMs({ status: "running" }, 2_000)).toBe(2_000);
  });

  it("polls every 30 s while a run waits on a person, by its status or its wait", () => {
    expect(runPollMs({ status: "waiting" }, 2_000)).toBe(WAITING_POLL_MS);
    expect(runPollMs({ status: "running", waiting: wait }, 2_000)).toBe(WAITING_POLL_MS);
    expect(WAITING_POLL_MS).toBe(30_000);
  });

  it("stops once a run is over", () => {
    for (const status of ["succeeded", "failed", "cancelled"]) {
      expect(runPollMs({ status }, 2_000)).toBeNull();
    }
  });

  it("leaves what a waiting run is shown as alone", () => {
    expect(isRunGoing("waiting")).toBe(true);
    expect(runStatusTone("waiting")).toBe("warning");
  });
});

describe("runsPollMs", () => {
  it("takes the busiest run's rate, or none when every run is over", () => {
    expect(runsPollMs([], 5_000)).toBeNull();
    expect(runsPollMs([{ status: "succeeded" }, { status: "failed" }], 5_000)).toBeNull();
    expect(runsPollMs([{ status: "waiting" }, { status: "succeeded" }], 5_000)).toBe(30_000);
    expect(runsPollMs([{ status: "waiting" }, { status: "running" }], 5_000)).toBe(5_000);
  });
});
