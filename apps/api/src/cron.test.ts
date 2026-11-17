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

const billingTick = vi.hoisted(() => vi.fn(async (_deps: unknown, _at: Date) => {}));
vi.mock("./billing/jobs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./billing/jobs")>()),
  billingTick,
}));
const vaultTick = vi.hoisted(() => vi.fn(async (_db: unknown, _env: unknown) => {}));
vi.mock("./vault/upkeep", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./vault/upkeep")>()),
  vaultTick,
}));
const purgeRetiredFiles = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => 0));
vi.mock("./compliance/retention", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./compliance/retention")>()),
  purgeRetiredFiles,
}));

const order: string[] = [];
const summaryPass = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => 0));
vi.mock("./account/summaries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./account/summaries")>()),
  summaryPass,
}));
vi.mock("./runs/reconcile", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./runs/reconcile")>()),
  reconcileRuns: vi.fn(async () => void order.push("reconcile")),
}));
vi.mock("./documents/sweep", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./documents/sweep")>()),
  readingSweep: vi.fn(async () => void order.push("reading")),
}));
summaryPass.mockImplementation(async () => {
  order.push("summaries");
  return 0;
});

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
    // No CODES binding: no code service step.
    expect(cronTick.mock.calls[0]?.[0]).not.toHaveProperty("codesTick");
  });

  it("adds the code service's alerts step in the same single call when CODES is bound", async () => {
    cronTick.mockClear();
    const deps = {
      ...defaultDeps,
      openDb: () => ({ db: {}, close: async () => {} }),
      instances: () => ({}),
      platform: () => ({}),
    } as unknown as typeof defaultDeps;
    const env = { CODES: {} } as unknown as Bindings;
    await runCron(env, new Date("2026-11-05T10:03:00Z"), deps);
    expect(cronTick).toHaveBeenCalledTimes(1);
    expect(cronTick.mock.calls[0]?.[0]).toHaveProperty("reachTick");
    expect(cronTick.mock.calls[0]?.[0]).toHaveProperty("codesTick");
  });

  it("calls a model only in its last pass, after every other pass of the tick", async () => {
    order.length = 0;
    cronTick.mockImplementationOnce(async () => void order.push("clients"));
    const deps = {
      ...defaultDeps,
      openDb: () => ({ db: {}, close: async () => {} }),
      instances: () => ({}),
      platform: () => ({}),
    } as unknown as typeof defaultDeps;
    await runCron({} as Bindings, new Date("2026-11-05T10:05:00Z"), deps);
    // Each client's schedules and deliveries (cronTick), the reconciler and the reading sweep, then
    // the summaries.
    expect(order).toEqual(["clients", "reconcile", "reading", "summaries"]);
    // The client pass carries no model step.
    expect(Object.keys(cronTick.mock.calls.at(-1)?.[0] ?? {})).not.toContain("afterClients");
  });

  it("still runs the vault, retention and pack passes when the billing pass throws", async () => {
    billingTick.mockRejectedValueOnce(new Error("stripe is down"));
    vaultTick.mockClear();
    purgeRetiredFiles.mockClear();
    const nightly = vi.fn(async () => {});
    const deps = {
      ...defaultDeps,
      openDb: () => ({ db: {}, close: async () => {} }),
      instances: () => ({}),
      platform: () => ({
        packs: [{ manifest: { id: "p" }, nightly: { hour: 10, minute: 7, run: nightly } }],
      }),
      objects: () => ({}),
    } as unknown as typeof defaultDeps;
    // Minute 7 is the usage sweep's: billing, the vault and retention run.
    await expect(
      runCron({} as Bindings, new Date("2026-11-05T10:07:00Z"), deps),
    ).resolves.toBeUndefined();
    expect(billingTick).toHaveBeenCalled();
    expect(vaultTick).toHaveBeenCalledOnce();
    expect(purgeRetiredFiles).toHaveBeenCalledOnce();
    expect(nightly).toHaveBeenCalledOnce();
  });
});
