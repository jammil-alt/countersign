// Step model §10f (stream N): record types and custom fields in the back office, and the Uses
// picker's record actions. Operator only; a client's fields are its own and shared ones are offered
// to every client; a removed field is hidden, never deleted; a field's type can't change once a
// record holds data; an agent's version only offers, and only publishes, what its grants and data
// sets allow, typed with its client's custom fields.

import { customField, vendor } from "@countersign/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type ApiHarness,
  admin,
  createApiHarness,
  OPERATOR,
  OTHER_OPERATOR,
  testBundle,
} from "./api.test-helper";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

const h = await createApiHarness();
afterAll(() => h?.close());

describe.skipIf(!h)("record types and custom fields", () => {
  const H = h as ApiHarness;
  let agentA = "";

  beforeAll(async () => {
    const created = await H.call(OPERATOR, "POST", "/api/ops/templates", {
      slug: "margins",
      bundle: testBundle("Margins"),
    });
    const templateId = j(created.json).agent.id;
    await H.call(
      OPERATOR,
      "POST",
      `/api/ops/agents/${templateId}/versions/${j(created.json).version.id}/publish`,
    );
    const forked = await H.call(OPERATOR, "POST", `/api/ops/templates/${templateId}/fork`, {
      clientId: H.A.tenantId,
      serviceName: "Margins",
    });
    expect(forked.status, JSON.stringify(forked.json)).toBe(200);
    agentA = j(forked.json).agent.id;
  });

  const create = (who: string, body: Record<string, unknown>) =>
    H.call(who, "POST", "/api/ops/custom-fields", {
      recordType: "vendor",
      type: "text",
      ...body,
    });

  it("lists every record type the areas declare", async () => {
    const res = await H.call(OPERATOR, "GET", "/api/ops/record-types");
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const types = j(res.json).recordTypes.map((t: { id: string; area: string }) => [t.id, t.area]);
    expect(types).toEqual(
      expect.arrayContaining([
        ["vendor", "shared"],
        ["master_item", "purchasing"],
        ["bank_transaction", "bookkeeping"],
      ]),
    );
  });

  it("adds a client's field and a shared one, operator only, each client seeing its own", async () => {
    expect(
      (await create(admin("a"), { clientId: H.A.tenantId, name: "x", label: "X" })).status,
    ).toBe(403);
    // An operator who doesn't serve A can't add A's field.
    expect(
      (await create(OTHER_OPERATOR, { clientId: H.A.tenantId, name: "x", label: "X" })).status,
    ).toBe(404);
    const own = await create(OPERATOR, {
      clientId: H.A.tenantId,
      name: "region",
      label: "Region",
      about: "Where the vendor delivers from",
    });
    expect(own.status, JSON.stringify(own.json)).toBe(200);
    expect(j(own.json).field).toMatchObject({
      name: "region",
      scope: "client",
      clientId: H.A.tenantId,
    });
    const shared = await create(OPERATOR, { name: "terms", label: "Terms" });
    expect(j(shared.json).field).toMatchObject({ name: "terms", scope: "shared", clientId: null });

    const forA = j(
      (await H.call(OPERATOR, "GET", `/api/ops/record-types?client=${H.A.tenantId}`)).json,
    );
    expect(forA.fields.map((f: { name: string }) => f.name).sort()).toEqual(["region", "terms"]);
    const forB = j(
      (await H.call(OPERATOR, "GET", `/api/ops/record-types?client=${H.B.tenantId}`)).json,
    );
    expect(forB.fields.map((f: { name: string }) => f.name)).toEqual(["terms"]);
  });

  it("refuses a built-in name, a second field of the same name, and a link to nothing", async () => {
    for (const [body, words] of [
      [{ clientId: H.A.tenantId, name: "name", label: "Name" }, "already has a field name"],
      [
        { clientId: H.A.tenantId, name: "region", label: "Again" },
        "already has a custom field region",
      ],
      [
        {
          clientId: H.A.tenantId,
          name: "owner",
          label: "Owner",
          type: "record",
          spec: { record: "deal" },
        },
        "no record type deal",
      ],
    ] as const) {
      const res = await create(OPERATOR, body);
      expect(res.status, JSON.stringify(res.json)).toBe(422);
      expect(j(res.json).error.message).toContain(words);
    }
  });

  it("changes a field's type only while no record holds data, and hides it keeping its data", async () => {
    const forA = j(
      (await H.call(OPERATOR, "GET", `/api/ops/record-types?client=${H.A.tenantId}`)).json,
    );
    const region = forA.fields.find((f: { name: string }) => f.name === "region");
    const toNumber = await H.call(OPERATOR, "PATCH", `/api/ops/custom-fields/${region.id}`, {
      type: "number",
    });
    expect(toNumber.status, JSON.stringify(toNumber.json)).toBe(200);
    const back = await H.call(OPERATOR, "PATCH", `/api/ops/custom-fields/${region.id}`, {
      type: "text",
    });
    expect(back.status).toBe(200);
    // A vendor of A's now holds a region.
    await H.t.db.insert(vendor).values({
      tenantId: H.A.tenantId,
      name: "West Lumber",
      normalizedName: "west lumber",
      ext: { custom: { region: "West" } },
    });
    const blocked = await H.call(OPERATOR, "PATCH", `/api/ops/custom-fields/${region.id}`, {
      type: "number",
    });
    expect(blocked.status).toBe(422);
    expect(j(blocked.json).error.message).toContain("holds data, so its type can't change");
    const hidden = await H.call(OPERATOR, "PATCH", `/api/ops/custom-fields/${region.id}`, {
      hidden: true,
    });
    expect(j(hidden.json).field.hidden).toBe(true);
    const [row] = await H.t.db.select().from(customField).where(eq(customField.id, region.id));
    expect(row?.hiddenAt).not.toBeNull();
    const [v] = await H.t.db.select().from(vendor).where(eq(vendor.normalizedName, "west lumber"));
    expect(v?.ext).toEqual({ custom: { region: "West" } });
    await H.call(OPERATOR, "PATCH", `/api/ops/custom-fields/${region.id}`, { hidden: false });
  });

  it("keeps a name to one field across a client's and the shared ones, and never changes a shared type", async () => {
    const own = await create(OPERATOR, { clientId: H.B.tenantId, name: "terms", label: "Terms" });
    expect(own.status).toBe(422);
    expect(j(own.json).error.message).toContain("already has a shared custom field terms");
    const shared = await create(OPERATOR, { name: "region", label: "Region" });
    expect(shared.status).toBe(422);
    expect(j(shared.json).error.message).toContain("already has a client's custom field region");
    const fields = j((await H.call(OPERATOR, "GET", "/api/ops/record-types")).json).fields;
    const terms = fields.find((f: { name: string }) => f.name === "terms");
    const retyped = await H.call(OPERATOR, "PATCH", `/api/ops/custom-fields/${terms.id}`, {
      type: "number",
    });
    expect(retyped.status).toBe(422);
    expect(j(retyped.json).error.message).toContain("is shared, so its type can't change");
  });

  it("caps a client at 50 fields per record type, its own and the shared ones together", async () => {
    // B has the shared "terms"; 49 of its own make 50.
    await H.t.db.insert(customField).values(
      Array.from({ length: 49 }, (_, i) => ({
        tenantId: H.B.tenantId,
        recordType: "vendor",
        name: `b${i}`,
        label: `B ${i}`,
        type: "text" as const,
      })),
    );
    const full = await create(OPERATOR, { clientId: H.B.tenantId, name: "more", label: "More" });
    expect(full.status).toBe(422);
    expect(j(full.json).error.message).toContain("50 custom fields, the most it can have");
    // A new shared field would show at B too.
    const sharedFull = await create(OPERATOR, { name: "sharedMore", label: "Shared more" });
    expect(sharedFull.status).toBe(422);
    // Remove one, add one, and the removed one can't be shown again.
    const forB = j(
      (await H.call(OPERATOR, "GET", `/api/ops/record-types?client=${H.B.tenantId}`)).json,
    ).fields;
    const b0 = forB.find((f: { name: string }) => f.name === "b0");
    await H.call(OPERATOR, "PATCH", `/api/ops/custom-fields/${b0.id}`, { hidden: true });
    expect(
      (await create(OPERATOR, { clientId: H.B.tenantId, name: "more", label: "More" })).status,
    ).toBe(200);
    const shown = await H.call(OPERATOR, "PATCH", `/api/ops/custom-fields/${b0.id}`, {
      hidden: false,
    });
    expect(shown.status).toBe(422);
    // A's count isn't B's.
    expect(
      (await create(OPERATOR, { clientId: H.A.tenantId, name: "aMore", label: "A" })).status,
    ).toBe(200);
  });

  it("offers record actions only as the agent's grants allow, typed with its client's fields", async () => {
    const ids = async () =>
      (
        j((await H.call(OPERATOR, "GET", `/api/ops/agents/${agentA}/action-catalog`)).json)
          .groups as { actions: { id: string; output: { name: string }[] }[] }[]
      ).flatMap((g) => g.actions);
    expect((await ids()).filter((a) => a.id.startsWith("records."))).toEqual([]);
    const bundle = testBundle("Margins");
    const granted = {
      ...bundle,
      definition: {
        ...bundle.definition,
        data: {
          grants: [],
          sets: [
            {
              id: "vendor-terms",
              name: "Vendor terms",
              on: true,
              grants: [{ recordType: "vendor", read: true, create: false, update: true }],
            },
          ],
        },
      },
    };
    const saved = await H.call(OPERATOR, "POST", `/api/ops/agents/${agentA}/versions`, {
      bundle: granted,
    });
    expect(saved.status, JSON.stringify(saved.json)).toBe(200);
    // The test bundle's own steps aren't this test's; its grant raises nothing.
    expect(
      j(saved.json).errors.filter((e: { code: string }) => e.code === "record_grant_invalid"),
    ).toEqual([]);
    const actions = await ids();
    expect(actions.filter((a) => a.id.startsWith("records.")).map((a) => a.id)).toEqual([
      "records.vendor.find",
      "records.vendor.get",
      "records.vendor.update",
    ]);
    const get = actions.find((a) => a.id === "records.vendor.get");
    expect(get?.output.map((f) => f.name)).toEqual([
      "id",
      "name",
      "createdAt",
      "externalRefs",
      "region",
      "aMore",
      "terms",
    ]);
  });

  it("won't publish a grant on a record type nobody declares or a write it doesn't allow", async () => {
    const bundle = testBundle("Margins");
    const wide = {
      ...bundle,
      definition: {
        ...bundle.definition,
        data: {
          grants: [
            { recordType: "vendor", read: true, create: true, update: false },
            { recordType: "deal", read: true, create: false, update: false },
          ],
          sets: [],
        },
      },
    };
    const saved = await H.call(OPERATOR, "POST", `/api/ops/agents/${agentA}/versions`, {
      bundle: wide,
    });
    expect(saved.status).toBe(200);
    expect(
      j(saved.json)
        .errors.filter((e: { code: string }) => e.code === "record_grant_invalid")
        .map((e: { message: string }) => e.message),
    ).toEqual([
      "The agent's grant grants creating vendor records, which can't be created",
      "The agent's grant names deal, which isn't a record type",
    ]);
  });
});
