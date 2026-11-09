// Inviting an operator from the "Add operator" workflow: an unclaimed app_user row plus an operator
// membership in every client; an empty environment gets its first client (Mezonas); twice is the
// same as once; a client user is never promoted.

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withOperator } from "./client";
import { addOperator } from "./operators";
import { appUser, membership, tenant } from "./schema";
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

  it("refuses to make a client user an operator, and rejects a non-address", async () => {
    await expect(addOperator(t.db, { email: "admin@demo-client.example.com" })).rejects.toThrow(
      /client_admin of a client/,
    );
    await expect(addOperator(t.db, { email: "not an email" })).rejects.toThrow(/not an email/);
  });
});
