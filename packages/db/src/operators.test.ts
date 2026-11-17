// Inviting an operator from the "Add operator" workflow: an unclaimed app_user row plus an operator
// membership in every client; an empty environment gets its first client (Mezonas); twice is the
// same as once; a client user is never promoted. Removing one (`db:remove-operator`): every operator
// membership, their named items and leads let go, one audit row, never the last operator.

import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withOperator } from "./client";
import { addOperator, removeOperator } from "./operators";
import { appUser, auditEvent, inboxItem, membership, tenant } from "./schema";
import { seed } from "./seed";
import { createTestDatabase, databaseAvailable, type TestDatabase } from "./testing";

const online = await databaseAvailable();

describe.skipIf(!online)("addOperator", () => {
  let t: TestDatabase;
  beforeAll(async () => {
    const created = await createTestDatabase();
    if (!created) throw new Error("database vanished");
    t = created;
  });
  afterAll(async () => {
    await t?.drop();
  });

  const memberships = async (userId: string) => {
    const tenantIds = (await t.db.select({ id: tenant.id }).from(tenant)).map((r) => r.id);
    return withOperator(t.db, tenantIds, (tx) =>
      tx
        .select({ tenantId: membership.tenantId, role: membership.role })
        .from(membership)
        .where(eq(membership.userId, userId)),
    );
  };

  it("on an empty database, creates the first client and makes the invite its operator", async () => {
    const r = await addOperator(t.db, { email: "first@mezonas.test" });
    expect(r).toMatchObject({ created: true, clients: 1, createdClient: "Mezonas" });
    const [row] = await t.db.select().from(appUser).where(eq(appUser.id, r.userId));
    expect(row).toMatchObject({ email: "first@mezonas.test", workosUserId: null });
    const clients = await t.db.select().from(tenant);
    expect(clients).toEqual([
      expect.objectContaining({
        name: "Mezonas",
        timezone: "America/Chicago",
        settings: { connectors_offered: [] },
      }),
    ]);
    expect(await memberships(r.userId)).toEqual([{ tenantId: clients[0]?.id, role: "operator" }]);
    // Run again: no second client.
    const again = await addOperator(t.db, { email: "first@mezonas.test" });
    expect(again).toMatchObject({ created: false, clients: 1, createdClient: null });
    expect(await t.db.select().from(tenant)).toHaveLength(1);
  });

  it("invites by lowercased email into every client, and changes nothing the second time", async () => {
    await seed(t.db);
    const first = await addOperator(t.db, { email: "  Owner@Mezonas.TEST ", name: "Owner" });
    // Mezonas (from the first test) and the seed's two clients.
    expect(first).toMatchObject({ created: true, clients: 3, createdClient: null });
    const [row] = await t.db.select().from(appUser).where(eq(appUser.id, first.userId));
    expect(row).toMatchObject({ email: "owner@mezonas.test", name: "Owner", workosUserId: null });
    expect((await memberships(first.userId)).map((m) => m.role)).toEqual([
      "operator",
      "operator",
      "operator",
    ]);

    const second = await addOperator(t.db, { email: "owner@mezonas.test" });
    expect(second).toEqual({
      userId: first.userId,
      created: false,
      clients: 3,
      createdClient: null,
    });
    expect(await memberships(first.userId)).toHaveLength(3);
  });

  it("audits each add: the user, the clients, whether it was new and who ran it", async () => {
    const r = await addOperator(t.db, { email: "audited@mezonas.test", by: "someone, run 7" });
    await addOperator(t.db, { email: "audited@mezonas.test" });
    const tenantIds = (await t.db.select({ id: tenant.id }).from(tenant)).map((x) => x.id);
    const rows = await withOperator(t.db, tenantIds, (tx) =>
      tx.select().from(auditEvent).where(eq(auditEvent.action, "operator.add")),
    );
    const mine = rows.filter((x) => (x.target as { user?: string }).user === r.userId);
    expect(mine).toEqual([
      expect.objectContaining({
        actorKind: "system",
        outcome: "ok",
        tenantId: null,
        target: { user: r.userId, clients: "3", created: "true", by: "someone, run 7" },
      }),
      expect.objectContaining({
        target: { user: r.userId, clients: "3", created: "false" },
      }),
    ]);
  });

  it("refuses to make a client user an operator, and rejects a non-address", async () => {
    await expect(addOperator(t.db, { email: "admin@demo-client.example.com" })).rejects.toThrow(
      /client_admin of a client/,
    );
    await expect(addOperator(t.db, { email: "not an email" })).rejects.toThrow(/not an email/);
  });

  it("removes an operator from every client, lets go of their items and leads, and audits it", async () => {
    // The tests above leave first@ (Mezonas), owner@ and audited@ (all three) and the seed's operator.
    const leaver = await addOperator(t.db, { email: "leaver@mezonas.test" });
    expect(await memberships(leaver.userId)).toHaveLength(3);
    const tenantIds = (await t.db.select({ id: tenant.id }).from(tenant)).map((r) => r.id);
    const led = tenantIds[0] as string;
    const [item, done] = await withOperator(t.db, tenantIds, async (tx) => {
      await tx
        .update(tenant)
        .set({
          settings: sql`jsonb_set(${tenant.settings}, '{lead}'::text[], jsonb_build_object('userId', ${leaver.userId}::text))`,
        })
        .where(eq(tenant.id, led));
      return tx
        .insert(inboxItem)
        .values([
          {
            tenantId: led,
            kind: "request",
            title: "Lead check",
            assigneeRole: "operator",
            assigneeUserId: leaver.userId,
          },
          {
            tenantId: led,
            kind: "request",
            title: "Done already",
            assigneeRole: "operator",
            assigneeUserId: leaver.userId,
            status: "resolved",
          },
        ])
        .returning({ id: inboxItem.id });
    });

    const r = await removeOperator(t.db, { email: " Leaver@Mezonas.test ", by: "run 42" });
    expect(r).toEqual({ userId: leaver.userId, clients: 3, reassigned: 1, leads: 1 });
    expect(await memberships(leaver.userId)).toEqual([]);
    // The user stays: history and the audit log name them.
    const [row] = await t.db.select().from(appUser).where(eq(appUser.id, leaver.userId));
    expect(row?.email).toBe("leaver@mezonas.test");
    const after = await withOperator(t.db, tenantIds, async (tx) => ({
      items: await tx
        .select({ id: inboxItem.id, role: inboxItem.assigneeRole, user: inboxItem.assigneeUserId })
        .from(inboxItem)
        .where(eq(inboxItem.assigneeRole, "operator")),
      client: (await tx.select().from(tenant).where(eq(tenant.id, led)))[0],
      audit: await tx.select().from(auditEvent).where(eq(auditEvent.action, "operator.remove")),
    }));
    expect(after.items).toEqual(
      expect.arrayContaining([
        { id: item?.id, role: "operator", user: null },
        // A resolved item keeps who answered it.
        { id: done?.id, role: "operator", user: leaver.userId },
      ]),
    );
    expect(after.client?.settings).toMatchObject({ lead: null });
    expect(after.audit).toEqual([
      expect.objectContaining({
        actorKind: "system",
        outcome: "ok",
        tenantId: null,
        target: { user: leaver.userId, clients: "3", reassigned: "1", leads: "1", by: "run 42" },
      }),
    ]);

    await expect(removeOperator(t.db, { email: "leaver@mezonas.test" })).rejects.toThrow(
      /not an operator/,
    );
    await expect(removeOperator(t.db, { email: "nobody@mezonas.test" })).rejects.toThrow(/no user/);
    await expect(removeOperator(t.db, { email: "admin@demo-client.example.com" })).rejects.toThrow(
      /not an operator/,
    );
  });

  it("never removes the last operator", async () => {
    await removeOperator(t.db, { email: "first@mezonas.test" });
    await removeOperator(t.db, { email: "audited@mezonas.test" });
    await removeOperator(t.db, { email: "operator@example.com" });
    await expect(removeOperator(t.db, { email: "owner@mezonas.test" })).rejects.toThrow(
      /last operator/,
    );
    const tenantIds = (await t.db.select({ id: tenant.id }).from(tenant)).map((r) => r.id);
    const [owner] = await t.db
      .select()
      .from(appUser)
      .where(eq(appUser.email, "owner@mezonas.test"));
    expect(await memberships(owner?.id ?? "")).toHaveLength(tenantIds.length);
  });
});
