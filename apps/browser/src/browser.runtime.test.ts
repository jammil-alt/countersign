// The browser service inside workerd, through the real `Browsers` entry point. Browser Run is not
// bound here (as in local development), so `open` answers `no_browser` and browser tools stay off;
// a request outside the contract is refused before anything is launched.

import { exports } from "cloudflare:workers";
import type { BrowserTab } from "@countersign/connectors";
import { describe, expect, it } from "vitest";
import { RemoteTab } from "./service";

const browsers = exports.Browsers;

describe("Browsers.open", () => {
  it("answers no_browser without Browser Run", async () => {
    const none = { ok: false, error: { code: "no_browser", message: "no browser is set up here" } };
    expect(await browsers.open({ hosts: ["portal.supplier.test"] })).toEqual(none);
    expect(await browsers.open({ hosts: ["portal.supplier.test"], keepAliveMs: 300_000 })).toEqual(
      none,
    );
  });

  it("refuses a request outside the contract", async () => {
    const invalid = { ok: false, error: { code: "invalid", message: "invalid open request" } };
    for (const input of [
      { hosts: "portal.supplier.test" },
      { hosts: [""] },
      { hosts: ["a.test"], keepAliveMs: "long" },
    ]) {
      expect(await browsers.open(input as never)).toEqual(invalid);
    }
  });
});

describe("RemoteTab", () => {
  it("closes the browser when apps/api lets go of it without closing", async () => {
    let closed = 0;
    const tab = {
      url: () => "about:blank",
      close: async () => {
        closed++;
      },
    } as unknown as BrowserTab;
    const remote = new RemoteTab(tab);
    remote[Symbol.dispose]();
    expect(closed).toBe(1);
  });
});

describe("the Worker over HTTP", () => {
  it("has no routes", async () => {
    const r = await exports.default.fetch("http://browser.test/anything");
    expect(r.status).toBe(404);
  });
});
