// FLOW lens: a client admin sets up a website login in the vault (Accounts, "Enter a login"). For a
// site that texts its codes, the code service buys the agent a number from Twilio; when that fails,
// the page shows the API's message as it is (an action's ErrorNotice in English: errorText).
import {
  createBrowserConnector,
  FakeCodesService,
  generateEncryptionKey,
} from "@countersign/connectors";
import type { BrowserSiteProfileInput } from "@countersign/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ApiHarness, admin, createApiHarness, OPERATOR } from "../api.test-helper";
import type { Bindings } from "../env";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

const ORIGIN = "https://portal.texter.test";
const TWILIO_TEXT =
  "Twilio: The requested resource /2010-04-01/Accounts/AC0000000000000000000000000000beef/IncomingPhoneNumbers.json was not found";

/** The code service as apps/mfa answers when Twilio refuses to sell a number (service.ts:131). */
class TwilioRefuses extends FakeCodesService {
  override async addPhone(_input: { tenantId: string; identityId: string }) {
    return { ok: false as const, error: { code: "unavailable" as const, message: TWILIO_TEXT } };
  }
}

const PROFILE: BrowserSiteProfileInput = {
  login: {
    url: `${ORIGIN}/login`,
    origins: [ORIGIN],
    usernameField: "#user",
    passwordField: "#pass",
    submitButton: "#go",
    secondFactor: {
      kind: "sms",
      sender: "+15125550100",
      pattern: "code is (\\d{6})",
      codeField: "#code",
      codeButton: "#verify",
    },
    signedIn: { selector: "#account" },
  },
  signOut: { url: `${ORIGIN}/logout` },
  allow: [`${ORIGIN}/home`],
};

const h = await createApiHarness({
  connectors: () => [createBrowserConnector({ codePoll: { intervalMs: 0, attempts: 1 } })],
  env: { ENCRYPTION_KEY: generateEncryptionKey(), CODES: new TwilioRefuses() } as Partial<Bindings>,
});
afterAll(() => h?.close());

describe.skipIf(!h)("FLOW: website login setup", () => {
  const H = h as ApiHarness;

  beforeAll(async () => {
    const made = await H.call(OPERATOR, "POST", "/api/ops/browser-sites", {
      slug: "texter",
      name: "Texting supplier",
      tier: "low",
      notes: "Terms allow automated access",
      profile: PROFILE,
    });
    expect(made.status, JSON.stringify(made.json)).toBe(200);
    const offer = await H.call(OPERATOR, "PUT", `/api/ops/clients/${H.A.tenantId}/connectors`, {
      offered: ["testkit", "browser"],
    });
    expect(offer.status, JSON.stringify(offer.json)).toBe(200);
  });

  it("FLOW-6: a failed number purchase reads in our words, never Twilio's text or account path", async () => {
    const res = await H.call(admin("a"), "POST", "/api/access/browser", { site: "texter" });
    // The page shows `error.message` of a 4xx/5xx action error in English (i18n/errors.ts:91).
    const message = String(j(res.json).error?.message ?? "");
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(message).not.toMatch(/Twilio/);
    expect(message).not.toMatch(/Accounts\/AC/);
  });
});
