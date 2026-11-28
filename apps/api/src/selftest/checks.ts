// The connector self-test's checks (2026-11-28): for each connector, a fixed list of calls through
// the same connector code and invoke path agents use (packages/connectors invoke.ts), on one live
// connection of the Sandbox client. Every check reads or parses; none writes or sends:
//
// - reads run through `runReadTool` (input and output validated, as for an agent);
// - a write's "before" read runs through `captureBefore`, which reads the record the write would
//   change and never writes (invariant 8: only `executeWrite` writes, and it is never called here);
// - a write's input as an agent would give it is parsed by the tool's own schema (`parseWriteInput`);
// - Resend and Twilio are asked about the account (a domain's status, the subaccount, its numbers),
//   never to send.
//
// Each check's provider error is kept, scrubbed, so a staging failure reads like the real refusal.

import {
  type Connector,
  captureBefore,
  EMAIL_SEND_TOOL,
  type FetchLike,
  getDomain,
  MESSAGES_SEARCH_TOOL,
  parseWriteInput,
  QBO_TOOLS,
  ResendConfig,
  ResendCredentials,
  readTwilioConfig,
  requireCredentials,
  runReadTool,
  SMS_SEND_TOOL,
  ToolCallError,
  type ToolContext,
  TwilioCredentials,
  accountUrl as twilioAccountUrl,
  twilioRequest,
} from "@countersign/connectors";
import {
  dec,
  emailSubjectFrom,
  redactCardNumbers,
  type SelftestCheck,
  SUBJECT_LINE_MAX,
} from "@countersign/core";
import { z } from "zod";
import { withoutQueryParams, withoutSecrets } from "../observability/sentry";

/** The longest one check may take before it counts as failed. */
// DECISION: 30 seconds. QuickBooks' slowest read here (every vendor, for vendor.create's duplicate
// check) is a few pages; a check that hangs fails alone and the others still run.
export const CHECK_TIMEOUT_MS = 30_000;
const ERROR_MAX = 500;

export interface CheckEnv {
  connector: Connector;
  ctx: ToolContext;
  /** Outbound HTTP for the account checks that are not tools (Resend's domain, Twilio's account). */
  fetch: FetchLike;
  /** Mezonas' own Resend key, which alone can read a domain (a connection's key only sends). */
  resendApiKey?: string | undefined;
  /** Our sending domain's id at Resend, for a connection that sends from ours. */
  resendFallbackDomainId?: string | undefined;
  now: Date;
}

/** A check that had nothing to check with, and why. */
class Skip {
  constructor(readonly reason: string) {}
}
const skip = (reason: string) => new Skip(reason);

/** A provider's or our refusal as an operator reads it: no secret, no card number, no query data. */
export function scrubError(error: unknown): string {
  let text = error instanceof Error ? error.message : String(error);
  if (error instanceof ToolCallError && error.issues?.length) {
    const issues = error.issues
      .slice(0, 5)
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    text = `${text} (${issues})`;
  }
  const clean = redactCardNumbers(withoutSecrets(withoutQueryParams(text)));
  return clean.length > ERROR_MAX ? `${clean.slice(0, ERROR_MAX)}…` : clean;
}

function timeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer within ${ms / 1000} s`)), ms);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

/** Runs checks one after another (a provider's rate limit counts calls), keeping each result. */
export class CheckList {
  readonly results: SelftestCheck[] = [];
  constructor(private readonly timeoutMs = CHECK_TIMEOUT_MS) {}

  async check(id: string, what: string, run: () => Promise<undefined | Skip>): Promise<void> {
    const started = Date.now();
    let status: SelftestCheck["status"] = "pass";
    let error: string | null = null;
    try {
      const out = await timeout(run(), this.timeoutMs);
      if (out instanceof Skip) {
        status = "skip";
        error = out.reason;
      }
    } catch (e) {
      // The connection's matrix (the client's) or the operator's switch has the call off: that is
      // a setting, not a broken call.
      if (e instanceof ToolCallError && (e.code === "permission_off" || e.code === "action_off")) {
        status = "skip";
      } else {
        status = "fail";
      }
      error = scrubError(e);
    }
    this.results.push({ id, what, status, ms: Math.max(0, Date.now() - started), error });
  }
}

const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const daysAgo = (now: Date, n: number) => isoDay(new Date(now.getTime() - n * 86_400_000));
/** A short random mark, so a "before" read for a new record never finds one we made. */
const mark = () => crypto.randomUUID().replace(/-/g, "").slice(0, 10).toUpperCase();

// ── QuickBooks ──────────────────────────────────────────────────────────────────────────────────

interface Named {
  id: string;
  name: string | null;
}
interface Txn {
  id: string;
  syncToken: string;
  total: string;
  memo: string | null;
  vendor: Named | null;
  lines: { id: string | null; amount: string }[];
}

/** Write tools checked by their "before" read below; every other write's input is parsed. */
const QBO_BEFORE_CHECKED = new Set<string>([
  QBO_TOOLS.billUpdateMemo,
  QBO_TOOLS.purchaseUpdateMemo,
  QBO_TOOLS.itemUpdatePurchaseCost,
  QBO_TOOLS.invoiceAddNote,
  QBO_TOOLS.vendorCreate,
  QBO_TOOLS.billCreate,
  QBO_TOOLS.purchaseOrderCreate,
]);

/**
 * The context a "before" read runs in: the Sandbox connection with its creates and updates at
 * "ask first", whatever its matrix says, its reads and scope as they are.
 */
// DECISION: a new connection starts with its writes off (Connectors C2), and the Sandbox's may
// keep them off; `captureBefore` would then refuse before reading anything, and the check would
// say nothing. A before read changes nothing, and only `executeWrite` writes, which the self-test
// never calls, so the read is made as if the write were allowed to ask. The stored connection is
// not changed, and this is the Sandbox client only (runner.ts refuses every other).
export function beforeContext(ctx: ToolContext): ToolContext {
  const { entities: _entities, ...matrix } = ctx.connection.permissions;
  return {
    ...ctx,
    connection: {
      ...ctx.connection,
      permissions: { ...matrix, create: "approval", update: "approval", delete: "off" },
    },
  };
}

export async function qboChecks(list: CheckList, e: CheckEnv): Promise<void> {
  const { connector, ctx, now } = e;
  // biome-ignore lint/suspicious/noExplicitAny: a tool's output is checked by its own schema.
  const read = async (tool: string, input: unknown): Promise<any> =>
    (await runReadTool(connector, tool, input, ctx)).output;
  const before = (tool: string, input: unknown) =>
    captureBefore(connector, tool, input, beforeContext(ctx));
  const today = isoDay(now);

  let accounts: { id: string; name: string; accountType: string | null }[] = [];
  let expense: { id: string } | undefined;
  let vendors: Named[] = [];
  let items: {
    id: string;
    syncToken: string;
    type: string | null;
    active: boolean;
    purchaseCost: string | null;
  }[] = [];
  let bill: Txn | undefined;
  let purchase: Txn | undefined;
  let invoice: { id: string; syncToken: string } | undefined;

  // Name lists.
  await list.check(QBO_TOOLS.accountQuery, "List the active accounts", async () => {
    accounts = (await read(QBO_TOOLS.accountQuery, { limit: 100 })).accounts;
    return undefined;
  });
  await list.check(
    `${QBO_TOOLS.accountQuery}:types`,
    "Accounts by type, in QuickBooks' words (AccountType in ('Expense', 'Cost of Goods Sold'))",
    async () => {
      const out = await read(QBO_TOOLS.accountQuery, {
        types: ["Expense", "Cost of Goods Sold"],
        limit: 25,
      });
      expense = out.accounts[0];
      const asked = accounts.filter(
        (a) => a.accountType === "Expense" || a.accountType === "Cost of Goods Sold",
      );
      if (asked.length > 0 && out.accounts.length === 0) {
        throw new Error(
          `the company has ${asked.length} such accounts, and the query by type found none`,
        );
      }
      return undefined;
    },
  );
  expense ??= accounts.find((a) => a.accountType === "Expense");
  await list.check(QBO_TOOLS.classQuery, "List the active classes", async () => {
    await read(QBO_TOOLS.classQuery, {});
    return undefined;
  });
  await list.check(QBO_TOOLS.customerQuery, "List customers", async () => {
    await read(QBO_TOOLS.customerQuery, {});
    return undefined;
  });
  await list.check(QBO_TOOLS.vendorQuery, "List vendors", async () => {
    vendors = (await read(QBO_TOOLS.vendorQuery, { limit: 100 })).vendors;
    return undefined;
  });
  await list.check(
    `${QBO_TOOLS.vendorQuery}:name`,
    "Find a vendor by part of its name (DisplayName like '%…%')",
    async () => {
      const v = vendors.find((x) => (x.name ?? "").trim().length >= 3);
      if (!v?.name) return skip("no vendor with a name to look for");
      const part = v.name.trim().slice(0, Math.min(6, v.name.trim().length));
      const found: Named[] = (await read(QBO_TOOLS.vendorQuery, { name: part })).vendors;
      if (!found.some((x) => x.id === v.id)) {
        throw new Error(`vendor ${v.id} wasn't found by "${part}", the start of its name`);
      }
      return undefined;
    },
  );
  await list.check(QBO_TOOLS.itemQuery, "List items", async () => {
    items = (await read(QBO_TOOLS.itemQuery, { limit: 100 })).items;
    return undefined;
  });

  // Bills and purchases, each with and without a vendor and a window.
  for (const entity of ["bill", "purchase"] as const) {
    const tool = entity === "bill" ? QBO_TOOLS.billQuery : QBO_TOOLS.purchaseQuery;
    const key = entity === "bill" ? "bills" : "purchases";
    let first: Txn | undefined;
    await list.check(tool, `List ${key}`, async () => {
      const rows: Txn[] = (await read(tool, {}))[key];
      first = rows.find((r) => r.vendor) ?? rows[0];
      return undefined;
    });
    await list.check(`${tool}:lastDays`, `${key} of the last 365 days`, async () => {
      await read(tool, { lastDays: 365 });
      return undefined;
    });
    const vendorId = first?.vendor?.id;
    for (const [variant, extra] of [
      ["vendorId", {}],
      ["vendorId+lastDays", { lastDays: 365 }],
    ] as const) {
      await list.check(`${tool}:${variant}`, `${key} from one vendor`, async () => {
        if (!vendorId) return skip(`no ${entity} with a vendor to look for`);
        const rows: Txn[] = (await read(tool, { vendorId, ...extra }))[key];
        const other = rows.find((r) => r.vendor?.id !== vendorId);
        if (other) throw new Error(`${entity} ${other.id} isn't from vendor ${vendorId}`);
        // The vendor has at least the one we read (the windowed variant may leave an old one out).
        if (variant === "vendorId" && rows.length === 0) {
          throw new Error(`${entity} ${first?.id} from vendor ${vendorId} wasn't found by vendor`);
        }
        return undefined;
      });
    }
    if (entity === "bill") bill = first;
    else purchase = first;
  }

  // Purchase orders.
  let poVendor: string | undefined;
  await list.check(QBO_TOOLS.purchaseOrderQuery, "List purchase orders", async () => {
    const rows: { vendor: Named | null }[] = (await read(QBO_TOOLS.purchaseOrderQuery, {}))
      .purchaseOrders;
    poVendor = rows.find((r) => r.vendor)?.vendor?.id;
    return undefined;
  });
  await list.check(
    `${QBO_TOOLS.purchaseOrderQuery}:vendorId`,
    "Purchase orders from one vendor (VendorRef = '…')",
    async () => {
      const vendorId = poVendor ?? vendors[0]?.id;
      if (!vendorId) return skip("no vendor to look for");
      await read(QBO_TOOLS.purchaseOrderQuery, { vendorId });
      return undefined;
    },
  );
  await list.check(
    `${QBO_TOOLS.purchaseOrderQuery}:status`,
    "Open purchase orders (POStatus = 'Open')",
    async () => {
      await read(QBO_TOOLS.purchaseOrderQuery, { status: "Open" });
      return undefined;
    },
  );

  // Attachments, receivables, banking marks and a register.
  await list.check(QBO_TOOLS.attachableList, "A bill's attachments", async () => {
    if (!bill) return skip("no bill to read the attachments of");
    await read(QBO_TOOLS.attachableList, { entity: "Bill", entityId: bill.id });
    return undefined;
  });
  await list.check(`${QBO_TOOLS.invoiceQuery}:open`, "Open invoices", async () => {
    invoice = (await read(QBO_TOOLS.invoiceQuery, { open: true })).invoices[0];
    if (!invoice) invoice = (await read(QBO_TOOLS.invoiceQuery, {})).invoices[0];
    return undefined;
  });
  await list.check(QBO_TOOLS.paymentQuery, "List customer payments", async () => {
    await read(QBO_TOOLS.paymentQuery, {});
    return undefined;
  });
  await list.check(QBO_TOOLS.agingReport, "The aged receivables report", async () => {
    await read(QBO_TOOLS.agingReport, {});
    return undefined;
  });
  await list.check(
    "qbo.banking.find",
    "Today's purchases by booking mark (TxnDate = '…')",
    async () => {
      const out = await read("qbo.banking.find", {
        entity: "purchase",
        txnDate: today,
        references: [`selftest-${mark()}`],
      });
      if (out.found) throw new Error("a mark nothing was ever booked with was found");
      return undefined;
    },
  );
  const bank = accounts.find((a) => a.accountType === "Bank");
  await list.check(
    "qbo.account.register",
    "A bank account's register for 30 days (GeneralLedger)",
    async () => {
      if (!bank) return skip("no bank account");
      await read("qbo.account.register", {
        accountId: bank.id,
        startDate: daysAgo(now, 30),
        endDate: today,
      });
      return undefined;
    },
  );

  // A write's "before" read: what the approval card shows. captureBefore never writes.
  for (const [tool, entity, txn] of [
    [QBO_TOOLS.billUpdateMemo, "bill", bill],
    [QBO_TOOLS.purchaseUpdateMemo, "purchase", purchase],
  ] as const) {
    await list.check(`${tool}:before`, `Read a ${entity} as its memo change would`, async () => {
      if (!txn) return skip(`no ${entity} to read`);
      const out = await before(tool, {
        id: txn.id,
        syncToken: txn.syncToken,
        memo: txn.memo ?? "",
      });
      if (!out.before) throw new Error(`${entity} ${txn.id} wasn't found by id`);
      return undefined;
    });
  }
  const item = items.find((i) => i.active && i.type !== "Category");
  await list.check(
    `${QBO_TOOLS.itemUpdatePurchaseCost}:before`,
    "Read an item as a purchase cost change would",
    async () => {
      if (!item) return skip("no item to read");
      const out = await before(QBO_TOOLS.itemUpdatePurchaseCost, {
        id: item.id,
        syncToken: item.syncToken,
        purchaseCost: item.purchaseCost ?? "0",
      });
      if (!out.before) throw new Error(`item ${item.id} wasn't found by id`);
      return undefined;
    },
  );
  await list.check(
    `${QBO_TOOLS.invoiceAddNote}:before`,
    "Read an invoice as adding a note would",
    async () => {
      if (!invoice) return skip("no invoice to read");
      const out = await before(QBO_TOOLS.invoiceAddNote, {
        invoiceId: invoice.id,
        syncToken: invoice.syncToken,
        note: "Mezonas self-test: read only, never written",
      });
      if (!out.before) throw new Error(`invoice ${invoice.id} wasn't found by id`);
      return undefined;
    },
  );
  await list.check(
    `${QBO_TOOLS.vendorCreate}:before`,
    "Look for a new vendor's name among every vendor (Active in (true, false)), as adding one would",
    async () => {
      const out = await before(QBO_TOOLS.vendorCreate, {
        displayName: `Mezonas self-test ${mark()} (never created)`,
      });
      const existing = (out.before as { existing?: unknown } | null)?.existing;
      if (existing) throw new Error("a vendor with a name never used was found");
      return undefined;
    },
  );
  const vendorId = bill?.vendor?.id ?? vendors[0]?.id;
  await list.check(
    `${QBO_TOOLS.billCreate}:before`,
    "Check a new bill as creating it would (its vendor, accounts and a duplicate number)",
    async () => {
      if (!vendorId || !expense) return skip("no vendor or expense account to write a bill with");
      await before(QBO_TOOLS.billCreate, {
        vendorId,
        docNumber: `MZST${mark()}`,
        txnDate: today,
        expectedTotal: "1.00",
        privateNote: "Mezonas self-test: checked, never created",
        lines: [{ accountId: expense.id, amount: "1.00", description: "Mezonas self-test" }],
      });
      return undefined;
    },
  );
  await list.check(
    `${QBO_TOOLS.purchaseOrderCreate}:before`,
    "Check a new purchase order with an item line as creating it would (Item Id in (…) and Active in (true, false))",
    async () => {
      if (!vendorId || !item) return skip("no vendor or item to write a purchase order with");
      await before(QBO_TOOLS.purchaseOrderCreate, {
        vendorId,
        docNumber: `MZST${mark()}`,
        txnDate: today,
        expectedTotal: "1.00",
        memo: "Mezonas self-test: checked, never created",
        lines: [{ itemId: item.id, qty: "1", unitPrice: "1.00", amount: "1.00" }],
      });
      return undefined;
    },
  );

  // Every other write: its input as an agent would give it, parsed by the tool's own schema.
  const ids = qboSampleIds({ accounts, expense, vendors, bill, purchase, item });
  for (const spec of connector.manifest.tools) {
    if (spec.verb === "read" || QBO_BEFORE_CHECKED.has(spec.id)) continue;
    const input = qboSampleInput(spec.id, ids, today);
    await list.check(`${spec.id}:input`, "Parse a realistic input with the tool's schema", () => {
      if (input === undefined) return Promise.resolve(skip("no sample input for this tool yet"));
      parseWriteInput(connector, spec.id, input);
      return Promise.resolve(undefined);
    });
  }
}

interface SampleIds {
  account: string;
  otherAccount: string;
  bank: string;
  card: string;
  vendor: string;
  bill: Txn | undefined;
  purchase: Txn | undefined;
  item: string;
}

function qboSampleIds(s: {
  accounts: { id: string; accountType: string | null }[];
  expense: { id: string } | undefined;
  vendors: Named[];
  bill: Txn | undefined;
  purchase: Txn | undefined;
  item: { id: string } | undefined;
}): SampleIds {
  const byType = (t: string) => s.accounts.find((a) => a.accountType === t)?.id;
  const account = s.expense?.id ?? s.accounts[0]?.id ?? "1";
  return {
    account,
    otherAccount: s.accounts.find((a) => a.id !== account)?.id ?? "2",
    bank: byType("Bank") ?? "1",
    card: byType("Credit Card") ?? byType("Bank") ?? "1",
    vendor: s.vendors[0]?.id ?? "1",
    bill: s.bill,
    purchase: s.purchase,
    item: s.item?.id ?? "1",
  };
}

/** What an agent would give each write, with the company's own ids where we read them. */
function qboSampleInput(tool: string, ids: SampleIds, today: string): unknown {
  const reference = "selftest-0001";
  const itemize = (t: Txn | undefined) => {
    const line = t?.lines.find((l) => l.id) ?? null;
    const amount = line ? dec(line.amount).toFixed(2) : "10.00";
    return {
      id: t?.id ?? "1",
      syncToken: t?.syncToken ?? "0",
      expectedTotal: t ? t.total : "10.00",
      currency: "USD",
      replaceLineIds: [line?.id ?? "1"],
      lines: [{ accountId: ids.account, amount, description: "Mezonas self-test" }],
    };
  };
  switch (tool) {
    case QBO_TOOLS.billUpdateLines:
      return itemize(ids.bill);
    case QBO_TOOLS.purchaseUpdateLines:
      return itemize(ids.purchase);
    case QBO_TOOLS.attachableUpload:
      return { documentId: crypto.randomUUID(), entity: "Bill", entityId: ids.bill?.id ?? "1" };
    case "qbo.purchase.create":
      return {
        accountId: ids.card,
        paymentType: "CreditCard",
        vendorId: ids.vendor,
        txnDate: today,
        currency: "USD",
        expectedTotal: "12.50",
        privateNote: "Mezonas self-test",
        reference,
        lines: [{ accountId: ids.account, amount: "12.50" }],
      };
    case "qbo.deposit.create":
      return {
        accountId: ids.bank,
        txnDate: today,
        expectedTotal: "100.00",
        reference,
        lines: [
          { accountId: ids.otherAccount, amount: "100.00", description: "Mezonas self-test" },
        ],
      };
    case "qbo.transfer.create":
      return {
        fromAccountId: ids.bank,
        toAccountId: ids.card,
        amount: "50.00",
        txnDate: today,
        reference,
      };
    case "qbo.account.create":
      return {
        name: "Mezonas self-test",
        accountType: "Expense",
        accountSubType: "SuppliesMaterials",
        description: "Mezonas self-test",
      };
    case "qbo.account.update":
      return { id: ids.account, syncToken: "0", name: "Mezonas self-test" };
    case "qbo.class.create":
    case "qbo.location.create":
      return { name: "Mezonas self-test" };
    case "qbo.class.update":
    case "qbo.location.update":
      return { id: "1", syncToken: "0", active: true };
    case "qbo.journal.create":
      return {
        txnDate: today,
        currency: "USD",
        expectedTotal: "25.00",
        privateNote: "Mezonas self-test",
        reference,
        lines: [
          { accountId: ids.account, posting: "debit", amount: "25.00" },
          { accountId: ids.otherAccount, posting: "credit", amount: "25.00" },
        ],
      };
    default:
      return undefined;
  }
}

// ── Email sending (Resend) ──────────────────────────────────────────────────────────────────────

/** A conversation's purpose as it reaches a reach-out with no subject: long, with line breaks. */
const LONG_PURPOSE = [
  "Ask the vendor for the signed delivery receipt for purchase order 4471 and confirm the corrected unit price on line 3 before we pay the invoice.",
  "",
  "Goal: the receipt as a PDF and the price in writing.",
  "Stop when: they answer, or after two reminders a week apart.",
  "x".repeat(400),
].join("\n");

export async function resendChecks(list: CheckList, e: CheckEnv): Promise<void> {
  let config: ResendConfig | undefined;
  await list.check("resend.config", "The connection's sending settings parse", async () => {
    config = ResendConfig.parse(e.ctx.connection.config);
    return undefined;
  });
  await list.check(
    "resend.key",
    "The connection's sending key is stored and reads back",
    async () => {
      const r = ResendCredentials.safeParse(await requireCredentials(e.ctx.credentials));
      if (!r.success) throw new Error("the stored credentials aren't a Resend key");
      return undefined;
    },
  );
  await list.check("resend.domain", "The sending domain is verified at Resend", async () => {
    if (!config) return skip("the sending settings don't parse");
    const id = config.domainId ?? e.resendFallbackDomainId;
    if (!id) return skip("no domain id to read");
    if (!e.resendApiKey) return skip("Mezonas' Resend key isn't set here");
    const domain = await getDomain(e.fetch, e.resendApiKey, id);
    if (domain.status !== "verified") {
      throw new Error(`${domain.name} is ${domain.status} at Resend, not verified`);
    }
    return undefined;
  });
  await list.check(
    "core.emailSubjectFrom",
    `A subject made from a long purpose is one line of at most ${SUBJECT_LINE_MAX} characters`,
    async () => {
      const subject = emailSubjectFrom(LONG_PURPOSE);
      if (/[\r\n]/.test(subject)) throw new Error("the subject has a line break");
      if (subject.length > SUBJECT_LINE_MAX) {
        throw new Error(`the subject has ${subject.length} characters`);
      }
      return undefined;
    },
  );
  await list.check(
    `${EMAIL_SEND_TOOL}:input`,
    "Parse an email with a made subject with the tool's schema",
    async () => {
      parseWriteInput(e.connector, EMAIL_SEND_TOOL, {
        to: "selftest@example.com",
        subject: emailSubjectFrom(LONG_PURPOSE),
        text: LONG_PURPOSE,
      });
      return undefined;
    },
  );
}

// ── Texts (Twilio) ──────────────────────────────────────────────────────────────────────────────

const TwilioAccount = z.object({ sid: z.string(), status: z.string() });
const TwilioIncoming = z.object({
  sid: z.string(),
  phone_number: z.string(),
  sms_url: z.string().nullish(),
});

export async function twilioChecks(list: CheckList, e: CheckEnv): Promise<void> {
  const config = readTwilioConfig(e.ctx.connection.config);
  let auth: z.infer<typeof TwilioCredentials> | undefined;
  await list.check("twilio.config", "The connection's subaccount and numbers parse", async () => {
    if (!config) throw new Error("the connection's settings aren't a Twilio subaccount's");
    return undefined;
  });
  await list.check("twilio.account", "The subaccount is active at Twilio", async () => {
    const r = TwilioCredentials.safeParse(await requireCredentials(e.ctx.credentials));
    if (!r.success) throw new Error("the stored credentials aren't a Twilio subaccount's");
    auth = r.data;
    const account = TwilioAccount.parse(
      await twilioRequest(e.fetch, auth, "GET", `${twilioAccountUrl(auth.accountSid)}.json`),
    );
    if (account.status !== "active") throw new Error(`the subaccount is ${account.status}`);
    return undefined;
  });
  await list.check(
    "twilio.numbers",
    "Each of the client's numbers is on the subaccount and texts reach us",
    async () => {
      if (!auth || !config) return skip("the subaccount wasn't read");
      if (config.numbers.length === 0) return skip("the connection has no number");
      for (const n of config.numbers) {
        const got = TwilioIncoming.parse(
          await twilioRequest(
            e.fetch,
            auth,
            "GET",
            `${twilioAccountUrl(auth.accountSid)}/IncomingPhoneNumbers/${n.sid}.json`,
          ),
        );
        if (got.phone_number !== n.phoneNumber) {
          throw new Error(`number ${n.sid} is ${got.phone_number} at Twilio, not ${n.phoneNumber}`);
        }
        if (got.sms_url && got.sms_url !== config.webhooks.messages) {
          throw new Error(`${n.phoneNumber} sends its texts somewhere other than our webhook`);
        }
      }
      return undefined;
    },
  );
  await list.check(MESSAGES_SEARCH_TOOL, "Read the last week's messages (one)", async () => {
    await runReadTool(
      e.connector,
      MESSAGES_SEARCH_TOOL,
      { since: daysAgo(e.now, 7), limit: 1 },
      e.ctx,
    );
    return undefined;
  });
  await list.check(`${SMS_SEND_TOOL}:input`, "Parse a text with the tool's schema", async () => {
    parseWriteInput(e.connector, SMS_SEND_TOOL, {
      to: "+15005550006",
      text: "Mezonas self-test: parsed, never sent",
    });
    return undefined;
  });
}

/** The checks for each connector the self-test covers. */
export const SELFTEST_CONNECTORS: Readonly<
  Record<string, (list: CheckList, e: CheckEnv) => Promise<void>>
> = {
  qbo: qboChecks,
  resend: resendChecks,
  twilio: twilioChecks,
};
