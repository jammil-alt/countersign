// FLOW lens: what a client sees when a tool's sign-in comes back without a connection. The portal's
// callback page (`/connections/:connector/callback`) posts every query parameter to
// `POST /api/connections/:connector/callback` and shows the API's message as it is.
import { createZohoCrmConnector, generateEncryptionKey } from "@countersign/connectors";
import { fakeZoho } from "@countersign/connectors/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ApiHarness, admin, createApiHarness, OPERATOR } from "../api.test-helper";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

const zoho = fakeZoho();
const h = await createApiHarness({
  connectors: () => [
    createZohoCrmConnector({
      clientId: "1000.CLIENT",
      clientSecret: "zoho-secret",
      fetch: zoho.fetch,
    }),
  ],
  env: {
    ENCRYPTION_KEY: generateEncryptionKey(),
    OAUTH_STATE_SECRET: "state-secret-".repeat(4),
    APP_ORIGIN: "https://app.mezonas.test",
  },
});
afterAll(() => h?.close());

describe.skipIf(!h)("FLOW: OAuth callback refusals", () => {
  const H = h as ApiHarness;

  beforeAll(async () => {
    const offer = await H.call(OPERATOR, "PUT", `/api/ops/clients/${H.B.tenantId}/connectors`, {
      offered: ["testkit", "zoho_crm"],
    });
    expect(offer.status, JSON.stringify(offer.json)).toBe(200);
  });

  it("FLOW-1: a link with any ?error= text never puts that text on the Mezonas page", async () => {
    // Anyone can mail a client a link to app.mezonas.com/connections/zoho_crm/callback?error=...;
    // the page posts the query as it is. No sign-in was started: there is not even a state.
    const planted = "Your account is suspended. Call 555-0100 to restore it";
    const res = await H.call(admin("b"), "POST", "/api/connections/zoho_crm/callback", {
      params: { error: planted },
    });
    expect(res.status).toBe(400);
    // Expected: our own words (you cancelled, or the sign-in didn't finish), never the link's.
    expect(j(res.json).error.message).not.toContain(planted);
  });

  it("FLOW-1: a person who presses Deny at the provider is told so in plain words", async () => {
    const start = await H.call(admin("b"), "POST", "/api/connections/zoho_crm/authorize");
    const state = new URL(j(start.json).redirectUrl).searchParams.get("state") ?? "";
    const res = await H.call(admin("b"), "POST", "/api/connections/zoho_crm/callback", {
      params: { error: "access_denied", state },
    });
    expect(res.status).toBe(400);
    // Expected: no OAuth error code in what the client reads.
    expect(j(res.json).error.message).not.toMatch(/access_denied/);
  });
});
