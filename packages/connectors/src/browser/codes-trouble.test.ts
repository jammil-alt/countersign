// The browser connector when our own code service (apps/mfa) is down, at its daily cap, misses one
// claim, or still holds a timed-out sign-in's wait (PLATFORM_QA INTEG-1, INTEG-2). Drives the real
// `withBrowserSession` path (browser.page.read through runReadTool) with the connector's own fakes.

import { describe, expect, it } from "vitest";
import { failure, ORIGIN, setUp } from "./browser.test-helper";

describe("code-service trouble is not the client's failed sign-in", () => {
  it("(PLATFORM_QA INTEG-1) two code-service outages (openWait throws) do not stop the connection", async () => {
    const s = setUp();
    await s.identify();
    s.codes.openWait = async () => {
      throw new Error("code service: RPC failed (service unavailable)");
    };
    expect(await failure(s.read(`${ORIGIN}/invoices`))).toMatch(/^CodesUnavailable: /);
    await failure(s.read(`${ORIGIN}/invoices`));
    // Nothing was typed and the site never refused the login: our own service was down.
    expect(s.portal.signIns).toBe(0);
    expect(s.state.value?.failures ?? 0).toBe(0);
    expect(s.stops).toEqual([]);
    expect(s.connection.status).toBe("connected");
  });

  it("(PLATFORM_QA INTEG-1) the code service's own daily cap does not count as a failed sign-in", async () => {
    const s = setUp();
    await s.identify();
    s.codes.openWait = async () => ({
      ok: false,
      error: { code: "daily_cap", message: "this identity reached its 20 code requests for today" },
    });
    expect(await failure(s.read(`${ORIGIN}/invoices`))).toMatch(/^CodesUnavailable: /);
    await failure(s.read(`${ORIGIN}/invoices`));
    expect(s.state.value?.failures ?? 0).toBe(0);
    expect(s.stops).toEqual([]);
    expect(s.connection.status).toBe("connected");
  });

  it("(PLATFORM_QA INTEG-1) a single code-service error while polling for the code is polled past", async () => {
    const s = setUp();
    await s.identify();
    const claim = s.codes.claim.bind(s.codes);
    let blips = 1;
    s.codes.claim = async (input) => {
      if (blips > 0) {
        blips -= 1;
        throw new Error("code service: RPC failed (connection reset)");
      }
      return claim(input);
    };
    const out = await s.read(`${ORIGIN}/invoices`).then(
      () => "signed in",
      (e: Error) => `${e.name}: ${e.message}`,
    );
    expect(out).toBe("signed in");
    expect(s.state.value?.failures ?? 0).toBe(0);
  });

  it("(PLATFORM_QA INTEG-1) a claim that fails on every poll is our trouble, not a failed sign-in", async () => {
    const s = setUp();
    await s.identify();
    s.codes.claim = async () => {
      throw new Error("code service: RPC failed (connection reset)");
    };
    expect(await failure(s.read(`${ORIGIN}/invoices`))).toMatch(/^CodesUnavailable: /);
    expect(s.state.value?.failures ?? 0).toBe(0);
    // The wait it opened is closed, so no later code lands in it.
    expect(s.codes.waits.every((w) => w.claimed)).toBe(true);
  });
});

describe("a sign-in's wait ends with it", () => {
  it("(PLATFORM_QA INTEG-2) a timed-out sign-in's open wait does not take the next sign-in's code", async () => {
    const s = setUp();
    await s.identify();
    const email = [...s.codes.identities.values()][0]?.email ?? "";
    // Try 1: the site's email is slow, so no code arrives during the claim's poll. It fails.
    s.portal.options.codeTo = { codes: s.codes, email: "nobody@agents.mezonas.test" };
    expect(await failure(s.read(`${ORIGIN}/invoices`))).toMatch(/no sign-in code arrived/);
    expect(s.state.value?.failures).toBe(1);
    // Try 2, inside the first wait's time: the site emails a fresh code to the identity.
    s.portal.options.codeTo = { codes: s.codes, email };
    const second = await s.read(`${ORIGIN}/invoices`).then(
      () => "signed in",
      (e: Error) => `${e.name}: ${e.message}`,
    );
    // The code the site sent for try 2 did not land in try 1's wait: try 2 claimed its own.
    expect(s.codes.waits[0]?.code ?? null).toBeNull();
    expect(second).toBe("signed in");
    expect(s.stops).toEqual([]);
    expect(s.connection.status).toBe("connected");
  });

  it("(PLATFORM_QA INTEG-2) every failed sign-in closes its wait, whatever failed", async () => {
    const s = setUp({ password: "not-the-password" });
    await s.identify();
    // The site refuses the password, so it never asks for a code.
    expect(await failure(s.read(`${ORIGIN}/invoices`))).toMatch(/SignInFailed/);
    expect(s.codes.waits).toHaveLength(1);
    expect(s.codes.waits.every((w) => w.claimed)).toBe(true);
  });
});
