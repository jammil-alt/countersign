// The Playwright adapter's liveness check (docs/plan.md §1.86): a held session asks before it opens
// a fresh browser, so a page Browser Run closed, or a browser that no longer answers, reads dead.
// Its read-only mode (§1.86 "Scripts (wave 4)"): only GET and HEAD leave the browser.

import { describe, expect, it } from "vitest";
import { type PlaywrightPageLike, type PlaywrightRouteLike, playwrightTab } from "./playwright";

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

describe("playwrightTab.readOnly", () => {
  type Handler = (route: PlaywrightRouteLike) => unknown;
  function routed() {
    const handlers: Handler[] = [];
    const page = {
      route: async (_url: string, handler: Handler) => {
        handlers.push(handler);
      },
    } as unknown as PlaywrightPageLike;
    /** A request through the page's route: whether it went out. */
    const send = async (method: string): Promise<"sent" | "aborted"> => {
      let outcome: "sent" | "aborted" = "sent";
      const route: PlaywrightRouteLike = {
        request: () => ({ method: () => method }),
        abort: async () => {
          outcome = "aborted";
        },
        continue: async () => {
          outcome = "sent";
        },
      };
      for (const h of handlers) await h(route);
      return outcome;
    };
    return { page, handlers, send };
  }

  it("aborts every request but GET and HEAD while on, and nothing once off", async () => {
    const r = routed();
    const tab = playwrightTab(r.page, { close: async () => undefined });
    await tab.readOnly?.(true);
    expect(await r.send("POST")).toBe("aborted");
    expect(await r.send("put")).toBe("aborted");
    expect(await r.send("DELETE")).toBe("aborted");
    expect(await r.send("GET")).toBe("sent");
    expect(await r.send("HEAD")).toBe("sent");
    await tab.readOnly?.(false);
    expect(await r.send("POST")).toBe("sent");
    // One route for the page's life, however often it is turned on.
    await tab.readOnly?.(true);
    expect(await r.send("POST")).toBe("aborted");
    expect(r.handlers).toHaveLength(1);
  });
});
