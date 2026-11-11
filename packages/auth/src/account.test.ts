import { describe, expect, it } from "vitest";
import {
  ACCOUNT_WINDOW_SEC,
  accountFresh,
  compactAccount,
  cookieFits,
  expandAccount,
  MAX_COOKIE_BYTES,
} from "./account";

const account = {
  at: 1000,
  user: { id: "u-1", email: "ada@millwork.test", name: null },
  memberships: [{ tenantId: "t-1", tenantName: "Millwork", role: "client_admin" as const }],
};

describe("the carried account", () => {
  it("round-trips through its compact form, for its own user only", () => {
    const compact = JSON.parse(JSON.stringify(compactAccount(account)));
    expect(expandAccount(compact, "u-1")).toEqual(account);
    expect(expandAccount(compact, "u-2")).toBeNull();
    expect(expandAccount({ ...compact, m: [{ t: "t-1", n: "x", r: "owner" }] }, "u-1")).toBeNull();
    expect(expandAccount(undefined, "u-1")).toBeNull();
  });

  it("is fresh for the window only, and never from the future", () => {
    expect(accountFresh(account, 1000)).toBe(true);
    expect(accountFresh(account, 1000 + ACCOUNT_WINDOW_SEC - 1)).toBe(true);
    expect(accountFresh(account, 1000 + ACCOUNT_WINDOW_SEC)).toBe(false);
    expect(accountFresh(account, 999)).toBe(false);
  });

  it("measures a cookie in bytes", () => {
    expect(cookieFits("a".repeat(MAX_COOKIE_BYTES))).toBe(true);
    expect(cookieFits("é".repeat(MAX_COOKIE_BYTES / 2 + 1))).toBe(false);
  });
});
