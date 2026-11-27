// The Sandbox's sample company (POST /api/ops/clients/:id/sample-company): operators only, in the
// Sandbox only; seeds an invented business once (a second call adds nothing, and a record the
// operator edited stays as they left it); its records are what the steps read: a Match on vendors
// by email domain and by name, a vendor item by SKU, the chart of accounts through
// `ledger.accounts.list`, and the operator as an employee a message trigger lets in.

import { createDbPorts, ledgerAccounts, type ToolInvocation } from "@countersign/agents";
import {
  LedgerAccountsInput,
  matchesPeople,
  type SampleCompanyResult,
  steps,
} from "@countersign/core";
import { auditEvent, contact, membership, tenant, tenantPack, vendor } from "@countersign/db";
import { packToolContext } from "@countersign/pack-materials";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type ApiHarness,
  admin,
  createApiHarness,
  OPERATOR,
  OTHER_OPERATOR,
} from "./api.test-helper";
import { matchPort } from "./packs";
import { contactByEmail, contactFacts } from "./triggers/senders";

const h = await createApiHarness();
afterAll(() => h?.close());

const YOU = { name: "Pat Operator", email: "Pat.Operator@Mezonas.test", phone: "(512) 555-0177" };

describe.skipIf(!h)("the Sandbox's sample company", () => {
  const H = h as ApiHarness;
  let sandbox = "";
  const path = (id: string) => `/api/ops/clients/${id}/sample-company`;
  const seed = async (body: unknown = {}) => {
    const res = await H.call(OPERATOR, "POST", path(sandbox), body);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    return res.json as SampleCompanyResult;
  };
  const ctx = () =>
    packToolContext({ tenantId: sandbox, agentVersionId: "", mode: "test", db: H.db });
  const match = (settings: unknown, items: Record<string, unknown>[]) =>
    matchPort().match({ ctx: ctx(), settings: steps.MatchSettings.parse(settings), items });

  beforeAll(async () => {
    const [row] = await H.t.db
      .insert(tenant)
      .values({ name: "Sandbox", settings: { sandbox: true } })
      .returning();
    sandbox = row?.id as string;
    await H.t.db
      .insert(membership)
      .values({ tenantId: sandbox, userId: H.operator, role: "operator" });
  });

  it("is refused outside the Sandbox, to client roles, and to an operator who doesn't serve it", async () => {
    const real = await H.call(OPERATOR, "POST", path(H.A.tenantId), {});
    expect(real.status).toBe(403);
    expect((real.json as { error: { code: string } }).error.code).toBe("not_sandbox");
    expect((await H.call(admin("a"), "POST", path(sandbox), {})).status).toBe(403);
    expect((await H.call(OTHER_OPERATOR, "POST", path(sandbox), {})).status).toBe(404);
    expect(
      (await H.call(OPERATOR, "POST", path(sandbox), { you: { name: "x", phone: "12" } })).status,
    ).toBe(422);
    const [none] = await H.t.db.select().from(vendor).where(eq(vendor.tenantId, H.A.tenantId));
    expect(none).toBeUndefined();
  });

  it("seeds the company once, with the operator as an employee, and audits the call", async () => {
    const first = await seed({ you: YOU });
    const expected = {
      vendors: 8,
      organizations: 12,
      contacts: 16,
      ledgerAccounts: 22,
      ledgerNotes: 5,
      masterItems: 15,
      vendorItems: 20,
      transactions: 10,
    };
    expect(first.company).toEqual({ name: "Ridgeline Builders", domain: "ridgeline.example.com" });
    expect(first.counts).toEqual(expected);
    expect(first.added).toEqual(expected);
    expect(first.switchedOn).toEqual(["materials"]);
    expect(first.employees.map((e) => [e.name, e.you])).toEqual([
      ["Dana Whitfield", false],
      ["Marco Alvarez", false],
      ["Priya Natarajan", false],
      ["Tom Becker", false],
      ["Pat Operator", true],
    ]);
    expect(first.employees.at(-1)).toMatchObject({
      email: "pat.operator@mezonas.test",
      phone: "+15125550177",
    });
    const [on] = await H.t.db
      .select()
      .from(tenantPack)
      .where(and(eq(tenantPack.tenantId, sandbox), eq(tenantPack.pack, "materials")));
    expect(on).toBeDefined();
    const audits = await H.t.db.select().from(auditEvent).where(eq(auditEvent.tenantId, sandbox));
    expect(audits.some((a) => JSON.stringify(a).includes("sample-company"))).toBe(true);

    // Again, after the operator renamed a vendor: nothing added, the rename kept.
    await H.t.db
      .update(vendor)
      .set({ name: "Northfork Lumber (renamed)" })
      .where(and(eq(vendor.tenantId, sandbox), eq(vendor.name, "Northfork Lumber Co.")));
    const again = await seed({ you: YOU });
    expect(again.counts).toEqual(expected);
    expect(Object.values(again.added).every((n) => n === 0)).toBe(true);
    expect(again.switchedOn).toEqual([]);
    expect(again.employees).toEqual(first.employees);
    const vendors = await H.t.db.select().from(vendor).where(eq(vendor.tenantId, sandbox));
    expect(vendors).toHaveLength(8);
    expect(vendors.map((v) => v.name)).toContain("Northfork Lumber (renamed)");
  });

  it("makes the operator's email an employee a message trigger lets in", async () => {
    const found = await H.t.db.transaction((tx) =>
      contactByEmail(tx, sandbox, "pat.operator@mezonas.test"),
    );
    expect(found).toMatchObject({ relationship: "employee", phone: "+15125550177" });
    const facts = contactFacts(found as NonNullable<typeof found>);
    expect(matchesPeople({ relationships: ["employee"] }, facts)).toBe(true);
    const [one] = await H.t.db
      .select()
      .from(contact)
      .where(and(eq(contact.tenantId, sandbox), eq(contact.email, "pat.operator@mezonas.test")));
    expect(one?.id).toBe(found?.id);
  });

  it("is what a Match on vendors finds, by email domain and by name", async () => {
    const [northfork] = await H.t.db
      .select()
      .from(vendor)
      .where(and(eq(vendor.tenantId, sandbox), eq(vendor.normalizedName, "northfork lumber")));
    const byEmail = await match({ to: "vendors", type: "exact", keys: ["email_domain"] }, [
      { email: "billing@northforklumber.example.com" },
    ]);
    expect(byEmail.output.items[0]?.matched).toBe(northfork?.id);
    const byName = await match({ to: "vendors", type: "exact", keys: ["name"] }, [
      { name: "NORTHFORK LUMBER CO" },
    ]);
    expect(byName.output.items[0]?.matched).toBe(northfork?.id);
    const byId = await match({ to: "vendors", type: "exact", keys: ["accounting_id"] }, [
      { accountingId: "9101" },
    ]);
    expect(byId.output.items[0]?.matched).toBe(northfork?.id);

    // And one of its items by SKU, in its own catalog only.
    const sku = await match({ to: "vendor-items", type: "exact" }, [
      { vendorId: northfork?.id, sku: "nf-bb34", description: "Baltic birch 3/4" },
    ]);
    const item = sku.output.items[0];
    expect(item?.matched).toBeTruthy();
    const elsewhere = await match({ to: "vendor-items", type: "exact" }, [
      { vendorId: northfork?.id, sku: "CP-1034BB", description: "Baltic birch 3/4" },
    ]);
    expect(elsewhere.output.items[0]?.matched).toBeNull();
  });

  it("is the chart of accounts `ledger.accounts.list` reads, with its notes", async () => {
    const ports = createDbPorts(H.db);
    const out = (await ledgerAccounts.run(LedgerAccountsInput.parse({}), {
      tenantId: sandbox,
      ledger: ports.ledger,
    } as unknown as ToolInvocation)) as {
      accounts: { name: string; number: string | null; kind: string; notes: { note: string }[] }[];
      count: number;
    };
    expect(out.count).toBe(22);
    const fuel = out.accounts.find((a) => a.number === "6000");
    expect(fuel).toMatchObject({ name: "Fuel", kind: "expense" });
    expect(fuel?.notes[0]?.note).toMatch(/fuel card/);
    expect(out.accounts.filter((a) => a.kind === "card").map((a) => a.name)).toEqual([
      "Company Visa",
      "Fuel card",
    ]);
  });
});
