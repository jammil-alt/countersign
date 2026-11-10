// The Playwright adapter's liveness check (docs/plan.md §1.86): a held session asks before it opens
// a fresh browser, so a page Browser Run closed, or a browser that no longer answers, reads dead.
// Its read-only mode (§1.86 "Scripts (wave 4)"): only GET and HEAD leave the browser, from the
// page and from any popup or new page of its context.

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
  /** A fake context: its routes see every page's requests, the tab's own and its popups'. */
  function routed() {
    const handlers: Handler[] = [];
    const pageRoutes: Handler[] = [];
    const context = {
      cookies: async () => [],
      addCookies: async () => undefined,
      route: async (_url: string, handler: Handler) => {
        handlers.push(handler);
      },
    };
    const page = {
      context: () => context,
      // A page-level route would miss a popup: the adapter must not use it.
      route: async (_url: string, handler: Handler) => {
        pageRoutes.push(handler);
      },
    } as unknown as PlaywrightPageLike;
    /** A request from any page of the context (the tab or a popup): whether it went out. */
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
    return { page, handlers, pageRoutes, send };
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

  it("filters on the page's context, so a popup or a new page is held too", async () => {
    const r = routed();
    const tab = playwrightTab(r.page, { close: async () => undefined });
    await tab.readOnly?.(true);
    expect(r.pageRoutes).toHaveLength(0);
    expect(r.handlers).toHaveLength(1);
    // A popup's form post goes through the same context's route.
    expect(await r.send("POST")).toBe("aborted");
  });
});
