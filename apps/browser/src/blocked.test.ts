// The browser service's copy of the blocked tier's hosts is core's list, matched the same way
// (core's own tests cover the matching in depth).

import { BROWSER_BLOCKED_HOSTS, blockedHost as coreBlockedHost } from "@countersign/core";
import { describe, expect, it } from "vitest";
import { BLOCKED_HOSTS, blockedHost } from "./blocked";

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
    ]) {
      expect(blockedHost(host), host).toBe(coreBlockedHost(host));
    }
  });
});
