// The vault's hourly upkeep warns about lost client keys only when one is active (Sentry
// MEZONAS-API-K): a retired key under a lost master key is what `retire-lost-keys.yml` leaves
// behind, counted apart and never warned about, every hour, forever.

import { CredentialCipher, generateEncryptionKey } from "@countersign/connectors";
import { createDb, type Db, tenant, tenantKey } from "@countersign/db";
import { createTestDatabase, type TestDatabase } from "@countersign/db/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const reportProblem = vi.hoisted(() =>
  vi.fn((_what: string, _tags?: Record<string, string>) => {}),
);
vi.mock("../observability/report", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../observability/report")>()),
  reportProblem,
}));

const { vaultTick } = await import("./upkeep");

const t = await createTestDatabase();

function workerUrl(url: string): string {
  const u = new URL(url);
  u.searchParams.set("options", "-c role=cs_worker");
  return u.toString();
}

describe.skipIf(!t)("vault upkeep and lost client keys", () => {
  const T = t as TestDatabase;
  const ENCRYPTION_KEY = generateEncryptionKey();
  let db: Db;
  let lostMaster: CredentialCipher;
  const raw = () => crypto.getRandomValues(new Uint8Array(32));
  const client = async (name: string) => {
    const [row] = await T.db.insert(tenant).values({ name }).returning();
    if (!row) throw new Error("no tenant");
    return row.id;
  };

  beforeAll(async () => {
    db = createDb(workerUrl(T.url), { max: 2 });
    // Staging, 2026-11-21: a deploy replaced the master key; the workflow retired its keys.
    lostMaster = await CredentialCipher.create({ current: generateEncryptionKey() });
  });
  afterAll(async () => {
    await db?.$client.end();
    await T?.drop();
  });

  it("doesn't warn about retired keys under a lost master, and counts them apart", async () => {
    const retired = await client("Retired after the loss");
    await T.db.insert(tenantKey).values({
      tenantId: retired,
      status: "retired",
      wrappedKey: await lostMaster.wrap(raw(), retired),
    });
    reportProblem.mockClear();
    const result = await vaultTick(db, { ENCRYPTION_KEY });
    expect(result).toMatchObject({ lostKeys: 0, retiredLostKeys: 1 });
    expect(reportProblem).not.toHaveBeenCalled();
  });

  it("warns once a run about an active key under a lost master", async () => {
    const active = await client("Not retired yet");
    await T.db.insert(tenantKey).values({
      tenantId: active,
      status: "active",
      wrappedKey: await lostMaster.wrap(raw(), active),
    });
    reportProblem.mockClear();
    const result = await vaultTick(db, { ENCRYPTION_KEY });
    expect(result).toMatchObject({ lostKeys: 1, retiredLostKeys: 1 });
    expect(reportProblem).toHaveBeenCalledTimes(1);
    expect(reportProblem).toHaveBeenCalledWith(
      "vault upkeep: client keys wrapped by a master key we no longer hold",
      { job: "vault", lost: "1" },
    );
  });
});
