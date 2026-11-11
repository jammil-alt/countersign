// The Browser Run opener's launch options (docs/plan.md §1.86): a held session's browser stays
// open as long as its run may wait between calls, within Browser Run's documented range; one
// tool call's keeps Browser Run's default. `@cloudflare/playwright` is stood in for: it needs the
// Worker.

import { beforeEach, describe, expect, it, vi } from "vitest";

const launched: Record<string, unknown>[] = [];
const contexts: Record<string, unknown>[] = [];
const page = { isClosed: () => false, context: () => ({ cookies: async () => [] }) };

vi.mock("@cloudflare/playwright", () => ({
  launch: async (_binding: unknown, options: Record<string, unknown>) => {
    launched.push(options);
    return {
      newContext: async (options: Record<string, unknown>) => {
        contexts.push(options);
        return { newPage: async () => page };
      },
      close: async () => undefined,
    };
  },
}));

const { BROWSER_RUN_KEEP_ALIVE, browserRunKeepAlive, browserRunOpener } = await import("./driver");

describe("Browser Run opener", () => {
  beforeEach(() => {
    launched.length = 0;
    contexts.length = 0;
  });

  it("makes a context with no downloads and no service workers (read only can't see theirs)", async () => {
    const open = browserRunOpener({ BROWSER: {} as never });
    if (!open) throw new Error("no opener");
    await open({ hosts: ["portal.supplier.test"] });
    expect(contexts).toEqual([{ acceptDownloads: false, serviceWorkers: "block" }]);
  });

  it("keeps a held session's browser for its run's wait, within Browser Run's range", async () => {
    const open = browserRunOpener({ BROWSER: {} as never });
    if (!open) throw new Error("no opener");
    const one = await open({ hosts: ["portal.supplier.test"] });
    await open({ hosts: ["portal.supplier.test"], keepAliveMs: 5 * 60_000 });
    await open({ hosts: ["portal.supplier.test"], keepAliveMs: 60 * 60_000 });
    await open({ hosts: ["portal.supplier.test"], keepAliveMs: 1 });
    expect(launched.map((o) => o.keep_alive)).toEqual([
      BROWSER_RUN_KEEP_ALIVE.default,
      300_000,
      BROWSER_RUN_KEEP_ALIVE.max,
      BROWSER_RUN_KEEP_ALIVE.min,
    ]);
    expect(launched[0]).toMatchObject({ recording: false });
    expect(await one?.alive?.()).toBe(true);
  });

  it("clamps to Browser Run's documented 10 s to 10 min", () => {
    expect(BROWSER_RUN_KEEP_ALIVE).toEqual({ min: 10_000, max: 600_000, default: 60_000 });
    expect(browserRunKeepAlive(undefined)).toBe(60_000);
    expect(browserRunKeepAlive(Number.NaN)).toBe(60_000);
    expect(browserRunKeepAlive(299_999.6)).toBe(300_000);
  });
});
