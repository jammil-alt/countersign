// Skill model (2026-11-10), Wave B item 9 (docs/plan.md §1.86 "Skill model"): action write steps.
// A v4 write step names a tool, as before, or an action: what to do, provider-neutral (send an
// email, send a text, create a bill, create a vendor). The action resolves from the agent's
// bindings when the step runs: the agent's own email or text channel, else the account's
// (apps/api's `channelFor`); the accounting connection the agent is bound to (QuickBooks or
// BILL). Then it runs exactly as a write step calling that tool: one external action, its
// idempotency key, its before state, its undo, the gate (invariant 8). Every action is external,
// so its approval is on by default.
//
// Pure: the schema and validator (core), the executor (packages/workflows), the resolution
// (apps/api) and the builder (apps/web) share it.

import { z } from "zod";
import { OutboundAttachments } from "../attachments";
import { isPlainObject } from "../json";
import { CurrencyCode, DecimalString } from "../money";
import { bindingConnector } from "../permissions/grants";
import { CHANNEL_TOOLS } from "../reach/rules";
import type { JsonSchema } from "../schemas/common";
import type { PermissionMatrix } from "../schemas/permissions";
import { IsoDate } from "./hours";

// ── The actions ──────────────────────────────────────────────────────────────────────────────

export const WRITE_ACTIONS = ["send_email", "send_text", "create_bill", "create_vendor"] as const;
export const WriteAction = z.enum(WRITE_ACTIONS);
export type WriteAction = z.infer<typeof WriteAction>;

/** Accounting connectors an accounting action can resolve to, in this order. */
export const ACCOUNTING_CONNECTORS = ["qbo", "billcom"] as const;

/** The channel kind a messaging action sends on (`channelFor`'s kind). */
export type ActionChannel = "email" | "sms";

export interface ActionSpec {
  action: WriteAction;
  /** "Create bill": the palette's and the step's name. */
  label: string;
  /** One line for the palette. */
  description: string;
  /** Resolved from the agent's accounting connection, or from its channel of this kind. */
  from: { accounting: true } | { channel: ActionChannel };
  /** The tool each connector runs it with. */
  tools: Readonly<Record<string, string>>;
}

/** The channel connectors that carry `kind`, with their send tool (core's `CHANNEL_TOOLS`). */
function channelTools(kind: ActionChannel): Record<string, string> {
  return Object.fromEntries(
    Object.entries(CHANNEL_TOOLS).flatMap(([connector, kinds]) => {
      const tool = kinds[kind];
      return tool ? [[connector, tool]] : [];
    }),
  );
}

export const ACTION_SPECS: Readonly<Record<WriteAction, ActionSpec>> = {
  send_email: {
    action: "send_email",
    label: "Send email",
    description: "Email a contact from the agent's address, else the account's.",
    from: { channel: "email" },
    tools: channelTools("email"),
  },
  send_text: {
    action: "send_text",
    label: "Send text",
    description: "Text a contact from the agent's number, else the account's.",
    from: { channel: "sms" },
    tools: channelTools("sms"),
  },
  create_bill: {
    action: "create_bill",
    label: "Create bill",
    description: "Add a bill in the accounting system the agent is connected to.",
    from: { accounting: true },
    tools: { qbo: "qbo.bill.create", billcom: "billcom.bill.create" },
  },
  create_vendor: {
    action: "create_vendor",
    label: "Create vendor",
    description: "Add a vendor in the accounting system the agent is connected to.",
    from: { accounting: true },
    tools: { qbo: "qbo.vendor.create", billcom: "billcom.vendor.create" },
  },
};

/** How a run view names the system a connector is: "Create bill · in QuickBooks". */
// DECISION: core names the connectors an action resolves to itself (it can't read the connector
// registry); a connector missing here is named by its id.
export const ACTION_CONNECTOR_NAMES: Readonly<Record<string, string>> = {
  qbo: "QuickBooks",
  billcom: "BILL",
  gmail: "Gmail",
  outlook: "Outlook",
  resend: "our sending",
  twilio: "your number",
};

/** "Create bill · in QuickBooks", "Send email · through Gmail", "Send text · from your number". */
export function actionStepLabel(action: WriteAction, connector: string): string {
  const spec = ACTION_SPECS[action];
  const name = ACTION_CONNECTOR_NAMES[connector] ?? connector;
  const word = "accounting" in spec.from ? "in" : connector === "twilio" ? "from" : "through";
  return `${spec.label} · ${word} ${name}`;
}

/** The tool `action` runs with through `connector`, or null when that connector can't. */
export function actionTool(action: WriteAction, connector: string): string | null {
  return ACTION_SPECS[action].tools[connector] ?? null;
}

/** Whether an action is resolved from an accounting connection (and so may name `via`). */
export function isAccountingAction(action: WriteAction): boolean {
  return "accounting" in ACTION_SPECS[action].from;
}

// ── Inputs (provider-neutral) ────────────────────────────────────────────────────────────────

/** An email to one contact. `cc` is accepted for the shape but no email tool sends it yet. */
export const SendEmailInput = z.strictObject({
  to: z.string().trim().min(1).max(320),
  cc: z.array(z.string().trim().min(1).max(320)).max(10).optional(),
  subject: z.string().trim().min(1).max(200),
  /** Plain text. */
  body: z.string().trim().min(1).max(20_000),
  attachments: OutboundAttachments.optional(),
});
export type SendEmailInput = z.infer<typeof SendEmailInput>;

export const SendTextInput = z.strictObject({
  /** E.164. */
  to: z.string().trim().min(1).max(20),
  body: z.string().trim().min(1).max(1600),
});
export type SendTextInput = z.infer<typeof SendTextInput>;

export const BillLineInput = z.strictObject({
  description: z.string().trim().min(1).max(500),
  amount: DecimalString,
  /** The account the line is coded to, by the accounting system's id. */
  account: z.string().trim().min(1).max(100).optional(),
  /** Or the item (QuickBooks), by its id. */
  item: z.string().trim().min(1).max(100).optional(),
});
export type BillLineInput = z.infer<typeof BillLineInput>;

/** A bill. The vendor by the accounting system's id, or by name; money as decimal strings. */
export const CreateBillInput = z
  .strictObject({
    vendorId: z.string().trim().min(1).max(100).optional(),
    vendorName: z.string().trim().min(1).max(500).optional(),
    invoiceNumber: z.string().trim().min(1).max(50),
    date: IsoDate,
    dueDate: IsoDate.optional(),
    lines: z.array(BillLineInput).min(1).max(250),
    total: DecimalString,
    currency: CurrencyCode,
    memo: z.string().trim().max(4000).optional(),
  })
  .refine((b) => b.vendorId !== undefined || b.vendorName !== undefined, {
    message: "name the vendor: vendorId or vendorName",
    path: ["vendorId"],
  });
export type CreateBillInput = z.infer<typeof CreateBillInput>;

export const VendorAddressInput = z.strictObject({
  line1: z.string().trim().min(1).max(500),
  line2: z.string().trim().min(1).max(500).optional(),
  city: z.string().trim().min(1).max(255).optional(),
  /** State or province, e.g. "OR". */
  region: z.string().trim().min(1).max(255).optional(),
  postalCode: z.string().trim().min(1).max(30).optional(),
  country: z.string().trim().min(1).max(255).optional(),
});

export const CreateVendorInput = z.strictObject({
  name: z.string().trim().min(1).max(500),
  email: z.string().trim().min(1).max(254).optional(),
  phone: z.string().trim().min(1).max(30).optional(),
  address: VendorAddressInput.optional(),
});
export type CreateVendorInput = z.infer<typeof CreateVendorInput>;

export const ACTION_INPUTS = {
  send_email: SendEmailInput,
  send_text: SendTextInput,
  create_bill: CreateBillInput,
  create_vendor: CreateVendorInput,
} as const satisfies Record<WriteAction, z.ZodType>;

const inputSchemas = new Map<WriteAction, JsonSchema>();

/** The action's input as JSON Schema, for template typing and the builder's fields. */
export function actionInputSchema(action: WriteAction): JsonSchema {
  let s = inputSchemas.get(action);
  if (!s) {
    s = z.toJSONSchema(ACTION_INPUTS[action], {
      io: "input",
      unrepresentable: "any",
    }) as JsonSchema;
    inputSchemas.set(action, s);
  }
  return s;
}

// ── Resolution from the agent's bindings ─────────────────────────────────────────────────────

/** What an action resolves from, for one client agent. */
export interface ActionBindings {
  /** The connectors of the agent's bindings (keys or connector ids; `qbo:2` reads as `qbo`). */
  bound: readonly string[];
  /**
   * The channel each kind resolves to for the agent (its own, else the account's), with that
   * connection's matrix; null when nothing carries it. A kind left out isn't known (not checked).
   */
  channels?: Partial<
    Record<ActionChannel, { connector: string; matrix?: Partial<PermissionMatrix> } | null>
  >;
}

export type ActionProblemCode =
  | "action_no_connection"
  | "action_needs_via"
  | "action_via_unknown"
  | "action_via_not_here";

export type ActionResolution =
  | { ok: true; connector: string; tool: string; channel?: ActionChannel }
  | { ok: false; code: ActionProblemCode; message: string };

/**
 * The connector and tool an action resolves to. Accounting: the one accounting connector the
 * agent is bound to, or `via` among them. A channel: what `channels` says the agent's channel is.
 * Undefined when the channel isn't known here (the runtime resolves it).
 */
// DECISION: `via` is for accounting actions only; a message's channel is the one `channelFor`
// resolves (the agent's own, else the account's), never picked per step. Two bindings of the same
// accounting connector (`qbo` and `qbo:2`) count as one connector: the gate resolves the binding.
export function resolveActionConnector(
  action: WriteAction,
  via: string | undefined,
  bindings: ActionBindings,
): ActionResolution | undefined {
  const spec = ACTION_SPECS[action];
  if ("channel" in spec.from) {
    if (via !== undefined) {
      return {
        ok: false,
        code: "action_via_not_here",
        message: `${spec.label} sends on the agent's channel, else the account's: it can't name a connection`,
      };
    }
    const kind = spec.from.channel;
    if (!bindings.channels || !Object.hasOwn(bindings.channels, kind)) return undefined;
    const line = bindings.channels[kind];
    const tool = line ? actionTool(action, line.connector) : null;
    if (!line || !tool) {
      return {
        ok: false,
        code: "action_no_connection",
        message:
          kind === "email"
            ? "neither the agent nor the account has an email channel that can send"
            : "neither the agent nor the account has a number that can text",
      };
    }
    return { ok: true, connector: line.connector, tool, channel: kind };
  }
  const bound = [
    ...new Set(
      bindings.bound
        .map(bindingConnector)
        .filter((c) => (ACCOUNTING_CONNECTORS as readonly string[]).includes(c)),
    ),
  ];
  if (via !== undefined) {
    if (!bound.includes(via)) {
      return {
        ok: false,
        code: "action_via_unknown",
        message: `the agent isn't bound to ${ACTION_CONNECTOR_NAMES[via] ?? via}`,
      };
    }
    return { ok: true, connector: via, tool: actionTool(action, via) as string };
  }
  if (bound.length === 0) {
    return {
      ok: false,
      code: "action_no_connection",
      message: `${spec.label} needs an accounting connection: bind QuickBooks or BILL`,
    };
  }
  if (bound.length > 1) {
    return {
      ok: false,
      code: "action_needs_via",
      message: `the agent is bound to ${bound.map((c) => ACTION_CONNECTOR_NAMES[c] ?? c).join(" and ")}: say which one`,
    };
  }
  const connector = bound[0] as string;
  return { ok: true, connector, tool: actionTool(action, connector) as string };
}

/** A client agent's action bindings from its publish matrices (keys: binding keys). */
export function actionBindingsFromMatrices(
  matrices: Record<string, unknown>,
  channels?: ActionBindings["channels"],
): ActionBindings {
  return { bound: Object.keys(matrices), ...(channels ? { channels } : {}) };
}

// ── The provider's input ─────────────────────────────────────────────────────────────────────

/** An action's input that can't become its tool's: refused before anything is sent. */
export class ActionInputError extends Error {
  override name = "ActionInputError";
  /** Nothing was written: the tool was never called. */
  readonly notWritten = true;
}

function parsed<T>(schema: z.ZodType<T>, input: unknown, label: string): T {
  const r = schema.safeParse(input);
  if (!r.success) {
    const issue = r.error.issues[0];
    const where = issue?.path.length ? `${issue.path.join(".")}: ` : "";
    throw new ActionInputError(`${label}: ${where}${issue?.message ?? "invalid input"}`);
  }
  return r.data;
}

function defined(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
}

/**
 * The action's input, already resolved, as `tool` takes it. Throws `ActionInputError` (nothing is
 * sent) when it doesn't parse or the provider can't take it as given.
 */
// DECISION: what a provider can't take is refused here, never guessed: a vendor named without its
// id (both QuickBooks and BILL take the vendor by id: look it up in a read step first), a BILL bill
// without a due date or with an item line, and an email with `cc` (no email tool sends one yet).
export function actionToolInput(
  action: WriteAction,
  tool: string,
  input: unknown,
): Record<string, unknown> {
  const spec = ACTION_SPECS[action];
  if (!Object.values(spec.tools).includes(tool)) {
    throw new ActionInputError(`${spec.label} doesn't run with ${tool}`);
  }
  switch (action) {
    case "send_email": {
      const e = parsed(SendEmailInput, input, spec.label);
      if (e.cc && e.cc.length > 0) {
        throw new ActionInputError("Send email: copies (cc) can't be sent yet; email each person");
      }
      // Every email tool takes the same input (core's CHANNEL_TOOLS).
      return defined({ to: e.to, subject: e.subject, text: e.body, attachments: e.attachments });
    }
    case "send_text": {
      const t = parsed(SendTextInput, input, spec.label);
      return { to: t.to, text: t.body };
    }
    case "create_vendor": {
      const v = parsed(CreateVendorInput, input, spec.label);
      if (tool === "qbo.vendor.create") {
        return defined({
          displayName: v.name,
          email: v.email,
          phone: v.phone,
          billingAddress: v.address,
        });
      }
      const a = v.address;
      return defined({
        name: v.name,
        email: v.email,
        phone: v.phone,
        address: a
          ? defined({
              line1: a.line1,
              line2: a.line2,
              city: a.city,
              state: a.region,
              zip: a.postalCode,
              country: a.country,
            })
          : undefined,
      });
    }
    case "create_bill": {
      const b = parsed(CreateBillInput, input, spec.label);
      if (b.vendorId === undefined) {
        throw new ActionInputError(
          "Create bill: the vendor needs its id in the accounting system; look it up in a read step first",
        );
      }
      if (tool === "qbo.bill.create") {
        return defined({
          vendorId: b.vendorId,
          docNumber: b.invoiceNumber,
          txnDate: b.date,
          dueDate: b.dueDate,
          currency: b.currency,
          expectedTotal: b.total,
          privateNote: b.memo,
          lines: b.lines.map((l) =>
            defined({
              description: l.description,
              amount: l.amount,
              accountId: l.account,
              itemId: l.item,
            }),
          ),
        });
      }
      if (b.dueDate === undefined) {
        throw new ActionInputError("Create bill: BILL needs a due date");
      }
      if (b.lines.some((l) => l.item !== undefined)) {
        throw new ActionInputError("Create bill: BILL's lines take an account, not an item");
      }
      return defined({
        vendorId: b.vendorId,
        invoiceNumber: b.invoiceNumber,
        invoiceDate: b.date,
        dueDate: b.dueDate,
        currency: b.currency,
        expectedTotal: b.total,
        description: b.memo,
        lines: b.lines.map((l) =>
          defined({ amount: l.amount, description: l.description, chartOfAccountId: l.account }),
        ),
      });
    }
  }
}

// ── The builder's offer: a write after a skill whose output fits ─────────────────────────────

/** A skill's output schema may say which action it prepares (`x-action`), and how its fields map. */
export const ACTION_HINT = "x-action";
/** `{ <action input field>: <output field> }`, for fields named differently. */
export const ACTION_HINT_FIELDS = "x-action-fields";

/** Fields of which at least one must be there (beyond JSON Schema's `required`). */
const ONE_OF: Partial<Record<WriteAction, readonly string[]>> = {
  create_bill: ["vendorId", "vendorName"],
};

function types(s: unknown): string[] {
  if (!isPlainObject(s)) return [];
  const t = s.type;
  if (typeof t === "string") return [t];
  if (Array.isArray(t)) return t.filter((x): x is string => typeof x === "string");
  for (const k of ["anyOf", "oneOf"] as const) {
    const list = s[k];
    if (Array.isArray(list)) return list.flatMap(types);
  }
  return [];
}

function sameType(want: unknown, have: unknown): boolean {
  const w = types(want);
  const h = types(have);
  if (w.length === 0 || h.length === 0) return true;
  return h.every((t) => w.includes(t) || (t === "integer" && w.includes("number")));
}

/** An action a step's output fits, with the action step's input pre-mapped from that output. */
export interface ActionFit {
  action: WriteAction;
  /** The write step's input: each action field filled from `{{steps.<id>.output.<field>}}`. */
  input: Record<string, string>;
}

/**
 * The actions a step's output fits: its output says so (`x-action`), or it has every field the
 * action needs, by the same name and a compatible type. The fields both have are pre-mapped.
 */
// DECISION: a fit is by field names and JSON types only (the builder's offer, never a decision):
// the operator reviews the pre-mapped input, and the validator types it as any other input.
export function actionFits(stepId: string, output: JsonSchema | undefined): ActionFit[] {
  if (!isPlainObject(output)) return [];
  const props = isPlainObject(output.properties) ? output.properties : {};
  const hint = output[ACTION_HINT];
  const hinted = typeof hint === "string" ? hint : undefined;
  const renames = isPlainObject(output[ACTION_HINT_FIELDS])
    ? (output[ACTION_HINT_FIELDS] as Record<string, unknown>)
    : {};
  const out: ActionFit[] = [];
  for (const action of WRITE_ACTIONS) {
    const schema = actionInputSchema(action);
    const want = (isPlainObject(schema.properties) ? schema.properties : {}) as Record<
      string,
      unknown
    >;
    const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
    const input: Record<string, string> = {};
    for (const [f, s] of Object.entries(want)) {
      const from = hinted === action && typeof renames[f] === "string" ? String(renames[f]) : f;
      if (Object.hasOwn(props, from) && sameType(s, props[from])) {
        input[f] = `{{steps.${stepId}.output.${from}}}`;
      }
    }
    const one = ONE_OF[action];
    const fits =
      hinted === action ||
      (required.every((f) => f in input) && (!one || one.some((f) => f in input)));
    if (fits && Object.keys(input).length > 0) out.push({ action, input });
  }
  return out;
}
