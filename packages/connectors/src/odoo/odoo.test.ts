import {
  DEFAULT_PERMISSIONS,
  decideToolCall,
  type JsonObject,
  type PermissionMatrix,
  processorsForOffer,
} from "@countersign/core";
import { describe, expect, it } from "vitest";
import {
  type ToolContext,
  ToolRefused,
  UnconfirmedWriteError,
  type WriteContext,
  writeNotMade,
} from "../connector";
import { memoryCredentials } from "../credentials-accessor";
import { executeWrite, runReadTool } from "../invoke";
import { memoryLogger } from "../logger";
import { ReconnectRequiredError } from "../oauth/tokens";
import { connectionDefaults, connectionLevel } from "../permissions";
import { ConnectorRegistry } from "../registry";
import { FAKE_ODOO, fakeOdoo } from "../testing";
import { wireDecimal } from "./client";
import {
  createOdooConnector,
  mapOdooValue,
  ODOO_TOOLS,
  OdooAddressRefused,
  OdooApiError,
  OdooInvalidInputError,
  odooDecimal,
  odooJson,
  odooOrigin,
} from "./index";

const NOW = new Date("2026-11-10T15:00:00.000Z");
const tenant = "0190f0c8-0000-7000-8000-000000000001";
const connectionId = "0190f0c8-0000-7000-8000-0000000000c9";
const LOGIN: JsonObject = {
  url: `${FAKE_ODOO.url}/odoo/action-123`,
  database: FAKE_ODOO.database,
  login: FAKE_ODOO.login,
  apiKey: FAKE_ODOO.apiKey,
};

function setup(
  over: { credentials?: JsonObject | null; permissions?: Partial<PermissionMatrix> } = {},
) {
  const odoo = fakeOdoo({ now: () => NOW });
  const connector = createOdooConnector({ fetch: odoo.fetch });
  const logger = memoryLogger();
  const ctx = (extra: Partial<ToolContext> = {}): ToolContext => ({
    tenantId: tenant,
    connection: {
      id: connectionId,
      tenantId: tenant,
      connector: "odoo",
      status: "connected",
      externalAccountId: null,
      config: {},
      permissions: over.permissions ?? DEFAULT_PERMISSIONS,
    },
    credentials: memoryCredentials(over.credentials === undefined ? LOGIN : over.credentials),
    logger,
    now: () => NOW,
    ...extra,
  });
  const wctx = (key = "run-1:step:0"): WriteContext => ({ ...ctx(), idempotencyKey: key });
  const read = async (tool: string, input: unknown, c: ToolContext = ctx()) =>
    // biome-ignore lint/suspicious/noExplicitAny: outputs are read loosely in tests.
    (await runReadTool(connector, tool, input, c)).output as any;
  const write = async (tool: string, input: unknown, c: WriteContext = wctx()) =>
    // biome-ignore lint/suspicious/noExplicitAny: outputs are read loosely in tests.
    (await executeWrite(connector, tool, input, c)) as { output: any; before: any };
  return { odoo, connector, logger, ctx, wctx, read, write };
}

describe("odoo connector: the manifest", () => {
  it("is Odoo, signed in with a login and an API key the client enters, and registers", () => {
    const { connector } = setup();
    new ConnectorRegistry([connector]);
    const m = connector.manifest;
    expect(m).toMatchObject({ id: "odoo", name: "Odoo", auth: "api_key" });
    expect(m.credentialFields?.map((f) => [f.name, f.secret])).toEqual([
      ["url", false],
      ["database", false],
      ["login", false],
      ["apiKey", true],
    ]);
    expect(m.tools.some((t) => t.verb === "delete")).toBe(false);
    expect(m.tools.filter((t) => t.sideEffect === "external").map((t) => t.id)).toEqual([
      ODOO_TOOLS.create,
      ODOO_TOOLS.update,
      ODOO_TOOLS.confirmOrder,
      ODOO_TOOLS.postInvoice,
      ODOO_TOOLS.validateReceipt,
      ODOO_TOOLS.note,
      ODOO_TOOLS.activity,
    ]);
  });

  it("starts with approval on every write and delete off; reads run alone", () => {
    const m = setup().connector.manifest;
    const matrix = connectionDefaults(m);
    expect(matrix).toMatchObject({ create: "approval", update: "approval", delete: "off" });
    for (const t of m.tools) {
      const input = t.entityInput ? { model: "sale.order" } : {};
      expect(connectionLevel(m, t, matrix, input), t.id).toBe(
        t.verb === "read" ? "auto" : "approval",
      );
    }
    const confirm = m.tools.find((t) => t.id === ODOO_TOOLS.confirmOrder);
    if (!confirm) throw new Error("no confirm");
    const decide = (matrixIn: Partial<PermissionMatrix>, step?: "not_required") =>
      decideToolCall({
        sideEffect: confirm.sideEffect,
        verb: confirm.verb,
        matrix: matrixIn,
        agentMode: "act",
        ...(step ? { stepApproval: step } : {}),
        entity: {
          tool: { id: confirm.id, entityInput: confirm.entityInput },
          input: { model: "purchase.order" },
          declared: m.permissionEntities,
        },
      });
    expect(decide(matrix)).toBe("approval");
    expect(decide({ ...DEFAULT_PERMISSIONS, update: "auto" })).toBe("approval");
    expect(decide({ ...DEFAULT_PERMISSIONS, update: "auto" }, "not_required")).toBe("run");
    expect(confirm.amount).toEqual({ path: "expectedTotal", currencyPath: "currency" });
  });

  it("is the client's own tool, not a processor of ours", () => {
    expect(processorsForOffer("odoo")).toEqual([]);
  });
});

describe("odoo connector: signing in", () => {
  it("signs in with the client's login and key at the address's origin, by JSON-RPC", async () => {
    const { odoo, read } = setup();
    const out = await read(ODOO_TOOLS.get, { model: "res.partner", id: FAKE_ODOO.partners.harbor });
    expect(out.record.name).toBe("Harbor Millwork");
    const first = odoo.requests[0];
    expect(first?.url).toBe(`${FAKE_ODOO.url}/jsonrpc`);
    expect(first?.body).toMatchObject({
      params: {
        service: "common",
        method: "authenticate",
        args: [FAKE_ODOO.database, FAKE_ODOO.login, FAKE_ODOO.apiKey, {}],
      },
    });
    // One sign-in per call.
    expect(
      odoo.requests.filter((r) => JSON.stringify(r.body).includes("authenticate")),
    ).toHaveLength(1);
  });

  it("needs a person when Odoo refuses the login, the key or the database", async () => {
    const wrongKey = setup({ credentials: { ...LOGIN, apiKey: "not-the-key" } });
    const e1 = await wrongKey
      .read(ODOO_TOOLS.get, { model: "res.partner", id: 11 })
      .catch((e) => e);
    expect(e1).toBeInstanceOf(ReconnectRequiredError);
    expect(writeNotMade(e1)).toBe(true);
    const wrongDb = setup({ credentials: { ...LOGIN, database: "nope" } });
    const e2 = await wrongDb.read(ODOO_TOOLS.get, { model: "res.partner", id: 11 }).catch((e) => e);
    expect(e2).toBeInstanceOf(ReconnectRequiredError);
    const revoked = setup();
    revoked.odoo.revokeKey();
    await expect(
      revoked.read(ODOO_TOOLS.get, { model: "res.partner", id: 11 }),
    ).rejects.toBeInstanceOf(ReconnectRequiredError);
    const empty = setup({ credentials: null });
    await expect(
      empty.read(ODOO_TOOLS.get, { model: "res.partner", id: 11 }),
    ).rejects.toBeInstanceOf(ReconnectRequiredError);
  });

  it("calls only an https address on a public host, and never follows a redirect", async () => {
    for (const url of [
      "http://harbor.odoo.com",
      "https://localhost:8069",
      "https://10.0.0.5",
      "https://odoo.internal",
      "https://user:pw@harbor.odoo.com",
    ]) {
      const s = setup({ credentials: { ...LOGIN, url } });
      const e = await s.read(ODOO_TOOLS.get, { model: "res.partner", id: 11 }).catch((x) => x);
      expect(e, url).toBeInstanceOf(OdooAddressRefused);
      expect(e).toBeInstanceOf(ToolRefused);
      expect(s.odoo.requests).toEqual([]);
    }
    expect(odooOrigin("https://acme.odoo.com/odoo/crm")).toBe("https://acme.odoo.com");
    const moved = setup();
    moved.odoo.failNext(302);
    const e = await moved.read(ODOO_TOOLS.get, { model: "res.partner", id: 11 }).catch((x) => x);
    expect(e).toBeInstanceOf(OdooApiError);
    expect(e.message).toMatch(/redirect/);
  });

  it("never puts the API key in an error, a log or an output", async () => {
    const { read, logger } = setup();
    const e = await read(ODOO_TOOLS.search, {
      model: "res.partner",
      conditions: [{ field: "nonexistent_field", op: "=", value: 1 }],
    }).catch((x) => x);
    expect(e).toBeInstanceOf(OdooInvalidInputError);
    expect(String(e.message)).not.toContain(FAKE_ODOO.apiKey);
    const out = await read(ODOO_TOOLS.search, { model: "res.partner" });
    expect(JSON.stringify(out)).not.toContain(FAKE_ODOO.apiKey);
    expect(JSON.stringify(logger)).not.toContain(FAKE_ODOO.apiKey);
  });
});

describe("odoo connector: reading", () => {
  it("searches by a word and by conditions, with sources and a next page", async () => {
    const { read } = setup();
    const byWord = await read(ODOO_TOOLS.search, { model: "res.partner", query: "acme" });
    expect(byWord.records.map((r: { id: number }) => r.id)).toEqual([FAKE_ODOO.partners.acme]);
    expect(byWord.sources).toEqual([`res.partner:${FAKE_ODOO.partners.acme}`]);
    const page = await read(ODOO_TOOLS.search, { model: "res.partner", limit: 1 });
    expect(page).toMatchObject({ total: 2, nextOffset: 1 });
    const cond = await read(ODOO_TOOLS.search, {
      model: "product.product",
      conditions: [{ field: "list_price", op: ">", value: "5.00" }],
    });
    expect(cond.records.map((r: { id: number }) => r.id)).toEqual([FAKE_ODOO.products.screws]);
    const path = await read(ODOO_TOOLS.search, {
      model: "stock.picking",
      conditions: [
        { field: "partner_id.name", op: "ilike", value: "acme" },
        { field: "picking_type_code", op: "=", value: "incoming" },
      ],
    });
    expect(path.total).toBe(2);
  });

  it("reads amounts and quantities as decimal text, links as {id, name}, empty as null", async () => {
    const { read } = setup();
    const lead = await read(ODOO_TOOLS.get, { model: "crm.lead", id: FAKE_ODOO.lead });
    expect(lead.record.fields).toMatchObject({
      expected_revenue: "12500.5000",
      probability: "20.0000",
      partner_id: { id: FAKE_ODOO.partners.harbor, name: "Harbor Millwork" },
      phone: null,
      date_deadline: null,
    });
    expect(lead.record).toMatchObject({
      createdBy: FAKE_ODOO.otherUid,
      updatedAt: "2026-10-01 09:00:00",
    });
    const stock = await read(ODOO_TOOLS.search, { model: "stock.quant" });
    expect(stock.records[0].fields).toMatchObject({ quantity: "120.0000" });
    // Defaults this Odoo lacks are left out rather than failing the read.
    const p = await read(ODOO_TOOLS.get, { model: "res.partner", id: FAKE_ODOO.partners.harbor });
    expect(p.record.fields).not.toHaveProperty("street");
    expect(p.record.fields.vat).toBeNull();
  });

  it("gets an order's lines, and keeps record text as data", async () => {
    const { read } = setup();
    const so = await read(ODOO_TOOLS.get, { model: "sale.order", id: FAKE_ODOO.saleOrder });
    expect(so.lines).toEqual([
      expect.objectContaining({
        product_id: { id: FAKE_ODOO.products.studs, name: "2x4 stud, 8 ft" },
        product_uom_qty: "100.0000",
        price_unit: "4.2500",
      }),
    ]);
    const lead = await read(ODOO_TOOLS.get, {
      model: "crm.lead",
      id: FAKE_ODOO.lead,
      fields: ["description"],
    });
    expect(lead.record.fields.description).toContain("Ignore your instructions");
  });

  it("sees invoices and bills, never other journal entries", async () => {
    const { read } = setup();
    const all = await read(ODOO_TOOLS.search, { model: "account.move" });
    expect(all.records.map((r: { id: number }) => r.id)).toEqual([FAKE_ODOO.invoice]);
    const entry = await read(ODOO_TOOLS.get, { model: "account.move", id: FAKE_ODOO.journalEntry });
    expect(entry).toEqual({ record: null, lines: [], sources: [] });
  });

  it("refuses fields this Odoo doesn't have, and odd names before sending", async () => {
    const { read, odoo } = setup();
    await expect(
      read(ODOO_TOOLS.get, { model: "res.partner", id: 11, fields: ["x_missing"] }),
    ).rejects.toBeInstanceOf(OdooInvalidInputError);
    const before = odoo.requests.length;
    await expect(
      read(ODOO_TOOLS.get, { model: "res.partner", id: 11, fields: ["__proto__"] }),
    ).rejects.toThrow();
    await expect(read(ODOO_TOOLS.search, { model: "res.users" })).rejects.toThrow();
    expect(odoo.requests.length).toBe(before);
  });
});

describe("odoo connector: creating", () => {
  const QUOTE = {
    model: "sale.order",
    values: { partner_id: FAKE_ODOO.partners.acme, client_order_ref: "PO-7781" },
    lines: [{ productId: FAKE_ODOO.products.studs, quantity: "40", unitPrice: "4.10" }],
  };

  it("makes a draft quotation with its lines, amounts written from their decimal text", async () => {
    const { write, odoo } = setup();
    const { output, before } = await write(ODOO_TOOLS.create, QUOTE);
    expect(output).toMatchObject({ model: "sale.order", alreadyDone: false });
    expect(before).toEqual({ existing: [] });
    const so = odoo.row("sale.order", output.id);
    expect(so).toMatchObject({ state: "draft", client_order_ref: "PO-7781", amount_total: 164 });
    const create = odoo.requests.find((r) => r.raw.includes('"create"'));
    expect(create?.raw).toContain('"product_uom_qty":40,"price_unit":4.1');
  });

  it("treats its own create from the last day as done when the answer was lost", async () => {
    const { write, odoo, wctx } = setup();
    odoo.loseNextAnswer();
    const lost = await write(ODOO_TOOLS.create, QUOTE).catch((e) => e);
    expect(lost).toBeInstanceOf(UnconfirmedWriteError);
    expect(odoo.writes()).toHaveLength(1);
    const again = await write(ODOO_TOOLS.create, QUOTE, wctx());
    expect(again.output.alreadyDone).toBe(true);
    expect(odoo.writes()).toHaveLength(1);
    // Someone else's draft for the same customer is shown to the approver, not taken as ours.
    expect(again.before.existing.length).toBeGreaterThan(0);
  });

  it("refuses a contact whose email is already in Odoo, and protected fields", async () => {
    const { write, odoo } = setup();
    const dup = await write(ODOO_TOOLS.create, {
      model: "res.partner",
      values: { name: "Acme again", email: "orders@acme.example" },
    }).catch((e) => e);
    expect(dup).toBeInstanceOf(OdooApiError);
    expect(dup.kind).toBe("conflict");
    expect(writeNotMade(dup)).toBe(true);
    const state = await write(ODOO_TOOLS.create, {
      model: "account.move",
      moveType: "in_invoice",
      values: { partner_id: FAKE_ODOO.partners.acme, state: "posted" },
    }).catch((e) => e);
    expect(state).toBeInstanceOf(OdooInvalidInputError);
    const float = await write(ODOO_TOOLS.create, {
      model: "crm.lead",
      values: { name: "Deck", expected_revenue: 99 },
    });
    expect(odoo.row("crm.lead", float.output.id)?.expected_revenue).toBe(99);
    await expect(
      write(ODOO_TOOLS.create, {
        model: "crm.lead",
        values: { name: "X", expected_revenue: true },
      }),
    ).rejects.toBeInstanceOf(OdooInvalidInputError);
    expect(odoo.writes()).toHaveLength(1);
  });

  it("makes a draft bill with taxes and accounts on its lines", async () => {
    const { write, odoo } = setup();
    const { output } = await write(ODOO_TOOLS.create, {
      model: "account.move",
      moveType: "in_invoice",
      values: {
        partner_id: FAKE_ODOO.partners.acme,
        ref: "ACME-20977",
        invoice_date: "2026-11-09",
      },
      lines: [
        {
          productId: FAKE_ODOO.products.screws,
          quantity: "3",
          unitPrice: "6.40",
          taxIds: [5],
          accountId: 601,
        },
      ],
    });
    expect(odoo.row("account.move", output.id)).toMatchObject({
      move_type: "in_invoice",
      state: "draft",
    });
    await expect(
      write(ODOO_TOOLS.create, {
        model: "purchase.order",
        values: { partner_id: FAKE_ODOO.partners.acme },
        lines: [{ productId: FAKE_ODOO.products.screws, quantity: "3", taxIds: [5] }],
      }),
    ).rejects.toBeInstanceOf(OdooInvalidInputError);
  });
});

describe("odoo connector: updating", () => {
  it("changes fields with their before state, and its restore undo", async () => {
    const { write, odoo, connector } = setup();
    const { output, before } = await write(ODOO_TOOLS.update, {
      model: "crm.lead",
      id: FAKE_ODOO.lead,
      values: { expected_revenue: "14000", phone: "+1 555 0199" },
      expectedUpdatedAt: "2026-10-01 09:00:00",
    });
    expect(output.alreadyDone).toBe(false);
    expect(before.values).toEqual({ expected_revenue: "12500.5000", phone: null });
    expect(odoo.row("crm.lead", FAKE_ODOO.lead)?.expected_revenue).toBe(14000);
    const handler = connector.tools[ODOO_TOOLS.update];
    if (handler?.kind !== "write" || !handler.undoInput) throw new Error("no undo");
    const undo = handler.undoInput({
      input: {
        model: "crm.lead",
        id: FAKE_ODOO.lead,
        values: { expected_revenue: "14000", phone: "+1 555 0199" },
      },
      before,
      output,
      current: { ...before, updatedAt: "2026-11-10 15:00:00" },
    });
    expect(undo).toEqual({
      model: "crm.lead",
      id: FAKE_ODOO.lead,
      values: { expected_revenue: "12500.5000", phone: null },
      expectedUpdatedAt: "2026-11-10 15:00:00",
    });
  });

  it("does nothing when already as asked, and refuses a record changed since it was read", async () => {
    const { write, odoo } = setup();
    const same = await write(ODOO_TOOLS.update, {
      model: "res.partner",
      id: FAKE_ODOO.partners.harbor,
      values: { city: "Portland", country_id: 233 },
    });
    expect(same.output.alreadyDone).toBe(true);
    odoo.touch("res.partner", FAKE_ODOO.partners.harbor, { city: "Salem" });
    const stale = await write(ODOO_TOOLS.update, {
      model: "res.partner",
      id: FAKE_ODOO.partners.harbor,
      values: { city: "Eugene" },
      expectedUpdatedAt: "2026-10-01 09:00:00",
    }).catch((e) => e);
    expect(stale).toBeInstanceOf(OdooApiError);
    expect(stale.code).toBe("STALE");
    expect(odoo.writes()).toEqual([]);
  });

  it("passes on Odoo's own refusal as not written", async () => {
    const { write, odoo } = setup();
    odoo.touch("account.move", FAKE_ODOO.invoice, { state: "posted" });
    const e = await write(ODOO_TOOLS.update, {
      model: "account.move",
      id: FAKE_ODOO.invoice,
      values: { ref: "X" },
    }).catch((x) => x);
    expect(e).toBeInstanceOf(OdooInvalidInputError);
    expect(e.message).toMatch(/posted entry/);
    expect(writeNotMade(e)).toBe(true);
  });
});

describe("odoo connector: confirming, posting and validating", () => {
  it("confirms a purchase order at the total the person saw, once", async () => {
    const { write, odoo } = setup();
    const wrong = await write(ODOO_TOOLS.confirmOrder, {
      model: "purchase.order",
      id: FAKE_ODOO.purchaseOrder,
      expectedTotal: "300.00",
      currency: "USD",
    }).catch((e) => e);
    expect(wrong).toBeInstanceOf(OdooInvalidInputError);
    expect(odoo.writes()).toEqual([]);
    const ok = await write(ODOO_TOOLS.confirmOrder, {
      model: "purchase.order",
      id: FAKE_ODOO.purchaseOrder,
      expectedTotal: "310.00",
      currency: "USD",
    });
    expect(ok.output).toMatchObject({ state: "purchase", alreadyDone: false, name: "P00061" });
    expect(ok.before).toMatchObject({
      state: "draft",
      total: "310.0000",
      currency: "USD",
      partner: "Acme Lumber",
    });
    const again = await write(ODOO_TOOLS.confirmOrder, {
      model: "purchase.order",
      id: FAKE_ODOO.purchaseOrder,
      expectedTotal: "310.00",
      currency: "USD",
    });
    expect(again.output.alreadyDone).toBe(true);
    expect(odoo.writes()).toEqual([{ model: "purchase.order", method: "button_confirm" }]);
  });

  it("posts a draft invoice once", async () => {
    const { write, odoo } = setup();
    const { output } = await write(ODOO_TOOLS.postInvoice, {
      id: FAKE_ODOO.invoice,
      expectedTotal: "462.19",
      currency: "USD",
    });
    expect(output).toMatchObject({ state: "posted", alreadyDone: false });
    expect(output.name).toMatch(/^INV\//);
    const again = await write(ODOO_TOOLS.postInvoice, {
      id: FAKE_ODOO.invoice,
      expectedTotal: "462.19",
      currency: "USD",
    });
    expect(again.output.alreadyDone).toBe(true);
    expect(odoo.writes()).toHaveLength(1);
  });

  it("validates a receipt, and leaves deliveries and backorders to a person", async () => {
    const { write, odoo } = setup();
    const { output, before } = await write(ODOO_TOOLS.validateReceipt, { id: FAKE_ODOO.receipt });
    expect(output).toMatchObject({ state: "done", alreadyDone: false });
    expect(before.moves).toEqual([
      { product: "2x4 stud, 8 ft", demand: "50.0000", quantity: "50.0000" },
    ]);
    await expect(
      write(ODOO_TOOLS.validateReceipt, { id: FAKE_ODOO.delivery }),
    ).rejects.toBeInstanceOf(OdooInvalidInputError);
    const wizard = await write(ODOO_TOOLS.validateReceipt, { id: FAKE_ODOO.emptyReceipt }).catch(
      (e) => e,
    );
    expect(wizard).toBeInstanceOf(OdooApiError);
    expect(wizard.message).toMatch(/person to decide/);
    expect(odoo.row("stock.picking", FAKE_ODOO.emptyReceipt)?.state).toBe("assigned");
  });
});

describe("odoo connector: notes and activities", () => {
  it("logs an internal note once, its text kept as text", async () => {
    const { write, odoo } = setup();
    const text = "Called Dana: wants <b>oak</b> & walnut\nQuote by Friday";
    const { output } = await write(ODOO_TOOLS.note, {
      model: "crm.lead",
      recordId: FAKE_ODOO.lead,
      text,
    });
    expect(output.alreadyDone).toBe(false);
    const post = odoo.requests.find((r) => r.raw.includes("message_post"));
    expect(post?.raw).toContain('"subtype_xmlid":"mail.mt_note"');
    const again = await write(ODOO_TOOLS.note, {
      model: "crm.lead",
      recordId: FAKE_ODOO.lead,
      text,
    });
    expect(again.output).toMatchObject({ id: output.id, alreadyDone: true });
    expect(odoo.writes()).toHaveLength(1);
    await expect(
      write(ODOO_TOOLS.note, { model: "stock.quant", recordId: FAKE_ODOO.quant, text: "x" }),
    ).rejects.toBeInstanceOf(OdooInvalidInputError);
  });

  it("schedules an activity once, for our user unless told", async () => {
    const { write, odoo } = setup();
    const input = {
      model: "sale.order",
      recordId: FAKE_ODOO.saleOrder,
      summary: "Chase the signed quote",
      dueDate: "2026-11-14",
    };
    const { output } = await write(ODOO_TOOLS.activity, input);
    expect(odoo.row("mail.activity", output.id)).toMatchObject({
      res_model: "sale.order",
      res_id: FAKE_ODOO.saleOrder,
      user_id: [FAKE_ODOO.uid, "Mezonas"],
    });
    const again = await write(ODOO_TOOLS.activity, input);
    expect(again.output).toEqual({ id: output.id, alreadyDone: true });
  });
});

describe("odoo connector: wire values", () => {
  it("reads Odoo's numbers as decimals and writes decimals as numbers from their text", () => {
    expect(odooDecimal(0.1 + 0.2)).toBe("0.3000");
    expect(odooDecimal(462.19)).toBe("462.1900");
    expect(mapOdooValue(false, { type: "char" })).toBeNull();
    expect(mapOdooValue(false, { type: "boolean" })).toBe(false);
    expect(mapOdooValue([3, "New"], { type: "many2one" })).toEqual({ id: 3, name: "New" });
    expect(mapOdooValue(7, { type: "monetary" })).toBe("7.0000");
    expect(odooJson({ a: wireDecimal("0012.5000"), b: "0.1" })).toBe('{"a":12.5,"b":"0.1"}');
  });

  it("an answer lost on a write is unconfirmed, a refused one is not written", async () => {
    const { write, odoo } = setup();
    odoo.failNext(503);
    // The 503 lands on the sign-in, before any write: a plain failure.
    const e = await write(ODOO_TOOLS.note, {
      model: "crm.lead",
      recordId: FAKE_ODOO.lead,
      text: "x",
    }).catch((x) => x);
    expect(e).toBeInstanceOf(OdooApiError);
    expect(e.retryable).toBe(true);
  });
});
