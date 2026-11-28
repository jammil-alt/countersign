// Which connection a test copy is bound to (staging, 2026-11-27: the Sandbox kept its first,
// never-connected QuickBooks connection beside the one connected later, and every new test copy
// was bound to the dead one, so its first QuickBooks step failed "the connection is disconnected").
import { connection } from "@countersign/db";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createApiHarness } from "./api.test-helper";
import { connectionsToBind } from "./runs/bind-connections";

for (const level of process.env.SHOW_LOGS ? [] : (["warn", "error"] as const)) {
  vi.spyOn(console, level).mockImplementation(() => {});
}

const h = await createApiHarness();
afterAll(() => h?.close());

describe.skipIf(!h)("connectionsToBind", () => {
  const H = h as NonNullable<typeof h>;

  it("binds a connected connection before an older one that isn't, and moves a test copy off it", async () => {
    const tenantId = H.A.tenantId;
    const [dead] = await H.t.db
      .insert(connection)
      .values({ tenantId, connector: "qbo-bind", status: "disconnected" })
      .returning();
    const [live] = await H.t.db
      .insert(connection)
      .values({ tenantId, connector: "qbo-bind", status: "connected" })
      .returning();
    if (!dead || !live) throw new Error("no connections");
    const tx = H.t.db as never;
    const needed = ["qbo-bind", "none-here"];

    // Unbound: the connected one, though it is newer. A connector the client lacks stays unbound.
    expect(await connectionsToBind(tx, { tenantId, needed, bindings: {}, rebind: false })).toEqual({
      "qbo-bind": live.id,
    });
    // Bound to the dead one: a client agent keeps the operator's binding.
    const bindings = { "qbo-bind": dead.id };
    expect(await connectionsToBind(tx, { tenantId, needed, bindings, rebind: false })).toEqual({});
    // A test copy moves to the connected one.
    expect(await connectionsToBind(tx, { tenantId, needed, bindings, rebind: true })).toEqual({
      "qbo-bind": live.id,
    });
    // Bound to a connected one already: nothing changes.
    expect(
      await connectionsToBind(tx, {
        tenantId,
        needed,
        bindings: { "qbo-bind": live.id },
        rebind: true,
      }),
    ).toEqual({});
  });
});
