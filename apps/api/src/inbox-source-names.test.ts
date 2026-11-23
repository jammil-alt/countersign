// S5.6 (overnight fixes, 2026-11-23): an inbox item's cited records read by name ("Acme Supply"),
// not "Record ·f752ac": the portal's and the back office's inbox lists name them, each client's
// own records only.
import { inboxItem, vendor } from "@countersign/db";
import { afterAll, describe, expect, it } from "vitest";
import { admin, createApiHarness, OPERATOR } from "./api.test-helper";

const h = await createApiHarness();
afterAll(() => h?.close());

describe.skipIf(!h)("the inbox names the records its items cite", () => {
  const H = h as NonNullable<typeof h>;

  it("in the portal and the back office, never another client's", async () => {
    const [acme] = await H.t.db
      .insert(vendor)
      .values({ tenantId: H.A.tenantId, name: "Acme Supply", normalizedName: "acme supply" })
      .returning();
    const [theirs] = await H.t.db
      .insert(vendor)
      .values({ tenantId: H.B.tenantId, name: "B's vendor", normalizedName: "b's vendor" })
      .returning();
    if (!acme || !theirs) throw new Error("no vendors");
    await H.t.db.insert(inboxItem).values({
      tenantId: H.A.tenantId,
      kind: "review",
      assigneeRole: "client_admin",
      title: "Check the vendor",
      payload: { sources: [acme.id, theirs.id, "vendor:59"] },
    });

    const portal = await H.call(admin("a"), "GET", "/api/inbox");
    expect(portal.status).toBe(200);
    const names = (portal.json as { sourceNames?: Record<string, string> }).sourceNames ?? {};
    expect(names[acme.id]).toBe("Acme Supply");
    expect(names[theirs.id]).toBeUndefined();

    const ops = await H.call(OPERATOR, "GET", "/api/ops/inbox?assigned=all");
    expect(ops.status).toBe(200);
    const opsNames = (ops.json as { sourceNames?: Record<string, string> }).sourceNames ?? {};
    expect(opsNames[acme.id]).toBe("Acme Supply");
  });
});
