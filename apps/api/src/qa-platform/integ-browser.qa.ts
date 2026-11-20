// INTEG lens: the browser connector when the code service (apps/mfa) is down, at its cap, or
// holding a stale wait. Drives the real `withBrowserSession` path (browser.page.read through
// runReadTool) with the connector's own fakes: FakeCodesService behind fakeCodesPort (as
// apps/api's codesPort wraps the CODES binding), FakeSupplierPortal behind FakeBrowserDriver.

import { describe, expect, it } from "vitest";
import {
  failure,
  ORIGIN,
  setUp,
} from "../../../../packages/connectors/src/browser/browser.test-helper";

describe("INTEG browser: code-service trouble is not the client's failed sign-in", () => {
  it("INTEG-1: two code-service outages (openWait throws) do not stop the connection", async () => {
    const s = setUp();
    await s.identify();
    // The CODES binding throws (the Worker is down, an RPC error): apps/api's codesClient
    // rethrows it, or answers CodesServiceError("bad_response").
    s.codes.openWait = async () => {
      throw new Error("code service: RPC failed (service unavailable)");
    };
    await failure(s.read(`${ORIGIN}/invoices`));
    await failure(s.read(`${ORIGIN}/invoices`));
    // Nothing was typed wrong and the site never refused the login: our own service was down.
    expect(s.portal.signIns).toBe(0);
    expect(s.state.value?.failures ?? 0).toBe(0);
    expect(s.stops).toEqual([]);
    expect(s.connection.status).toBe("connected");
  });

  it("INTEG-1: the code service's own daily cap does not count as a failed sign-in", async () => {
    const s = setUp();
    await s.identify();
    // apps/mfa answers `daily_cap` once the identity used its code requests for the day
    // (identity.ts openWait); fakeCodesPort turns it into a thrown error, as codesClient does.
    s.codes.openWait = async () => ({
      ok: false,
      error: { code: "daily_cap", message: "this identity reached its 20 code requests for today" },
    });
    await failure(s.read(`${ORIGIN}/invoices`));
    await failure(s.read(`${ORIGIN}/invoices`));
    expect(s.stops).toEqual([]);
    expect(s.connection.status).toBe("connected");
  });
});

describe("INTEG browser: one failed claim during the code poll", () => {
  it("INTEG-1: a single code-service error while polling for the code is polled past, not a failed sign-in", async () => {
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
});

describe("INTEG browser: a sign-in's wait outlives it", () => {
  it("INTEG-2: a timed-out sign-in's open wait does not take the next sign-in's code", async () => {
    const s = setUp();
    await s.identify();
    const email = [...s.codes.identities.values()][0]?.email ?? "";
    // Try 1: the site's email is slow, so no code arrives during the claim's poll (45 x 2 s
    // = 90 s in production, while the wait stays open 180 s). The sign-in fails.
    s.portal.options.codeTo = { codes: s.codes, email: "nobody@agents.mezonas.test" };
    expect(await failure(s.read(`${ORIGIN}/invoices`))).toMatch(/no sign-in code arrived/);
    expect(s.state.value?.failures).toBe(1);
    // Try 2, inside the first wait's 180 s: the site emails a fresh code to the identity.
    s.portal.options.codeTo = { codes: s.codes, email };
    // Expected: try 2 claims the code its own submit triggered and signs in.
    const second = await s.read(`${ORIGIN}/invoices`).then(
      () => "signed in",
      (e: Error) => `${e.name}: ${e.message}`,
    );
    // The code the site sent for try 2 must not land in try 1's wait (never claimed again).
    expect(s.codes.waits[0]?.code ?? null).toBeNull();
    expect(second).toBe("signed in");
    expect(s.stops).toEqual([]);
    expect(s.connection.status).toBe("connected");
  });
});
