// "billcom": BILL (Bill.com), accounts payable (docs/plan.md §1.87). The client admin enters, in the
// vault, the login of a BILL user made for us (username, password, organization id): encrypted with
// the client's own key, write-only, never shown, logged or given to a model (invariant 13). Our
// developer key (BILL_DEV_KEY) and BILL_ENV are the platform's. Each tool call signs in lazily,
// signs in again once if the session ended, and signs out when it's done (or when the skill run
// that holds the session ends).
//
// Reads: vendors, bills and payments, each with `sources`. Writes, each `external` behind approval
// and run once per external action: vendor create and update, bill create, update and archive (a
// created bill's undo), and a stored document attached to a bill. `billcom.payment.create` is
// defined but refused: BILL pays only from an MFA-trusted session, which waits for a path through
// our code service; its entity starts off and it is always signed by a person. No delete tool.
// Unchecked facts: ./NOTES.md.

import { CurrencyCode, DecimalString, dec } from "@countersign/core";
import { z } from "zod";
import {
  type Connector,
  defineConnector,
  defineReadTool,
  defineWriteTool,
  type ToolContext,
  ToolRefused,
  UnconfirmedWriteError,
} from "../connector";
import {
  BILLCOM_API_BASE,
  BILLCOM_CREDENTIAL_FIELDS,
  BillcomApiError,
  BillcomClient,
  type BillcomEnvironment,
  type BillcomFetch,
  BillcomId,
  BillcomNotConfiguredError,
  refuse,
  runtimeBillcomFetch,
  type SessionHolder,
  type WriteNote,
  wire,
  writeAnswer,
} from "./api";
import {
  BillcomAddress,
  BillcomBill,
  BillcomDocument,
  BillcomPage,
  BillcomPayment,
  BillcomVendor,
  mapBillcomBill,
  mapBillcomDocument,
  mapBillcomPayment,
  mapBillcomVendor,
  RawBill,
  RawVendor,
  resultsOf,
} from "./records";

// Named, not `export *`: QuickBooks' wire helpers share some of these names.
export {
  BILLCOM_API_BASE,
  BILLCOM_CREDENTIAL_FIELDS,
  BillcomApiError,
  BillcomCredentials,
  BillcomEnvironment,
  type BillcomErrorKind,
  type BillcomFetch,
  BillcomId,
  BillcomInvalidInputError,
  BillcomNotConfiguredError,
  type BillcomRequestInit,
  billcomAmount,
  billcomEnvironment,
  billcomJson,
  readBillcomError,
} from "./api";
export {
  BillcomAddress,
  BillcomBill,
  BillcomDocument,
  BillcomPayment,
  BillcomVendor,
  mapBillcomBill,
  mapBillcomPayment,
  mapBillcomVendor,
} from "./records";

export const BILLCOM_CONNECTOR_ID = "billcom";
export const BILLCOM_TOOLS = {
  vendorSearch: "billcom.vendor.search",
  vendorGet: "billcom.vendor.get",
  vendorCreate: "billcom.vendor.create",
  vendorUpdate: "billcom.vendor.update",
  billList: "billcom.bill.list",
  billGet: "billcom.bill.get",
  billCreate: "billcom.bill.create",
  billUpdate: "billcom.bill.update",
  billArchive: "billcom.bill.archive",
  billAttach: "billcom.bill.attach_document",
  paymentList: "billcom.payment.list",
  paymentGet: "billcom.payment.get",
  paymentCreate: "billcom.payment.create",
} as const;

/** Files BILL takes on a bill, as far as we know (NOTES.md). */
const DOCUMENT_TYPES = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/tiff",
]);
// DECISION: 10 MB, under what BILL is said to take (UNCHECKED, NOTES.md).
const DOCUMENT_MAX_BYTES = 10 * 1024 * 1024;
/** A vendor's open bills read to find a duplicate: pages of 100. */
const DUPLICATE_PAGES = 10;
/** A vendor made this recently with every asked field is this action's own earlier write. */
const TWIN_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Why `billcom.payment.create` never runs yet: BILL takes a payment only from a session the user
 * confirmed with a second factor (an MFA-trusted session), and that path through our code service
 * (apps/mfa) isn't built. A refusal: nothing is sent.
 */
export class BillcomPaymentRefused extends ToolRefused {
  readonly notWritten = true;
  constructor() {
    super(
      "We don't pay bills in BILL yet. BILL pays only from a sign-in confirmed with a second factor, and we haven't built that step.",
    );
    this.name = "BillcomPaymentRefused";
  }
}

// ── Inputs ──────────────────────────────────────────────────────────────────────────────────────

const IsoDate = z.iso.date();
const Max = z.number().int().min(1).max(100).default(50);
/** BILL's cursor for the next page (`nextPage`), passed back as it came. */
const PageCursor = z
  .string()
  .min(1)
  .max(500)
  .regex(/^[A-Za-z0-9_\-=+/.]+$/, "a page cursor from BILL");
/** Whether text can go inside a BILL filter's quotes: no quote, backslash or control character. */
export function filterSafe(v: string): boolean {
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i);
    if (c < 0x20 || c === 0x7f || c === 0x22 || c === 0x5c) return false;
  }
  return true;
}
const FilterText = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .refine(filterSafe, "no quotes, backslashes or control characters");
const PaymentStatus = z.string().regex(/^[A-Z_]{1,30}$/, "BILL's status in capitals, e.g. UNPAID");
const Name = z.string().trim().min(1).max(100);
const Phone = z.string().trim().min(3).max(40);
const AccountNumber = z.string().trim().min(1).max(60);
const AddressInput = z.object({
  line1: z.string().trim().min(1).max(100),
  line2: z.string().trim().max(100).optional(),
  city: z.string().trim().min(1).max(60),
  state: z.string().trim().min(1).max(60),
  zip: z.string().trim().min(1).max(20),
  country: z.string().trim().min(2).max(60),
});
type AddressInput = z.infer<typeof AddressInput>;

/** Letters and digits only, lower case: "INV-20931" and "inv 20931" are the same number. */
// DECISION: invoice numbers are compared on their letters and digits, as QuickBooks bills are
// (qbo/bill-create.ts), so a number typed with a different dash or case is still a duplicate.
export function normalizeInvoiceNumber(v: string): string {
  return v.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** `field:op:"value"`, joined by commas (UNCHECKED: BILL's v3 filter syntax, NOTES.md). */
function filters(parts: [string, string, string | boolean | undefined][]): Record<string, string> {
  const out = parts
    .filter(([, , v]) => v !== undefined)
    .map(([f, op, v]) => (typeof v === "boolean" ? `${f}:${op}:${v}` : `${f}:${op}:"${v}"`));
  return out.length > 0 ? { filters: out.join(",") } : {};
}

function pageQuery(max: number, page: string | undefined, f: Record<string, string>) {
  return { max: String(max), ...(page ? { page } : {}), ...f };
}

const lower = (v: string | null | undefined) => (v ?? "").toLowerCase();

// ── The connector ───────────────────────────────────────────────────────────────────────────────

export interface BillcomOptions {
  /** Our BILL developer key (BILL_DEV_KEY). Unset: every tool refuses, nothing is sent. */
  devKey?: string | undefined;
  /** Which BILL (BILL_ENV): the sandbox unless production. */
  environment?: BillcomEnvironment;
  fetch?: BillcomFetch;
}

export function createBillcomConnector(options: BillcomOptions = {}): Connector {
  const environment = options.environment ?? "sandbox";

  /**
   * Runs `fn` with BILL for this call's connection. A skill run that holds sessions keeps one BILL
   * session per connection for its calls (closed, and signed out, when the run ends); otherwise the
   * call signs in when it first needs to and signs out when it's done.
   */
  // DECISION: no session is kept beyond what the framework holds (one call, or one skill run's
  // RunSessions); the login is read from the vault at each sign-in and never kept.
  async function withBill<T>(ctx: ToolContext, fn: (c: BillcomClient) => Promise<T>): Promise<T> {
    if (!options.devKey) throw new BillcomNotConfiguredError();
    const opts = {
      base: BILLCOM_API_BASE[environment],
      devKey: options.devKey,
      fetch: options.fetch ?? runtimeBillcomFetch(),
    };
    if (ctx.sessions) {
      const holder = await ctx.sessions.hold<SessionHolder>(
        `${BILLCOM_CONNECTOR_ID}:${ctx.connection.id}`,
        async () => {
          const h: SessionHolder = { session: null };
          return { value: h, close: () => new BillcomClient(opts, ctx, h).logout() };
        },
      );
      return fn(new BillcomClient(opts, ctx, holder));
    }
    const client = new BillcomClient(opts, ctx, { session: null });
    try {
      return await fn(client);
    } finally {
      await client.logout();
    }
  }

  async function getOrNull<T>(
    c: BillcomClient,
    path: string,
    map: (raw: unknown) => T,
  ): Promise<T | null> {
    try {
      return map(await c.request("GET", path));
    } catch (error) {
      if (error instanceof BillcomApiError && error.status === 404) return null;
      throw error;
    }
  }

  const vendorPath = (id: string) => `/vendors/${encodeURIComponent(id)}`;
  const billPath = (id: string) => `/bills/${encodeURIComponent(id)}`;

  /** Live vendors whose name is this one, any case. */
  async function vendorsNamed(c: BillcomClient, name: string): Promise<BillcomVendor[]> {
    const safe = FilterText.safeParse(name);
    const body = await c.request("GET", "/vendors", {
      query: pageQuery(100, undefined, {
        ...filters([
          ["name", "sw", safe.success ? safe.data : undefined],
          ["archived", "eq", false],
        ]),
      }),
    });
    return resultsOf(body)
      .map(mapBillcomVendor)
      .filter((v) => !v.archived && lower(v.name) === lower(name.trim()));
  }

  /** A vendor's bills in BILL now with this invoice number (compared normalized), not archived. */
  async function billsNumbered(
    c: BillcomClient,
    vendorId: string,
    invoiceNumber: string,
  ): Promise<BillcomBill[]> {
    const want = normalizeInvoiceNumber(invoiceNumber);
    const found: BillcomBill[] = [];
    let page: string | undefined;
    for (let i = 0; i < DUPLICATE_PAGES; i++) {
      const body = BillcomPage.parse(
        await c.request("GET", "/bills", {
          query: pageQuery(
            100,
            page,
            filters([
              ["vendorId", "eq", vendorId],
              ["archived", "eq", false],
            ]),
          ),
        }),
      );
      for (const b of body.results.map(mapBillcomBill)) {
        if (
          b.vendorId === vendorId &&
          !b.archived &&
          normalizeInvoiceNumber(b.invoiceNumber ?? "") === want
        ) {
          found.push(b);
        }
      }
      page = body.nextPage ?? undefined;
      if (!page) return found;
    }
    throw refuse(
      `this vendor has more than ${DUPLICATE_PAGES * 100} open bills in BILL, so we couldn't check for a duplicate`,
    );
  }

  async function liveVendor(c: BillcomClient, id: string): Promise<BillcomVendor> {
    const v = await getOrNull(c, vendorPath(id), mapBillcomVendor);
    if (!v || v.archived)
      throw refuse(`vendor ${id} isn't one of this organization's vendors in BILL`);
    return v;
  }

  // ── Vendor create ──

  const VendorCreateInput = z.object({
    name: Name,
    accountType: z.enum(["BUSINESS", "PERSON"]).default("BUSINESS"),
    email: z.email().max(254).optional(),
    phone: Phone.optional(),
    accountNumber: AccountNumber.optional(),
    address: AddressInput.optional(),
  });
  type VendorCreateInput = z.infer<typeof VendorCreateInput>;

  const wireAddress = (a: AddressInput) => ({
    line1: a.line1,
    ...(a.line2 ? { line2: a.line2 } : {}),
    city: a.city,
    stateOrProvince: a.state,
    zipOrPostalCode: a.zip,
    country: a.country,
  });

  /** Whether a vendor already has every field the create asks for. */
  function sameVendor(v: BillcomVendor, i: VendorCreateInput): boolean {
    return (
      lower(v.name) === lower(i.name) &&
      (i.email === undefined || lower(v.email) === lower(i.email)) &&
      (i.phone === undefined || v.phone === i.phone) &&
      (i.accountNumber === undefined || v.accountNumber === i.accountNumber)
    );
  }

  // ── Updates: vendor and bill ──

  const VendorSet = z
    .object({
      name: Name.optional(),
      email: z.email().max(254).optional(),
      phone: Phone.optional(),
      accountNumber: AccountNumber.optional(),
      address: AddressInput.optional(),
    })
    .refine((s) => Object.keys(s).length > 0, "set at least one field");
  type VendorSet = z.infer<typeof VendorSet>;
  type VendorField = keyof VendorSet;

  const VendorValues = z.object({
    name: z.string().nullable().optional(),
    email: z.string().nullable().optional(),
    phone: z.string().nullable().optional(),
    accountNumber: z.string().nullable().optional(),
    address: BillcomAddress.nullable().optional(),
  });

  function vendorValue(v: BillcomVendor, field: VendorField) {
    return v[field];
  }

  function sameAddress(a: BillcomAddress | null | undefined, b: AddressInput): boolean {
    return (
      !!a &&
      a.line1 === b.line1 &&
      (a.line2 ?? "") === (b.line2 ?? "") &&
      a.city === b.city &&
      a.state === b.state &&
      a.zip === b.zip &&
      a.country === b.country
    );
  }

  function vendorHas(values: z.infer<typeof VendorValues>, set: VendorSet): boolean {
    return (Object.keys(set) as VendorField[]).every((k) =>
      k === "address"
        ? set.address !== undefined && sameAddress(values.address, set.address)
        : (values[k] ?? null) === (set[k] ?? null),
    );
  }

  const BillSet = z
    .object({
      invoiceNumber: z.string().trim().min(1).max(50).optional(),
      invoiceDate: IsoDate.optional(),
      dueDate: IsoDate.optional(),
      description: z.string().trim().min(1).max(4000).optional(),
    })
    .refine((s) => Object.keys(s).length > 0, "set at least one field");
  type BillSet = z.infer<typeof BillSet>;
  type BillField = keyof BillSet;

  const BillValues = z.object({
    invoiceNumber: z.string().nullable().optional(),
    invoiceDate: z.string().nullable().optional(),
    dueDate: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
  });

  /** A changed-since refusal: the record moved on from what was read or approved. */
  function changedSince(
    what: string,
    updatedTime: string | null,
    expected: string | undefined,
    proposed: unknown,
  ): void {
    if (expected !== undefined && expected !== updatedTime) {
      throw refuse(`${what} changed in BILL since it was read; read it again`);
    }
    const approved = (proposed as { updatedTime?: unknown } | null | undefined)?.updatedTime;
    if (typeof approved === "string" && approved !== updatedTime) {
      throw refuse(`${what} changed in BILL since this change was approved`);
    }
  }

  /** Builds a restore's input from the before state, or null where a field was empty before. */
  function restoreSet<K extends string>(
    fields: readonly K[],
    values: Partial<Record<K, unknown>>,
  ): Record<K, unknown> | null {
    const set = {} as Record<K, unknown>;
    for (const k of fields) {
      const prev = values[k];
      // DECISION: a field that was empty before isn't restored (UNCHECKED whether BILL clears a
      // field on null), so that write has no undo.
      if (prev === null || prev === undefined) return null;
      set[k] = prev;
    }
    return set;
  }

  // ── Bill create ──

  const NewLine = z.object({
    amount: DecimalString,
    description: z.string().trim().max(500).optional(),
    /** An account of the client's BILL chart of accounts. */
    chartOfAccountId: BillcomId.optional(),
  });

  const BillCreateInput = z.object({
    vendorId: BillcomId,
    invoiceNumber: z.string().trim().min(1).max(50),
    invoiceDate: IsoDate,
    dueDate: IsoDate,
    currency: CurrencyCode,
    /** What the lines add up to; the bill is refused if they don't. */
    expectedTotal: DecimalString,
    description: z.string().trim().max(4000).optional(),
    lines: z.array(NewLine).min(1).max(100),
  });
  type BillCreateInput = z.infer<typeof BillCreateInput>;

  function billProblem(i: BillCreateInput): Error | null {
    // DECISION: US dollars only until a non-US BILL organization is checked (NOTES.md).
    if (i.currency !== "USD") return refuse(`BILL bills here are in USD, not ${i.currency}`);
    let total = dec("0");
    for (const l of i.lines) {
      if (!dec(l.amount).greaterThan(0)) return refuse("each line's amount must be more than zero");
      total = total.plus(dec(l.amount));
    }
    if (!total.equals(dec(i.expectedTotal))) {
      return refuse(`the lines add up to ${total.toFixed(2)}, not the ${i.expectedTotal} expected`);
    }
    return null;
  }

  /** The bill this create would make is the one there: same total and line count. */
  const sameBill = (b: BillcomBill, i: BillCreateInput) =>
    dec(b.amount.amount).equals(dec(i.expectedTotal)) && b.lines.length === i.lines.length;

  const BillCreated = z.object({
    id: z.string(),
    vendorId: z.string(),
    invoiceNumber: z.string().nullable(),
    amount: z.object({ amount: DecimalString, currency: CurrencyCode }),
    lineCount: z.number().int(),
    updatedTime: z.string().nullable(),
    alreadyDone: z.boolean(),
  });
  const createdOut = (b: BillcomBill, alreadyDone: boolean): z.input<typeof BillCreated> => ({
    id: b.id,
    vendorId: b.vendorId,
    invoiceNumber: b.invoiceNumber,
    amount: b.amount,
    lineCount: b.lines.length,
    updatedTime: b.updatedTime,
    alreadyDone,
  });

  const BillState = z.object({
    id: z.string(),
    vendorName: z.string().nullable(),
    invoiceNumber: z.string().nullable(),
    amount: z.object({ amount: DecimalString, currency: CurrencyCode }),
    paymentStatus: z.string().nullable(),
    archived: z.boolean(),
    updatedTime: z.string().nullable(),
  });
  const billState = (b: BillcomBill): z.infer<typeof BillState> => ({
    id: b.id,
    vendorName: b.vendorName,
    invoiceNumber: b.invoiceNumber,
    amount: b.amount,
    paymentStatus: b.paymentStatus,
    archived: b.archived,
    updatedTime: b.updatedTime,
  });

  /** BILL changes a bill only while nothing is paid or scheduled on it. */
  // DECISION: we refuse it ourselves rather than send it: a scheduled payment is money on its way.
  const unpaid = (status: string | null) => status === null || status === "UNPAID";

  return defineConnector({
    id: BILLCOM_CONNECTOR_ID,
    name: "BILL",
    description:
      "Vendors, bills and payments in your BILL (Bill.com). We sign in as a BILL user you make for us. Paying bills stays off.",
    icon: "bill",
    auth: "api_key",
    credentialFields: BILLCOM_CREDENTIAL_FIELDS.map((f) => ({ ...f })),
    entities: ["Vendor", "Bill", "Payment", "Document"],
    permissionEntities: [
      { id: "vendor", label: "Vendors", verbs: ["read", "create", "update"] },
      { id: "bill", label: "Bills", verbs: ["read", "create", "update"] },
      { id: "payment", label: "Payments", verbs: ["read", "create"] },
      { id: "document", label: "Bill documents", verbs: ["create"] },
    ],
    // DECISION: payments start off, above the platform's defaults (approval on, delete off). Only
    // the operator can turn them on, and then only to approval in effect: the tool is always
    // signed by a person (`approval: "always"`), and refused until the MFA path exists.
    defaultPermissions: {
      read: "auto",
      create: "approval",
      update: "approval",
      delete: "off",
      entities: { payment: { create: "off" } },
    },
    isConfigured: () => Boolean(options.devKey),
    tools: [
      // ── Reads ──
      defineReadTool({
        id: BILLCOM_TOOLS.vendorSearch,
        entity: "vendor",
        description:
          "Find vendors in BILL by the start of their name or by email; archived ones only when asked. A page at a time.",
        summary: "Found {{vendors.length}} vendors",
        input: z.object({
          name: FilterText.optional(),
          email: FilterText.optional(),
          includeArchived: z.boolean().default(false),
          max: Max,
          page: PageCursor.optional(),
        }),
        output: z.object({
          vendors: z.array(BillcomVendor),
          nextPage: z.string().nullable(),
          sources: z.array(z.string()),
        }),
        run: (input, ctx) =>
          withBill(ctx, async (c) => {
            const body = BillcomPage.parse(
              await c.request("GET", "/vendors", {
                query: pageQuery(
                  input.max,
                  input.page,
                  filters([
                    ["name", "sw", input.name],
                    ["email", "eq", input.email],
                    ["archived", "eq", input.includeArchived ? undefined : false],
                  ]),
                ),
              }),
            );
            // DECISION: BILL's filters are applied again to the page it gave (UNCHECKED syntax).
            const vendors = body.results
              .map(mapBillcomVendor)
              .filter(
                (v) =>
                  (input.includeArchived || !v.archived) &&
                  (!input.name || lower(v.name).startsWith(lower(input.name))) &&
                  (!input.email || lower(v.email) === lower(input.email)),
              );
            return { vendors, nextPage: body.nextPage ?? null, sources: vendors.map((v) => v.id) };
          }),
      }),
      defineReadTool({
        id: BILLCOM_TOOLS.vendorGet,
        entity: "vendor",
        description: "Read one vendor in BILL by its id.",
        input: z.object({ id: BillcomId }),
        output: z.object({ vendor: BillcomVendor.nullable(), sources: z.array(z.string()) }),
        run: (input, ctx) =>
          withBill(ctx, async (c) => {
            const vendor = await getOrNull(c, vendorPath(input.id), mapBillcomVendor);
            return { vendor, sources: vendor ? [vendor.id] : [] };
          }),
      }),
      defineReadTool({
        id: BILLCOM_TOOLS.billList,
        entity: "bill",
        description:
          "List bills in BILL by vendor, payment status (UNPAID, PARTIAL, SCHEDULED, PAID) and due dates; archived ones only when asked. A page at a time.",
        summary: "Found {{bills.length}} bills",
        input: z.object({
          vendorId: BillcomId.optional(),
          paymentStatus: PaymentStatus.optional(),
          /** Due on or after. */
          dueFrom: IsoDate.optional(),
          /** Due on or before. */
          dueTo: IsoDate.optional(),
          includeArchived: z.boolean().default(false),
          max: Max,
          page: PageCursor.optional(),
        }),
        output: z.object({
          bills: z.array(BillcomBill),
          nextPage: z.string().nullable(),
          sources: z.array(z.string()),
        }),
        run: (input, ctx) =>
          withBill(ctx, async (c) => {
            const body = BillcomPage.parse(
              await c.request("GET", "/bills", {
                query: pageQuery(
                  input.max,
                  input.page,
                  filters([
                    ["vendorId", "eq", input.vendorId],
                    ["paymentStatus", "eq", input.paymentStatus],
                    ["dueDate", "gte", input.dueFrom],
                    ["dueDate", "lte", input.dueTo],
                    ["archived", "eq", input.includeArchived ? undefined : false],
                  ]),
                ),
              }),
            );
            const bills = body.results
              .map(mapBillcomBill)
              .filter(
                (b) =>
                  (input.includeArchived || !b.archived) &&
                  (!input.vendorId || b.vendorId === input.vendorId) &&
                  (!input.paymentStatus || b.paymentStatus === input.paymentStatus) &&
                  (!input.dueFrom || (b.dueDate !== null && b.dueDate >= input.dueFrom)) &&
                  (!input.dueTo || (b.dueDate !== null && b.dueDate <= input.dueTo)),
              );
            return { bills, nextPage: body.nextPage ?? null, sources: bills.map((b) => b.id) };
          }),
      }),
      defineReadTool({
        id: BILLCOM_TOOLS.billGet,
        entity: "bill",
        description:
          "Read one bill in BILL by its id: vendor, invoice number, dates, lines, amounts and payment status.",
        input: z.object({ id: BillcomId }),
        output: z.object({ bill: BillcomBill.nullable(), sources: z.array(z.string()) }),
        run: (input, ctx) =>
          withBill(ctx, async (c) => {
            const bill = await getOrNull(c, billPath(input.id), mapBillcomBill);
            return { bill, sources: bill ? [bill.id] : [] };
          }),
      }),
      defineReadTool({
        id: BILLCOM_TOOLS.paymentList,
        entity: "payment",
        description:
          "List payments in BILL by vendor, bill or status (e.g. SCHEDULED, PAID), a page at a time. Reading only: we never pay from here.",
        summary: "Found {{payments.length}} payments",
        input: z.object({
          vendorId: BillcomId.optional(),
          /** Only payments that pay this bill (checked on the page BILL gives). */
          billId: BillcomId.optional(),
          status: PaymentStatus.optional(),
          max: Max,
          page: PageCursor.optional(),
        }),
        output: z.object({
          payments: z.array(BillcomPayment),
          nextPage: z.string().nullable(),
          sources: z.array(z.string()),
        }),
        run: (input, ctx) =>
          withBill(ctx, async (c) => {
            const body = BillcomPage.parse(
              await c.request("GET", "/payments", {
                query: pageQuery(
                  input.max,
                  input.page,
                  filters([
                    ["vendorId", "eq", input.vendorId],
                    ["status", "eq", input.status],
                  ]),
                ),
              }),
            );
            const payments = body.results
              .map(mapBillcomPayment)
              .filter(
                (p) =>
                  (!input.vendorId || p.vendorId === input.vendorId) &&
                  (!input.status || p.status === input.status) &&
                  (!input.billId || p.bills.some((b) => b.billId === input.billId)),
              );
            return {
              payments,
              nextPage: body.nextPage ?? null,
              sources: payments.map((p) => p.id),
            };
          }),
      }),
      defineReadTool({
        id: BILLCOM_TOOLS.paymentGet,
        entity: "payment",
        description:
          "Read one payment in BILL by its id: its status, date, amount and the bills it pays.",
        input: z.object({ id: BillcomId }),
        output: z.object({ payment: BillcomPayment.nullable(), sources: z.array(z.string()) }),
        run: (input, ctx) =>
          withBill(ctx, async (c) => {
            const payment = await getOrNull(
              c,
              `/payments/${encodeURIComponent(input.id)}`,
              mapBillcomPayment,
            );
            return { payment, sources: payment ? [payment.id] : [] };
          }),
      }),

      // ── Vendor writes ──
      defineWriteTool({
        id: BILLCOM_TOOLS.vendorCreate,
        entity: "vendor",
        description:
          "Add a vendor to BILL: name, business or person, email, phone, the client's account number with them and an address. Refused if a vendor of that name is already there.",
        verb: "create",
        // R5: no archive tool for vendors; delete stays off.
        undo: { kind: "none" },
        summary: "Added the vendor {{name}} in BILL",
        input: VendorCreateInput,
        output: z.object({
          id: z.string(),
          name: z.string(),
          updatedTime: z.string().nullable(),
          alreadyDone: z.boolean(),
        }),
        // What is there already: live vendors of that name (none, or the create is refused).
        beforeSchema: z.object({ existing: z.array(BillcomVendor) }),
        before: (input, ctx) =>
          withBill(ctx, async (c) => {
            const existing = await vendorsNamed(c, input.name);
            // Proposed (no key yet): any vendor of that name is a duplicate. Right before writing,
            // one made in the last day with every field asked is this action's own (run says so).
            if (!("idempotencyKey" in ctx) && existing.length > 0) {
              throw refuse(
                `a vendor named ${input.name} is already in BILL (${existing[0]?.id}): update it instead`,
              );
            }
            return { existing };
          }),
        run: (input, ctx) =>
          withBill(ctx, async (c) => {
            const existing = await vendorsNamed(c, input.name);
            const since = ctx.now().getTime() - TWIN_WINDOW_MS;
            // DECISION: BILL takes no idempotency key we know of (NOTES.md). A vendor of this name
            // made in the last day with every asked field is this action's own earlier write (a
            // retry after a lost answer): reported done, not made again. Any other is refused.
            const twin = existing.find(
              (v) =>
                sameVendor(v, input) &&
                v.createdTime !== null &&
                Date.parse(v.createdTime) >= since,
            );
            if (twin) {
              return {
                id: twin.id,
                name: twin.name,
                updatedTime: twin.updatedTime,
                alreadyDone: true,
              };
            }
            if (existing.length > 0) {
              throw refuse(`a vendor named ${input.name} is already in BILL: update it instead`);
            }
            const note: WriteNote = {
              title: `The vendor ${input.name} may have been added in BILL`,
              details: { name: input.name },
            };
            ctx.logger.info("creating a BILL vendor");
            const answer = await c.request("POST", "/vendors", {
              json: {
                name: input.name,
                accountType: input.accountType,
                ...(input.email ? { email: input.email } : {}),
                ...(input.phone ? { phone: input.phone } : {}),
                ...(input.accountNumber ? { accountNumber: input.accountNumber } : {}),
                ...(input.address ? { address: wireAddress(input.address) } : {}),
              },
              write: note,
            });
            const v = mapBillcomVendor(writeAnswer(RawVendor, answer, note));
            return { id: v.id, name: v.name, updatedTime: v.updatedTime, alreadyDone: false };
          }),
      }),
      defineWriteTool({
        id: BILLCOM_TOOLS.vendorUpdate,
        entity: "vendor",
        description:
          "Change a vendor in BILL: name, email, phone, account number or address. Give the vendor's updatedTime as read to refuse the change if it changed since.",
        verb: "update",
        // R5: the fields go back to their values before, if the vendor hasn't changed since.
        undo: { kind: "restore" },
        summary: "Updated the vendor {{id}} in BILL",
        input: z.object({
          id: BillcomId,
          set: VendorSet,
          expectedUpdatedTime: z.string().max(60).optional(),
        }),
        output: z.object({
          id: z.string(),
          updatedTime: z.string().nullable(),
          alreadyDone: z.boolean(),
        }),
        beforeSchema: z.object({
          id: z.string(),
          name: z.string(),
          archived: z.boolean(),
          updatedTime: z.string().nullable(),
          values: VendorValues,
        }),
        before: (input, ctx) =>
          withBill(ctx, async (c) => {
            const v = await getOrNull(c, vendorPath(input.id), mapBillcomVendor);
            if (!v) return null;
            const values = Object.fromEntries(
              (Object.keys(input.set) as VendorField[]).map((k) => [k, vendorValue(v, k)]),
            );
            return {
              id: v.id,
              name: v.name,
              archived: v.archived,
              updatedTime: v.updatedTime,
              values,
            };
          }),
        undoInput: ({ input, before, output }) => {
          if (!before) return null;
          const set = restoreSet(Object.keys(input.set) as VendorField[], before.values);
          if (!set) return null;
          const address = set.address as Partial<BillcomAddress> | undefined;
          return {
            id: input.id,
            set: address
              ? {
                  ...set,
                  address: Object.fromEntries(
                    Object.entries(address).filter(([, value]) => value !== null),
                  ),
                }
              : set,
            ...(output.updatedTime ? { expectedUpdatedTime: output.updatedTime } : {}),
          };
        },
        run: (input, ctx, before) =>
          withBill(ctx, async (c) => {
            if (!before) throw refuse(`vendor ${input.id} isn't in BILL`);
            if (before.archived) throw refuse(`vendor ${input.id} is archived in BILL`);
            if (vendorHas(before.values, input.set)) {
              return { id: before.id, updatedTime: before.updatedTime, alreadyDone: true };
            }
            changedSince(
              "The vendor",
              before.updatedTime,
              input.expectedUpdatedTime,
              ctx.proposedBefore,
            );
            const s = input.set;
            const note: WriteNote = {
              title: `The vendor ${before.name} may have been changed in BILL`,
              details: { vendorId: input.id },
            };
            ctx.logger.info("updating a BILL vendor", { vendorId: input.id });
            const answer = await c.request("PATCH", vendorPath(input.id), {
              json: {
                ...(s.name !== undefined ? { name: s.name } : {}),
                ...(s.email !== undefined ? { email: s.email } : {}),
                ...(s.phone !== undefined ? { phone: s.phone } : {}),
                ...(s.accountNumber !== undefined ? { accountNumber: s.accountNumber } : {}),
                ...(s.address !== undefined ? { address: wireAddress(s.address) } : {}),
              },
              write: note,
            });
            const v = mapBillcomVendor(writeAnswer(RawVendor, answer, note));
            return { id: v.id, updatedTime: v.updatedTime, alreadyDone: false };
          }),
      }),

      // ── Bill writes ──
      defineWriteTool({
        id: BILLCOM_TOOLS.billCreate,
        entity: "bill",
        description:
          "Create a bill in BILL from a vendor's invoice: vendor, invoice number and date, due date, currency, lines (amount, description, account) and the expected total. Refused if the lines don't add up, the vendor isn't the organization's, or the bill is already there.",
        verb: "create",
        // R5: a created bill is taken back by archiving it (BILL's own void), never deleted.
        undo: { kind: "reverse", tool: BILLCOM_TOOLS.billArchive },
        summary: "Created the bill {{invoiceNumber}} for {{amount.amount}} in BILL",
        amount: { path: "expectedTotal", currencyPath: "currency", currency: "USD" },
        input: BillCreateInput,
        output: BillCreated,
        // DECISION: a new bill has no prior state; `before` keeps the vendor as BILL has it, so the
        // approval card names it.
        beforeSchema: z.object({ vendor: z.object({ id: z.string(), name: z.string() }) }),
        before: (input, ctx) =>
          withBill(ctx, async (c) => {
            const problem = billProblem(input);
            if (problem) throw problem;
            const vendor = await liveVendor(c, input.vendorId);
            const live = await billsNumbered(c, input.vendorId, input.invoiceNumber);
            // As QuickBooks' create: only right before writing (the action's key) is a bill exactly
            // like this one this action's own earlier write; when proposed, any is a duplicate.
            const ours = "idempotencyKey" in ctx && live.some((b) => sameBill(b, input));
            if (live.length > 0 && !ours) {
              throw refuse(`a bill ${input.invoiceNumber} from this vendor is already in BILL`);
            }
            return { vendor: { id: vendor.id, name: vendor.name } };
          }),
        undoInput: ({ output }) => ({
          id: output.id,
          ...(output.updatedTime ? { expectedUpdatedTime: output.updatedTime } : {}),
        }),
        run: (input, ctx) =>
          withBill(ctx, async (c) => {
            const problem = billProblem(input);
            if (problem) throw problem;
            const vendor = await liveVendor(c, input.vendorId);
            const live = await billsNumbered(c, input.vendorId, input.invoiceNumber);
            const ours = live.find((b) => sameBill(b, input));
            if (ours) {
              ctx.logger.info("BILL bill already created", { billId: ours.id });
              return createdOut(ours, true);
            }
            if (live.length > 0) {
              throw refuse(`a bill ${input.invoiceNumber} from this vendor is already in BILL`);
            }
            const note: WriteNote = {
              title: `The bill ${input.invoiceNumber} from ${vendor.name} may have been created in BILL`,
              details: { vendorId: input.vendorId, invoiceNumber: input.invoiceNumber },
            };
            ctx.logger.info("creating a BILL bill", {
              vendorId: input.vendorId,
              lines: input.lines.length,
            });
            const answer = await c.request("POST", "/bills", {
              json: {
                vendorId: input.vendorId,
                invoice: { invoiceNumber: input.invoiceNumber, invoiceDate: input.invoiceDate },
                dueDate: input.dueDate,
                ...(input.description ? { description: input.description } : {}),
                billLineItems: input.lines.map((l) => ({
                  amount: wire(l.amount),
                  ...(l.description ? { description: l.description } : {}),
                  ...(l.chartOfAccountId ? { chartOfAccountId: l.chartOfAccountId } : {}),
                })),
              },
              write: note,
            });
            const bill = mapBillcomBill(writeAnswer(RawBill, answer, note));
            if (!dec(bill.amount.amount).equals(dec(input.expectedTotal))) {
              // BILL made it, but not as asked (a total it changed): a person looks at it.
              throw new UnconfirmedWriteError(
                `BILL made the bill ${input.invoiceNumber} for ${bill.amount.amount}, not ${input.expectedTotal}`,
                "the total BILL answered differs from the one approved",
                { connector: "billcom", billId: bill.id },
              );
            }
            return createdOut(bill, false);
          }),
      }),
      defineWriteTool({
        id: BILLCOM_TOOLS.billUpdate,
        entity: "bill",
        description:
          "Change a bill in BILL: invoice number, invoice date, due date or description (not its amounts or lines). Refused once a payment is scheduled or made on it. Give the bill's updatedTime as read to refuse the change if it changed since.",
        verb: "update",
        // R5: the fields go back to their values before, if the bill hasn't changed since.
        undo: { kind: "restore" },
        summary: "Updated the bill {{id}} in BILL",
        input: z.object({
          id: BillcomId,
          set: BillSet,
          expectedUpdatedTime: z.string().max(60).optional(),
        }),
        output: z.object({
          id: z.string(),
          updatedTime: z.string().nullable(),
          alreadyDone: z.boolean(),
        }),
        beforeSchema: BillState.extend({ values: BillValues }),
        before: (input, ctx) =>
          withBill(ctx, async (c) => {
            const b = await getOrNull(c, billPath(input.id), mapBillcomBill);
            if (!b) return null;
            const values = Object.fromEntries(
              (Object.keys(input.set) as BillField[]).map((k) => [k, b[k]]),
            );
            return { ...billState(b), values };
          }),
        undoInput: ({ input, before, output }) => {
          if (!before) return null;
          const set = restoreSet(Object.keys(input.set) as BillField[], before.values);
          if (!set) return null;
          return {
            id: input.id,
            set,
            ...(output.updatedTime ? { expectedUpdatedTime: output.updatedTime } : {}),
          };
        },
        run: (input, ctx, before) =>
          withBill(ctx, async (c) => {
            if (!before) throw refuse(`bill ${input.id} isn't in BILL`);
            if (before.archived) throw refuse(`bill ${input.id} is archived in BILL`);
            const s = input.set;
            const has = (Object.keys(s) as BillField[]).every(
              (k) => (before.values[k] ?? null) === (s[k] ?? null),
            );
            if (has) return { id: before.id, updatedTime: before.updatedTime, alreadyDone: true };
            changedSince(
              "The bill",
              before.updatedTime,
              input.expectedUpdatedTime,
              ctx.proposedBefore,
            );
            if (!unpaid(before.paymentStatus)) {
              throw refuse(
                `bill ${input.id} has a payment scheduled or made (${before.paymentStatus})`,
              );
            }
            const current = await getOrNull(c, billPath(input.id), mapBillcomBill);
            if (!current) throw refuse(`bill ${input.id} isn't in BILL`);
            const note: WriteNote = {
              title: `The bill ${before.invoiceNumber ?? input.id} may have been changed in BILL`,
              details: { billId: input.id },
            };
            // UNCHECKED (NOTES.md): whether a PATCH merges `invoice`; both its fields are sent.
            const invoice =
              s.invoiceNumber !== undefined || s.invoiceDate !== undefined
                ? {
                    invoice: {
                      invoiceNumber: s.invoiceNumber ?? current.invoiceNumber,
                      invoiceDate: s.invoiceDate ?? current.invoiceDate,
                    },
                  }
                : {};
            ctx.logger.info("updating a BILL bill", { billId: input.id });
            const answer = await c.request("PATCH", billPath(input.id), {
              json: {
                ...invoice,
                ...(s.dueDate !== undefined ? { dueDate: s.dueDate } : {}),
                ...(s.description !== undefined ? { description: s.description } : {}),
              },
              write: note,
            });
            const b = mapBillcomBill(writeAnswer(RawBill, answer, note));
            return { id: b.id, updatedTime: b.updatedTime, alreadyDone: false };
          }),
      }),
      defineWriteTool({
        id: BILLCOM_TOOLS.billArchive,
        entity: "bill",
        description:
          "Archive a bill in BILL (BILL's void: the bill stays, marked archived). Refused once a payment is scheduled or made on it. Undoes a bill we created.",
        verb: "update",
        undo: { kind: "none" },
        summary: "Archived the bill {{id}} in BILL",
        input: z.object({ id: BillcomId, expectedUpdatedTime: z.string().max(60).optional() }),
        output: z.object({ id: z.string(), archived: z.boolean(), alreadyDone: z.boolean() }),
        beforeSchema: BillState,
        before: (input, ctx) =>
          withBill(ctx, async (c) => {
            const b = await getOrNull(c, billPath(input.id), mapBillcomBill);
            return b ? billState(b) : null;
          }),
        run: (input, ctx, before) =>
          withBill(ctx, async (c) => {
            if (!before) throw refuse(`bill ${input.id} isn't in BILL`);
            if (before.archived) return { id: before.id, archived: true, alreadyDone: true };
            changedSince(
              "The bill",
              before.updatedTime,
              input.expectedUpdatedTime,
              ctx.proposedBefore,
            );
            if (!unpaid(before.paymentStatus)) {
              throw refuse(
                `bill ${input.id} has a payment scheduled or made (${before.paymentStatus})`,
              );
            }
            const note: WriteNote = {
              title: `The bill ${before.invoiceNumber ?? input.id} may have been archived in BILL`,
              details: { billId: input.id },
            };
            ctx.logger.info("archiving a BILL bill", { billId: input.id });
            await c.request("POST", `${billPath(input.id)}/archive`, { write: note });
            return { id: before.id, archived: true, alreadyDone: false };
          }),
      }),
      defineWriteTool({
        id: BILLCOM_TOOLS.billAttach,
        entity: "document",
        description:
          "Attach a stored document (the vendor's invoice as PDF or image) to a bill in BILL.",
        verb: "create",
        // R5: no tool removes a bill's document, and delete stays off.
        undo: { kind: "none" },
        summary: "Attached {{fileName}} to the bill in BILL",
        input: z.object({ billId: BillcomId, documentId: z.uuid() }),
        output: z.object({
          billId: z.string(),
          billDocumentId: z.string(),
          fileName: z.string(),
          alreadyDone: z.boolean(),
        }),
        // What the approver sees: the bill, the documents it has now and the file it gets.
        beforeSchema: z.object({
          bill: BillState,
          documents: z.array(BillcomDocument),
          adding: z
            .object({ fileName: z.string(), size: z.number().int(), contentType: z.string() })
            .nullable(),
        }),
        before: (input, ctx) =>
          withBill(ctx, async (c) => {
            const b = await getOrNull(c, billPath(input.billId), mapBillcomBill);
            if (!b) return null;
            const docs = ctx.services?.documents;
            const facts = docs?.describe
              ? await docs.describe(input.documentId)
              : await docs?.read(input.documentId);
            const size = facts ? ("sizeBytes" in facts ? facts.sizeBytes : facts.bytes.length) : 0;
            return {
              bill: billState(b),
              documents: resultsOf(
                await c.request("GET", `/documents/bills/${encodeURIComponent(b.id)}`),
              ).map(mapBillcomDocument),
              adding: facts
                ? { fileName: facts.filename, size, contentType: facts.mimeType }
                : null,
            };
          }),
        run: (input, ctx, before) =>
          withBill(ctx, async (c) => {
            const docs = ctx.services?.documents;
            if (!docs) throw new Error("documents are not available to this call");
            if (!before) throw refuse(`bill ${input.billId} isn't in BILL`);
            const file = await docs.read(input.documentId);
            if (!file) throw refuse("that document isn't this client's");
            if (!DOCUMENT_TYPES.has(file.mimeType)) {
              throw refuse(`BILL can't take a ${file.mimeType} on a bill`);
            }
            if (file.bytes.length > DOCUMENT_MAX_BYTES) {
              throw refuse("the document is larger than 10 MB");
            }
            // DECISION: a document of the same name already on the bill is this action's own
            // earlier upload (BILL takes no idempotency key we know of): reported done, not added.
            const there = before.documents.find((d) => d.name === file.filename);
            if (there) {
              return {
                billId: input.billId,
                billDocumentId: there.id,
                fileName: file.filename,
                alreadyDone: true,
              };
            }
            const note: WriteNote = {
              title: `${file.filename} may have been attached to the bill ${before.bill.invoiceNumber ?? input.billId} in BILL`,
              details: { billId: input.billId, fileName: file.filename },
            };
            ctx.logger.info("attaching a document to a BILL bill", { billId: input.billId });
            const answer = await c.request(
              "POST",
              `/attachments/bills/${encodeURIComponent(input.billId)}`,
              {
                query: { name: file.filename },
                bytes: { data: file.bytes, type: file.mimeType },
                write: note,
              },
            );
            const out = writeAnswer(z.looseObject({ id: z.string().min(1) }), answer, note);
            return {
              billId: input.billId,
              billDocumentId: out.id,
              fileName: file.filename,
              alreadyDone: false,
            };
          }),
      }),

      // ── Payments: defined, off, and refused ──
      defineWriteTool({
        id: BILLCOM_TOOLS.paymentCreate,
        entity: "payment",
        description:
          "Pay a bill from BILL. Off: it is refused until payments can be confirmed with a second factor, and always needs a person's signature.",
        verb: "create",
        approval: "always",
        undo: { kind: "none" },
        amount: { path: "amount", currencyPath: "currency", currency: "USD" },
        input: z.object({
          billId: BillcomId,
          amount: DecimalString,
          currency: CurrencyCode,
          processDate: IsoDate.optional(),
        }),
        output: z.object({ id: z.string() }),
        beforeSchema: z.object({}),
        // DECISION: refused when proposed and again at the write, before BILL is called at all.
        async before() {
          throw new BillcomPaymentRefused();
        },
        async run() {
          throw new BillcomPaymentRefused();
        },
      }),
    ],
  });
}
