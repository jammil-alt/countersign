// S5.3 (overnight fixes, 2026-11-23): the session carries the active client's time zone, so the
// portal draws its first screen on the client's day instead of the browser's.
import { tenant } from "@countersign/db";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { admin, createApiHarness, OPERATOR } from "./api.test-helper";

const h = await createApiHarness();
afterAll(() => h?.close());

describe.skipIf(!h)("the session's time zone", () => {
  const H = h as NonNullable<typeof h>;

  it("is the active client's zone, and null with no client chosen", async () => {
    await H.t.db
      .update(tenant)
      .set({ timezone: "Europe/Madrid" })
      .where(eq(tenant.id, H.A.tenantId));
    const portal = await H.call(admin("a"), "GET", "/api/session");
    expect(portal.status).toBe(200);
    expect((portal.json as { timezone: unknown }).timezone).toBe("Europe/Madrid");

    const ops = await H.call(OPERATOR, "GET", "/api/session");
    expect(ops.status).toBe(200);
    const body = ops.json as { activeTenantId: string | null; timezone: unknown };
    if (body.activeTenantId === null) expect(body.timezone).toBeNull();
  });
});
