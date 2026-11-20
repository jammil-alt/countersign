import { describe, expect, it } from "vitest";
import { CASE_TIMEOUT_MS, staleRun } from "./partial";

// INTEG-2: a suite run whose job never started (or died) is read as finished once every case's
// step would have timed out.
describe("staleRun", () => {
  const now = new Date("2026-11-20T12:00:00Z");
  const ago = (ms: number) => new Date(now.getTime() - ms);

  it("keeps a running run running within its cases' time", () => {
    expect(staleRun({ status: "running", createdAt: ago(CASE_TIMEOUT_MS) }, 1, now)).toBe(false);
    expect(staleRun({ status: "running", createdAt: ago(3 * CASE_TIMEOUT_MS) }, 4, now)).toBe(
      false,
    );
  });

  it("reads a running run past every case's timeout as finished", () => {
    expect(staleRun({ status: "running", createdAt: ago(CASE_TIMEOUT_MS + 61_000) }, 1, now)).toBe(
      true,
    );
  });

  it("never reads a finished run as stale", () => {
    expect(staleRun({ status: "done", createdAt: ago(10 * CASE_TIMEOUT_MS) }, 1, now)).toBe(false);
  });
});
