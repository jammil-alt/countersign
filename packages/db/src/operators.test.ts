// Inviting an operator from the "Add operator" workflow: an unclaimed app_user row plus an operator
// membership in every client; twice is the same as once; a client user is never promoted.

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withOperator } from "./client";
import { addOperator, removeOperator } from "./operators";
import { appUser, auditEvent, membership, tenant } from "./schema";
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

  it("works on an empty database: an invite with no clients yet", async () => {
    const r = await addOperator(t.db, { email: "first@mezonas.test" });
    expect(r).toMatchObject({ created: true, clients: 0 });
    const [row] = await t.db.select().from(appUser).where(eq(appUser.id, r.userId));
    expect(row).toMatchObject({ email: "first@mezonas.test", workosUserId: null });
  });

  it("invites by lowercased email into every client, and changes nothing the second time", async () => {
    await seed(t.db);
    const first = await addOperator(t.db, { email: "  Owner@Mezonas.TEST ", name: "Owner" });
    expect(first).toMatchObject({ created: true, clients: 2 });
    const [row] = await t.db.select().from(appUser).where(eq(appUser.id, first.userId));
    expect(row).toMatchObject({ email: "owner@mezonas.test", name: "Owner", workosUserId: null });
    expect((await memberships(first.userId)).map((m) => m.role)).toEqual(["operator", "operator"]);

    const second = await addOperator(t.db, { email: "owner@mezonas.test" });
    expect(second).toEqual({ userId: first.userId, created: false, clients: 2 });
    expect(await memberships(first.userId)).toHaveLength(2);
  });

  it("refuses to make a client user an operator, and rejects a non-address", async () => {
    await expect(addOperator(t.db, { email: "admin@demo-client.example.com" })).rejects.toThrow(
      /client_admin of a client/,
    );
    await expect(addOperator(t.db, { email: "not an email" })).rejects.toThrow(/not an email/);
  });

  it("removes an operator from every client, with an audit row, and never the last one", async () => {
    // The seed and the tests above leave one operator (owner@mezonas.test) plus the seed's.
    const second = await addOperator(t.db, { email: "leaver@mezonas.test" });
    expect(await memberships(second.userId)).toHaveLength(2);

    const r = await removeOperator(t.db, { email: " Leaver@Mezonas.test ", by: "run 42" });
    expect(r).toEqual({ userId: second.userId, clients: 2 });
    expect(await memberships(second.userId)).toEqual([]);
    const [user] = await t.db.select().from(appUser).where(eq(appUser.id, second.userId));
    expect(user?.email).toBe("leaver@mezonas.test");
    const tenantIds = (await t.db.select({ id: tenant.id }).from(tenant)).map((x) => x.id);
    const audit = await withOperator(t.db, tenantIds, (tx) =>
      tx.select().from(auditEvent).where(eq(auditEvent.action, "operator.remove")),
    );
    expect(audit).toEqual([
      expect.objectContaining({
        actorKind: "system",
        outcome: "ok",
        tenantId: null,
        target: { user: second.userId, clients: "2", by: "run 42" },
      }),
    ]);

    await expect(removeOperator(t.db, { email: "leaver@mezonas.test" })).rejects.toThrow(
      /not an operator/,
    );
    await expect(removeOperator(t.db, { email: "nobody@mezonas.test" })).rejects.toThrow(/no user/);

    // Down to one operator: refused.
    const ops = await withOperator(t.db, tenantIds, (tx) =>
      tx
        .selectDistinct({ userId: membership.userId })
        .from(membership)
        .where(eq(membership.role, "operator")),
    );
    for (const o of ops.slice(1)) {
      const [u] = await t.db.select().from(appUser).where(eq(appUser.id, o.userId));
      await removeOperator(t.db, { email: u?.email ?? "" });
    }
    const [last] = await t.db
      .select()
      .from(appUser)
      .where(eq(appUser.id, ops[0]?.userId ?? ""));
    await expect(removeOperator(t.db, { email: last?.email ?? "" })).rejects.toThrow(
      /last operator/,
    );
  });
});
