// STATE lens: a double submit of the Access page's "set up a login" (POST /api/access/browser).
// The route checks for a login of the site, then makes an agent identity in the code service (and
// for a texted code buys a number), then inserts the connection; nothing in the database stops a
// second request that read "none" at the same time.
import {
  createBrowserConnector,
  FakeCodesService,
  generateEncryptionKey,
} from "@countersign/connectors";
import type { BrowserSiteProfileInput } from "@countersign/core";
import { connection } from "@countersign/db";
import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { type ApiHarness, admin, createApiHarness, OPERATOR } from "../api.test-helper";
import type { Bindings } from "../env";

const ORIGIN = "https://portal.state-supplier.test";
const PROFILE: BrowserSiteProfileInput = {
  login: {
    url: `${ORIGIN}/login`,
    origins: [ORIGIN],
    usernameField: "#user",
    passwordField: "#pass",
    submitButton: "#go",
    secondFactor: {
      kind: "email",
      sender: "@state-supplier.test",
      pattern: "code is (\\d{6})",
      codeField: "#code",
      codeButton: "#verify",
    },
    signedIn: { selector: "#account" },
  },
  signOut: { url: `${ORIGIN}/logout` },
  allow: [`${ORIGIN}/home`],
};

const codes = new FakeCodesService();
const h = await createApiHarness({
  connectors: () => [createBrowserConnector({ codePoll: { intervalMs: 0, attempts: 1 } })],
  env: { ENCRYPTION_KEY: generateEncryptionKey(), CODES: codes } as Partial<Bindings>,
});
afterAll(() => h?.close());

describe.skipIf(!h)("STATE: browser login set-up", () => {
  const H = h as ApiHarness;

  it("STATE-6: two set-ups of the same site at once (a double click) make one login and one agent identity", async () => {
    const made = await H.call(OPERATOR, "POST", "/api/ops/browser-sites", {
      slug: "state-supplier",
      name: "Supplier portal",
      tier: "low",
      notes: "Terms allow automated access (checked 2026-11-05)",
      profile: PROFILE,
    });
    expect(made.status, JSON.stringify(made.json)).toBe(200);
    const offer = await H.call(OPERATOR, "PUT", `/api/ops/clients/${H.A.tenantId}/connectors`, {
      offered: ["testkit", "browser"],
    });
    expect(offer.status, JSON.stringify(offer.json)).toBe(200);

    const identitiesBefore = codes.identities.size;
    const [one, two] = await Promise.all([
      H.call(admin("a"), "POST", "/api/access/browser", { site: "state-supplier" }),
      H.call(admin("a"), "POST", "/api/access/browser", { site: "state-supplier" }),
    ]);
    const rows = await H.t.db
      .select({ id: connection.id })
      .from(connection)
      .where(and(eq(connection.tenantId, H.A.tenantId), eq(connection.connector, "browser")));
    // One login for the site ("a login for this site is already set up" for the other) ...
    expect([one.status, two.status].sort()).toEqual([200, 409]);
    expect(rows).toHaveLength(1);
    // ... and one agent identity in the code service, not an orphan beside it.
    expect(codes.identities.size - identitiesBefore).toBe(1);
  });
});
