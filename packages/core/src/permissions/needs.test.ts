// Connectors C1 (docs/connectors-plan.md §4): an agent's needs from its steps, the gaps against a
// client's connections, and the matrix that allows exactly what it needs.

import { describe, expect, it } from "vitest";
import type { Step } from "../process/schema";
import type { PermissionEntity, PermissionMatrix } from "../schemas/permissions";
import { SkillDefinition, SkillNeed } from "../schemas/skill";
import type { ToolSpec } from "../schemas/tool";
import { decideToolCall } from "./decide";
import {
  type AccessState,
  accessGaps,
  agentNeeds,
  allowNeeds,
  type ConnectorNeed,
  needsMet,
  skillNeeds,
  uncoveredConnectors,
} from "./needs";

const spec = (t: Partial<ToolSpec> & Pick<ToolSpec, "id" | "sideEffect" | "source">): ToolSpec =>
  ({
    description: "",
    input: { type: "object" },
    output: { type: "object" },
    verb: t.sideEffect === "none" ? "read" : "create",
    ...t,
  }) as ToolSpec;

const tools: Record<string, ToolSpec> = {
  "qbo.bill.query": spec({
    id: "qbo.bill.query",
    sideEffect: "none",
    source: "qbo",
    entity: "bill",
  }),
  "qbo.vendor.query": spec({
    id: "qbo.vendor.query",
    sideEffect: "none",
    source: "qbo",
    entity: "vendor",
  }),
  "qbo.bill.create": spec({
    id: "qbo.bill.create",
    sideEffect: "external",
    source: "qbo",
    connector: "qbo",
    entity: "bill",
  }),
  "qbo.vendor.create": spec({
    id: "qbo.vendor.create",
    sideEffect: "external",
    source: "qbo",
    connector: "qbo",
    entity: "vendor",
  }),
  "qbo.invoice.add_note": spec({
    id: "qbo.invoice.add_note",
    sideEffect: "external",
    source: "qbo",
    connector: "qbo",
    verb: "update",
    entity: "invoice",
  }),
  "billcom.bill.create": spec({
    id: "billcom.bill.create",
    sideEffect: "external",
    source: "billcom",
    connector: "billcom",
    entity: "bill",
  }),
  "billcom.vendor.create": spec({
    id: "billcom.vendor.create",
    sideEffect: "external",
    source: "billcom",
    connector: "billcom",
    entity: "vendor",
  }),
  "gmail.send": spec({
    id: "gmail.send",
    sideEffect: "external",
    source: "gmail",
    connector: "gmail",
    approval: "always",
  }),
  "materials.catalog.create_item": spec({
    id: "materials.catalog.create_item",
    sideEffect: "internal",
    source: "materials",
  }),
  "web.search": spec({ id: "web.search", sideEffect: "none", source: "platform" }),
};

const QBO_ENTITIES: PermissionEntity[] = [
  { id: "bill", label: "Bills", verbs: ["read", "create", "update"] },
  { id: "vendor", label: "Vendors", verbs: ["read", "create"] },
  {
    id: "invoice",
    label: "Invoices",
    verbs: ["read", "update"],
    scopes: [
      { id: "notes_only", label: "Notes only", verb: "update", tools: ["qbo.invoice.add_note"] },
    ],
  },
];

const skill = (s: Partial<SkillDefinition>): SkillDefinition =>
  ({
    schemaVersion: 1,
    id: "custom:skill",
    name: "Skill",
    description: "",
    category: "purchasing",
    mode: "task",
    instructions: "",
    tools: [],
    input: { type: "object" },
    output: { type: "object" },
    settings: [],
    requiresConnectors: [],
    requiresPacks: [],
    producesAlerts: false,
    ...s,
  }) as SkillDefinition;

const skills: Record<string, SkillDefinition> = {
  "custom:read-bills": skill({
    id: "custom:read-bills",
    tools: ["qbo.bill.query", "web.search", "materials.catalog.create_item"],
    reads: ["qbo.vendor.query"],
  }),
  "custom:vendors": skill({
    id: "custom:vendors",
    tools: ["qbo.vendor.create"],
    needs: [{ connector: "slack", verb: "create", why: "to post the new vendor" }],
  }),
  "custom:old": skill({ id: "custom:old", requiresConnectors: ["hubspot"] }),
};

const ctx = { tools, skills, connectors: new Set(["qbo", "billcom", "gmail", "slack", "hubspot"]) };

const step = (s: Partial<Step> & Pick<Step, "id" | "kind">): Step =>
  ({ name: s.id, input: {}, ...s }) as Step;

const auto = { checks: { approval: { required: "not_required" } } } as Partial<Step>;

function bundle(steps: Step[], mode: "act" | "suggest_only" = "act") {
  return {
    definition: { permissions: { mode } },
    workflows: [{ slug: "buy", workflow: { schemaVersion: 4, steps } }],
  };
}

const pick = (needs: ConnectorNeed[], connector: string, verb: string, entity?: string) =>
  needs.find((n) => n.connector === connector && n.verb === verb && n.entity === entity);

describe("SkillDefinition.needs", () => {
  it("is optional, so stored skills parse as they were", () => {
    const parsed = SkillDefinition.parse(skill({ model: { id: "claude-haiku-5-5" } }));
    expect(parsed.needs).toBeUndefined();
  });

  it("names a connector, a verb, a record type and why; never delete", () => {
    expect(SkillNeed.safeParse({ connector: "qbo", verb: "read", why: "x" }).success).toBe(true);
    expect(
      SkillNeed.safeParse({ connector: "qbo", verb: "delete", entity: "bill", why: "x" }).success,
    ).toBe(false);
    expect(SkillNeed.safeParse({ connector: "qbo", verb: "read", why: "" }).success).toBe(false);
  });
});

describe("skillNeeds", () => {
  it("are its tools' and reads' needs; platform, pack and internal tools need nothing", () => {
    const needs = skillNeeds(skills["custom:read-bills"] as SkillDefinition, ctx);
    expect(needs).toEqual([
      { connector: "qbo", verb: "read", entity: "bill", tool: "qbo.bill.query" },
      { connector: "qbo", verb: "read", entity: "vendor", tool: "qbo.vendor.query" },
    ]);
  });

  it("adds what the skill declares", () => {
    const needs = skillNeeds(skills["custom:vendors"] as SkillDefinition, ctx);
    expect(needs).toContainEqual({
      connector: "slack",
      verb: "create",
      why: "to post the new vendor",
    });
  });

  it("reads a connector only in requiresConnectors as a read on it", () => {
    const old = skills["custom:old"] as SkillDefinition;
    expect(skillNeeds(old, ctx)).toEqual([{ connector: "hubspot", verb: "read" }]);
    expect(uncoveredConnectors(old, ctx)).toEqual(["hubspot"]);
    const covered = skill({ tools: ["qbo.bill.query"], requiresConnectors: ["qbo"] });
    expect(uncoveredConnectors(covered, ctx)).toEqual([]);
    expect(skillNeeds(covered, ctx)).toHaveLength(1);
  });
});

describe("agentNeeds", () => {
  it("collects reads, writes and skills, each with the steps it comes from", () => {
    const needs = agentNeeds(
      bundle([
        step({ id: "r1", kind: "read", tool: "qbo.bill.query" } as Partial<Step> as Step),
        step({ id: "s1", kind: "skill", skill: "custom:read-bills" } as Partial<Step> as Step),
        step({ id: "w1", kind: "write", tool: "qbo.bill.create" } as Partial<Step> as Step),
      ]),
      ctx,
    );
    const bills = pick(needs, "qbo", "read", "bill");
    expect(bills?.level).toBe("on");
    expect(bills?.because.map((b) => b.stepId)).toEqual(["r1", "s1"]);
    const create = pick(needs, "qbo", "create", "bill");
    expect(create).toMatchObject({ level: "ask", wantsAuto: false, tool: "qbo.bill.create" });
  });

  // Connectors C4: a record tool whose input names the type (Odoo's, HubSpot's) needs the type the
  // step's input names plainly; one left to a template stays on the verb alone.
  it("reads the record type a step's input names for a tool that takes it from its input", () => {
    const odoo = {
      ...ctx,
      tools: {
        ...tools,
        "odoo.record.update": spec({
          id: "odoo.record.update",
          sideEffect: "external",
          source: "odoo",
          connector: "odoo",
          verb: "update",
          entityInput: { field: "model", values: { "purchase.order": "purchase_order" } },
        }),
      },
      connectors: new Set([...ctx.connectors, "odoo"]),
    };
    const write = (id: string, model: string) =>
      step({
        id,
        kind: "write",
        tool: "odoo.record.update",
        input: { model, id: "7" },
      } as Partial<Step> as Step);
    const needs = agentNeeds(
      bundle([write("w1", "purchase.order"), write("w2", "{{trigger.model}}")]),
      odoo,
    );
    expect(pick(needs, "odoo", "update", "purchase_order")?.because.map((b) => b.stepId)).toEqual([
      "w1",
    ]);
    expect(pick(needs, "odoo", "update")?.because.map((b) => b.stepId)).toEqual(["w2"]);
  });

  it("wants auto only for a write step set to skip approval in an act agent", () => {
    const steps = [
      step({ id: "w1", kind: "write", tool: "qbo.bill.create", ...auto } as Partial<Step> as Step),
      step({ id: "w2", kind: "write", tool: "gmail.send", ...auto } as Partial<Step> as Step),
      step({ id: "r1", kind: "read", tool: "qbo.vendor.query", ...auto } as Partial<Step> as Step),
    ];
    const act = agentNeeds(bundle(steps, "act"), ctx);
    expect(pick(act, "qbo", "create", "bill")?.wantsAuto).toBe(true);
    // A verb a person always signs never runs on its own; a read has nothing to skip.
    expect(pick(act, "gmail", "create")?.wantsAuto).toBe(false);
    expect(pick(act, "qbo", "read", "vendor")?.wantsAuto).toBe(false);
    const suggest = agentNeeds(bundle(steps, "suggest_only"), ctx);
    expect(pick(suggest, "qbo", "create", "bill")?.wantsAuto).toBe(false);
  });

  it("makes an action without via one need per connector, as alternatives", () => {
    const needs = agentNeeds(
      bundle([step({ id: "a1", kind: "write", action: "create_bill" } as Partial<Step> as Step)]),
      ctx,
    );
    expect(needs.map((n) => [n.connector, n.anyOf])).toEqual([
      ["qbo", "buy/a1"],
      ["billcom", "buy/a1"],
    ]);
    const via = agentNeeds(
      bundle([
        step({
          id: "a1",
          kind: "write",
          action: "create_bill",
          via: "qbo",
        } as Partial<Step> as Step),
      ]),
      ctx,
    );
    expect(via.map((n) => [n.connector, n.anyOf])).toEqual([["qbo", undefined]]);
  });

  it("walks inside forks and loops, and v4 automations with this agent's overrides", () => {
    const fork = step({
      id: "f1",
      kind: "if",
      paths: [
        {
          id: "p1",
          when: [],
          steps: [
            step({ id: "in", kind: "read", tool: "qbo.bill.query" } as Partial<Step> as Step),
          ],
        },
      ],
      otherwise: { id: "o1", steps: [] },
    } as unknown as Step);
    const use = step({
      id: "u1",
      kind: "process",
      process: "vendor-setup@1",
      approvals: { v1: { required: "not_required" } },
    } as unknown as Step);
    const needs = agentNeeds(bundle([fork, use]), {
      ...ctx,
      automations: {
        "vendor-setup@1": {
          schemaVersion: 2,
          slug: "vendor-setup",
          name: "Vendor setup",
          steps: [
            step({ id: "v1", kind: "write", tool: "qbo.vendor.create" } as Partial<Step> as Step),
          ],
        } as never,
      },
    });
    expect(pick(needs, "qbo", "read", "bill")?.because[0]?.stepId).toBe("in");
    expect(pick(needs, "qbo", "create", "vendor")).toMatchObject({ wantsAuto: true });
  });

  it("skips stored v3 workflows (callers read them as processes first)", () => {
    expect(
      agentNeeds(
        {
          definition: { permissions: { mode: "act" } },
          workflows: [{ slug: "old", workflow: { schemaVersion: 3, steps: [] } }],
        },
        ctx,
      ),
    ).toEqual([]);
  });
});

// ── Gaps ─────────────────────────────────────────────────────────────────────────────────────

const need = (
  n: Partial<ConnectorNeed> & Pick<ConnectorNeed, "connector" | "verb">,
): ConnectorNeed => ({
  level: n.verb === "read" ? "on" : "ask",
  wantsAuto: false,
  why: [],
  because: [],
  ...n,
});

const READ_BILLS = need({ connector: "qbo", verb: "read", entity: "bill", tool: "qbo.bill.query" });
const CREATE_VENDOR = need({
  connector: "qbo",
  verb: "create",
  entity: "vendor",
  tool: "qbo.vendor.create",
});

const qbo = (permissions: Partial<PermissionMatrix>, status = "connected") => ({
  id: "c-qbo",
  connector: "qbo",
  status,
  permissions,
});

const declared = { qbo: QBO_ENTITIES };

describe("accessGaps", () => {
  it("says not connected, broken or not bound, once per connector", () => {
    expect(
      accessGaps([READ_BILLS, CREATE_VENDOR], { connections: [], bindings: {} }).map((g) => [
        g.kind,
        g.needs.length,
        g.fixBy,
      ]),
    ).toEqual([["not_connected", 2, "client"]]);
    expect(
      accessGaps([READ_BILLS], { connections: [qbo({}, "error")], bindings: {} })[0],
    ).toMatchObject({ kind: "broken", connectionId: "c-qbo", fixBy: "client" });
    expect(accessGaps([READ_BILLS], { connections: [qbo({})], bindings: {} })[0]).toMatchObject({
      kind: "not_bound",
      fixBy: "mezonas",
    });
  });

  it("with no agent yet (a template), any connection of the connector counts", () => {
    expect(accessGaps([READ_BILLS], { connections: [qbo({})] })).toEqual([]);
  });

  it("finds a row the connection turns off, by verb or by record type", () => {
    const state = (m: Partial<PermissionMatrix>): AccessState => ({
      connections: [qbo(m)],
      bindings: { qbo: "c-qbo" },
      declared,
    });
    expect(accessGaps([CREATE_VENDOR], state({ create: "approval" }))).toEqual([]);
    const byVerb = accessGaps([CREATE_VENDOR], state({ create: "off" }));
    expect(byVerb.map((g) => [g.kind, g.fixBy])).toEqual([["off_on_connection", "client"]]);
    const byEntity = accessGaps(
      [CREATE_VENDOR, READ_BILLS],
      state({ create: "approval", entities: { vendor: { create: "off" } } }),
    );
    expect(byEntity.map((g) => [g.kind, g.needs.map((n) => n.tool)])).toEqual([
      ["off_on_connection", ["qbo.vendor.create"]],
    ]);
  });

  it("tells a scope that leaves the tool out from a row turned off", () => {
    const fix = need({
      connector: "qbo",
      verb: "update",
      entity: "invoice",
      tool: "qbo.invoice.fix",
    });
    const note = need({
      connector: "qbo",
      verb: "update",
      entity: "invoice",
      tool: "qbo.invoice.add_note",
    });
    const gaps = accessGaps([fix, note], {
      connections: [
        qbo({ update: "approval", entities: { invoice: { scope: { update: "notes_only" } } } }),
      ],
      bindings: { qbo: "c-qbo" },
      declared,
    });
    expect(gaps.map((g) => [g.kind, g.needs.map((n) => n.tool)])).toEqual([
      ["scope_excludes", ["qbo.invoice.fix"]],
    ]);
  });

  it("finds the agent's grant turning a row off or leaving the tool out", () => {
    const base = { connections: [qbo({})], bindings: { qbo: "c-qbo" }, declared };
    expect(
      accessGaps([CREATE_VENDOR], {
        ...base,
        grants: { "c-qbo": { verbs: { create: "off" } } },
      })[0],
    ).toMatchObject({ kind: "off_in_grant", fixBy: "mezonas" });
    expect(
      accessGaps([CREATE_VENDOR], {
        ...base,
        grants: { "c-qbo": { tools: ["qbo.bill.query"] } },
      })[0],
    ).toMatchObject({ kind: "off_in_grant" });
  });

  it("suggests, without blocking, where a step would run on its own but will ask", () => {
    const wants = { ...CREATE_VENDOR, wantsAuto: true };
    const gaps = accessGaps([wants], {
      connections: [qbo({})],
      bindings: { qbo: "c-qbo" },
      declared,
    });
    expect(gaps).toMatchObject([{ kind: "could_run_alone", blocking: false, fixBy: "mezonas" }]);
    expect(needsMet(gaps)).toBe(true);
    expect(
      accessGaps([wants], {
        connections: [qbo({ create: "auto" })],
        bindings: { qbo: "c-qbo" },
        declared,
      }),
    ).toEqual([]);
  });

  it("meets an anyOf group when one of its connectors does", () => {
    const viaQbo = need({
      connector: "qbo",
      verb: "create",
      entity: "bill",
      tool: "qbo.bill.create",
      anyOf: "buy/a1",
    });
    const viaBill = need({
      connector: "billcom",
      verb: "create",
      entity: "bill",
      tool: "billcom.bill.create",
      anyOf: "buy/a1",
    });
    expect(
      accessGaps([viaQbo, viaBill], { connections: [qbo({})], bindings: { qbo: "c-qbo" } }),
    ).toEqual([]);
    const none = accessGaps([viaQbo, viaBill], { connections: [], bindings: {} });
    expect(none.map((g) => g.connector)).toEqual(["billcom", "qbo"]);
    expect(needsMet(none)).toBe(false);
  });

  it("agrees with the gate: no blocking gap means no call is refused", () => {
    const matrix: Partial<PermissionMatrix> = {
      create: "approval",
      entities: { vendor: { create: "approval" }, bill: { create: "off" } },
    };
    const gaps = accessGaps([CREATE_VENDOR], {
      connections: [qbo(matrix)],
      bindings: { qbo: "c-qbo" },
      declared,
    });
    expect(needsMet(gaps)).toBe(true);
    const decision = decideToolCall({
      sideEffect: "external",
      verb: "create",
      matrix,
      agentMode: "act",
      entity: { tool: { id: "qbo.vendor.create", entity: "vendor" }, declared: QBO_ENTITIES },
    });
    expect(decision).toBe("approval");
  });
});

// ── Allowing what an agent needs ─────────────────────────────────────────────────────────────

describe("allowNeeds", () => {
  const LOW_RISK: Partial<PermissionMatrix> = {
    read: "auto",
    create: "off",
    update: "off",
    delete: "off",
  };

  it("opens exactly the needed rows at Needs approval, pinning the rest of the verb off", () => {
    const r = allowNeeds(LOW_RISK, [CREATE_VENDOR], QBO_ENTITIES);
    expect(r.matrix.create).toBe("approval");
    expect(r.matrix.entities).toEqual({ bill: { create: "off" } });
    expect(r.allowed).toEqual([{ verb: "create" }]);
    expect(r.unresolved).toEqual([]);
    // The result meets the need, and a bill still can't be created.
    const state = (m: PermissionMatrix): AccessState => ({
      connections: [qbo(m)],
      bindings: { qbo: "c-qbo" },
      declared,
    });
    expect(accessGaps([CREATE_VENDOR], state(r.matrix))).toEqual([]);
    const bill = need({
      connector: "qbo",
      verb: "create",
      entity: "bill",
      tool: "qbo.bill.create",
    });
    expect(accessGaps([bill], state(r.matrix))[0]?.kind).toBe("off_on_connection");
  });

  it("opens a record type the matrix turned off, and never sets auto", () => {
    const r = allowNeeds(
      { create: "approval", entities: { vendor: { create: "off" } } },
      [{ ...CREATE_VENDOR, wantsAuto: true }],
      QBO_ENTITIES,
    );
    expect(r.matrix.entities).toEqual({ vendor: { create: "approval" } });
    expect(r.allowed).toEqual([{ verb: "create", entity: "vendor" }]);
  });

  it("turns a read on, and leaves a met need alone", () => {
    const r = allowNeeds({ read: "off" }, [READ_BILLS], QBO_ENTITIES);
    expect(r.matrix.read).toBe("auto");
    expect(r.matrix.entities).toEqual({ vendor: { read: "off" }, invoice: { read: "off" } });
    const same = allowNeeds({ read: "auto" }, [READ_BILLS], QBO_ENTITIES);
    expect(same.allowed).toEqual([]);
    expect(same.matrix.entities).toBeUndefined();
  });

  it("leaves a scope that excludes the tool, and delete, unresolved", () => {
    const fix = need({
      connector: "qbo",
      verb: "update",
      entity: "invoice",
      tool: "qbo.invoice.fix",
    });
    const r = allowNeeds(
      { update: "approval", entities: { invoice: { scope: { update: "notes_only" } } } },
      [fix, need({ connector: "qbo", verb: "delete", entity: "bill" })],
      QBO_ENTITIES,
    );
    expect(r.unresolved.map((n) => n.verb)).toEqual(["update", "delete"]);
    expect(r.matrix.delete).toBe("off");
  });

  it("doesn't change the matrix it was given", () => {
    const before: Partial<PermissionMatrix> = {
      create: "off",
      entities: { bill: { read: "auto" } },
    };
    const copy = JSON.parse(JSON.stringify(before)) as typeof before;
    allowNeeds(before, [CREATE_VENDOR], QBO_ENTITIES);
    expect(before).toEqual(copy);
  });
});
