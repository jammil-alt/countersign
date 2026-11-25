import { describe, expect, it } from "vitest";
import { ToolSpec } from "../schemas/tool";
import { buildActionCatalog } from "../steps/catalog";
import { parseRecordActionId, recordActionId, recordActionSpecs } from "./actions";
import {
  CUSTOM_EXT_KEY,
  CustomFieldDef,
  checkCustomValues,
  customFieldProblems,
  customValuesOf,
  MAX_CUSTOM_FIELDS,
  visibleCustomFields,
} from "./custom-fields";
import { clientRecordFields, FindQuery, findQueryProblems, findReads } from "./find";
import {
  AgentData,
  agentDataProblems,
  crossAreaWrites,
  effectiveRecordGrants,
  recordGrantAllows,
  widenedRecordGrants,
} from "./grants";
import { RecordType, recordTypesProblems } from "./record-type";

const VENDOR = RecordType.parse({
  id: "vendor",
  name: "Vendor",
  plural: "Vendors",
  area: "shared",
  about: "A business the client buys from.",
  fields: [
    { name: "name", type: "text", required: true },
    { name: "createdAt", type: "date", required: true },
  ],
  keys: ["name"],
  operations: { update: true },
});

const JOB_MARGIN = RecordType.parse({
  id: "job_margin",
  name: "Margin by job",
  plural: "Margins by job",
  area: "bookkeeping",
  about: "A job's margin.",
  fields: [
    { name: "job", type: "text", required: true },
    { name: "margin", type: "money", required: true },
    { name: "vendorId", type: "record", record: "vendor", required: false },
  ],
  links: [{ name: "vendor", to: "vendor", field: "vendorId" }],
  operations: { create: true, update: true },
  writable: ["job", "margin", "vendorId"],
});

const field = (over: Partial<CustomFieldDef> & Pick<CustomFieldDef, "name" | "type">) =>
  CustomFieldDef.parse({
    recordType: "vendor",
    label: over.name,
    scope: "client",
    ...over,
  });

describe("record types", () => {
  it("refuses reserved names, unknown keys and links that don't read a linking field", () => {
    const bad = RecordType.safeParse({
      ...JOB_MARGIN,
      fields: [...JOB_MARGIN.fields, { name: "id", type: "text", required: false }],
      keys: ["nope"],
      links: [{ name: "vendor", to: "vendor", field: "job" }],
    });
    expect(bad.success).toBe(false);
    expect(bad.error?.issues.map((i) => i.message)).toEqual(
      expect.arrayContaining([
        "id is a reserved name",
        "key nope isn't a field",
        "link vendor reads job, which isn't a field linking to vendor",
      ]),
    );
  });

  it("checks ids across areas and links to declared types", () => {
    expect(recordTypesProblems([VENDOR, JOB_MARGIN])).toEqual([]);
    expect(recordTypesProblems([JOB_MARGIN])).toEqual([
      "job_margin's link vendor goes to vendor, which isn't declared",
    ]);
    expect(recordTypesProblems([VENDOR, VENDOR])).toContain(
      "two areas declare the record type vendor",
    );
  });
});

describe("standard actions", () => {
  it("offers Find and Get on every type, Create and Update only where allowed, under its area", () => {
    const vendor = recordActionSpecs(VENDOR);
    expect(vendor.map((s) => s.id)).toEqual([
      "records.vendor.find",
      "records.vendor.get",
      "records.vendor.update",
    ]);
    for (const s of [...vendor, ...recordActionSpecs(JOB_MARGIN)]) {
      expect(ToolSpec.safeParse(s).success, s.id).toBe(true);
    }
    const catalog = buildActionCatalog([...vendor, ...recordActionSpecs(JOB_MARGIN)], {
      connectors: {},
      areas: { shared: "Shared", bookkeeping: "Bookkeeping" },
    });
    const kinds = Object.fromEntries(
      catalog.flatMap((g) => g.actions.map((a) => [a.id, `${g.id}:${a.kind}`])),
    );
    expect(kinds).toEqual({
      "records.vendor.find": "shared:get",
      "records.vendor.get": "shared:get",
      "records.vendor.update": "shared:save",
      "records.job_margin.find": "bookkeeping:get",
      "records.job_margin.get": "bookkeeping:get",
      "records.job_margin.create": "bookkeeping:save",
      "records.job_margin.update": "bookkeeping:save",
    });
  });

  it("types a client's custom fields like built-in ones", () => {
    const [, get, update] = recordActionSpecs(VENDOR, [
      field({ name: "region", type: "text", required: true }),
    ]);
    const catalog = buildActionCatalog([get as ToolSpec, update as ToolSpec], {
      connectors: {},
      areas: {},
    });
    const actions = catalog[0]?.actions ?? [];
    expect(actions[0]?.output.map((f) => f.name)).toEqual(["id", "name", "createdAt", "region"]);
    // Update: the custom field only (name isn't writable), never required.
    expect(actions[1]?.input.map((f) => [f.name, f.required])).toEqual([
      ["id", true],
      ["region", false],
      ["sources", false],
    ]);
  });

  it("names its ids so the gate can read them back", () => {
    expect(parseRecordActionId(recordActionId("bank_transaction", "update"))).toEqual({
      recordType: "bank_transaction",
      action: "update",
    });
    expect(parseRecordActionId("records.vendor.delete")).toBeNull();
    expect(parseRecordActionId("qbo.bill.create")).toBeNull();
  });
});

describe("grants and data sets", () => {
  const data = AgentData.parse({
    grants: [{ recordType: "vendor", read: true }],
    sets: [
      {
        id: "margin-and-roi",
        name: "Margin and ROI",
        grants: [
          { recordType: "job_margin", read: true, create: true, update: true },
          { recordType: "vendor", read: true },
        ],
      },
      { id: "off", name: "Off", on: false, grants: [{ recordType: "vendor", update: true }] },
    ],
  });

  it("grants nothing by default, and the union of the grants and the sets that are on", () => {
    expect(recordGrantAllows(undefined, "vendor", "read")).toBe(false);
    expect(recordGrantAllows(data, "vendor", "read")).toBe(true);
    expect(recordGrantAllows(data, "vendor", "update")).toBe(false);
    expect(recordGrantAllows(data, "job_margin", "create")).toBe(true);
    expect(recordGrantAllows(data, "bank_transaction", "read")).toBe(false);
    expect(effectiveRecordGrants(data).size).toBe(2);
  });

  it("shows writes into another area, and what a new version widens", () => {
    expect(crossAreaWrites(data, "purchasing", [VENDOR, JOB_MARGIN])).toEqual([
      { recordType: "job_margin", area: "bookkeeping", create: true, update: true },
    ]);
    expect(crossAreaWrites(data, "bookkeeping", [VENDOR, JOB_MARGIN])).toEqual([]);
    expect(
      widenedRecordGrants(data, {
        ...data,
        sets: data.sets.map((s) => ({ ...s, on: true })),
      }),
    ).toEqual(["update vendor"]);
  });

  it("refuses a grant on an unknown type or a write the type doesn't allow", () => {
    const wide = AgentData.parse({ grants: [{ recordType: "vendor", create: true }] });
    expect(agentDataProblems(wide, [VENDOR])).toEqual([
      "The agent's grant grants creating vendor records, which can't be created",
    ]);
    expect(agentDataProblems(data, [VENDOR])).toEqual([
      "Data set Margin and ROI names job_margin, which isn't a record type",
    ]);
  });
});

describe("Find", () => {
  const fieldsOf = (t: string) =>
    t === "vendor"
      ? clientRecordFields(VENDOR, [field({ name: "region", type: "text" })])
      : t === "job_margin"
        ? clientRecordFields(JOB_MARGIN)
        : undefined;

  it("reads its own type and each it follows, and checks fields through links", () => {
    const q = FindQuery.parse({
      where: [{ field: "vendor.region", op: "equals", value: "West" }],
      follow: ["vendor"],
      groupBy: "vendor.name",
      totals: [{ field: "margin", as: "margin" }],
      minTotal: { total: "margin", atLeast: "100" },
    });
    expect(findReads(JOB_MARGIN, q)).toEqual(["job_margin", "vendor"]);
    expect(findQueryProblems(JOB_MARGIN, q, fieldsOf)).toEqual([]);
    const bad = FindQuery.parse({
      where: [
        { field: "vendor.region", op: "isSet" },
        { field: "nope", op: "isSet" },
      ],
      follow: ["customer"],
      minTotal: { total: "x", atLeast: 1 },
    });
    expect(findQueryProblems(JOB_MARGIN, bad, fieldsOf)).toEqual([
      "Margin by job has no link customer",
      "there is no field vendor.region",
      "there is no field nope",
      "the minimum names x, which isn't one of the totals",
    ]);
  });
});

describe("custom fields", () => {
  const known = new Set(["vendor", "job_margin"]);

  it("checks a definition: names, links, the limit, and no type change once it holds data", () => {
    const def = field({ name: "terms", type: "text" });
    expect(
      customFieldProblems({ def, recordType: VENDOR, knownTypes: known, existing: [] }),
    ).toEqual([]);
    expect(
      customFieldProblems({
        def: field({ name: "name", type: "text" }),
        recordType: VENDOR,
        knownTypes: known,
        existing: [],
      }),
    ).toEqual(["vendor already has a field name"]);
    expect(
      customFieldProblems({
        def: field({ name: "owner", type: "record", spec: { record: "deal" } }),
        recordType: VENDOR,
        knownTypes: known,
        existing: [],
      }),
    ).toEqual(["there is no record type deal to link to"]);
    const many = Array.from({ length: MAX_CUSTOM_FIELDS }, (_, i) =>
      field({ name: `f${i}`, type: "text" }),
    );
    expect(
      customFieldProblems({ def, recordType: VENDOR, knownTypes: known, existing: many }),
    ).toEqual([`vendor has ${MAX_CUSTOM_FIELDS} custom fields, the most it can have`]);
    const changed = { ...def, type: "number" as const };
    expect(
      customFieldProblems({
        def: changed,
        recordType: VENDOR,
        knownTypes: known,
        existing: [def],
        before: def,
        holdsData: true,
      }),
    ).toEqual(["terms holds data, so its type can't change; add a new field instead"]);
    expect(
      customFieldProblems({
        def: changed,
        recordType: VENDOR,
        knownTypes: known,
        existing: [def],
        before: def,
        holdsData: false,
      }),
    ).toEqual([]);
  });

  it("shows a client's own and shared fields, never hidden ones, its own first", () => {
    const defs = [
      field({ name: "terms", type: "text", scope: "shared" }),
      field({ name: "terms", type: "number" }),
      field({ name: "region", type: "text", scope: "shared" }),
      field({ name: "old", type: "text", hidden: true }),
    ];
    expect(visibleCustomFields(defs, "vendor").map((d) => [d.name, d.type])).toEqual([
      ["terms", "number"],
      ["region", "text"],
    ]);
  });

  it("checks every value on a write: types, money as decimals, required, card numbers", () => {
    const defs = [
      field({ name: "limit", type: "money", label: "Credit limit", required: true }),
      field({ name: "since", type: "date" }),
      field({ name: "active", type: "yes_no" }),
      field({
        name: "contacts",
        type: "list",
        spec: { of: [{ name: "email", type: "text", required: true }] },
      }),
      field({ name: "note", type: "text" }),
    ];
    expect(
      checkCustomValues({
        defs,
        creating: true,
        values: { limit: "2500.00", since: "2026-01-31", contacts: [{ email: "a@b.co" }] },
      }),
    ).toEqual({
      ok: true,
      custom: { limit: "2500.00", since: "2026-01-31", contacts: [{ email: "a@b.co" }] },
    });
    const bad = checkCustomValues({
      defs,
      creating: true,
      values: {
        limit: 2500.5,
        since: "31/01/2026",
        active: "yes",
        contacts: [{ mail: "x" }],
        note: "card 4111 1111 1111 1111",
        nope: 1,
      },
    });
    expect(bad).toEqual({
      ok: false,
      problems: [
        'Credit limit is money, written as a decimal ("1250.00")',
        "since is a date (YYYY-MM-DD)",
        "active is yes or no",
        "contacts 1 has no field mail",
        "note looks like a card number; card numbers are never stored",
        "there is no field nope",
        "Credit limit is required",
      ],
    });
    // An update keeps what it doesn't touch, clears with null, and isn't refused for a required
    // field it never names.
    expect(
      checkCustomValues({
        defs,
        creating: false,
        current: { note: "old", since: "2026-01-01" },
        values: { note: null },
      }),
    ).toEqual({ ok: true, custom: { since: "2026-01-01" } });
    expect(
      checkCustomValues({
        defs,
        creating: false,
        current: { limit: "1" },
        values: { limit: null },
      }),
    ).toEqual({ ok: false, problems: ["Credit limit is required"] });
  });

  it("reads values from ext.custom only, never the area's own ext keys", () => {
    expect(
      customValuesOf({ senderDomains: ["a.com"], [CUSTOM_EXT_KEY]: { region: "West" } }),
    ).toEqual({ region: "West" });
    expect(customValuesOf({ senderDomains: ["a.com"] })).toEqual({});
    expect(customValuesOf(null)).toEqual({});
  });
});
