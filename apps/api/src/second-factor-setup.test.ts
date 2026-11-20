// Which Twilio keys reach Verify for sign-in codes (docs/plan.md §1.100): the Verify subaccount's
// API key when it is set, else the main account's keys; half a key pair, or neither, fails closed.

import type { FetchLike } from "@countersign/connectors";
import { describe, expect, it } from "vitest";
import type { Bindings } from "./env";
import { secondFactorSetupOf } from "./second-factor";

const base = {
  AUTH_PROVIDER: "workos",
  WORKOS_CLIENT_ID: "client_test",
  WORKOS_API_KEY: "sk_test",
  WORKOS_COOKIE_PASSWORD: "p".repeat(64),
  APP_ORIGIN: "https://staging.mezonas.test",
  ENCRYPTION_KEY: "second-factor-setup-test-key-0123456789",
  TWILIO_VERIFY_SERVICE_SID: "VA00000000000000000000000000000009",
} as Partial<Bindings>;

/** The Basic credentials Verify was called with, after sending one code. */
async function credentialsUsed(env: Partial<Bindings>): Promise<string> {
  let auth = "";
  const fetch: FetchLike = async (_url, init) => {
    auth = init?.headers?.Authorization ?? init?.headers?.authorization ?? "";
    const body = JSON.stringify({ status: "pending" });
    return { status: 201, ok: true, headers: { get: () => null }, text: async () => body };
  };
  const setup = secondFactorSetupOf(env as Bindings, { fetch });
  if (setup.state !== "on") throw new Error(`setup is ${setup.state}`);
  await setup.config.verifier.sendCode("+15551234567", "sms");
  return atob(auth.replace(/^Basic /, ""));
}

describe("the sign-in step's Twilio keys (§1.100)", () => {
  it("uses the Verify subaccount's API key when it is set, not the main account's", async () => {
    expect(
      await credentialsUsed({
        ...base,
        TWILIO_ACCOUNT_SID: "AC_main",
        TWILIO_AUTH_TOKEN: "main-token",
        TWILIO_VERIFY_API_KEY_SID: "SK_verify",
        TWILIO_VERIFY_API_KEY_SECRET: "verify-secret",
      }),
    ).toBe("SK_verify:verify-secret");
  });

  it("uses the main account's keys without one", async () => {
    expect(
      await credentialsUsed({
        ...base,
        TWILIO_ACCOUNT_SID: "AC_main",
        TWILIO_AUTH_TOKEN: "main-token",
      }),
    ).toBe("AC_main:main-token");
  });

  it("fails closed on half a key pair, even with the main account's keys", () => {
    const setup = secondFactorSetupOf({
      ...base,
      TWILIO_ACCOUNT_SID: "AC_main",
      TWILIO_AUTH_TOKEN: "main-token",
      TWILIO_VERIFY_API_KEY_SID: "SK_verify",
    } as Bindings);
    expect(setup.state).toBe("misconfigured");
  });

  it("fails closed with no keys at all", () => {
    expect(secondFactorSetupOf(base as Bindings).state).toBe("misconfigured");
  });

  it("is off without its service", () => {
    expect(
      secondFactorSetupOf({
        ...base,
        TWILIO_VERIFY_SERVICE_SID: "",
        TWILIO_VERIFY_API_KEY_SID: "SK_verify",
      } as Bindings).state,
    ).toBe("off");
  });
});
