// The welcome link (docs/plan.md §1.149): signed over the client, the intake, the person and the
// expiry under its own label; a forged, altered or foreign token reads as nothing, an expired one
// reads as expired.

import { describe, expect, it } from "vitest";
import { signFormLink } from "../forms/link";
import { signWelcomeLink, verifyWelcomeLink, welcomeLinkExpiry, welcomeLinkUrl } from "./link";

const env = { ENCRYPTION_KEY: "welcome-test-key-0123456789abcdef", ENVIRONMENT: "staging" };
const T = "0192f1a0-0000-7000-8000-000000000001";
const I = "0192f1a0-0000-7000-8000-000000000002";
const P = "0192f1a0-0000-7000-8000-000000000003";
const NOW = Date.parse("2026-11-17T12:00:00Z");
const LATER = Math.floor(NOW / 1000) + 3600;

describe("the welcome link", () => {
  it("reads back what it signed, the same each time", async () => {
    const token = await signWelcomeLink(env, { t: T, i: I, p: P, e: LATER });
    expect(await signWelcomeLink(env, { p: P, e: LATER, t: T, i: I })).toBe(token);
    expect(await verifyWelcomeLink(env, token, NOW)).toEqual({
      payload: { t: T, i: I, p: P, e: LATER },
      expired: false,
    });
  });

  it("reads an expired link as expired, not as nothing", async () => {
    const token = await signWelcomeLink(env, { t: T, i: I, p: P, e: LATER });
    expect((await verifyWelcomeLink(env, token, (LATER + 1) * 1000))?.expired).toBe(true);
  });

  it("refuses a forged, altered, foreign or malformed token", async () => {
    const token = await signWelcomeLink(env, { t: T, i: I, p: P, e: LATER });
    const [body, sig] = token.split(".") as [string, string];
    // Another key.
    const other = await signWelcomeLink(
      { ...env, ENCRYPTION_KEY: "another-key-0123456789abcdef0000" },
      { t: T, i: I, p: P, e: LATER },
    );
    expect(await verifyWelcomeLink(env, other, NOW)).toBeNull();
    // A later expiry with the old signature.
    const longer = btoa(JSON.stringify({ t: T, i: I, p: P, e: LATER + 10 ** 6 }))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(await verifyWelcomeLink(env, `${longer}.${sig}`, NOW)).toBeNull();
    // The form link's key is another label: its tokens never open this page.
    const form = await signFormLink(env, { t: T, r: I, e: LATER });
    expect(await verifyWelcomeLink(env, form, NOW)).toBeNull();
    for (const bad of ["", "x", `${body}.`, `${body}.${sig}.x`, `${body}.${sig}`.repeat(30)]) {
      expect(await verifyWelcomeLink(env, bad, NOW)).toBeNull();
    }
  });

  it("is made only with the key in production", async () => {
    await expect(
      signWelcomeLink({ ENVIRONMENT: "production" }, { t: T, i: I, p: P, e: LATER }),
    ).rejects.toThrow(/ENCRYPTION_KEY/);
  });

  it("works for 14 days and points at /start/<token>", async () => {
    const sent = new Date(NOW);
    const expiresAt = welcomeLinkExpiry(sent);
    expect(expiresAt.getTime() - NOW).toBe(14 * 24 * 60 * 60 * 1000);
    const url = await welcomeLinkUrl(
      { origin: "https://app.mezonas.com", env },
      { tenantId: T, intakeId: I, personId: P, expiresAt },
    );
    expect(url).toMatch(/^https:\/\/app\.mezonas\.com\/start\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });
});
