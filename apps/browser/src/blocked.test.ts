// The browser service's copy of the blocked tier's hosts is core's list, matched the same way
// (core's own tests cover the matching in depth).

import { BROWSER_BLOCKED_HOSTS, blockedHost as coreBlockedHost } from "@countersign/core";
import { describe, expect, it } from "vitest";
import { BLOCKED_HOSTS, blockedHost, onBlockedSite } from "./blocked";

describe("the blocked hosts", () => {
  it("are core's list, entry for entry", () => {
    expect([...BLOCKED_HOSTS]).toEqual([...BROWSER_BLOCKED_HOSTS]);
  });

  it("match as core matches them", () => {
    for (const host of [
      "paypal.com",
      "www.paypal.com",
      "secure.chase.com.",
      "login.microsoftonline.com:443",
      "*.okta.com",
      "notpaypal.com",
      "paypal.com.example.test",
      "docs.google.com",
      "portal.supplier.test",
      "paypal.com..",
      "*.google.com",
      "*.googleusercontent.com",
      "*.x.paypal.com",
    ]) {
      expect(blockedHost(host), host).toBe(coreBlockedHost(host));
    }
  });

  it("find a listed site in an address, written any way", () => {
    for (const [url, blocked] of [
      ["https://paypal.com../", true],
      ["https://user:pw@paypal.com/", true],
      ["https://paypal.com@evil.test/", false],
      ["https://ｐａｙｐａｌ．ｃｏｍ/", true],
      ["https://acme.okta.com/", true],
      ["https://docs.google.com/", false],
      ["about:blank", false],
    ] as const) {
      expect(onBlockedSite(url), url).toBe(blocked);
    }
  });
});
