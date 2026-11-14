// The opener apps/api uses (docs/plan.md §1.26 "Browser driver"): the browser service behind the
// `BROWSER` service binding, stood in for here. Without the binding there is no browser; with it,
// a site's hosts and a held session's keep-alive are passed on as asked, and the tab answers
// through the service (the launch options themselves are apps/browser's driver.test.ts).

import type { BrowserOpenInput, BrowserService, BrowserTabService } from "@countersign/connectors";
import { describe, expect, it } from "vitest";
import { browserRunOpener } from "./driver";

function service(opened: "tab" | "no_browser" | "invalid" = "tab") {
  const asked: BrowserOpenInput[] = [];
  const calls: string[] = [];
  let at = "about:blank";
  const tab = {
    goto: async (url: string) => {
      calls.push(`goto ${url}`);
      at = url;
      return { url: at, value: null };
    },
    has: async () => ({ url: at, value: true }),
    alive: async () => true,
    close: async () => {
      calls.push("close");
    },
  } as unknown as BrowserTabService;
  const binding: BrowserService = {
    open: async (input) => {
      asked.push(input);
      return opened === "tab"
        ? { ok: true, url: at, tab }
        : { ok: false, error: { code: opened, message: `${opened} answer` } };
    },
  };
  return { binding, asked, calls };
}

describe("browserRunOpener", () => {
  it("is absent without the BROWSER service binding (local development)", () => {
    expect(browserRunOpener({})).toBeUndefined();
  });

  it("passes the hosts and a held session's keep-alive to the service", async () => {
    const s = service();
    const open = browserRunOpener({ BROWSER: s.binding });
    if (!open) throw new Error("no opener");
    await open({ hosts: ["portal.supplier.test"] });
    await open({ hosts: ["portal.supplier.test"], keepAliveMs: 300_000 });
    expect(s.asked).toEqual([
      { hosts: ["portal.supplier.test"] },
      { hosts: ["portal.supplier.test"], keepAliveMs: 300_000 },
    ]);
  });

  it("drives the service's tab, tracking where it is", async () => {
    const s = service();
    const tab = await browserRunOpener({ BROWSER: s.binding })?.({ hosts: ["a.test"] });
    if (!tab) throw new Error("no tab");
    await tab.goto("https://a.test/login");
    expect(tab.url()).toBe("https://a.test/login");
    expect(await tab.has("#user")).toBe(true);
    expect(await tab.alive?.()).toBe(true);
    await tab.close();
    expect(s.calls).toEqual(["goto https://a.test/login", "close"]);
  });

  it("answers null when the service has no browser, and fails on a refusal", async () => {
    const none = browserRunOpener({ BROWSER: service("no_browser").binding });
    expect(await none?.({ hosts: ["a.test"] })).toBeNull();
    const refused = browserRunOpener({ BROWSER: service("invalid").binding });
    await expect(refused?.({ hosts: ["a.test"] })).rejects.toThrow(/refused: invalid answer/);
  });

  it("refuses an answer outside the contract", async () => {
    for (const answer of [null, { ok: true, url: "about:blank" }, { ok: "yes" }, { ok: false }]) {
      const open = browserRunOpener({
        BROWSER: { open: async () => answer } as unknown as BrowserService,
      });
      await expect(open?.({ hosts: ["a.test"] })).rejects.toThrow(/unexpected answer to open/);
    }
  });
});
