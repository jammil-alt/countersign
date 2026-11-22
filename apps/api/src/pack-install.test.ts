// docs/plan.md §1.230 (Wave Y, Y1): one install path for every pack, taking only configuration.
// A demo pack with configuration fields, registered beside the deployment's, is switched on for a
// client from the Areas tab's route: the operator's values are checked and kept over the defaults
// (a bad one switches nothing on), installing again changes only the configuration, the change is
// logged, HIPAA mode marks the pack's vendors of ours it holds back, and the portal's view carries
// none of it. Only the operator, and only for clients they serve.

import { PackManifest } from "@countersign/core";
import { tenant, tenantChange, tenantPack, withTenant } from "@countersign/db";
import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { type ApiHarness, admin, createApiHarness, OPERATOR } from "./api.test-helper";
import { DEPLOYMENT_PACKS, type RegisteredPack } from "./packs";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
type J = any;

const DEMO: RegisteredPack = {
  manifest: PackManifest.parse({
    id: "close-demo",
    name: "Close demo",
    version: "0.1.0",
    description: "A pack with configuration, for the install path's tests.",
    area: "bookkeeping",
    config: [
      {
        key: "close_day",
        label: "Close the books on this day of the month",
        type: "number",
        default: 5,
        min: 1,
        max: 28,
      },
      {
        key: "basis",
        label: "Accounting basis",
        type: "choice",
        options: [
          { value: "accrual", label: "Accrual" },
          { value: "cash", label: "Cash" },
        ],
        default: "accrual",
      },
    ],
    processors: ["openai"],
    connections: [{ connectors: ["qbo"], use: "The books." }],
    events: [],
    tools: [],
    skills: [],
    templates: [],
    screens: [],
  }),
  handlers: {},
};

const h = await createApiHarness({ packs: [...DEPLOYMENT_PACKS, DEMO] });
afterAll(() => h?.close());

describe.skipIf(!h)("installing a pack with configuration only", () => {
  const H = h as ApiHarness;
  const install = (who: string, client: string, config?: Record<string, unknown>) =>
    H.call(who, "POST", `/api/ops/clients/${client}/packs/close-demo/install`, {
      ...(config ? { config } : {}),
    });
  const view = async (client: string) => {
    const res = await H.call(OPERATOR, "GET", `/api/ops/clients/${client}/packs`);
    expect(res.status).toBe(200);
    return (res.json as J).packs.find((p: J) => p.id === "close-demo");
  };
  const isOn = (tenantId: string) =>
    withTenant(H.db, tenantId, async (tx) => {
      const rows = await tx
        .select()
        .from(tenantPack)
        .where(and(eq(tenantPack.tenantId, tenantId), eq(tenantPack.pack, "close-demo")));
      return rows.length > 0;
    });
  const changes = (tenantId: string) =>
    withTenant(H.db, tenantId, (tx) =>
      tx.select().from(tenantChange).where(eq(tenantChange.tenantId, tenantId)),
    );

  it("shows the pack off, at its defaults, with its area and vendors", async () => {
    const pack = await view(H.A.tenantId);
    expect(pack).toMatchObject({
      enabled: false,
      areaId: "bookkeeping",
      config: { values: { close_day: 5, basis: "accrual" } },
      processors: [{ id: "openai", name: expect.any(String), heldForHipaa: false }],
    });
    expect(pack.config.fields.map((f: J) => f.key)).toEqual(["close_day", "basis"]);
  });

  it("refuses a bad configuration and switches nothing on", async () => {
    const unknown = await install(OPERATOR, H.A.tenantId, { nope: 1 });
    expect(unknown.status).toBe(400);
    const range = await install(OPERATOR, H.A.tenantId, { close_day: 40 });
    expect(range.status).toBe(400);
    expect((range.json as J).error?.message ?? JSON.stringify(range.json)).toMatch(/close_day/);
    expect(await isOn(H.A.tenantId)).toBe(false);
  });

  it("switches it on with the operator's values, the rest at their defaults, and logs it", async () => {
    const res = await install(OPERATOR, H.A.tenantId, { close_day: 10 });
    expect(res.status).toBe(200);
    expect((res.json as J).pack).toMatchObject({
      enabled: true,
      config: { values: { close_day: 10, basis: "accrual" } },
    });
    expect(await isOn(H.A.tenantId)).toBe(true);
    const [row] = await H.db
      .select({ settings: tenant.settings })
      .from(tenant)
      .where(eq(tenant.id, H.A.tenantId));
    expect((row?.settings as J).packs["close-demo"]).toEqual({ close_day: 10, basis: "accrual" });
    const logged = await changes(H.A.tenantId);
    expect(logged.map((c) => (c.change as J).setting)).toContain("packs.close-demo");
  });

  it("installing again changes only the configuration, keeping what isn't sent", async () => {
    const res = await install(OPERATOR, H.A.tenantId, { basis: "cash" });
    expect(res.status).toBe(200);
    expect((await view(H.A.tenantId)).config.values).toEqual({ close_day: 10, basis: "cash" });
    // Nothing new to keep: nothing logged again.
    const before = (await changes(H.A.tenantId)).length;
    expect(before).toBe(2);
    expect((await install(OPERATOR, H.A.tenantId, {})).status).toBe(200);
    expect((await changes(H.A.tenantId)).length).toBe(before);
  });

  it("switches on at the defaults through the plain enable route too", async () => {
    const res = await H.call(
      OPERATOR,
      "POST",
      `/api/ops/clients/${H.B.tenantId}/packs/close-demo/enable`,
    );
    expect(res.status).toBe(200);
    expect((res.json as J).pack.config.values).toEqual({ close_day: 5, basis: "accrual" });
  });

  it("is the operator's, for clients they serve only", async () => {
    expect((await install(admin("a"), H.A.tenantId, { close_day: 3 })).status).toBe(403);
    const other = await install(OPERATOR, H.C.tenantId, { close_day: 3 });
    expect([403, 404]).toContain(other.status);
    expect(await isOn(H.C.tenantId)).toBe(false);
    expect((await view(H.A.tenantId)).config.values.close_day).toBe(10);
  });

  it("marks the vendors HIPAA mode holds back for a client in it", async () => {
    await H.db
      .update(tenant)
      .set({ settings: { compliance: { hipaa: true } } })
      .where(eq(tenant.id, H.B.tenantId));
    const pack = await view(H.B.tenantId);
    expect(pack.processors).toEqual([
      { id: "openai", name: expect.any(String), heldForHipaa: true },
    ]);
  });

  it("never reaches the portal: no configuration, no vendors", async () => {
    const res = await H.call(admin("a"), "GET", "/api/packs");
    expect(res.status).toBe(200);
    const mine = (res.json as J).packs.find((p: J) => p.id === "close-demo");
    expect(mine).toBeDefined();
    expect(mine).not.toHaveProperty("config");
    expect(mine).not.toHaveProperty("processors");
  });
});
