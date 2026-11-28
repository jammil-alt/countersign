// The wiring checks at publish (`./wiring`), on the five failures staging had on 2026-11-27/28,
// through the server's context (`process/bundle.ts`'s `stepContext`, the registries as JSON
// Schemas) so what is tested is what publishing runs.

import { describe, expect, it } from "vitest";
import { stepContext } from "../process/bundle";
import type { SkillDefinition } from "../schemas/skill";
import type { ToolSpec } from "../schemas/tool";
import { MatchProfile } from "./match-profile";
import { Workflow, type WorkflowInput } from "./schema";
import { convertToShape, schemaShape } from "./shape";
import { validateWorkflow } from "./validate";
import { stepOutputShape, workflowWiring } from "./wiring";

const str = { type: "string" };
const decimal = { type: "string", pattern: "^-?\\d+(\\.\\d+)?$" };
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

const READ_DOCUMENT = {
  id: "docs.read-document",
  input: obj({ documentId: str }, ["documentId"]),
  output: obj({
    header: obj({ vendorName: str, invoiceNumber: str, currency: str }),
    lines: {
      type: "array",
      items: obj({ vendorSku: str, description: str, quantity: { type: "number" }, amount: str }),
    },
    total: str,
  }),
} as unknown as SkillDefinition;

const tool = (id: string, input: unknown, output: unknown = obj({ id: str })) =>
  ({ id, sideEffect: "external", input, output }) as unknown as ToolSpec;

const TOOLS: Record<string, ToolSpec> = {
  "qbo.bill.create": tool(
    "qbo.bill.create",
    obj(
      { vendorId: str, total: decimal, lines: { type: "array", items: obj({ amount: decimal }) } },
      ["vendorId"],
    ),
  ),
  "qbo.purchase.create": tool(
    "qbo.purchase.create",
    obj(
      {
        accountId: str,
        currency: str,
        expectedTotal: decimal,
        lines: {
          type: "array",
          items: obj({ accountId: str, amount: decimal, quantity: { type: "number" } }, [
            "accountId",
            "amount",
          ]),
        },
      },
      ["accountId", "expectedTotal", "lines"],
    ),
  ),
};

const VENDORS = MatchProfile.parse({
  id: "vendors",
  name: "Vendors",
  area: "shared",
  record: "vendor",
  source: { kind: "table" },
  input: [{ name: "name", type: "text", required: true }],
  keys: [{ id: "name", name: "Name", field: "name" }],
  types: ["exact"],
});

const vendorItems = (also?: string[]) =>
  MatchProfile.parse({
    id: "vendor-items",
    name: "Vendor items",
    area: "purchasing",
    record: "vendor_item",
    source: { kind: "table" },
    input: [
      { name: "vendorId", type: "record", record: "vendor", required: true },
      { name: "sku", type: "text", required: true },
    ],
    keys: [{ id: "sku", name: "SKU", field: "sku", ...(also ? { also } : {}) }],
    types: ["exact"],
  });

const context = (profiles = [VENDORS, vendorItems(["vendorSku"])]) =>
  stepContext({ tools: TOOLS, skills: { "docs.read-document": READ_DOCUMENT }, profiles });

const trigger = {
  id: "t1",
  on: { type: "manual", input: obj({ documentId: str }, ["documentId"]) },
};
const outputs = [{ id: "o_none", name: "Done", kind: "nothing" }];
const end = { id: "s_end", kind: "end", name: "Done", outputs: ["o_none"] };

const wf = (steps: unknown[], more: Partial<WorkflowInput> = {}) =>
  Workflow.parse({
    schemaVersion: 5,
    triggers: [trigger],
    outputs,
    steps: [...steps, end],
    ...more,
  });

const read = {
  id: "s_read",
  kind: "do",
  name: "Read the invoice",
  doneBy: "ai",
  uses: { type: "skill", skill: "docs.read-document" },
  input: { documentId: "{{trigger.documentId}}" },
};
const matchVendor = {
  id: "s_vendor",
  kind: "do",
  name: "Match the vendor",
  doneBy: "rules",
  uses: { type: "match", match: { to: "vendors", type: "exact" } },
  input: { name: "{{steps.s_read.output.header.vendorName}}" },
};
const matchItems = {
  id: "s_items",
  kind: "do",
  name: "Match the lines",
  doneBy: "rules",
  uses: { type: "match", match: { to: "vendor-items", type: "exact", keys: ["sku"] } },
  input: {
    items: "{{steps.s_read.output.lines}}",
    vendorId: "{{steps.s_vendor.output.items.0.matched}}",
  },
};
const bill = (input: Record<string, unknown>) => ({
  id: "s_bill",
  kind: "do",
  name: "Create the bill",
  doneBy: "rules",
  uses: { type: "action", action: "qbo.bill.create" },
  input,
});
const code = {
  id: "s_code",
  kind: "do",
  name: "Code the receipt",
  doneBy: "ai",
  ai: { text: "Code each line to an account." },
  input: { lines: "{{steps.s_read.output.lines}}" },
  output: [
    { name: "total", type: "money", required: true },
    {
      name: "lines",
      type: "list",
      required: true,
      of: [
        { name: "accountId", type: "text", required: true },
        { name: "amount", type: "money", required: true },
      ],
    },
  ],
};
const purchase = (input: Record<string, unknown>) => ({
  id: "s_purchase",
  kind: "do",
  name: "Book the purchase",
  doneBy: "rules",
  uses: { type: "action", action: "qbo.purchase.create" },
  input: { accountId: "35", ...input },
});
const ask = {
  id: "s_ask",
  kind: "do",
  name: "Ask the employee",
  doneBy: "contact",
  input: {},
  contact: {
    with: "{{trigger.documentId}}",
    channel: "email",
    goal: "What was it for?",
    deadline: { after: "2 days" },
  },
  output: [{ name: "answer", type: "text", required: true, about: "What they said" }],
};
const tellAfter = (text: string) => ({
  id: "s_tell",
  kind: "do",
  name: "Note it",
  doneBy: "ai",
  ai: { text: "Write it down." },
  input: { note: text },
  output: [{ name: "note", type: "text", required: true }],
});

const wiringIssues = (w: Workflow, ctx = context()) =>
  validateWorkflow(w, ctx).filter((i) =>
    ["reference_unknown", "reference_type", "match_item_missing"].includes(i.code),
  );

describe("the wiring between steps, at publish", () => {
  it("passes a well-wired workflow, and lists the conversions the run makes", () => {
    const w = wf([
      read,
      matchVendor,
      matchItems,
      bill({
        vendorId: "{{steps.s_vendor.output.items.0.matched}}",
        total: "{{steps.s_read.output.total}}",
      }),
      code,
      purchase({
        currency: "{{steps.s_read.output.header.currency}}",
        expectedTotal: "{{steps.s_code.output.total}}",
        lines: "{{steps.s_code.output.lines}}",
      }),
    ]);
    expect(validateWorkflow(w, context())).toEqual([]);
    expect(workflowWiring(w, context()).conversions).toEqual([
      { at: "s_purchase", field: "expectedTotal", conversions: ["money_amount"] },
      { at: "s_purchase", field: "lines", conversions: ["money_amount"] },
    ]);
  });

  // Owner, 2026-11-28: a person step asks for the fields it lists and hands each on by its name.
  it("reads a person step by the fields it lists, beside its answer and who gave it", () => {
    const ask = {
      id: "s_ask",
      kind: "do",
      name: "Ask the bookkeeper",
      doneBy: "person",
      input: {},
      person: {
        mode: "ask",
        who: "client_admin",
        question: "Book it?",
        deadline: { after: "1 day" },
      },
      output: [
        { name: "choice", type: "text", required: true },
        { name: "note", type: "text", required: false },
      ],
    };
    const ok = wf([
      read,
      ask,
      tellAfter("{{steps.s_ask.output.note}} by {{steps.s_ask.output.by}}"),
    ]);
    expect(wiringIssues(ok)).toEqual([]);
    const wrong = wf([read, ask, tellAfter("{{steps.s_ask.output.reason}}")]);
    expect(wiringIssues(wrong).map((i) => i.code)).toEqual(["reference_unknown"]);
  });

  it("1. refuses a Match's record read as if it were a group", () => {
    const w = wf([
      read,
      matchVendor,
      bill({ vendorId: "{{steps.s_vendor.output.items.0.matched.id}}" }),
    ]);
    expect(wiringIssues(w)).toEqual([
      {
        at: "s_bill",
        code: "reference_unknown",
        message:
          'Reads `items.0.matched.id` for "vendorId", which "Match the vendor" doesn\'t hand on: it hands on `items.0.matched` (the vendor\'s id).',
      },
    ]);
    const other = wf([
      read,
      matchVendor,
      bill({ vendorId: "{{steps.s_vendor.output.items.0.matched.accountingId}}" }),
    ]);
    expect(wiringIssues(other)[0]?.message).toContain("`items.0.matched.accountingId`");
    // A list read without an item's position says how to read one.
    const noIndex = wf([
      read,
      matchVendor,
      bill({ vendorId: "{{steps.s_vendor.output.items.matched}}" }),
    ]);
    expect(wiringIssues(noIndex)[0]?.message).toBe(
      'Reads `items.matched` for "vendorId", which "Match the vendor" doesn\'t hand on: `items` is a list: read one of its items by position (`items.0.matched`).',
    );
  });

  it("2. refuses a Match on a field the items don't have, unless the key reads it under another name", () => {
    const without = context([VENDORS, vendorItems()]);
    expect(wiringIssues(wf([read, matchVendor, matchItems]), without)).toEqual([
      {
        at: "s_items",
        code: "match_item_missing",
        message:
          'Matches each item of `lines` from "Read the invoice" on "sku", which its items don\'t have: they have `vendorSku`, `description`, `quantity` and `amount`. Give "sku" beside the list, or match on a field they have.',
      },
    ]);
    // The key's other name (`MatchKey.also`) is the line's `vendorSku`: it fits.
    expect(wiringIssues(wf([read, matchVendor, matchItems]))).toEqual([]);
    // Given beside the list for every item, it fits too.
    const beside = { ...matchItems, input: { ...matchItems.input, sku: "ABC-1" } };
    expect(wiringIssues(wf([read, matchVendor, beside]), without)).toEqual([]);
  });

  it("3. knows money from a step isn't a tool's decimal: converted where it can be, refused where not", () => {
    // Into a decimal string: converted at run time (above); into a number, refused.
    const w = wf([
      read,
      code,
      purchase({
        expectedTotal: "{{steps.s_code.output.total}}",
        lines: [
          {
            accountId: "{{steps.s_code.output.lines.0.accountId}}",
            amount: "{{steps.s_code.output.lines.0.amount}}",
            quantity: "{{steps.s_code.output.total}}",
          },
        ],
      }),
    ]);
    expect(wiringIssues(w)).toEqual([
      {
        at: "s_purchase",
        code: "reference_type",
        message:
          'Reads `total` from "Code the receipt" for "lines.0.quantity", which is an amount and a currency, and this takes a number.',
      },
    ]);
    // A whole list whose items' money goes into numbers says where.
    const listed = {
      ...code,
      output: [
        {
          name: "lines",
          type: "list",
          required: true,
          of: [
            { name: "accountId", type: "text", required: true },
            { name: "amount", type: "money", required: true },
            { name: "quantity", type: "money", required: true },
          ],
        },
        { name: "total", type: "money", required: true },
      ],
    };
    const whole = wf([
      read,
      listed,
      purchase({
        expectedTotal: "{{steps.s_code.output.total}}",
        lines: "{{steps.s_code.output.lines}}",
      }),
    ]);
    expect(wiringIssues(whole)[0]?.message).toBe(
      'Reads `lines` from "Code the receipt" for "lines": `lines.0.quantity` is an amount and a currency, and this takes a number.',
    );
  });

  it("4. knows what a Fork and a For each hand on", () => {
    const each = {
      id: "s_each",
      kind: "for_each",
      name: "Each line",
      over: "{{steps.s_read.output.lines}}",
      steps: [
        {
          id: "s_line",
          kind: "do",
          name: "Code the line",
          doneBy: "ai",
          ai: { text: "Pick its account." },
          input: { sku: "{{item.vendorSku}}", qty: "{{item.qty}}" },
          output: [{ name: "accountId", type: "text", required: true }],
        },
      ],
    };
    const fork = {
      id: "s_fork",
      kind: "fork",
      name: "Unclear?",
      paths: [
        {
          id: "p_ask",
          name: "Unclear",
          when: { rules: [{ field: "{{steps.s_read.output.total}}", op: "exists" }] },
          steps: [ask],
        },
        {
          id: "p_stop",
          name: "Nothing to book",
          when: { rules: [] },
          steps: [{ ...end, id: "s_stop" }],
        },
      ],
      otherwise: { id: "p_else", steps: [] },
    };
    const w = wf([
      read,
      each,
      fork,
      tellAfter(
        "{{steps.s_each.output.count}} {{steps.s_each.output.items.0.accountId}} {{steps.s_fork.output.answer}} {{steps.s_fork.output.pathName}}",
      ),
    ]);
    // `item.qty` isn't a line's: the item hands on its own fields.
    expect(wiringIssues(w)).toEqual([
      {
        at: "s_line",
        code: "reference_unknown",
        message:
          'Reads `qty` for "qty", which the item doesn\'t hand on: it hands on `vendorSku`, `description`, `quantity` and `amount`.',
      },
    ]);
    const after = wf([
      read,
      each,
      fork,
      tellAfter("{{steps.s_each.output.lines}} {{steps.s_fork.output.reply}}"),
    ]);
    expect(
      wiringIssues(after)
        .filter((i) => i.at === "s_tell")
        .map((i) => i.message),
    ).toEqual([
      'Reads `lines`, which "Each line" doesn\'t hand on: it hands on `count`, `failed`, `items` and `itemsTooLarge`.',
      'Reads `reply`, which "Unclear?" doesn\'t hand on: it hands on `answer`, `status`, `found`, `summary`, `conversationId`, `sources`, `pathId` and `pathName`.',
    ]);
    // A For each's list must be a list.
    const notList = wf([read, { ...each, over: "{{steps.s_read.output.total}}" }]);
    expect(wiringIssues(notList)[0]?.message).toBe(
      'Goes through `total` from "Read the invoice", which is text, not a list.',
    );
  });

  it("5. knows a conversation's findings are at its top level and under `found`", () => {
    const ok = wf([
      read,
      ask,
      tellAfter(
        "{{steps.s_ask.output.answer}} {{steps.s_ask.output.found.answer}} {{steps.s_ask.output.status}}",
      ),
    ]);
    expect(wiringIssues(ok)).toEqual([]);
    const bad = wf([read, ask, tellAfter("{{steps.s_ask.output.found.reply}}")]);
    expect(wiringIssues(bad)).toEqual([
      {
        at: "s_tell",
        code: "reference_unknown",
        message:
          'Reads `found.reply` for "note", which "Ask the employee" doesn\'t hand on: `found` holds `answer`.',
      },
    ]);
  });

  it("follows references in an output's action and a Fork's rules, and reads the trigger", () => {
    const w = wf(
      [
        read,
        {
          id: "s_fork",
          kind: "fork",
          name: "Big?",
          paths: [
            {
              id: "p_big",
              name: "Big",
              when: { rules: [{ field: "{{steps.s_read.output.totl}}", op: "exists" }] },
              steps: [],
            },
          ],
          otherwise: { id: "p_else", steps: [] },
        },
      ],
      {
        outputs: [
          {
            id: "o_bill",
            name: "Bill",
            kind: "write",
            action: { action: "qbo.bill.create", input: { vendorId: "{{trigger.vendor}}" } },
          },
        ],
      },
    );
    const withEnd = {
      ...w,
      steps: [...w.steps.slice(0, -1), { ...end, outputs: ["o_bill"] }],
    } as Workflow;
    expect(wiringIssues(withEnd).map((i) => [i.at, i.message])).toEqual([
      [
        "s_fork",
        'Reads `totl`, which "Read the invoice" doesn\'t hand on: it hands on `header`, `lines`, `total` and `sources`.',
      ],
      [
        "o_bill",
        'Reads `vendor` for "vendorId", which the trigger doesn\'t hand on: it hands on `documentId`.',
      ],
    ]);
  });

  it("passes what it can't know, and leaves the run's load to the run", () => {
    // No registries: a skill's output isn't known, so reading it passes.
    const w = wf([read, bill({ vendorId: "{{steps.s_read.output.anything.at.all}}" })]);
    expect(wiringIssues(w, {})).toEqual([]);
    // Known (a step's own fields) but not checked at load.
    const known = wf([code, tellAfter("{{steps.s_code.output.nope}}")]);
    expect(wiringIssues(known, {})).toHaveLength(1);
    expect(validateWorkflow(known, { wiring: false })).toEqual([]);
  });

  it("gives each step kind a shape", () => {
    const w = wf([read, matchVendor]);
    const match = stepOutputShape(w.steps[1] as never, context());
    expect(match.type === "group" && Object.keys(match.fields)).toEqual([
      "items",
      "matched",
      "unsure",
      "anyUnsure",
      "sources",
    ]);
    expect(stepOutputShape(w.steps[0] as never, {}).type).toBe("any");
  });
});

describe("the run's conversions", () => {
  const target = schemaShape(TOOLS["qbo.purchase.create"]?.input);

  it("takes money as its amount and a number as a decimal string", () => {
    const r = convertToShape(
      {
        accountId: "35",
        currency: "USD",
        expectedTotal: { amount: "41.54", currency: "USD" },
        lines: [{ accountId: "7", amount: { amount: "41.54", currency: "usd" }, quantity: 2 }],
      },
      target,
    );
    expect(r).toEqual({
      value: {
        accountId: "35",
        currency: "USD",
        expectedTotal: "41.54",
        lines: [{ accountId: "7", amount: "41.54", quantity: 2 }],
      },
      problems: [],
    });
    expect(convertToShape({ accountId: 35 }, target).value).toEqual({ accountId: "35" });
  });

  it("never drops an amount's currency", () => {
    const mixed = {
      expectedTotal: { amount: "1.00", currency: "USD" },
      lines: [{ amount: { amount: "1.00", currency: "EUR" } }],
    };
    expect(convertToShape(mixed, target).problems).toEqual([
      "its amounts are in USD and EUR, and this takes amounts in one currency",
    ]);
    const other = { currency: "CAD", expectedTotal: { amount: "1.00", currency: "USD" } };
    expect(convertToShape(other, target)).toEqual({
      value: other,
      problems: ["its amounts are in USD, and its currency is CAD"],
    });
  });
});
