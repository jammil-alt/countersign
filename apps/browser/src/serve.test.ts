// The tab as the browser service serves it, and as apps/api holds it (connectors'
// remoteBrowserTab): every answer brings the address back, inputs are checked, and a value typed
// by `fill` or a session set by `setCookies` never comes back, not even inside an error.

import {
  type BrowserTab,
  FakeBrowserDriver,
  FakeSupplierPortal,
  remoteBrowserTab,
} from "@countersign/connectors";
import { describe, expect, it } from "vitest";
import { serveTab } from "./serve";

const SECRET = "Hunter2-very-secret";

function tab(overrides: Partial<BrowserTab> = {}): BrowserTab & { log: string[] } {
  const log: string[] = [];
  let at = "about:blank";
  return {
    log,
    url: () => at,
    goto: async (url) => {
      log.push(`goto ${url}`);
      at = url;
    },
    fill: async (selector) => {
      log.push(`fill ${selector}`);
    },
    click: async (selector) => {
      log.push(`click ${selector}`);
      at = "https://portal.supplier.test/home";
    },
    has: async (selector) => selector === "#here",
    readText: async () => "page text",
    readTables: async () => [{ headers: ["a"], rows: [["1"]] }],
    textOf: async () => "one",
    controls: async () => [{ selector: "#go", kind: "button", label: "Go", submits: true }],
    sendsForm: async () => true,
    readOnly: async (on) => {
      log.push(`readOnly ${on}`);
    },
    download: async (url) => ({
      bytes: new Uint8Array([37, 80, 68, 70]),
      filename: "a.pdf",
      mimeType: "application/pdf",
      finalUrl: url,
      status: 200,
    }),
    cookies: async () => [],
    setCookies: async () => undefined,
    screenshot: async () => new Uint8Array([137, 80, 78, 71]),
    alive: async () => true,
    close: async () => {
      log.push("close");
    },
    ...overrides,
  };
}

describe("serveTab", () => {
  it("answers each call with the address the tab ended on", async () => {
    const t = tab();
    const served = serveTab(t);
    expect(await served.goto("https://portal.supplier.test/login")).toEqual({
      url: "https://portal.supplier.test/login",
      value: null,
    });
    expect(await served.click("#go")).toEqual({
      url: "https://portal.supplier.test/home",
      value: null,
    });
    expect(await served.has("#here")).toEqual({
      url: "https://portal.supplier.test/home",
      value: true,
    });
  });

  it("never hands back what fill typed, even when Playwright's error would", async () => {
    const served = serveTab(
      tab({
        fill: async (_s, value) => {
          throw new Error(`Timeout 20000ms exceeded while typing "${value}"`);
        },
      }),
    );
    const error = await served.fill("#pass", SECRET).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(String((error as Error).message)).toBe("the field could not be filled");
    expect(JSON.stringify(error)).not.toContain(SECRET);
    expect(String((error as Error).stack ?? "")).not.toContain(SECRET);
  });

  it("never hands back a session's cookies in an error", async () => {
    const served = serveTab(
      tab({
        setCookies: async (c) => {
          throw new Error(`bad cookie ${c[0]?.value}`);
        },
      }),
    );
    const cookie = {
      name: "sid",
      value: SECRET,
      domain: "portal.supplier.test",
      path: "/",
      expires: -1,
      httpOnly: true,
      secure: true,
      sameSite: "Lax" as const,
    };
    await expect(served.setCookies([cookie])).rejects.toThrow(
      /^the session could not be restored$/,
    );
  });

  it("never opens a site on the blocked list, and leaves one a page moved to", async () => {
    const t = tab();
    const served = serveTab(t);
    await expect(served.goto("https://www.paypal.com/myaccount")).rejects.toThrow(
      /^agents never open this site$/,
    );
    await expect(served.download("https://secure.chase.com/statement.pdf")).rejects.toThrow(
      /^agents never open this site$/,
    );
    expect(t.log).toEqual([]);

    // An allowed address that ends on a listed site, by a redirect or a click: left at once.
    let movedTo = "https://portal.supplier.test/home";
    const moved = tab({
      click: async () => {
        movedTo = "https://accounts.google.com/signin";
      },
      goto: async (url) => {
        moved.log.push(`goto ${url}`);
        movedTo = url === "about:blank" ? url : "https://login.microsoftonline.com/common";
      },
      url: () => movedTo,
    });
    const away = serveTab(moved);
    await expect(away.click("#sso")).rejects.toThrow(/^agents never open this site$/);
    expect(movedTo).toBe("about:blank");
    await expect(away.goto("https://portal.supplier.test/sso")).rejects.toThrow(
      /^agents never open this site$/,
    );
    expect(moved.log).toEqual([
      "goto about:blank",
      "goto https://portal.supplier.test/sso",
      "goto about:blank",
    ]);
  });

  it("reads nothing from a page that moved to a listed site by itself, and leaves it", async () => {
    let at = "https://accounts.google.com/signin";
    const t = tab({
      url: () => at,
      goto: async (url) => {
        t.log.push(`goto ${url}`);
        at = url;
      },
    });
    const served = serveTab(t);
    const reads = [
      () => served.readText(),
      () => served.readTables(),
      () => served.textOf("#a"),
      () => served.controls(),
      () => served.sendsForm("#f"),
      () => served.has("#a"),
      () => served.screenshot(),
      () => served.cookies(),
    ];
    for (const read of reads) {
      at = "https://accounts.google.com/signin";
      await expect(read()).rejects.toThrow(/^agents never open this site$/);
      expect(at).toBe("about:blank");
    }
    // On an ordinary page, reads go on.
    at = "https://portal.supplier.test/home";
    expect(await served.readText()).toEqual({ url: at, value: "page text" });
  });

  it("types only on the origins it is given, by the browser's own address now", async () => {
    let live = "https://portal.supplier.test/verify";
    const t = tab({
      url: () => "https://portal.supplier.test/verify",
      where: async () => live,
    });
    const served = serveTab(t);
    const origins = ["https://portal.supplier.test"];
    await served.fill("#code", "735019", origins);
    expect(t.log).toEqual(["fill #code"]);
    // The page moved by itself; the tab's last-known address still says the login origin.
    live = "https://login.evil.test/verify";
    await expect(served.fill("#code", "735019", origins)).rejects.toThrow(
      /^the page is not on an allowed origin; nothing was typed$/,
    );
    expect(t.log).toEqual(["fill #code"]);
    expect(await served.where()).toEqual({ url: "https://login.evil.test/verify", value: null });
    await expect(served.fill("#code", "1", [])).rejects.toThrow("invalid origins");
  });

  it("keeps a partitioned cookie's partition both ways", async () => {
    const kept: unknown[] = [];
    const cookie = {
      name: "sid",
      value: "v",
      domain: "portal.supplier.test",
      path: "/",
      expires: -1,
      httpOnly: true,
      secure: true,
      sameSite: "None" as const,
      partitionKey: "https://supplier.test",
    };
    const served = serveTab(
      tab({
        cookies: async () => [cookie],
        setCookies: async (c) => {
          kept.push(...c);
        },
      }),
    );
    const remote = remoteBrowserTab(served, "about:blank");
    expect(await remote.cookies()).toEqual([cookie]);
    await remote.setCookies([cookie]);
    expect(kept).toEqual([cookie]);
  });

  it("refuses input outside the contract before the browser sees it", async () => {
    const t = tab();
    const served = serveTab(t);
    await expect(served.fill("", "x")).rejects.toThrow("invalid selector");
    await expect(served.fill("#a", 7 as unknown as string)).rejects.toThrow("invalid value");
    await expect(served.goto(42 as unknown as string)).rejects.toThrow("invalid address");
    await expect(served.readOnly("yes" as unknown as boolean)).rejects.toThrow("invalid read-only");
    await expect(served.setCookies([{ name: 1 }] as never)).rejects.toThrow("invalid cookies");
    expect(t.log).toEqual([]);
  });
});

describe("remoteBrowserTab over serveTab", () => {
  it("keeps url() in step with the service's answers", async () => {
    const remote = remoteBrowserTab(serveTab(tab()), "about:blank");
    expect(remote.url()).toBe("about:blank");
    await remote.goto("https://portal.supplier.test/login");
    expect(remote.url()).toBe("https://portal.supplier.test/login");
    await remote.click("#go");
    expect(remote.url()).toBe("https://portal.supplier.test/home");
    expect(await remote.readTables()).toEqual([{ headers: ["a"], rows: [["1"]] }]);
    expect((await remote.download("https://portal.supplier.test/a.pdf")).bytes).toEqual(
      new Uint8Array([37, 80, 68, 70]),
    );
  });

  it("refuses an answer outside the contract", async () => {
    const served = serveTab(tab());
    const remote = remoteBrowserTab(
      { ...served, readText: async () => ({ url: "x", value: 42 }) as never },
      "about:blank",
    );
    await expect(remote.readText()).rejects.toThrow(/unexpected answer to readText/);
  });

  it("closes once, then reads dead; a service that stopped answering reads dead too", async () => {
    const t = tab();
    const remote = remoteBrowserTab(serveTab(t), "about:blank");
    expect(await remote.alive?.()).toBe(true);
    await remote.close();
    await remote.close();
    expect(t.log.filter((l) => l === "close")).toHaveLength(1);
    expect(await remote.alive?.()).toBe(false);
    const gone = remoteBrowserTab(
      {
        ...serveTab(tab()),
        alive: async () => {
          throw new Error("stub disposed");
        },
      },
      "about:blank",
    );
    expect(await gone.alive?.()).toBe(false);
  });

  it("reads a browser Browser Run closed as dead, as the connector's held session expects", async () => {
    const driver = new FakeBrowserDriver(new FakeSupplierPortal({ username: "u", password: "p" }));
    const local = await driver.open();
    const remote = remoteBrowserTab(serveTab(local), local.url());
    expect(remote.url()).toBe(local.url());
    expect(await remote.alive?.()).toBe(true);
    driver.killOpen();
    expect(await remote.alive?.()).toBe(false);
    await remote.close();
  });
});
