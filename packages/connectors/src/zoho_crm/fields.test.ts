// docs/plan.md §1.164 step 3, "Zoho's fields": the field metadata call (against the fake Zoho and
// fixtures/zoho_crm/fields-*.json, whose shape is UNCHECKED against live v8), the fallback for a
// grant made before the scope, the typed write inputs, and sync reading a connection's own fields.

import { DEFAULT_PERMISSIONS, type JsonObject } from "@countersign/core";
import { describe, expect, it } from "vitest";
import type { ConnectionContext } from "../connector";
import { memoryCredentials } from "../credentials-accessor";
import { formDecode } from "../http";
import { runReadTool } from "../invoke";
import { memoryLogger } from "../logger";
import { fakeZoho, ZOHO_FIXTURES } from "../testing";
import {
  parseZohoFields,
  readZohoFieldCache,
  readZohoSyncFieldsConfig,
  ZOHO_MAX_FIELDS_PER_CALL,
  type ZohoFieldCache,
  zohoFieldCacheStale,
  zohoRecordSchema,
  zohoScopeReadsFields,
  zohoSyncFieldsProblems,
  zohoToolInputs,
} from "./fields";
import { createZohoCrmConnector, ZOHO_TOOLS } from "./index";
import {
  readZohoSyncCursor,
  startZohoSync,
  zohoCursorFor,
  zohoStandardFieldCount,
  zohoSyncFields,
  zohoSyncFieldsKey,
  zohoVersionTime,
} from "./sync";

const NOW = new Date("2026-11-20T12:00:00.000Z");
/** The `fields` a list call asked for. */
const askedFields = (url: string) => formDecode(url.split("?")[1] ?? "").fields ?? "";
const tenantId = "0190f0c8-0000-7000-8000-000000000001";
const connectionId = "0190f0c8-0000-7000-8000-0000000000c1";

function ctx(
  opts: { scope?: string; config?: JsonObject; now?: Date } = {},
): ConnectionContext & { store: ReturnType<typeof memoryCredentials> } {
  const store = memoryCredentials({
    accessToken: ZOHO_FIXTURES.tokenCode.access_token,
    refreshToken: ZOHO_FIXTURES.tokenCode.refresh_token,
    expiresAt: "2026-11-20T13:00:00.000Z",
    accountsServer: "https://accounts.zoho.eu",
    apiDomain: "https://www.zohoapis.eu",
    ...(opts.scope ? { scope: opts.scope } : {}),
  } as JsonObject);
  return {
    tenantId,
    connection: {
      id: connectionId,
      tenantId,
      connector: "zoho_crm",
      status: "connected",
      externalAccountId: "20087654321",
      config: opts.config ?? {},
      permissions: DEFAULT_PERMISSIONS,
    },
    credentials: store,
    store,
    logger: memoryLogger(),
    now: () => opts.now ?? NOW,
  };
}

const connector = (zoho: ReturnType<typeof fakeZoho>) =>
  createZohoCrmConnector({ clientId: "1000.C", clientSecret: "s", fetch: zoho.fetch });

describe("Zoho field metadata", () => {
  it("parses a v8 field list: labels, types, custom, read-only, picklists without -None-", () => {
    const fields = parseZohoFields(ZOHO_FIXTURES.fieldsLeads);
    const by = Object.fromEntries(fields.map((f) => [f.apiName, f]));
    expect(by.Region).toEqual({
      apiName: "Region",
      label: "Sales region",
      dataType: "picklist",
      custom: true,
      readOnly: false,
      mandatory: false,
      picklist: ["North", "South", "West"],
      maxLength: 120,
    });
    expect(by.Last_Import_Date).toMatchObject({
      label: "Last import date",
      dataType: "date",
      custom: true,
      maxLength: null,
      picklist: null,
    });
    expect(by.Last_Name).toMatchObject({ mandatory: true, custom: false, maxLength: 80 });
    expect(by.Created_Time?.readOnly).toBe(true);
    // A formula is read-only whatever its flags say.
    expect(by.Lead_Score).toMatchObject({ readOnly: true, dataType: "formula" });
    expect(by.Lead_Status?.picklist).toEqual(["Not Contacted", "Contacted", "Junk Lead"]);
    // Hidden fields are left out.
    expect(by.Legacy_Id).toBeUndefined();
    // A field that doesn't read is skipped; an answer that isn't a list fails.
    expect(parseZohoFields({ fields: [{ api_name: "bad name" }, { api_name: "Ok" }] })).toEqual([
      expect.objectContaining({ apiName: "Ok", label: "Ok", dataType: "unknown" }),
    ]);
    expect(() => parseZohoFields({ data: [] })).toThrow(/unexpected shape/);
  });

  it("types a module's writable fields, titled by label, mandatory ones required on a create", () => {
    const fields = parseZohoFields(ZOHO_FIXTURES.fieldsLeads);
    const update = zohoRecordSchema(fields, { create: false });
    const props = update.properties as Record<string, Record<string, unknown>>;
    expect(update["x-record"]).toBe(true);
    expect(update.required).toBeUndefined();
    expect(props.Region).toEqual({
      title: "Sales region",
      type: "string",
      maxLength: 120,
      enum: ["North", "South", "West"],
    });
    expect(props.Last_Import_Date).toEqual({
      title: "Last import date",
      type: "string",
      format: "date",
    });
    expect(props.Annual_Revenue).toMatchObject({ type: "number" });
    expect(props.Owner).toMatchObject({ type: "object", required: ["id"] });
    // Read-only and computed fields aren't offered for a write.
    expect(props.Created_Time).toBeUndefined();
    expect(props.Lead_Score).toBeUndefined();
    expect(zohoRecordSchema(fields, { create: true }).required).toEqual(["Last_Name"]);
  });

  it("gives the record write tools typed inputs per module, only from a field list that read", () => {
    const c = createZohoCrmConnector();
    const spec = (id: string) => {
      const t = c.manifest.tools.find((x) => x.id === id);
      if (!t) throw new Error(id);
      return { id, input: t.input };
    };
    const tools = { create: spec(ZOHO_TOOLS.create), update: spec(ZOHO_TOOLS.update) };
    const cache: ZohoFieldCache = {
      v: 1,
      at: NOW.toISOString(),
      status: "ok",
      modules: {
        Leads: parseZohoFields(ZOHO_FIXTURES.fieldsLeads),
        Deals: parseZohoFields(ZOHO_FIXTURES.fieldsDeals),
      },
    };
    const inputs = zohoToolInputs(cache, tools);
    expect(Object.keys(inputs).sort()).toEqual([ZOHO_TOOLS.create, ZOHO_TOOLS.update].sort());
    const leads = inputs[ZOHO_TOOLS.update]?.schemas.Leads as Record<string, unknown>;
    expect(inputs[ZOHO_TOOLS.update]?.by).toBe("module");
    expect(Object.keys(inputs[ZOHO_TOOLS.update]?.schemas ?? {})).toEqual(["Leads", "Deals"]);
    const props = leads.properties as Record<string, Record<string, unknown>>;
    // The rest of the tool's input is as it was; `fields` is the module's record.
    expect(Object.keys(props)).toEqual(["module", "id", "fields", "expectedModifiedTime"]);
    expect(props.module).toEqual({ type: "string", const: "Leads" });
    expect(((props.fields?.properties ?? {}) as Record<string, unknown>).Region).toMatchObject({
      title: "Sales region",
    });
    expect(zohoToolInputs({ ...cache, status: "needs_sign_in", modules: {} }, tools)).toEqual({});
    expect(zohoToolInputs(null, tools)).toEqual({});
  });

  it("reads every module's fields through the connector, and the read tool", async () => {
    const zoho = fakeZoho();
    const c = connector(zoho);
    const cache = await c.fieldCache(ctx());
    expect(cache.status).toBe("ok");
    expect(cache.modules.Leads?.some((f) => f.apiName === "Region")).toBe(true);
    expect(cache.modules.Contacts?.map((f) => f.apiName)).toEqual(["Last_Name", "Email"]);
    expect(
      zoho
        .apiCalls()
        .map((r) => r.url.replace("https://www.zohoapis.eu", ""))
        .sort(),
    ).toEqual(
      ["Accounts", "Contacts", "Deals", "Leads"].map((m) => `/crm/v8/settings/fields?module=${m}`),
    );
    const out = (await runReadTool(c, ZOHO_TOOLS.fields, { module: "Deals" }, ctx())).output;
    expect(out).toMatchObject({ module: "Deals", available: true });
    expect((out as { fields: { apiName: string }[] }).fields.map((f) => f.apiName)).toContain(
      "Region",
    );
    expect(readZohoFieldCache({ zohoFields: cache })).toEqual(cache);
    expect(readZohoFieldCache({ zohoFields: { v: 2 } })).toBeNull();
    expect(zohoFieldCacheStale(cache, NOW)).toBe(false);
    expect(zohoFieldCacheStale(cache, new Date(NOW.getTime() + 25 * 3600_000))).toBe(true);
    expect(zohoFieldCacheStale(null, NOW)).toBe(true);
  });

  it("degrades for a grant made before the field scope: no refresh, no error, a new sign-in asked", async () => {
    // The stored grant names its scopes, without the field scope: nothing is called.
    expect(zohoScopeReadsFields("ZohoCRM.modules.leads.READ,ZohoCRM.org.READ")).toBe(false);
    expect(zohoScopeReadsFields("ZohoCRM.settings.fields.READ ZohoCRM.org.READ")).toBe(true);
    expect(zohoScopeReadsFields("zohocrm.settings.ALL")).toBe(true);
    expect(zohoScopeReadsFields(undefined)).toBeNull();
    const zoho = fakeZoho();
    const c = connector(zoho);
    const old = await c.fields(ctx({ scope: "ZohoCRM.modules.leads.READ" }), "Leads");
    expect(old).toEqual({ status: "needs_sign_in", fields: [] });
    expect(zoho.apiCalls()).toHaveLength(0);

    // No scope stored: Zoho's refusal tells, and it is not taken for an expired token.
    zoho.state.fieldsScopeMissing = true;
    const c2 = ctx();
    expect(await c.fields(c2, "Leads")).toEqual({ status: "needs_sign_in", fields: [] });
    expect(zoho.requests.some((r) => r.url.includes("/oauth/v2/token"))).toBe(false);
    expect(await c.fieldCache(c2)).toMatchObject({ status: "needs_sign_in", modules: {} });
    const tool = (await runReadTool(c, ZOHO_TOOLS.fields, { module: "Leads" }, c2)).output;
    expect(tool).toMatchObject({ available: false, fields: [], reason: expect.any(String) });
    // Everything else works as before.
    const lead = await runReadTool(
      c,
      ZOHO_TOOLS.get,
      { module: "Leads", id: ZOHO_FIXTURES.leadGet.data[0]?.id },
      c2,
    );
    expect((lead.output as { record: unknown }).record).not.toBeNull();
  });
});

describe("Zoho sync with a connection's own fields", () => {
  const cache: ZohoFieldCache = {
    v: 1,
    at: NOW.toISOString(),
    status: "ok",
    modules: {
      Leads: parseZohoFields(ZOHO_FIXTURES.fieldsLeads),
      Deals: parseZohoFields(ZOHO_FIXTURES.fieldsDeals),
    },
  };

  it("checks the fields against Zoho's list and v8's 50", () => {
    const standard = zohoStandardFieldCount;
    expect(zohoSyncFieldsProblems(undefined, cache, standard)).toEqual([]);
    expect(
      zohoSyncFieldsProblems({ Leads: ["Region", "Last_Import_Date"] }, cache, standard),
    ).toEqual([]);
    expect(zohoSyncFieldsProblems({ Leads: ["Nope"] }, cache, standard)).toEqual([
      { module: "Leads", field: "Nope", message: "Leads has no field Nope in Zoho" },
    ]);
    expect(zohoSyncFieldsProblems({ Tasks: ["Region"] }, cache, standard)[0]?.module).toBeNull();
    expect(zohoSyncFieldsProblems({ Leads: ["Region"] }, null, standard)[0]?.message).toMatch(
      /haven't read/,
    );
    expect(
      zohoSyncFieldsProblems(
        { Leads: ["Region"] },
        { ...cache, status: "needs_sign_in", modules: {} },
        standard,
      )[0]?.message,
    ).toMatch(/sign in to Zoho again/);
    // Taking fields away (or keeping them) is fine whatever the field list says.
    expect(
      zohoSyncFieldsProblems(
        { Leads: ["Region"] },
        { ...cache, status: "needs_sign_in", modules: {} },
        standard,
        { Leads: ["Region", "Last_Import_Date"] },
      ),
    ).toEqual([]);
    const many = Array.from({ length: 45 }, (_, i) => `Custom_${i}`);
    const wide: ZohoFieldCache = {
      ...cache,
      modules: {
        Leads: many.map((apiName) => ({
          apiName,
          label: apiName,
          dataType: "text",
          custom: true,
          readOnly: false,
          mandatory: false,
          picklist: null,
          maxLength: 50,
        })),
      },
    };
    expect(zohoSyncFieldsProblems({ Leads: many }, wide, standard)).toEqual([
      {
        module: "Leads",
        field: null,
        message: `Leads would read ${standard("Leads") + 45} fields; Zoho reads at most ${ZOHO_MAX_FIELDS_PER_CALL} at a time`,
      },
    ]);
    expect(readZohoSyncFieldsConfig({ syncFields: { Leads: ["Region"] } })).toEqual({
      Leads: ["Region"],
    });
    expect(readZohoSyncFieldsConfig({ syncFields: "Region" })).toEqual({});
  });

  it("asks for the extra fields, keeps them in the raw record, and reads again when they change", async () => {
    const zoho = fakeZoho();
    const c = connector(zoho);
    zoho.state.listed.Leads = [
      {
        id: "5843104000000424999",
        Last_Name: "Ortiz",
        Region: "North",
        Last_Import_Date: "2026-11-01",
        Lead_Score: 12,
        Modified_Time: "2026-11-19T10:00:00+00:00",
      },
    ];
    // Without extra fields: the standard list only, as before.
    const plain = await c.syncPage(ctx(), null);
    expect(plain.records[0]?.externalVersion).toBe("2026-11-19T10:00:00+00:00");
    expect(plain.records[0]?.payload).not.toHaveProperty("Region");
    expect(plain.next).not.toHaveProperty("fields");
    const firstCall = zoho.apiCalls()[0]?.url ?? "";
    expect(firstCall).toContain("/crm/v8/Leads?");
    expect(askedFields(firstCall)).toBe(zohoSyncFields("Leads"));

    zoho.requests.length = 0;
    const config = { syncFields: { Leads: ["Region", "Last_Import_Date"] } } as JsonObject;
    const stored = { zohoFields: cache };
    const page = await c.syncPage(ctx({ config }), stored);
    const asked = askedFields(zoho.apiCalls()[0]?.url ?? "");
    expect(asked.split(",")).toEqual(
      expect.arrayContaining(["Last_Name", "Region", "Last_Import_Date", "Modified_Time"]),
    );
    expect(asked.split(",")).not.toContain("Lead_Score");
    const key = zohoSyncFieldsKey({ Leads: ["Region", "Last_Import_Date"] });
    expect(key).toMatch(/^f[0-9a-f]{8}$/);
    expect(page.next.fields).toBe(key);
    expect(page.records).toEqual([
      {
        entityType: "Leads",
        externalId: "5843104000000424999",
        externalVersion: `2026-11-19T10:00:00+00:00~${key}`,
        payload: {
          id: "5843104000000424999",
          Last_Name: "Ortiz",
          Region: "North",
          Last_Import_Date: "2026-11-01",
          Modified_Time: "2026-11-19T10:00:00+00:00",
        },
      },
    ]);
    expect(zohoVersionTime(page.records[0]?.externalVersion)).toBe("2026-11-19T10:00:00+00:00");

    // A field Zoho no longer lists is dropped from the call, so the sync still reads.
    zoho.requests.length = 0;
    await c.syncPage(ctx({ config: { syncFields: { Leads: ["Region", "Gone_Field"] } } }), stored);
    const asked2 = askedFields(zoho.apiCalls()[0]?.url ?? "");
    expect(asked2.split(",")).toContain("Region");
    expect(asked2.split(",")).not.toContain("Gone_Field");
  });

  it("starts a pass over every module again when the fields change, keeping whether it is history", () => {
    const later = new Date(NOW.getTime() + 3600_000);
    const first = startZohoSync(NOW);
    const midway = { ...first, module: 2, page: 3, initial: false, since: NOW.toISOString() };
    expect(zohoCursorFor({ zoho: midway }, later, "")).toEqual(midway);
    const again = zohoCursorFor({ zoho: midway }, later, "fdeadbeef");
    expect(again).toMatchObject({ module: 0, page: 1, initial: false, fields: "fdeadbeef" });
    expect(Date.parse(again.since)).toBeLessThan(Date.parse(midway.since));
    expect(readZohoSyncCursor({ zoho: again })).toEqual(again);
    // Fields dropped: back to the standard list, read again too.
    expect(zohoCursorFor({ zoho: again }, later, "")).not.toHaveProperty("fields");
    expect(zohoCursorFor(null, NOW, "fdeadbeef")).toMatchObject({
      initial: true,
      fields: "fdeadbeef",
    });
    expect(zohoSyncFieldsKey({ Leads: ["Email"] })).toBe(""); // already read
    expect(zohoSyncFieldsKey({ Leads: ["B", "A"] })).toBe(zohoSyncFieldsKey({ Leads: ["A", "B"] }));
  });
});
