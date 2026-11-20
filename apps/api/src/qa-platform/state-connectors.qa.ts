// STATE lens: connector writes under retries and repeats. `executeAction` re-runs an `executing`
// action whose lease ran out (a Worker that stopped mid-write) with the same idempotency key and
// `recheck: false`, and says connectors "must make writes idempotent by that key"
// (packages/agents/src/runtime/actions.ts). Here the same `executeWrite` calls a takeover makes.
import { DEFAULT_PERMISSIONS, type JsonObject } from "@countersign/core";
import { describe, expect, it } from "vitest";
import type { WriteContext } from "../../../../packages/connectors/src/connector";
import { memoryCredentials } from "../../../../packages/connectors/src/credentials-accessor";
import { executeWrite } from "../../../../packages/connectors/src/invoke";
import { memoryLogger } from "../../../../packages/connectors/src/logger";
import { fakeZoho, ZOHO_FIXTURES } from "../../../../packages/connectors/src/testing";
import { createZohoCrmConnector, ZOHO_TOOLS } from "../../../../packages/connectors/src/zoho_crm";

const tenant = "0190f0c8-0000-7000-8000-000000000001";
const connectionId = "0190f0c8-0000-7000-8000-0000000000c1";

function writeCtx(
  connector: string,
  externalAccountId: string,
  credentials: JsonObject,
  key: string,
  now: Date,
): WriteContext {
  return {
    tenantId: tenant,
    connection: {
      id: connectionId,
      tenantId: tenant,
      connector,
      status: "connected",
      externalAccountId,
      config: {},
      permissions: DEFAULT_PERMISSIONS,
    },
    credentials: memoryCredentials(credentials),
    logger: memoryLogger(),
    now: () => now,
    idempotencyKey: key,
  };
}

describe("STATE: connector writes executed once", () => {
  it("STATE-4: a Zoho CRM create taken over after a stopped try (same idempotency key) is not created a second time", async () => {
    const now = new Date("2026-11-04T15:00:00.000Z");
    const zoho = fakeZoho();
    const connector = createZohoCrmConnector({
      clientId: "1000.CLIENTID",
      clientSecret: "client-secret",
      fetch: zoho.fetch,
    });
    const credentials = {
      accessToken: ZOHO_FIXTURES.tokenCode.access_token,
      refreshToken: ZOHO_FIXTURES.tokenCode.refresh_token,
      expiresAt: "2026-11-04T16:00:00.000Z",
      accountsServer: "https://accounts.zoho.eu",
      apiDomain: "https://www.zohoapis.eu",
    } as JsonObject;
    const input = { module: "Leads", fields: { Last_Name: "Okafor", Company: "Okafor Joinery" } };
    const key = "run-1:create:1";
    // The first try sent the create; the Worker stopped before `complete` recorded it.
    await executeWrite(
      connector,
      ZOHO_TOOLS.create,
      input,
      writeCtx("zoho_crm", "20087654321", credentials, key, now),
    );
    // 25 minutes later the step's retry takes the action over and runs it again, same key.
    const retry = executeWrite(
      connector,
      ZOHO_TOOLS.create,
      input,
      writeCtx("zoho_crm", "20087654321", credentials, key, now),
      { recheck: false },
    ).catch((e: unknown) => e);
    await retry;
    const creates = zoho.apiCalls().filter((r) => r.method === "POST" && /\/Leads$/.test(r.url));
    // Executed once: the takeover returns the first result or goes to the operator as
    // unconfirmed (as Slack, Gmail, Teams and LinkedIn do), never a second lead.
    expect(creates).toHaveLength(1);
  });
});
