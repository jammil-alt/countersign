// Migration 0034 (message translation, ARCHITECTURE §5.7; docs/plan.md §1.69) beyond what the RLS,
// immutability, purge and migration tests walk for every table: it applies on a database the
// previous Worker used (its contacts and usage rows keep working with the new defaults), a
// translation has exactly one original of the same client, one `translated` row per original,
// field and language, and the checks its writers rely on.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createTestDatabase,
  databaseAvailable,
  migrateAsOwner,
  type TestDatabase,
} from "./testing";

const online = await databaseAvailable();

const UNIQUE = "23505";
const CHECK = "23514";
const FOREIGN_KEY = "23503";

async function errorCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    const e = error as { code?: string; cause?: { code?: string } };
    return e.code ?? e.cause?.code ?? "unknown";
  }
  return undefined;
}

describe.skipIf(!online)("0034 on a database the previous Worker used", () => {
  let t: TestDatabase;
  let tenantId = "";
  let otherId = "";
  let rawId = "";
  let otherRawId = "";
  let messageId = "";

  beforeAll(async () => {
    const created = await createTestDatabase({ migrate: false });
    if (!created) throw new Error("database vanished");
    t = created;
    await migrateAsOwner(t.url, { upTo: "0033_purchasing" });
    // The previous Worker's rows: two clients, a contact, a day of usage, a text and a thread line.
    const [a] = await t.db.$client<{ id: string }[]>`
      insert into tenant (name) values ('Earlier') returning id`;
    const [b] = await t.db.$client<{ id: string }[]>`
      insert into tenant (name) values ('Other') returning id`;
    tenantId = a?.id ?? "";
    otherId = b?.id ?? "";
    await t.db.$client`
      insert into contact (tenant_id, name, phone) values (${tenantId}, 'Pat', '+15555550100')`;
    await t.db.$client`
      insert into usage_platform_daily (tenant_id, day, documents) values (${tenantId}, '2026-11-07', 2)`;
    for (const [tenant, sid] of [
      [tenantId, "SM1"],
      [otherId, "SM2"],
    ] as const) {
      const [c] = await t.db.$client<{ id: string }[]>`
        insert into connection (tenant_id, connector) values (${tenant}, 'twilio') returning id`;
      const [r] = await t.db.$client<{ id: string }[]>`
        insert into raw_record (tenant_id, connection_id, connector, entity_type, external_id, payload)
        values (${tenant}, ${c?.id ?? ""}, 'twilio', 'Message', ${sid},
                ${JSON.stringify({ direction: "in", text: "Hola, ¿mañana?" })}::jsonb)
        returning id`;
      if (tenant === tenantId) rawId = r?.id ?? "";
      else otherRawId = r?.id ?? "";
    }
    const [th] = await t.db.$client<{ id: string }[]>`
      insert into thread (tenant_id, title) values (${tenantId}, 'Lead') returning id`;
    const [m] = await t.db.$client<{ id: string }[]>`
      insert into message (tenant_id, thread_id, sender_type, body)
      values (${tenantId}, ${th?.id ?? ""}, 'system', ${JSON.stringify({ text: "Hola" })}::jsonb)
      returning id`;
    messageId = m?.id ?? "";
    await migrateAsOwner(t.url);
  });
  afterAll(async () => {
    await t?.drop();
  });

  it("gives earlier contacts and usage rows their defaults, and adds the table empty", async () => {
    const [c] = await t.db.$client<{ translation: unknown }[]>`select translation from contact`;
    expect(c?.translation).toEqual({});
    const [u] = await t.db.$client<{ documents: number; translations: number }[]>`
      select documents, translations from usage_platform_daily`;
    expect({ ...u }).toEqual({ documents: 2, translations: 0 });
    const [n] = await t.db.$client<
      { n: number }[]
    >`select count(*)::int as n from message_translation`;
    expect(n?.n).toBe(0);
    // The previous Worker's inserts, which name neither column, still work.
    await t.db.$client`
      insert into contact (tenant_id, name, phone) values (${tenantId}, 'Lee', '+15555550101')`;
    await t.db.$client`
      insert into usage_platform_daily (tenant_id, day, documents) values (${tenantId}, '2026-11-08', 1)`;
  });

  const insert = (values: Record<string, unknown>) => {
    const row = {
      tenant_id: tenantId,
      raw_record_id: null,
      message_id: null,
      reach_out_id: null,
      direction: "in",
      source_language: "es",
      target_language: "en",
      detected_by: "rule",
      status: "translated",
      text: "Hello, tomorrow?",
      ...values,
    };
    return t.db.$client`
      insert into message_translation ${t.db.$client(row as Record<string, string | null>)}`;
  };

  it("stores one translated row per original, field and language; other outcomes repeat", async () => {
    await insert({ raw_record_id: rawId });
    expect(await errorCode(insert({ raw_record_id: rawId }))).toBe(UNIQUE);
    // Another field of the same original, or another language, is its own translation.
    await insert({ raw_record_id: rawId, field: "subject" });
    await insert({ raw_record_id: rawId, target_language: "fr", text: "Bonjour, demain ?" });
    // A skipped or capped attempt carries no text and may repeat.
    for (let i = 0; i < 2; i++) {
      await insert({ raw_record_id: rawId, status: "capped", reason: "daily_limit", text: null });
    }
    await insert({ message_id: messageId, target_language: "en" });
    expect(await errorCode(insert({ message_id: messageId }))).toBe(UNIQUE);
  });

  it("refuses a row with no original, two originals, or text that doesn't fit its status", async () => {
    expect(await errorCode(insert({}))).toBe(CHECK);
    expect(await errorCode(insert({ raw_record_id: rawId, message_id: messageId }))).toBe(CHECK);
    expect(await errorCode(insert({ raw_record_id: rawId, status: "skipped" }))).toBe(CHECK);
    expect(await errorCode(insert({ raw_record_id: rawId, text: null }))).toBe(CHECK);
    expect(await errorCode(insert({ raw_record_id: rawId, status: "done", text: null }))).toBe(
      CHECK,
    );
    expect(
      await errorCode(insert({ raw_record_id: rawId, target_language: "unknown", text: "x" })),
    ).toBe(CHECK);
    expect(await errorCode(insert({ raw_record_id: rawId, source_language: "ja" }))).toBe(CHECK);
    expect(await errorCode(insert({ raw_record_id: rawId, field: "subject", tokens_in: -1 }))).toBe(
      CHECK,
    );
  });

  it("keeps a translation in its original's client", async () => {
    // Client A's row can't point at client B's raw record, or name client B's agent version.
    expect(await errorCode(insert({ raw_record_id: otherRawId }))).toBe(FOREIGN_KEY);
    expect(
      await errorCode(insert({ raw_record_id: otherRawId, tenant_id: otherId, message_id: null })),
    ).toBeUndefined();
    expect(
      await errorCode(insert({ tenant_id: otherId, message_id: messageId, raw_record_id: null })),
    ).toBe(FOREIGN_KEY);
  });
});
