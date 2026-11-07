// v0.12 W2-A: permissions per record type (docs/plan.md §1.44, M21).
import { describe, expect, it } from "vitest";
import { effectiveMode } from "../lifecycle/stage";
import { manifestEntityProblems } from "../schemas/connector";
import type {
  EntityPermissions,
  PermissionEntity,
  PermissionLevel,
  PermissionMatrix,
} from "../schemas/permissions";
import { decideToolCall } from "./decide";
import {
  effectiveLevel,
  entityCeiling,
  entityOfCall,
  entityProblems,
  loosenedEntities,
  readEntities,
} from "./entities";
import { explainWrite } from "./explain";
import { grantLevel, grantLoosening, grantProblems, normalizeGrant } from "./grants";

const DECLARED: PermissionEntity[] = [
  { id: "bill", label: "Bills", verbs: ["read", "create", "update"] },
  { id: "item", label: "Items", verbs: ["read", "update"] },
  { id: "vendor", label: "Vendors", verbs: ["read"] },
  {
    id: "invoice",
    label: "Invoices",
    verbs: ["read", "update"],
    scopes: [
      { id: "notes_only", label: "Notes only", verb: "update", tools: ["x.invoice.add_note"] },
    ],
  },
  { id: "customer", label: "Customers", verbs: ["read"] },
];

const BILL_CREATE = { id: "x.bill.create", entity: "bill" };
const BILL_UPDATE = { id: "x.bill.update", entity: "bill" };
const ITEM_UPDATE = { id: "x.item.update", entity: "item" };
const ADD_NOTE = { id: "x.invoice.add_note", entity: "invoice" };
const INVOICE_UPDATE = { id: "x.invoice.update", entity: "invoice" };
const CUSTOMER_QUERY = { id: "x.customer.query", entity: "customer" };
const NO_ENTITY = { id: "x.thing.update" };

type Level = PermissionLevel | undefined;
const LEVELS: Level[] = [undefined, "auto", "approval", "off"];
const STRICT: Record<PermissionLevel, number> = { auto: 0, approval: 1, off: 2 };

function strictest(levels: Level[]): PermissionLevel {
  return levels.reduce<PermissionLevel>(
    (a, b) => (b !== undefined && STRICT[b] > STRICT[a] ? b : a),
    "auto",
  );
}

describe("the folded decision: verb × entity × grant × step × mode/stage × autonomy", () => {
  // Every combination for an update to a bill. The connection's verb level is set (as every stored
  // matrix has one); the others may be left out (no narrowing). Expected: off anywhere refuses;
  // otherwise a write runs only when every level is auto, the step skips approval, the agent acts
  // and is live; anything else waits.
  const rows: [
    PermissionLevel,
    Level,
    Level,
    Level,
    "required" | "not_required",
    string,
    Level,
    string,
  ][] = [];
  for (const verb of ["auto", "approval", "off"] as const)
    for (const entity of LEVELS)
      for (const grantVerb of LEVELS)
        for (const grantEntity of LEVELS)
          for (const step of ["required", "not_required"] as const)
            for (const stage of ["live", "trial", "live-suggest"])
              for (const person of LEVELS) {
                const levels = [verb, entity, grantVerb, grantEntity, person];
                const top = strictest(levels);
                const expected =
                  top === "off"
                    ? "refused"
                    : top === "auto" && step === "not_required" && stage === "live"
                      ? "run"
                      : "approval";
                rows.push([verb, entity, grantVerb, grantEntity, step, stage, person, expected]);
              }

  it(`holds for all ${rows.length} combinations`, () => {
    for (const [verb, entity, grantVerb, grantEntity, step, stage, person, expected] of rows) {
      const matrix: Partial<PermissionMatrix> = {
        update: verb,
        ...(entity ? { entities: { bill: { update: entity } } } : {}),
      };
      const grant = {
        ...(grantVerb ? { verbs: { update: grantVerb } } : {}),
        ...(grantEntity ? { entities: { bill: { update: grantEntity } } } : {}),
      };
      const definition = {
        permissions: {
          mode: stage === "live-suggest" ? ("suggest_only" as const) : ("act" as const),
        },
      };
      const decision = decideToolCall({
        sideEffect: "external",
        verb: "update",
        matrix,
        grant,
        stepApproval: step,
        agentMode: effectiveMode(definition, stage === "trial" ? "trial" : "live"),
        ceilings: person ? [person] : undefined,
        entity: { tool: BILL_UPDATE, declared: DECLARED },
      });
      expect(
        decision,
        JSON.stringify({ verb, entity, grantVerb, grantEntity, step, stage, person }),
      ).toBe(expected);
    }
  });

  it("reads run unless something turns them off, whatever the entity's approval", () => {
    const read = (entity: Level, grantEntity: Level) =>
      decideToolCall({
        sideEffect: "none",
        verb: "read",
        matrix: { read: "auto", ...(entity ? { entities: { customer: { read: entity } } } : {}) },
        grant: grantEntity ? { entities: { customer: { read: grantEntity } } } : null,
        agentMode: "act",
        entity: { tool: CUSTOMER_QUERY, declared: DECLARED },
      });
    expect(read(undefined, undefined)).toBe("run");
    expect(read("approval", undefined)).toBe("run");
    expect(read("off", undefined)).toBe("refused");
    expect(read(undefined, "off")).toBe("refused");
  });

  it("an internal tool is never gated", () => {
    expect(
      decideToolCall({
        sideEffect: "internal",
        verb: "create",
        matrix: { create: "off", entities: { bill: { create: "off" } } },
        agentMode: "act",
        entity: { tool: BILL_CREATE },
      }),
    ).toBe("run");
  });
});

describe("old matrices", () => {
  it("apply to every entity: no `entities` key is the verb's level", () => {
    const old: Partial<PermissionMatrix> = { read: "auto", create: "auto", update: "approval" };
    for (const tool of [BILL_UPDATE, ITEM_UPDATE, ADD_NOTE, INVOICE_UPDATE]) {
      expect(
        effectiveLevel({ tool: { ...tool, verb: "update" }, matrix: old, declared: DECLARED }),
      ).toBe("approval");
    }
    expect(
      effectiveLevel({ tool: { ...BILL_CREATE, verb: "create" }, matrix: old, declared: DECLARED }),
    ).toBe("auto");
    // A stored matrix with no entities decides as before W2-A.
    for (const level of ["auto", "approval", "off"] as const) {
      const before = decideToolCall({
        sideEffect: "external",
        verb: "update",
        matrix: { update: level },
        stepApproval: "not_required",
        agentMode: "act",
      });
      const now = decideToolCall({
        sideEffect: "external",
        verb: "update",
        matrix: { update: level },
        stepApproval: "not_required",
        agentMode: "act",
        entity: { tool: BILL_UPDATE, declared: DECLARED },
      });
      expect(now).toBe(before);
    }
  });

  it("a tool without an entity is governed by the verb alone", () => {
    const matrix = { update: "auto" as const, entities: { bill: { update: "off" as const } } };
    expect(effectiveLevel({ tool: { ...NO_ENTITY, verb: "update" }, matrix })).toBe("auto");
  });
});

describe("entities and scopes", () => {
  it("an entity off blocks while another entity of the same connection still works", () => {
    const matrix: Partial<PermissionMatrix> = {
      update: "auto",
      entities: { item: { update: "off" } },
    };
    const decide = (tool: typeof BILL_UPDATE) =>
      decideToolCall({
        sideEffect: "external",
        verb: "update",
        matrix,
        stepApproval: "not_required",
        agentMode: "act",
        entity: { tool, declared: DECLARED },
      });
    expect(decide(ITEM_UPDATE)).toBe("refused");
    expect(decide(BILL_UPDATE)).toBe("run");
  });

  it("an entity is never looser than its verb: the stricter wins", () => {
    const matrix: Partial<PermissionMatrix> = {
      update: "approval",
      entities: { bill: { update: "auto" } },
    };
    expect(
      effectiveLevel({ tool: { ...BILL_UPDATE, verb: "update" }, matrix, declared: DECLARED }),
    ).toBe("approval");
  });

  it("`notes_only` allows add_note and turns another invoice update off", () => {
    const matrix: Partial<PermissionMatrix> = {
      update: "approval",
      entities: { invoice: { scope: { update: "notes_only" } } },
    };
    const level = (tool: typeof ADD_NOTE) =>
      effectiveLevel({ tool: { ...tool, verb: "update" }, matrix, declared: DECLARED });
    expect(level(ADD_NOTE)).toBe("approval");
    expect(level(INVOICE_UPDATE)).toBe("off");
    // Without the connector's declarations a scope can't be read: it lets nothing through.
    expect(effectiveLevel({ tool: { ...ADD_NOTE, verb: "update" }, matrix })).toBe("off");
  });

  it("a grant's scope and entity narrow like the connection's", () => {
    const matrix: Partial<PermissionMatrix> = { update: "auto" };
    const grant = { entities: { invoice: { scope: { update: "notes_only" } } } };
    const level = (tool: typeof ADD_NOTE) =>
      effectiveLevel({ tool: { ...tool, verb: "update" }, matrix, grant, declared: DECLARED });
    expect(level(ADD_NOTE)).toBe("auto");
    expect(level(INVOICE_UPDATE)).toBe("off");
  });

  it("delete stays off for every entity", () => {
    const matrix = { delete: "auto" as const, entities: { bill: { delete: "auto" as const } } };
    expect(
      entityCeiling({ tool: { id: "x.bill.delete", entity: "bill", verb: "delete" }, matrix }),
    ).toBe("off");
  });

  it("the prototype's QuickBooks shape: bills, items, vendors, invoices notes only, customers read only", () => {
    const matrix: Partial<PermissionMatrix> = {
      read: "auto",
      create: "approval",
      update: "approval",
      delete: "off",
      entities: {
        invoice: { scope: { update: "notes_only" } },
        customer: { read: "auto" },
      },
    };
    const at = (tool: { id: string; entity: string }, verb: "read" | "create" | "update") =>
      effectiveLevel({ tool: { ...tool, verb }, matrix, declared: DECLARED });
    expect(at(BILL_CREATE, "create")).toBe("approval");
    expect(at(BILL_UPDATE, "update")).toBe("approval");
    expect(at(ITEM_UPDATE, "update")).toBe("approval");
    expect(at(ADD_NOTE, "update")).toBe("approval");
    expect(at(INVOICE_UPDATE, "update")).toBe("off");
    expect(at(CUSTOMER_QUERY, "read")).toBe("auto");
  });
});

describe("entityOfCall", () => {
  const zoho = {
    entityInput: { field: "module", values: { Leads: "lead", Deals: "deal" } },
  };

  it("reads the entity a tool's input names", () => {
    expect(entityOfCall({ entity: "bill" }, {})).toBe("bill");
    expect(entityOfCall({}, {})).toBeUndefined();
    expect(entityOfCall(zoho, { module: "Leads" })).toBe("lead");
    expect(entityOfCall(zoho, { module: "Deals" })).toBe("deal");
  });

  it("an input it can't map is null, and the call is off", () => {
    for (const input of [{}, { module: "Tasks" }, { module: 3 }, null, "Leads"]) {
      expect(entityOfCall(zoho, input)).toBeNull();
    }
    // Built-in names are never read from the mapping or the input.
    expect(entityOfCall(zoho, { module: "constructor" })).toBeNull();
    expect(entityOfCall(zoho, { module: "__proto__" })).toBeNull();
    expect(entityOfCall(zoho, JSON.parse('{"__proto__": {"module": "Leads"}}'))).toBeNull();
    expect(
      effectiveLevel({
        tool: { id: "z.record.create", verb: "create", ...zoho },
        input: { module: "Tasks" },
        matrix: { create: "auto" },
      }),
    ).toBe("off");
    expect(
      effectiveLevel({
        tool: { id: "z.record.create", verb: "create", ...zoho },
        input: { module: "Leads" },
        matrix: { create: "auto", entities: { deal: { create: "off" } } },
      }),
    ).toBe("auto");
  });
});

describe("stored entities", () => {
  it("unreadable entities narrow to off, never widen", () => {
    expect(readEntities({})).toEqual({});
    expect(readEntities({ entities: { bill: { update: "maybe" } } })).toBeNull();
    expect(readEntities({ entities: { constructor: { update: "auto" } } })).toBeNull();
    const matrix = { update: "auto", entities: "nonsense" } as unknown as PermissionMatrix;
    expect(
      effectiveLevel({ tool: { ...BILL_UPDATE, verb: "update" }, matrix, declared: DECLARED }),
    ).toBe("off");
    // A tool without an entity is still governed by the verb alone.
    expect(effectiveLevel({ tool: { ...NO_ENTITY, verb: "update" }, matrix })).toBe("auto");
  });

  it("a key named like an object's built-ins finds nothing", () => {
    const matrix: Partial<PermissionMatrix> = { update: "auto", entities: {} };
    expect(
      effectiveLevel({
        tool: { id: "x.constructor.update", entity: "constructor", verb: "update" },
        matrix,
      }),
    ).toBe("auto");
  });
});

describe("entityProblems", () => {
  it("accepts the connector's own entities, verbs and scopes", () => {
    expect(
      entityProblems(
        {
          bill: { create: "off", update: "approval" },
          invoice: { scope: { update: "notes_only" } },
        },
        DECLARED,
      ),
    ).toEqual([]);
  });

  it("refuses unknown entities, verbs and scopes, and a delete that isn't off", () => {
    const problems = entityProblems(
      {
        truck: { read: "off" },
        vendor: { update: "off" },
        invoice: { scope: { update: "everything" } },
        bill: { delete: "auto" },
      } as EntityPermissions,
      DECLARED,
    );
    expect(problems).toEqual([
      "truck is not one of this connector's record types",
      "Vendors has no update",
      "Invoices has no scope everything for update",
      "Bills: delete stays off",
    ]);
  });
});

describe("loosenedEntities (tighten only)", () => {
  const matrixLevel = (
    m: { entities?: unknown } | null | undefined,
    v: "read" | "create" | "update" | "delete",
  ) => ((m as Partial<PermissionMatrix> | undefined)?.[v] ?? "approval") as PermissionLevel;

  it("finds an entity made looser than it was, an entry dropped, a scope dropped or widened", () => {
    const before = {
      update: "approval",
      entities: { bill: { update: "off" }, invoice: { scope: { update: "notes_only" } } },
    };
    expect(loosenedEntities(before, before, matrixLevel, DECLARED)).toEqual([]);
    expect(
      loosenedEntities(
        before,
        {
          update: "approval",
          entities: { bill: { update: "approval" }, invoice: before.entities.invoice },
        },
        matrixLevel,
        DECLARED,
      ),
    ).toEqual(["bill.update"]);
    expect(loosenedEntities(before, { update: "approval" }, matrixLevel, DECLARED)).toEqual([
      "bill.update",
      "invoice.update scope",
    ]);
  });

  it("allows tightening: an entity off, a scope set where there was none", () => {
    const before = { update: "approval" };
    expect(
      loosenedEntities(
        before,
        {
          update: "approval",
          entities: { item: { update: "off" }, invoice: { scope: { update: "notes_only" } } },
        },
        matrixLevel,
        DECLARED,
      ),
    ).toEqual([]);
  });

  it("an entry looser than the verb is loosening: a later verb change would let it through", () => {
    expect(
      loosenedEntities(
        { update: "approval" },
        { update: "approval", entities: { bill: { update: "auto" } } },
        matrixLevel,
        DECLARED,
      ),
    ).toEqual(["bill.update"]);
  });
});

describe("grants with entities", () => {
  it("narrow per entity and keep their entities when stored", () => {
    const limits = {
      verbs: { update: "approval" as const },
      entities: { bill: { update: "off" as const } },
    };
    expect(normalizeGrant(limits)).toEqual(limits);
    expect(normalizeGrant({ entities: {} })).toEqual({});
    expect(grantLevel(limits, "update")).toBe("approval");
  });

  it("a client can't loosen a grant's entity", () => {
    const before = { entities: { bill: { update: "off" as const } } };
    expect(grantLoosening(before, {}, DECLARED).entities).toEqual(["bill.update"]);
    expect(grantLoosening(before, before, DECLARED).entities).toEqual([]);
    expect(
      grantLoosening({}, { entities: { item: { update: "approval" } } }, DECLARED).entities,
    ).toEqual([]);
  });

  it("the operator's grant stays within the connection, entity by entity", () => {
    const matrix: Partial<PermissionMatrix> = {
      update: "auto",
      entities: { bill: { update: "approval" } },
    };
    expect(grantProblems({ entities: { bill: { update: "auto" } } }, matrix, [], DECLARED)).toEqual(
      ["bill update can't be auto: the connection allows approval at most"],
    );
    expect(grantProblems({ entities: { truck: { read: "off" } } }, matrix, [], DECLARED)).toEqual([
      "truck is not one of this connector's record types",
    ]);
    expect(grantProblems({ entities: { item: { update: "auto" } } }, matrix, [], DECLARED)).toEqual(
      [],
    );
  });
});

describe("explainWrite names the entity", () => {
  it("as `matrix` (or `grant`) with the entity whose own setting asked", () => {
    const why = explainWrite({
      verb: "update",
      matrix: { update: "auto", entities: { bill: { update: "approval" } } },
      stepApproval: "not_required",
      agentMode: "act",
      entity: "bill",
    });
    expect(why).toEqual({ reasons: ["matrix"], entity: "bill" });
    const grant = explainWrite({
      verb: "update",
      matrix: { update: "auto" },
      grant: { entities: { bill: { update: "approval" } } },
      stepApproval: "not_required",
      agentMode: "act",
      entity: "bill",
    });
    expect(grant).toEqual({ reasons: ["grant"], entity: "bill" });
    // No entity setting asked: no entity named.
    expect(
      explainWrite({
        verb: "update",
        matrix: { update: "approval" },
        stepApproval: "not_required",
        agentMode: "act",
        entity: "bill",
      }),
    ).toEqual({ reasons: ["matrix"] });
  });
});

describe("manifestEntityProblems", () => {
  const tools = [
    { id: "x.invoice.add_note", verb: "update" as const, entity: "invoice" },
    { id: "x.invoice.query", verb: "read" as const, entity: "invoice" },
    { id: "x.bill.create", verb: "create" as const, entity: "bill" },
  ];

  it("accepts entities that agree with the tools", () => {
    expect(manifestEntityProblems({ tools, permissionEntities: DECLARED })).toEqual([]);
  });

  it("finds undeclared entities, verbs the entity doesn't list and scopes over others' tools", () => {
    expect(
      manifestEntityProblems({
        tools: [...tools, { id: "x.truck.query", verb: "read", entity: "truck" }],
        permissionEntities: [
          { id: "bill", label: "Bills", verbs: ["read"] },
          {
            id: "invoice",
            label: "Invoices",
            verbs: ["read", "update"],
            scopes: [
              { id: "notes_only", label: "Notes only", verb: "update", tools: ["x.bill.create"] },
            ],
          },
        ],
      }),
    ).toEqual([
      "tool x.bill.create is a create, which entity bill doesn't list",
      "tool x.truck.query names entity truck, which the connector doesn't declare",
      "entity invoice: scope notes_only names x.bill.create, not one of its update tools",
    ]);
  });
});
