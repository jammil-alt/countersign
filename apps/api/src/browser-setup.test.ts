// Setting up a website login on the Access page (POST /api/access/browser) when the code service
// fails part way or two set-ups of one site run at once (PLATFORM_QA FLOW-6, STATE-6): the client
// reads our own words, and no second login or orphan agent identity is left behind.

import {
  createBrowserConnector,
  FakeCodesService,
  generateEncryptionKey,
} from "@countersign/connectors";
import type { BrowserSiteProfileInput } from "@countersign/core";
import { connection } from "@countersign/db";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ApiHarness, admin, createApiHarness, OPERATOR } from "./api.test-helper";
import type { Bindings } from "./env";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

const TWILIO_TEXT =
  "Twilio: The requested resource /2010-04-01/Accounts/AC0000000000000000000000000000beef/IncomingPhoneNumbers.json was not found";

/**
 * The code service, with two knobs: Twilio refusing to sell a number (as apps/mfa answered before
 * FLOW-6), and the first set-up held inside `createIdentity` until the test lets it go.
 */
class SetupCodes extends FakeCodesService {
  refusePhone = false;
  calls = 0;
  hold: { entered: () => void; release: Promise<void> } | null = null;
  override async createIdentity(input: { tenantId: string; label: string }) {
    this.calls += 1;
    const hold = this.hold;
    if (hold && this.calls === 1) {
      hold.entered();
      await hold.release;
    }
    return super.createIdentity(input);
  }
  override async addPhone(input: { tenantId: string; identityId: string }) {
    if (this.refusePhone) {
      return { ok: false as const, error: { code: "unavailable" as const, message: TWILIO_TEXT } };
    }
    return super.addPhone(input);
  }
}

function profile(origin: string, kind: "sms" | "email"): BrowserSiteProfileInput {
  return {
    login: {
      url: `${origin}/login`,
      origins: [origin],
      usernameField: "#user",
      passwordField: "#pass",
      submitButton: "#go",
      secondFactor: {
        kind,
        sender: kind === "sms" ? "+15125550100" : `@${new URL(origin).hostname}`,
        pattern: "code is (\\d{6})",
        codeField: "#code",
        codeButton: "#verify",
      },
      signedIn: { selector: "#account" },
    },
    signOut: { url: `${origin}/logout` },
    allow: [`${origin}/home`],
  };
}

const codes = new SetupCodes();
const h = await createApiHarness({
  connectors: () => [createBrowserConnector({ codePoll: { intervalMs: 0, attempts: 1 } })],
  env: { ENCRYPTION_KEY: generateEncryptionKey(), CODES: codes } as Partial<Bindings>,
});
afterAll(() => h?.close());

describe.skipIf(!h)("website login set-up", () => {
  const H = h as ApiHarness;

  beforeAll(async () => {
    for (const [slug, origin, kind] of [
      ["texter", "https://portal.texter.test", "sms"],
      ["state-supplier", "https://portal.state-supplier.test", "email"],
    ] as const) {
      const made = await H.call(OPERATOR, "POST", "/api/ops/browser-sites", {
        slug,
        name: "Supplier portal",
        tier: "low",
        notes: "Terms allow automated access (checked 2026-11-05)",
        profile: profile(origin, kind),
      });
      expect(made.status, JSON.stringify(made.json)).toBe(200);
    }
    const offer = await H.call(OPERATOR, "PUT", `/api/ops/clients/${H.A.tenantId}/connectors`, {
      offered: ["testkit", "browser"],
    });
    expect(offer.status, JSON.stringify(offer.json)).toBe(200);
  });

  const logins = (site: string) =>
    H.t.db
      .select({ id: connection.id })
      .from(connection)
      .where(
        and(
          eq(connection.tenantId, H.A.tenantId),
          eq(connection.connector, "browser"),
          sql`${connection.config}->>'site' = ${site}`,
        ),
      );

  it("(PLATFORM_QA FLOW-6) a failed number purchase reads in our words, and leaves no identity behind", async () => {
    codes.refusePhone = true;
    try {
      const before = codes.identities.size;
      const res = await H.call(admin("a"), "POST", "/api/access/browser", { site: "texter" });
      expect(res.status).toBe(503);
      const message = String(j(res.json).error?.message ?? "");
      expect(j(res.json).error?.code).toBe("codes_unavailable");
      expect(message).not.toMatch(/Twilio|Accounts\/AC|IncomingPhoneNumbers/);
      expect(message).toMatch(/^we couldn't/);
      // The identity made before the number failed is removed, and no login was made.
      expect(codes.identities.size).toBe(before);
      expect(await logins("texter")).toHaveLength(0);
    } finally {
      codes.refusePhone = false;
    }
  });

  it("(PLATFORM_QA STATE-6) two set-ups of the same site at once make one login and one agent identity", async () => {
    const before = codes.identities.size;
    codes.calls = 0;
    let release: () => void = () => undefined;
    let entered: () => void = () => undefined;
    const inside = new Promise<void>((resolve) => {
      entered = resolve;
    });
    codes.hold = {
      entered,
      release: new Promise<void>((resolve) => {
        release = resolve;
      }),
    };
    try {
      const post = () =>
        H.call(admin("a"), "POST", "/api/access/browser", { site: "state-supplier" });
      // The first set-up is held inside the code service, past its check for a login.
      const one = post();
      await inside;
      const two = post();
      // The second either waits for the first (the fix) or reaches the code service too.
      const waiting = async () => {
        const [row] = await H.t.db.execute<{ n: number }>(
          sql`select count(*)::int as n from pg_locks
              where locktype = 'advisory' and not granted
                and database = (select oid from pg_database where datname = current_database())`,
        );
        return (row?.n ?? 0) > 0;
      };
      for (let i = 0; i < 500 && codes.calls < 2 && !(await waiting()); i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      release();
      const [first, second] = await Promise.all([one, two]);
      expect([first.status, second.status], JSON.stringify([first.json, second.json])).toEqual([
        200, 409,
      ]);
      expect(j(second.json).error?.code).toBe("conflict");
      expect(await logins("state-supplier")).toHaveLength(1);
      expect(codes.identities.size - before).toBe(1);
    } finally {
      release();
      codes.hold = null;
    }
  });
});
