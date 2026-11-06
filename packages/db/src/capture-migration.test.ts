// Migration 0031 (WhatsApp passive capture, ARCHITECTURE v0.14 §5.5, §6.12; docs/plan.md §1.55)
// beyond what the RLS, immutability, purge and migration tests walk for every table: it applies on
// a database the previous Worker used, the keys and checks the new tables rely on, same-client
// foreign keys, and the document source the capture writes.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ClientFixture, insertClient } from "./fixtures.test-helper";
import { CAPTURE_DEFAULT_MAX_BYTES, contact, conversation, conversationChange } from "./schema";
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

const SHA = (c: string) => c.repeat(64);

describe.skipIf(!online)("0031 on a database the previous Worker used", () => {
  let t: TestDatabase;
  let tenantId = "";
  let connectionId = "";

  beforeAll(async () => {
    const created = await createTestDatabase({ migrate: false });
    if (!created) throw new Error("database vanished");
    t = created;
    await migrateAsOwner(t.url, { upTo: "0030_builder_sessions" });
    // The previous Worker's rows: a client, a connection, an uploaded document and a contact.
    const [tn] = await t.db.$client<{ id: string }[]>`
      insert into tenant (name) values ('Earlier') returning id`;
    tenantId = tn?.id ?? "";
    const [cn] = await t.db.$client<{ id: string }[]>`
      insert into connection (tenant_id, connector) values (${tenantId}, 'twilio') returning id`;
    connectionId = cn?.id ?? "";
    await t.db.$client`
      insert into document (tenant_id, source, storage_key, mime_type, filename, size_bytes, sha256)
      values (${tenantId}, 'upload', 'k1', 'application/pdf', 'a.pdf', 10, ${SHA("a")})`;
    await t.db.$client`
      insert into contact (tenant_id, name, whatsapp) values (${tenantId}, 'Pat', '+15555550100')`;
    await migrateAsOwner(t.url);
  });
  afterAll(async () => {
    await t?.drop();
  });

  it("adds the two tables, empty, and leaves the documents as they were", async () => {
    const [conversations] = await t.db.$client<{ n: number }[]>`
      select count(*)::int as n from conversation`;
    const [changes] = await t.db.$client<{ n: number }[]>`
      select count(*)::int as n from conversation_change`;
    const docs = await t.db.$client<{ source: string }[]>`select source from document`;
    expect([conversations?.n, changes?.n]).toEqual([0, 0]);
    expect(docs.map((d) => d.source)).toEqual(["upload"]);
  });

  it("accepts a document sent in a message, and still refuses an unknown source", async () => {
    await t.db.$client`
      insert into document (tenant_id, connection_id, source, storage_key, mime_type, filename,
                            size_bytes, sha256)
      values (${tenantId}, ${connectionId}, 'message', 'k2', 'image/jpeg', 'w.jpg', 10, ${SHA("b")})`;
    expect(
      await errorCode(t.db.$client`
        insert into document (tenant_id, source, storage_key, mime_type, filename, size_bytes, sha256)
        values (${tenantId}, 'whatsapp', 'k3', 'image/jpeg', 'w.jpg', 10, ${SHA("c")})`),
    ).toBe(CHECK);
  });

  it("applies the rest of the journal once", async () => {
    const [row] = await t.db.$client<{ n: number }[]>`
      select count(*)::int as n from drizzle.__drizzle_migrations`;
    expect(row?.n).toBeGreaterThanOrEqual(32);
  });
});

describe.skipIf(!online)("conversation and conversation_change (0031)", () => {
  let t: TestDatabase;
  let A: ClientFixture;
  let B: ClientFixture;
  let contactA = "";
  let contactB = "";

  beforeAll(async () => {
    const created = await createTestDatabase();
    if (!created) throw new Error("database vanished");
    t = created;
    A = await insertClient(t.db, "A");
    B = await insertClient(t.db, "B");
    const [ca] = await t.db
      .insert(contact)
      .values({ tenantId: A.tenantId, name: "Sam", whatsapp: "+15555550199" })
      .returning();
    const [cb] = await t.db
      .insert(contact)
      .values({ tenantId: B.tenantId, name: "Sam B", whatsapp: "+15555550198" })
      .returning();
    contactA = ca?.id ?? "";
    contactB = cb?.id ?? "";
  });
  afterAll(async () => {
    await t?.drop();
  });

  const direct = () => ({
    tenantId: A.tenantId,
    connectionId: A.connectionId,
    channel: "whatsapp" as const,
    kind: "direct" as const,
    contactId: contactA,
    title: "Sam",
  });

  it("a direct conversation starts with archive on, attachments off, 20 MB", async () => {
    const [row] = await t.db.insert(conversation).values(direct()).returning();
    expect(row?.capture).toEqual({
      archive: true,
      attachments: "off",
      maxBytes: CAPTURE_DEFAULT_MAX_BYTES,
    });
    expect(row?.externalId).toBeNull();
  });

  it("one direct conversation per connection, channel and contact; SMS is its own", async () => {
    expect(await errorCode(t.db.insert(conversation).values(direct()))).toBe(UNIQUE);
    const [sms] = await t.db
      .insert(conversation)
      .values({ ...direct(), channel: "sms" })
      .returning();
    expect(sms?.channel).toBe("sms");
  });

  it("a group has the provider's id, once per connection and channel", async () => {
    const group = {
      tenantId: A.tenantId,
      connectionId: A.connectionId,
      channel: "whatsapp" as const,
      kind: "group" as const,
      externalId: "120363000000000000@g.us",
      title: "Site crew",
    };
    await t.db.insert(conversation).values(group);
    expect(await errorCode(t.db.insert(conversation).values(group))).toBe(UNIQUE);
  });

  it("checks the kind's shape, the channel, the title and the capture", async () => {
    for (const bad of [
      { ...direct(), contactId: null },
      { ...direct(), externalId: "x" },
      { ...direct(), kind: "group" as const, contactId: null, externalId: null },
      { ...direct(), channel: "email" as "sms" },
      { ...direct(), kind: "broadcast" as "direct" },
      { ...direct(), title: "" },
      { ...direct(), channel: "sms" as const, title: "x".repeat(201) },
    ]) {
      expect(await errorCode(t.db.insert(conversation).values(bad)), JSON.stringify(bad)).toBe(
        CHECK,
      );
    }
    const base = { archive: true, attachments: "off", maxBytes: 1024 };
    for (const capture of [
      { ...base, attachments: "some" },
      { ...base, maxBytes: 0 },
      { ...base, maxBytes: 32 * 1024 * 1024 + 1 },
      { ...base, maxBytes: "1024" },
      { ...base, archive: "yes" },
      { attachments: "off", maxBytes: 1024 },
      [base],
    ]) {
      expect(
        await errorCode(
          t.db
            .insert(conversation)
            .values({ ...direct(), channel: "sms", capture: capture as never }),
        ),
        JSON.stringify(capture),
      ).toBe(CHECK);
    }
  });

  it("the connection and contact belong to the conversation's client", async () => {
    for (const bad of [
      { ...direct(), contactId: contactB },
      { ...direct(), connectionId: B.connectionId },
    ]) {
      expect(await errorCode(t.db.insert(conversation).values(bad)), JSON.stringify(bad)).toBe(
        FOREIGN_KEY,
      );
    }
  });

  it("conversation_change: of the conversation's client, sides and shape checked", async () => {
    const values = {
      tenantId: A.tenantId,
      conversationId: A.conversationId,
      side: "operator" as const,
      change: { setting: "capture", before: {}, after: {}, reason: "Client asked" },
    };
    const [row] = await t.db.insert(conversationChange).values(values).returning();
    expect(row?.actorId).toBeNull();
    expect(
      await errorCode(t.db.insert(conversationChange).values({ ...values, tenantId: B.tenantId })),
    ).toBe(FOREIGN_KEY);
    for (const bad of [
      { ...values, side: "agent" as "system" },
      { ...values, change: ["capture"] as never },
    ]) {
      expect(
        await errorCode(t.db.insert(conversationChange).values(bad)),
        JSON.stringify(bad),
      ).toBe(CHECK);
    }
  });
});
