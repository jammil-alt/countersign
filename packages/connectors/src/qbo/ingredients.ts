// P-2: QuickBooks ingredients (docs/plan.md §1.64, M35): building blocks for agents made later in the
// agent lab. Reads of the chart of accounts and of classes, so an agent can code a line; a new
// vendor, behind approval like every write, refused when proposed and again before writing if a
// vendor with the same name is there; and purchase orders (./purchase-order.ts). QuickBooks'
// `requestid` comes from the action's key, so a retried write is answered, not repeated.

import { z } from "zod";
import { defineReadTool, defineWriteTool, type ToolDefinition } from "../connector";
import { QboApiError, type QboClient, qboLiteral, qboRequestId } from "./api";
import { vendorCreateDisplay } from "./display";
import { purchaseOrderCreateTool, purchaseOrderQueryTool } from "./purchase-order";
import {
  QboAccount,
  QboClass,
  QboId,
  type QboVendor,
  toAccount,
  toClass,
  toVendor,
} from "./records";
import {
  addressLine,
  type ClientFor,
  Page,
  page,
  QBO_STAND_IN,
  QBO_TOOLS,
  QboAddressInput,
  wireAddress,
} from "./tool-kit";

// ── Reads ───────────────────────────────────────────────────────────────────────────────────────

/** `Active = true` (the default) or `Active = false`: one or the other, as asked. */
// DECISION: `active` filters literally (true lists active records, false inactive ones). We always
// send it, so the answer never depends on QuickBooks' own default for name lists (NOTES.md).
const activeCond = (active: boolean) => `Active = ${active ? "true" : "false"}`;

function accountQueryTool(clientFor: ClientFor): ToolDefinition {
  return defineReadTool({
    id: QBO_TOOLS.accountQuery,
    entity: "account",
    description:
      "List the company's accounts in QuickBooks (the chart of accounts), by type (e.g. Expense, Cost of Goods Sold, Other Current Liability) or part of the name, to choose the account a bill line is booked to. Active accounts unless active is false.",
    summary: "Found {{accounts.length}} accounts",
    input: z.object({
      /** QuickBooks account types, e.g. "Expense", "Cost of Goods Sold". */
      types: z.array(z.string().trim().min(1).max(50)).min(1).max(10).optional(),
      active: z.boolean().default(true),
      nameContains: z.string().trim().min(1).max(100).optional(),
      ...Page,
    }),
    output: z.object({ accounts: z.array(QboAccount), more: z.boolean() }),
    async run(input, ctx) {
      const conds = [activeCond(input.active)];
      // UNCHECKED (NOTES.md): `AccountType in (…)` and `Name like '%…%'` on Account.
      if (input.types) conds.push(`AccountType in (${input.types.map(qboLiteral).join(", ")})`);
      if (input.nameContains) conds.push(`Name like ${qboLiteral(`%${input.nameContains}%`)}`);
      const { rows, more } = await page(
        await clientFor(ctx),
        "Account",
        conds,
        input,
        toAccount,
        "Name",
      );
      return { accounts: rows, more };
    },
  });
}

function classQueryTool(clientFor: ClientFor): ToolDefinition {
  return defineReadTool({
    id: QBO_TOOLS.classQuery,
    entity: "class",
    description:
      "List the company's classes in QuickBooks (how it tracks costs by job, location or department, when it uses classes), by id or part of the name. Active classes unless active is false.",
    summary: "Found {{classes.length}} classes",
    input: z.object({
      ids: z.array(QboId).min(1).max(30).optional(),
      active: z.boolean().default(true),
      nameContains: z.string().trim().min(1).max(100).optional(),
      ...Page,
    }),
    output: z.object({ classes: z.array(QboClass), more: z.boolean() }),
    async run(input, ctx) {
      const conds = [activeCond(input.active)];
      if (input.ids) conds.push(`Id in (${input.ids.map(qboLiteral).join(", ")})`);
      if (input.nameContains) conds.push(`Name like ${qboLiteral(`%${input.nameContains}%`)}`);
      const { rows, more } = await page(
        await clientFor(ctx),
        "Class",
        conds,
        input,
        toClass,
        "Name",
      );
      return { classes: rows, more };
    },
  });
}

// ── A new vendor ────────────────────────────────────────────────────────────────────────────────

export const VendorCreateInput = z.object({
  /** The name QuickBooks lists the vendor by; it must be new. */
  displayName: z.string().trim().min(1).max(500),
  companyName: z.string().trim().min(1).max(100).optional(),
  email: z.email().max(100).optional(),
  phone: z.string().trim().min(1).max(30).optional(),
  billingAddress: QboAddressInput.optional(),
  /** Payment terms, by their QuickBooks id. */
  termsId: QboId.optional(),
});
export type VendorCreateInput = z.infer<typeof VendorCreateInput>;

/** A vendor refused because one with the same name is already in QuickBooks. */
export class QboDuplicateVendorError extends QboApiError {
  constructor(message: string) {
    super(409, "DUPLICATE_VENDOR", message, false);
    this.name = "QboDuplicateVendorError";
  }
}

/** Case and spacing don't make a name new: "Pacific  hardware " is "Pacific Hardware". */
export function normalizeVendorName(v: string): string {
  return v.trim().replace(/\s+/g, " ").toLowerCase();
}

const VENDOR_PAGE = 1000;
const VENDOR_PAGES = 20;

/** Every vendor, active or not, whose name is this one's (normalized). */
// DECISION: the company's vendors are read whole (1,000 a page, inactive ones too) and compared
// here, rather than trusting a `DisplayName` filter to match case and spacing the way we do. A
// company with more than 20,000 vendors is refused rather than half checked.
async function vendorsNamed(client: QboClient, name: string): Promise<QboVendor[]> {
  const want = normalizeVendorName(name);
  const found: QboVendor[] = [];
  for (let p = 0; p < VENDOR_PAGES; p++) {
    const { rows } = await client.query(
      `select * from Vendor where Active in (true, false) orderby Id startposition ${p * VENDOR_PAGE + 1} maxresults ${VENDOR_PAGE}`,
      "Vendor",
    );
    for (const row of rows) {
      const v = toVendor(row);
      if (normalizeVendorName(v.name) === want) found.push(v);
    }
    if (rows.length < VENDOR_PAGE) return found;
  }
  throw new QboApiError(
    422,
    "TOO_MANY_VENDORS",
    "this company has too many vendors to check for a duplicate",
    false,
  );
}

function duplicateVendor(v: QboVendor): QboDuplicateVendorError {
  return new QboDuplicateVendorError(
    `QuickBooks already has ${v.active ? "a" : "an inactive"} vendor named "${v.name}" (id ${v.id})`,
  );
}

/** The vendor this change would make is the one there: same name, company and email. */
// DECISION: right before writing (the action's key is known), a vendor with the same name whose
// company name and email are the ones asked for is this action's own earlier write, the answer to
// which was lost: it is reported done with its id, not created again. Any other is a duplicate.
function sameVendor(v: QboVendor, input: VendorCreateInput): boolean {
  return (
    v.active &&
    (input.companyName === undefined || v.companyName === input.companyName) &&
    (input.email === undefined || v.email?.toLowerCase() === input.email.toLowerCase())
  );
}

/** The terms by name, or a refusal: terms QuickBooks doesn't have can't go on a vendor. */
async function companyTerms(
  client: QboClient,
  id: string | undefined,
): Promise<{ id: string; name: string } | null> {
  if (id === undefined) return null;
  const raw = await client.read("Term", id);
  const name = raw?.Name;
  if (typeof name !== "string" || raw?.Active === false) {
    throw new QboApiError(
      422,
      "UNKNOWN_TERMS",
      `terms ${id} aren't one of this company's in QuickBooks`,
      false,
    );
  }
  return { id, name };
}

const Named = z.object({ id: z.string(), name: z.string() });

function vendorCreateTool(clientFor: ClientFor): ToolDefinition {
  return defineWriteTool({
    id: QBO_TOOLS.vendorCreate,
    entity: "vendor",
    description:
      "Add a vendor to QuickBooks: its display name (new to the company), company name, email, phone, billing address and payment terms. Refused if a vendor with the same name is there. The output's id is the new vendor's, for a later step.",
    verb: "create",
    // R5: no void or archive tool yet, and delete stays off (docs/plan.md §9 follow-ups).
    undo: { kind: "none" },
    summary: "Added vendor {{displayName}} to QuickBooks",
    display: vendorCreateDisplay,
    input: VendorCreateInput,
    output: z.object({
      id: z.string(),
      syncToken: z.string(),
      displayName: z.string(),
      alreadyDone: z.boolean(),
    }),
    testOutput: (input) => ({ ...QBO_STAND_IN, displayName: input.displayName }),
    // DECISION: a new vendor has no prior state; `before` says no vendor had the name (`existing`
    // null) and keeps what the card names: the address on one line and the terms' name.
    beforeSchema: z.object({
      existing: Named.nullable(),
      billingAddress: z.string().nullable(),
      terms: Named.nullable(),
    }),
    async before(input, ctx) {
      const client = await clientFor(ctx);
      const terms = await companyTerms(client, input.termsId);
      const named = await vendorsNamed(client, input.displayName);
      const before = (existing: { id: string; name: string } | null) => ({
        existing,
        billingAddress: addressLine(input.billingAddress),
        terms,
      });
      // As for a new bill: only right before writing can a vendor like this be our own write.
      const ours = "idempotencyKey" in ctx ? named.find((v) => sameVendor(v, input)) : undefined;
      if (ours) return before({ id: ours.id, name: ours.name });
      const first = named[0];
      if (first) throw duplicateVendor(first);
      return before(null);
    },
    async run(input, ctx) {
      const client = await clientFor(ctx);
      const named = await vendorsNamed(client, input.displayName);
      const ours = named.find((v) => sameVendor(v, input));
      if (ours) {
        ctx.logger.info("vendor already created", { id: ours.id });
        return {
          id: ours.id,
          syncToken: ours.syncToken,
          displayName: ours.name,
          alreadyDone: true,
        };
      }
      const first = named[0];
      if (first) throw duplicateVendor(first);
      await companyTerms(client, input.termsId);
      const body = {
        DisplayName: input.displayName,
        ...(input.companyName === undefined ? {} : { CompanyName: input.companyName }),
        ...(input.email === undefined ? {} : { PrimaryEmailAddr: { Address: input.email } }),
        ...(input.phone === undefined ? {} : { PrimaryPhone: { FreeFormNumber: input.phone } }),
        ...(input.billingAddress === undefined
          ? {}
          : { BillAddr: wireAddress(input.billingAddress) }),
        ...(input.termsId === undefined ? {} : { TermRef: { value: input.termsId } }),
      };
      ctx.logger.info("creating a vendor");
      let answer: Record<string, unknown>;
      try {
        answer = (await client.post("/vendor", body, {
          requestid: await qboRequestId(ctx.idempotencyKey),
        })) as Record<string, unknown>;
      } catch (error) {
        // UNCHECKED (NOTES.md): 6240 is QuickBooks' "Duplicate Name Exists", which also covers a
        // customer or employee with the name (names are unique across the three lists).
        if (error instanceof QboApiError && error.code === "6240") {
          throw new QboDuplicateVendorError(
            `QuickBooks already has a customer, vendor or employee named "${input.displayName}"`,
          );
        }
        throw error;
      }
      const v = toVendor(answer.Vendor);
      return { id: v.id, syncToken: v.syncToken, displayName: v.name, alreadyDone: false };
    },
  });
}

// ── All of P-2's tools ──────────────────────────────────────────────────────────────────────────

export function qboIngredientTools(clientFor: ClientFor): ToolDefinition[] {
  return [
    accountQueryTool(clientFor),
    classQueryTool(clientFor),
    vendorCreateTool(clientFor),
    purchaseOrderCreateTool(clientFor),
    purchaseOrderQueryTool(clientFor),
  ];
}
