// The every-minute cron runs the run dispatcher once per tick, with the reach-out step: a second call
// without it (a merge leftover) doubled every tick's work.
import { describe, expect, it, vi } from "vitest";
import type { Bindings } from "./env";
import { defaultDeps } from "./http";

const cronTick = vi.hoisted(() => vi.fn(async (_deps: unknown, _at: Date) => {}));
vi.mock("./runs/dispatch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./runs/dispatch")>()),
  cronTick,
}));

const { runCron } = await import("./app");

describe("runCron", () => {
  it("dispatches once per tick, with the reach-out step", async () => {
    const close = vi.fn(async () => {});
    const deps = {
      ...defaultDeps,
      openDb: () => ({ db: {}, close }),
      instances: () => ({}),
      platform: () => ({}),
    } as unknown as typeof defaultDeps;
    // Minute 3 is not the usage sweep's minute, so billing doesn't run.
    await runCron({} as Bindings, new Date("2026-11-05T10:03:00Z"), deps);
    expect(cronTick).toHaveBeenCalledTimes(1);
    expect(cronTick.mock.calls[0]?.[0]).toHaveProperty("reachTick");
    expect(close).toHaveBeenCalledOnce();
  });
});
