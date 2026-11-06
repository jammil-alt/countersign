// The cron checks in with Sentry's cron monitor (./scheduled.ts), so a cron that stops is news.

import { describe, expect, it, vi } from "vitest";

const withMonitor = vi.fn((_slug: string, fn: () => Promise<unknown>) => fn());
const captureException = vi.fn();
vi.mock("@sentry/cloudflare", async (real) => ({
  ...(await real<object>()),
  withMonitor,
  captureException,
}));
const runCron = vi.fn(async () => {});
vi.mock("./app", () => ({ runCron }));

const { scheduled, CRON_MONITOR, CRON_MONITOR_CONFIG } = await import("./scheduled");

describe("the scheduled handler", () => {
  it("runs the tick inside the Sentry cron monitor, on the wrangler schedule", async () => {
    const waits: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => waits.push(p) };
    scheduled(
      { scheduledTime: Date.UTC(2026, 10, 6, 12, 0), cron: "* * * * *" } as ScheduledController,
      {} as never,
      ctx as never,
    );
    await Promise.all(waits);
    expect(withMonitor).toHaveBeenCalledWith(
      CRON_MONITOR,
      expect.any(Function),
      CRON_MONITOR_CONFIG,
    );
    expect(runCron).toHaveBeenCalledOnce();
    expect(CRON_MONITOR_CONFIG.schedule.value).toBe("* * * * *");
  });

  it("reports a failed tick and still fails the invocation", async () => {
    runCron.mockRejectedValueOnce(new Error("database unreachable"));
    const waits: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => waits.push(p) };
    scheduled(
      { scheduledTime: Date.UTC(2026, 10, 6, 12, 1), cron: "* * * * *" } as ScheduledController,
      {} as never,
      ctx as never,
    );
    await expect(waits[0]).rejects.toThrow("database unreachable");
    expect(captureException).toHaveBeenCalledWith(expect.any(Error), { tags: { kind: "cron" } });
  });
});
