// Overnight S8.2 (Sentry MEZONAS-API-C): a client's Twilio credentials sealed under a client key
// that was retired after staging's master key was lost. The hourly texting pass reads the
// subaccount's credentials back with Mezonas' main account and stores them anew; without the main
// account it marks the connection as needing attention once and skips it after. Fake Twilio only.

import {
  CredentialCipher,
  createTwilioConnector,
  generateEncryptionKey,
  readTwilioConfig,
  tenantKeysInDb,
} from "@countersign/connectors";
import { FAKE_TWILIO_MAIN, fakeTwilio } from "@countersign/connectors/testing";
import { connection, connectionChange, tenantKey } from "@countersign/db";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type ApiHarness, createApiHarness, OPERATOR } from "./api.test-helper";
import { A2P_CRON_MINUTE, a2pCronTick } from "./messaging/a2p";

const ENCRYPTION_KEY = generateEncryptionKey();
const twilio = fakeTwilio();

const h = await createApiHarness({
  connectors: () => [createTwilioConnector({ fetch: twilio.fetch })],
  env: {
    ENCRYPTION_KEY,
    APP_ORIGIN: "https://app.mezonas.test",
    TWILIO_ACCOUNT_SID: FAKE_TWILIO_MAIN.accountSid,
    TWILIO_AUTH_TOKEN: FAKE_TWILIO_MAIN.authToken,
  },
  fetch: twilio.fetch,
});
afterAll(() => h?.close());

describe.skipIf(!h)("a Twilio connection whose client key was lost", () => {
  const H = h as ApiHarness;
  const errors: unknown[][] = [];

  const cron = async (env = H.env) => {
    const at = new Date();
    at.setUTCMinutes(A2P_CRON_MINUTE, 0, 0);
    await a2pCronTick(H.db, { env, fetch: twilio.fetch }, at);
  };
  const twilioRow = async (tenantId: string) => {
    const [row] = await H.t.db
      .select()
      .from(connection)
      .where(and(eq(connection.tenantId, tenantId), eq(connection.connector, "twilio")));
    if (!row) throw new Error("no Twilio connection");
    return row;
  };
  const changes = async (connectionId: string, kind: string) =>
    H.t.db
      .select({ change: connectionChange.change })
      .from(connectionChange)
      .where(
        and(
          eq(connectionChange.connectionId, connectionId),
          sql`${connectionChange.change}->>'kind' = ${kind}`,
        ),
      );
  /** As staging after 2026-11-21: the client's key retired, wrapped by a master key now gone. */
  const loseKey = async (tenantId: string) => {
    const gone = await CredentialCipher.create({ current: generateEncryptionKey() });
    const wrapped = await gone.wrap(crypto.getRandomValues(new Uint8Array(32)), tenantId);
    await H.t.db
      .update(tenantKey)
      .set({ status: "retired", wrappedKey: wrapped, retiredAt: new Date() })
      .where(eq(tenantKey.tenantId, tenantId));
  };

  beforeAll(async () => {
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args);
    });
    for (const id of [H.A.tenantId, H.B.tenantId]) {
      const p = await H.call(OPERATOR, "POST", `/api/ops/clients/${id}/messaging/twilio`);
      expect(p.status, JSON.stringify(p.json)).toBe(200);
      // Followed hourly: its campaign is verified (stage `ready`).
      const row = await twilioRow(id);
      const config = row.config as Record<string, Record<string, unknown>>;
      await H.t.db
        .update(connection)
        .set({
          config: {
            ...config,
            a2p: { ...config.a2p, registration: { stage: "ready", fees: [], issues: [] } },
          },
        })
        .where(eq(connection.id, row.id));
    }
  });

  it("reads the subaccount's credentials back with the main account and stores them anew", async () => {
    await loseKey(H.A.tenantId);
    errors.length = 0;
    await cron();
    expect(errors.map((e) => String(e[0]))).not.toContain(
      `texting registration pass for client ${H.A.tenantId} failed`,
    );
    const row = await twilioRow(H.A.tenantId);
    expect(row.status).toBe("connected");
    const config = readTwilioConfig(row.config);
    const master = await CredentialCipher.create({ current: ENCRYPTION_KEY });
    const opened = await master
      .forClients(tenantKeysInDb(H.db))
      .decrypt(row.credentialsEncrypted, { tenantId: H.A.tenantId, connectionId: row.id });
    expect(opened).toMatchObject({ accountSid: config?.subaccountSid });
    expect((await changes(row.id, "credentials_restored")).map((c) => c.change)).toEqual([
      expect.objectContaining({ by: "system", reason: "key_lost", account: config?.subaccountSid }),
    ]);
    // A fresh active key under the current master; the lost one stays retired.
    const keys = await H.t.db
      .select({ status: tenantKey.status })
      .from(tenantKey)
      .where(eq(tenantKey.tenantId, H.A.tenantId));
    expect(keys.map((k) => k.status).sort()).toEqual(["active", "retired"]);
    // The next hour reads them as usual: nothing restored again.
    await cron();
    expect(await changes(row.id, "credentials_restored")).toHaveLength(1);
  });

  it("without the main account, marks the connection once and skips it after", async () => {
    await loseKey(H.B.tenantId);
    const { TWILIO_ACCOUNT_SID: _sid, TWILIO_AUTH_TOKEN: _token, ...noMain } = H.env;
    errors.length = 0;
    await cron(noMain);
    await cron(noMain);
    expect(errors.map((e) => String(e[0]))).not.toContain(
      `texting registration pass for client ${H.B.tenantId} failed`,
    );
    const row = await twilioRow(H.B.tenantId);
    expect(row.status).toBe("error");
    expect((await changes(row.id, "needs_attention")).map((c) => c.change)).toEqual([
      expect.objectContaining({
        reason: "signin_expired",
        before: "connected",
        after: "error",
        detail: expect.stringContaining("key_lost"),
      }),
    ]);
    // Client A's connection is its own.
    expect((await twilioRow(H.A.tenantId)).status).toBe("connected");
  });
});
