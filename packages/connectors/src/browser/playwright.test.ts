// The Playwright adapter's liveness check (docs/plan.md §1.86): a held session asks before it opens
// a fresh browser, so a page Browser Run closed, or a browser that no longer answers, reads dead.

import { describe, expect, it } from "vitest";
import { type PlaywrightPageLike, playwrightTab } from "./playwright";

function pageLike(opts: { closed?: boolean; answers?: boolean }): PlaywrightPageLike {
  return {
    isClosed: () => opts.closed ?? false,
    context: () => ({
      cookies: async () => {
        if (opts.answers === false)
          throw new Error("Target page, context or browser has been closed");
        return [];
      },
      addCookies: async () => undefined,
    }),
  } as unknown as PlaywrightPageLike;
}

describe("playwrightTab.alive", () => {
  it("is alive while the browser answers; dead once closed, by us or by Browser Run", async () => {
    const close = async () => undefined;
    expect(await playwrightTab(pageLike({}), { close }).alive?.()).toBe(true);
    expect(await playwrightTab(pageLike({ closed: true }), { close }).alive?.()).toBe(false);
    expect(await playwrightTab(pageLike({ answers: false }), { close }).alive?.()).toBe(false);
    const tab = playwrightTab(pageLike({}), { close });
    await tab.close();
    expect(await tab.alive?.()).toBe(false);
  });
});
