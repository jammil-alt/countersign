// Migration 0043 (R4 business hours, docs/plan.md §1.86): a person's own hours and away dates on
// `membership` and `contact`. It applies on a database the previous Worker used (nullable columns,
// no backfill), and the Worker's role reads and writes them only within its client, as before.

import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant } from "./client";
import { type ClientFixture, insertClient } from "./fixtures.test-helper";
import { contact, membership } from "./schema";
import {
  asWorker,
  createTestDatabase,
  databaseAvailable,
  migrateAsOwner,
  type TestDatabase,
} from "./testing";

const online = await databaseAvailable();

const AWAY = {
  hours: {
    tz: "America/Chicago",
    week: { mon: [{ from: "09:00", to: "17:00" }] },
    usHolidays: true,
    closed: [],
  },
  away: [{ from: "2026-12-24", to: "2026-12-31" }],
};

describe.skipIf(!online)("0043 on a database the previous Worker used", () => {
  let t: TestDatabase;

  beforeAll(async () => {
    const created = await createTestDatabase({ migrate: false });
    if (!created) throw new Error("database vanished");
    t = created;
    await migrateAsOwner(t.url, { upTo: "0042_second_factor" });
    const [tn] = await t.db.$client<{ id: string }[]>`
      insert into tenant (name) values ('Earlier') returning id`;
    const [u] = await t.db.$client<{ id: string }[]>`
      insert into app_user (email) values ('earlier@example.com') returning id`;
    await t.db.$client`
      insert into membership (tenant_id, user_id, role)
      values (${tn?.id ?? ""}, ${u?.id ?? ""}, 'client_admin')`;
    await t.db.$client`
      insert into contact (tenant_id, name, email)
      values (${tn?.id ?? ""}, 'Dana', 'dana@example.com')`;
    await migrateAsOwner(t.url);
  });
  afterAll(async () => {
    await t?.drop();
  });

  it("adds the columns, null for every existing row", async () => {
    const members = await t.db.$client<{ hours: unknown }[]>`select hours from membership`;
    const contacts = await t.db.$client<{ hours: unknown }[]>`select hours from contact`;
    expect(members.map((m) => m.hours)).toEqual([null]);
    expect(contacts.map((c) => c.hours)).toEqual([null]);
  });
});

describe.skipIf(!online)("person hours under the Worker's role (0043)", () => {
  let t: TestDatabase;
  let A: ClientFixture;
  let B: ClientFixture;

  beforeAll(async () => {
    const created = await createTestDatabase();
    if (!created) throw new Error("database vanished");
    t = created;
    A = await insertClient(t.db, "A");
    B = await insertClient(t.db, "B");
  });
  afterAll(async () => {
    await t?.drop();
  });

  it("writes and reads its own client's member and contact hours", async () => {
    const read = await withTenant(t.db, A.tenantId, async (tx) => {
      await asWorker(tx);
      await tx
        .update(membership)
        .set({ hours: AWAY })
        .where(and(eq(membership.tenantId, A.tenantId), eq(membership.userId, A.userId)));
      await tx.update(contact).set({ hours: AWAY }).where(eq(contact.tenantId, A.tenantId));
      const [m] = await tx
        .select({ hours: membership.hours })
        .from(membership)
        .where(eq(membership.userId, A.userId));
      const cs = await tx.select({ hours: contact.hours }).from(contact);
      return { member: m?.hours, contacts: cs.map((c) => c.hours) };
    });
    expect(read.member).toEqual(AWAY);
    expect(read.contacts.length).toBeGreaterThan(0);
    for (const h of read.contacts) expect(h).toEqual(AWAY);
  });

  it("never reaches another client's rows", async () => {
    const changed = await withTenant(t.db, A.tenantId, async (tx) => {
      await asWorker(tx);
      const m = await tx
        .update(membership)
        .set({ hours: AWAY })
        .where(eq(membership.tenantId, B.tenantId))
        .returning();
      const c = await tx
        .update(contact)
        .set({ hours: AWAY })
        .where(eq(contact.tenantId, B.tenantId))
        .returning();
      return m.length + c.length;
    });
    expect(changed).toBe(0);
    const [bm] = await t.db
      .select({ hours: membership.hours })
      .from(membership)
      .where(eq(membership.tenantId, B.tenantId));
    expect(bm?.hours).toBeNull();
  });
});
