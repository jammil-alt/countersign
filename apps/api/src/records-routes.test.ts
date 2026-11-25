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
    expect(get?.output.map((f) => f.name)).toEqual(["id", "name", "createdAt", "region", "terms"]);
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
