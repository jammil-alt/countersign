// §1.164 "Reshape gaps": the `object` expression (a record built field by field, `mapList` without
// the list): evaluation, nesting, typing by field path, and the proposer building one.

import { describe, expect, it } from "vitest";
import type { JsonSchema } from "../schemas/common";
import {
  evaluateReshape,
  RESHAPE_MAX_NESTING,
  type ReshapeExpr,
  ReshapeExpr as ReshapeExprSchema,
  ReshapeMapping,
  reshapeExprSchema,
  reshapeNesting,
  reshapeOutputSchema,
  reshapeProblems,
} from "./reshape";
import { proposeReshape, type ReshapeContext } from "./reshape-propose";

const TODAY = "2026-11-20";

const order = {
  name: "Pat Lee",
  email: "pat@example.com",
  street: "1 Main St",
  zip: "97201",
  lines: [
    { sku: "A-1", qty: "2", price: "10.00", vendor: "Cascade" },
    { sku: "B-2", qty: "1", price: "4.5", vendor: "Pine" },
  ],
};

const CUSTOMER: JsonSchema = {
  type: "object",
  properties: {
    name: { type: "string" },
    email: { type: "string" },
    address: {
      type: "object",
      properties: { street: { type: "string" }, zip: { type: "string" } },
      required: ["street"],
    },
    phone: { type: "string" },
  },
  required: ["name", "email"],
};

const customerExpr: ReshapeExpr = {
  object: {
    fields: {
      name: { input: "o.name" },
      email: { input: "o.email" },
      address: { object: { fields: { street: { input: "o.street" }, zip: { input: "o.zip" } } } },
    },
  },
};

const ORDER_INPUT: JsonSchema = {
  type: "object",
  properties: {
    o: {
      type: "object",
      properties: {
        name: { type: "string" },
        email: { type: "string" },
        street: { type: "string" },
        zip: { type: "string" },
        lines: {
          type: "array",
          items: {
            type: "object",
            properties: {
              sku: { type: "string" },
              qty: { type: "string" },
              price: { type: "string" },
              vendor: { type: "string" },
            },
          },
        },
      },
    },
  },
};

describe("the object expression", () => {
  it("builds a nested record field by field", () => {
    const r = evaluateReshape(
      { fields: [{ name: "customer", schema: CUSTOMER, from: customerExpr }] },
      { o: order },
      { today: TODAY },
    );
    expect(r.problems).toEqual([]);
    expect(r.output).toEqual({
      customer: {
        name: "Pat Lee",
        email: "pat@example.com",
        address: { street: "1 Main St", zip: "97201" },
      },
    });
  });

  it("nests inside a mapped list, reading the item, and a list inside a record", () => {
    const lines: ReshapeExpr = {
      mapList: {
        list: { input: "o.lines" },
        fields: {
          sku: { item: "sku" },
          price: {
            object: {
              fields: {
                amount: { formatMoney: { value: { item: "price" } } },
                currency: { value: "USD" },
              },
            },
          },
          vendor: { object: { fields: { name: { item: "vendor" }, buyer: { input: "o.name" } } } },
        },
      },
    };
    const order2: ReshapeExpr = { object: { fields: { lines, count: { value: 2 } } } };
    const r = evaluateReshape(
      { fields: [{ name: "order", schema: {}, from: order2 }] },
      { o: order },
      { today: TODAY },
    );
    expect(r.problems).toEqual([]);
    expect(r.output.order).toEqual({
      count: 2,
      lines: [
        {
          sku: "A-1",
          price: { amount: "10.00", currency: "USD" },
          vendor: { name: "Cascade", buyer: "Pat Lee" },
        },
        {
          sku: "B-2",
          price: { amount: "4.50", currency: "USD" },
          vendor: { name: "Pine", buyer: "Pat Lee" },
        },
      ],
    });
  });

  it("names a problem by the field's path, and leaves an empty optional field out", () => {
    const r = evaluateReshape(
      {
        fields: [
          {
            name: "customer",
            schema: CUSTOMER,
            from: {
              object: {
                fields: {
                  name: { input: "o.name" },
                  email: { input: "o.missing" },
                  phone: { input: "o.phone" },
                  address: { object: { fields: { street: { input: "o.nowhere" } } } },
                },
              },
            },
          },
        ],
      },
      { o: order },
      { today: TODAY },
    );
    expect(r.problems.map((p) => p.field)).toEqual(["customer.email", "customer.address.street"]);
    expect(r.problems[0]?.message).toBe("customer.email is empty: input.o.missing has no value");
  });

  it("leaves out an optional record with nothing in it, and names a required one", () => {
    const empty: ReshapeExpr = { object: { fields: { zip: { input: "o.nope" } } } };
    const optional = evaluateReshape(
      { fields: [{ name: "shipTo", schema: {}, required: false, from: empty }] },
      { o: order },
      { today: TODAY },
    );
    expect(optional).toEqual({ output: {}, problems: [] });
    const required = evaluateReshape(
      { fields: [{ name: "shipTo", schema: {}, from: empty }] },
      { o: order },
      { today: TODAY },
    );
    expect(required.problems.map((p) => p.field)).toEqual(["shipTo"]);
  });

  it("is data: a field name each, and nests at most five deep", () => {
    expect(ReshapeExprSchema.safeParse(customerExpr).success).toBe(true);
    expect(
      ReshapeExprSchema.safeParse({ object: { fields: { "a b": { value: 1 } } } }).success,
    ).toBe(false);
    expect(ReshapeExprSchema.safeParse({ object: { fields: {}, extra: 1 } }).success).toBe(false);
    const nest = (n: number): ReshapeExpr =>
      n === 0 ? { value: 1 } : { object: { fields: { x: nest(n - 1) } } };
    expect(reshapeNesting(nest(RESHAPE_MAX_NESTING))).toBe(RESHAPE_MAX_NESTING);
    expect(ReshapeExprSchema.safeParse(nest(RESHAPE_MAX_NESTING)).success).toBe(true);
    expect(ReshapeExprSchema.safeParse(nest(RESHAPE_MAX_NESTING + 1)).success).toBe(false);
    // A list map and a record count alike.
    const mixed: ReshapeExpr = {
      mapList: { list: { input: "l" }, fields: { y: nest(RESHAPE_MAX_NESTING) } },
    };
    expect(ReshapeExprSchema.safeParse(mixed).success).toBe(false);
    expect(
      ReshapeMapping.safeParse({
        fields: [{ name: "deep", schema: {}, from: nest(RESHAPE_MAX_NESTING + 1) }],
      }).success,
    ).toBe(false);
  });
});

describe("typing the object expression", () => {
  it("types a record from its fields", () => {
    const t = reshapeExprSchema(customerExpr, { input: ORDER_INPUT });
    expect(t.problems).toEqual([]);
    expect(t.schema).toEqual({
      type: "object",
      properties: {
        name: { type: "string" },
        email: { type: "string" },
        address: {
          type: "object",
          properties: { street: { type: "string" }, zip: { type: "string" } },
          required: ["street", "zip"],
          additionalProperties: false,
        },
      },
      required: ["name", "email", "address"],
      additionalProperties: false,
    });
  });

  it("reports reads that aren't there, values that don't fit and missing fields, by path", () => {
    const mapping: ReshapeMapping = {
      fields: [
        {
          name: "customer",
          schema: CUSTOMER,
          from: {
            object: {
              fields: {
                name: { input: "o.fullName" },
                address: {
                  object: { fields: { street: { item: "x" }, zip: { value: 97201 } } },
                },
                fax: { input: "o.email" },
              },
            },
          },
        },
        {
          name: "lines",
          schema: {},
          from: {
            mapList: {
              list: { input: "o.lines" },
              fields: { price: { object: { fields: { amount: { item: "cost" } } } } },
            },
          },
        },
      ],
    };
    expect(reshapeProblems(mapping, ORDER_INPUT).map((p) => [p.field, p.message])).toEqual([
      ["customer", 'customer.name reads input.o.fullName: no field "fullName"'],
      ["customer", "customer.address.street reads a list item outside a list map"],
      ["lines", 'lines.price.amount reads item.cost: no field "cost"'],
    ]);
    // Once it reads what is there, the fit is checked inside the record.
    const fits = reshapeProblems(
      {
        fields: [
          {
            name: "customer",
            schema: CUSTOMER,
            from: {
              object: {
                fields: {
                  name: { input: "o.name" },
                  address: { object: { fields: { zip: { value: 97201 } } } },
                  fax: { input: "o.email" },
                },
              },
            },
          },
        ],
      },
      ORDER_INPUT,
    ).map((p) => p.message);
    expect(fits).toEqual([
      "customer has no email, which is required",
      "customer.address has no street, which is required",
      "customer.address.zip gets a whole number; it takes text",
    ]);
  });

  it("promises the record as the step's output", () => {
    expect(
      reshapeOutputSchema({ fields: [{ name: "customer", schema: CUSTOMER, from: customerExpr }] })
        .properties,
    ).toEqual({ customer: CUSTOMER });
  });
});

describe("proposing a record", () => {
  const next = (schema: JsonSchema): ReshapeContext["next"] => ({
    stepId: "n",
    name: "Create contact",
    schema,
  });

  it("builds a record the next step takes from a form's flat fields", () => {
    const form: JsonSchema = {
      type: "object",
      properties: {
        data: {
          type: "object",
          properties: {
            name: { type: "string" },
            emailAddress: { type: "string" },
            street: { type: "string" },
            source: { type: "string" },
          },
        },
      },
    };
    const context: ReshapeContext = {
      sources: [{ key: "trigger", template: "{{trigger}}", schema: form, label: "Trigger" }],
      next: next({
        type: "object",
        properties: { customer: CUSTOMER, source: { type: "string" } },
        required: ["customer"],
      }),
      input: { type: "object", properties: { trigger: form } },
    };
    const p = proposeReshape({ context });
    expect(p.mapping.fields.find((f) => f.name === "customer")?.from).toEqual({
      object: {
        fields: {
          name: { input: "trigger.data.name" },
          email: { input: "trigger.data.emailAddress" },
          address: { object: { fields: { street: { input: "trigger.data.street" } } } },
        },
      },
    });
    expect(p.how).toEqual({ customer: "fields", source: "exact" });
    expect(p.unmapped).toEqual(["customer.address.zip", "customer.phone"]);
    expect(p.input).toEqual({ trigger: "{{trigger}}" });
    // What it proposes type-checks against the step's input.
    expect(reshapeProblems(p.mapping, context.input)).toEqual([]);
  });

  it("maps a record of another shape field by field, and copies one that fits", () => {
    const src: JsonSchema = {
      type: "object",
      properties: {
        customer: {
          type: "object",
          properties: { fullName: { type: "string" }, email: { type: "string" } },
        },
        vendor: {
          type: "object",
          properties: { name: { type: "string" }, email: { type: "string" } },
          required: ["name", "email"],
        },
      },
    };
    const context: ReshapeContext = {
      sources: [{ key: "read", template: "{{steps.r.output}}", schema: src, label: "Read" }],
      next: next({
        type: "object",
        properties: {
          customer: CUSTOMER,
          vendor: {
            type: "object",
            properties: { name: { type: "string" }, email: { type: "string" } },
          },
        },
      }),
      input: { type: "object", properties: { read: src } },
    };
    const p = proposeReshape({ context });
    const from = Object.fromEntries(p.mapping.fields.map((f) => [f.name, f.from]));
    expect(from.customer).toEqual({
      object: {
        fields: {
          name: { input: "read.customer.fullName" },
          email: { input: "read.customer.email" },
        },
      },
    });
    expect(from.vendor).toEqual({ input: "read.vendor" });
    expect(p.how).toEqual({ customer: "exact", vendor: "exact" });
  });

  it("builds a record inside a mapped list's items", () => {
    const context: ReshapeContext = {
      sources: [
        {
          key: "o",
          template: "{{steps.o.output}}",
          schema: (ORDER_INPUT.properties as Record<string, JsonSchema>).o,
          label: "Order",
        },
      ],
      next: next({
        type: "object",
        properties: {
          lines: {
            type: "array",
            items: {
              type: "object",
              properties: {
                sku: { type: "string" },
                price: {
                  type: "object",
                  properties: { price: { type: "string" }, currency: { type: "string" } },
                  required: ["price"],
                },
              },
            },
          },
        },
      }),
      input: ORDER_INPUT,
    };
    const p = proposeReshape({ context });
    expect(p.mapping.fields[0]?.from).toEqual({
      mapList: {
        list: { input: "o.lines" },
        fields: {
          sku: { item: "sku" },
          price: { object: { fields: { price: { item: "price" } } } },
        },
      },
    });
  });

  it("builds no record from one stray optional field", () => {
    const src: JsonSchema = { type: "object", properties: { phone: { type: "string" } } };
    const context: ReshapeContext = {
      sources: [{ key: "s", template: "{{steps.s.output}}", schema: src, label: "S" }],
      next: next({ type: "object", properties: { customer: CUSTOMER } }),
      input: { type: "object", properties: { s: src } },
    };
    const p = proposeReshape({ context });
    expect(p.mapping.fields[0]?.from).toBeUndefined();
    expect(p.unmapped).toEqual(["customer"]);
  });
});
