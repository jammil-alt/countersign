import { describe, expect, it } from "vitest";
import { cloneJson } from "../json";
import { manualView, readManual } from "../manual/manual";
import { AgentDefinition } from "../schemas/agent";
import {
  adjustableId,
  adjustValue,
  adjustView,
  applyAdjustValue,
  judgeAdjustment,
  onlyAdjusted,
  recordAdjustment,
  sameTarget,
} from "./adjust";
import {
  type AdjustableSetting,
  AdjustableSettings,
  type AdjustParameter,
  AdjustTarget,
  readAdjustable,
} from "./adjustable";

const tolerance: AdjustableSetting = {
  id: "param-tolerance",
  label: "Price tolerance (%)",
  hint: "",
  target: { kind: "parameter", skill: "materials.match", parameter: "tolerance", type: "number" },
  bounds: { min: "0", max: "5" },
  tighter: "lower",
};

const limit: AdjustableSetting = {
  id: "param-limit",
  label: "Approve bills over",
  hint: "",
  target: {
    kind: "parameter",
    skill: "materials.match",
    parameter: "limit",
    type: "money",
  },
  bounds: { min: "1000", max: "10000" },
  tighter: "lower",
};

const category: AdjustableSetting = {
  id: "param-category",
  label: "Category",
  hint: "",
  target: { kind: "parameter", skill: "materials.match", parameter: "category", type: "text" },
  bounds: { options: ["Lumber", "Hardware"] },
};

const schedule: AdjustableSetting = {
  id: "schedule-main-t1",
  label: "When it checks prices",
  hint: "",
  target: { kind: "schedule", workflow: "main", triggerId: "t1" },
  bounds: { options: ["0 7 * * 1-5", "0 7 * * 1"] },
};

function bundle() {
  return {
    definition: {
      skills: [
        {
          skill: "materials.match",
          settings: {},
          parameters: { tolerance: 2, limit: { amount: "5000.00", currency: "USD" } },
        },
      ],
      adjustable: [tolerance, limit, category, schedule],
    } as Record<string, unknown> & { skills: unknown[] },
    workflows: [
      {
        slug: "main",
        name: "Main",
        enabled: true,
        workflow: {
          schemaVersion: 5,
          triggers: [{ id: "t1", on: { type: "schedule", cron: "0 7 * * 1-5" } }],
          outputs: [],
          steps: [
            {
              id: "match",
              kind: "do",
              doneBy: "ai",
              name: "Match",
              uses: { type: "skill", skill: "materials.match" },
            },
            {
              id: "post",
              kind: "do",
              doneBy: "rules",
              name: "Post",
              uses: { type: "action", action: "qbo.bill.create" },
              checks: { approval: { required: "required" } },
            },
          ],
        },
      },
    ],
  };
}

describe("client-adjustable settings: the schema", () => {
  it("names only a skill parameter or a schedule: never an approval, a permission or a step", () => {
    expect(AdjustTarget.safeParse(tolerance.target).success).toBe(true);
    expect(AdjustTarget.safeParse(schedule.target).success).toBe(true);
    for (const kind of ["approval", "permission", "write", "step", "connector", "assignee"]) {
      expect(AdjustTarget.safeParse({ kind, stepId: "post" }).success).toBe(false);
    }
    // A bucket list is set in the builder, never by a client.
    expect(AdjustTarget.safeParse({ ...tolerance.target, type: "buckets" }).success).toBe(false);
  });

  it("travels in the definition, and a definition without it parses as it was", () => {
    const base = {
      schemaVersion: 2,
      identity: { name: "A", role: "", mission: "" },
      kind: "functional",
      model: { id: "m" },
      instructions: "",
      skills: [],
    };
    expect(AgentDefinition.parse(base)).not.toHaveProperty("adjustable");
    expect(AgentDefinition.parse({ ...base, adjustable: [tolerance] }).adjustable).toEqual([
      tolerance,
    ]);
    expect(AdjustableSettings.safeParse([{ ...tolerance, id: "Not An Id" }]).success).toBe(false);
  });

  it("reads leniently and gives stable ids", () => {
    expect(readAdjustable(undefined)).toEqual([]);
    expect(readAdjustable([{ nope: 1 }])).toEqual([]);
    expect(adjustableId(tolerance.target)).toBe("param-tolerance");
    expect(adjustableId(limit.target)).toBe("param-limit");
    // A target written for a step (an older agent's) still gets its own id.
    expect(adjustableId({ ...(limit.target as AdjustParameter), stepId: "match" })).toBe(
      "param-match-limit",
    );
    expect(adjustableId(schedule.target)).toBe("schedule-main-t1");
    expect(sameTarget(tolerance.target, { ...tolerance.target })).toBe(true);
    expect(sameTarget(tolerance.target, limit.target)).toBe(false);
    expect(sameTarget(schedule.target, tolerance.target)).toBe(false);
  });
});

describe("judgeAdjustment: bounds, tightening and requests", () => {
  it("applies a number within the bounds, either way", () => {
    expect(judgeAdjustment(tolerance, "4", 2)).toEqual({
      outcome: "apply",
      value: 4,
      text: "4",
      tightens: false,
    });
    expect(judgeAdjustment(tolerance, "1%", 2)).toMatchObject({ outcome: "apply", value: 1 });
    expect(judgeAdjustment(tolerance, "0", 2)).toMatchObject({ outcome: "apply", tightens: true });
    expect(judgeAdjustment(tolerance, "5", 2)).toMatchObject({ outcome: "apply" });
  });

  it("asks us for a number beyond the bounds on the looser side", () => {
    expect(judgeAdjustment(tolerance, "8", 2)).toEqual({
      outcome: "request",
      text: "8",
      reason: "It is outside what we set up: between 0 and 5.",
    });
  });

  it("applies a tightening past the bounds, and only a tightening", () => {
    const lowFloor = { ...tolerance, bounds: { min: "1", max: "5" } };
    expect(judgeAdjustment(lowFloor, "0.5", 2)).toMatchObject({
      outcome: "apply",
      tightens: true,
    });
    // Past the bound on the tighter side but looser than now (now is below it): a request.
    expect(judgeAdjustment(lowFloor, "0.8", 0.5)).toMatchObject({ outcome: "request" });
    // No tighter side: past the bounds is a request either way.
    expect(judgeAdjustment({ ...lowFloor, tighter: undefined }, "0.5", 2)).toMatchObject({
      outcome: "request",
    });
  });

  it("reads money in the currency it had, and refuses another", () => {
    const now = { amount: "5000.00", currency: "USD" };
    expect(judgeAdjustment(limit, "$2,500", now)).toEqual({
      outcome: "apply",
      value: { amount: "2500.00", currency: "USD" },
      text: "2500.00 USD",
      tightens: true,
    });
    expect(judgeAdjustment(limit, "20000", now)).toMatchObject({ outcome: "request" });
    expect(judgeAdjustment(limit, "2500 EUR", now)).toEqual({
      outcome: "invalid",
      reason: "Keep it in USD.",
    });
    expect(judgeAdjustment(limit, "lots", now)).toMatchObject({ outcome: "invalid" });
  });

  it("applies one of the options and asks us for anything else", () => {
    expect(judgeAdjustment(category, "hardware")).toMatchObject({
      outcome: "apply",
      value: "Hardware",
    });
    expect(judgeAdjustment(category, "Paint")).toMatchObject({
      outcome: "request",
      text: "Paint",
    });
  });

  it("applies a schedule from the allowed list and asks us for another", () => {
    expect(judgeAdjustment(schedule, "0 7 * * 1")).toMatchObject({
      outcome: "apply",
      value: "0 7 * * 1",
    });
    expect(judgeAdjustment(schedule, "every hour")).toMatchObject({ outcome: "request" });
  });

  it("refuses an empty or a wrong kind of value", () => {
    expect(judgeAdjustment(tolerance, "  ")).toMatchObject({ outcome: "invalid" });
    expect(judgeAdjustment(tolerance, "two")).toEqual({
      outcome: "invalid",
      reason: "Write a number.",
    });
    const date = {
      ...tolerance,
      bounds: undefined,
      target: { ...tolerance.target, type: "date" as const },
    };
    expect(judgeAdjustment(date, "2026-12-24")).toMatchObject({ outcome: "apply" });
    expect(judgeAdjustment(date, "soon")).toMatchObject({ outcome: "invalid" });
  });

  it("keeps a date within its limits (G11)", () => {
    const date = {
      target: { kind: "parameter" as const, skill: "s", parameter: "start", type: "date" as const },
      bounds: { earliest: "2026-12-01", latest: "2026-12-31" },
    };
    expect(judgeAdjustment(date, "2026-12-24")).toMatchObject({ outcome: "apply" });
    expect(judgeAdjustment(date, "2027-01-05")).toEqual({
      outcome: "request",
      text: "2027-01-05",
      reason: "It is outside what we set up: between 2026-12-01 and 2026-12-31.",
    });
    // Later is stricter here (a start put off): past the high limit and later than now applies.
    const later = { ...date, tighter: "higher" as const };
    expect(judgeAdjustment(later, "2027-01-05", "2026-12-10")).toMatchObject({
      outcome: "apply",
      tightens: true,
    });
    expect(judgeAdjustment(later, "2026-11-20", "2026-12-10")).toMatchObject({
      outcome: "request",
    });
  });
});

describe("applying an adjustment", () => {
  it("writes the agent's value or a schedule, and nothing else; a step has no values of its own", () => {
    const b = bundle();
    const a = applyAdjustValue(b, tolerance.target, 1);
    if (!a.ok) throw new Error(a.reason);
    expect(adjustValue(a.bundle, tolerance.target)).toBe(1);
    expect(adjustValue(b, tolerance.target)).toBe(2);
    expect(onlyAdjusted(b, a.bundle, tolerance.target)).toBe(true);

    const s = applyAdjustValue(b, limit.target, { amount: "2500.00", currency: "USD" });
    if (!s.ok) throw new Error(s.reason);
    expect(adjustValue(s.bundle, limit.target)).toEqual({ amount: "2500.00", currency: "USD" });
    expect(onlyAdjusted(b, s.bundle, limit.target)).toBe(true);
    expect(
      applyAdjustValue(b, { ...(limit.target as AdjustParameter), stepId: "match" }, 1),
    ).toMatchObject({ ok: false });

    const c = applyAdjustValue(b, schedule.target, "0 7 * * 1");
    if (!c.ok) throw new Error(c.reason);
    expect(adjustValue(c.bundle, schedule.target)).toBe("0 7 * * 1");
    expect(onlyAdjusted(b, c.bundle, schedule.target)).toBe(true);
  });

  it("says when what it changes is gone", () => {
    const b = bundle();
    expect(
      applyAdjustValue(b, { kind: "schedule", workflow: "main", triggerId: "gone" }, "x"),
    ).toMatchObject({ ok: false });
    expect(
      applyAdjustValue(b, { ...(tolerance.target as AdjustParameter), skill: "gone" }, 1),
    ).toMatchObject({
      ok: false,
    });
  });

  it("refuses the never class: any other change beside the setting is caught", () => {
    const b = bundle();
    const a = applyAdjustValue(b, tolerance.target, 1);
    if (!a.ok) throw new Error(a.reason);
    // An approval turned off on the way.
    const loosened = cloneJson(a.bundle);
    const post = loosened.workflows[0]?.workflow.steps[1] as { checks: unknown };
    post.checks = { approval: { required: "not_required" } };
    expect(onlyAdjusted(b, loosened, tolerance.target)).toBe(false);
    // A new write step.
    const widened = cloneJson(a.bundle);
    widened.workflows[0]?.workflow.steps.push({
      id: "x",
      kind: "write",
      name: "X",
      tool: "qbo.bill.update",
    } as never);
    expect(onlyAdjusted(b, widened, tolerance.target)).toBe(false);
    // A permission.
    const mode = cloneJson(a.bundle);
    mode.definition.permissions = { mode: "act" };
    expect(onlyAdjusted(b, mode, tolerance.target)).toBe(false);
    // The bounds themselves are ours.
    const bounds = cloneJson(a.bundle);
    bounds.definition.adjustable = [{ ...tolerance, bounds: { min: "0", max: "50" } }];
    expect(onlyAdjusted(b, bounds, tolerance.target)).toBe(false);
    // The manual's record of it is allowed.
    const noted = cloneJson(a.bundle);
    noted.definition.manual = recordAdjustment(
      undefined,
      tolerance,
      "1",
      { name: "Ada", side: "client" },
      "2026-11-19T10:00:00.000Z",
    );
    expect(onlyAdjusted(b, noted, tolerance.target)).toBe(true);
  });
});

describe("recordAdjustment: every change in the manual", () => {
  const at = "2026-11-19T10:00:00.000Z";

  it("adds a decision of its own: changed, by the person, when", () => {
    const m = recordAdjustment(undefined, tolerance, "1", { name: "Ada", side: "client" }, at);
    expect(m.decisions).toEqual([
      {
        id: "set-param-tolerance",
        what: "Price tolerance (%): 1",
        why: "Set by Ada on the agent's settings.",
        value: "1",
        kind: "client_setup",
        risk: "normal",
        status: "changed",
        by: "Ada",
        at,
        side: "client",
      },
    ]);
    expect(readManual(m)).toEqual(m);
    // A second change updates the same row.
    const again = recordAdjustment(m, tolerance, "3", { name: "Bo", side: "client" }, at);
    expect(again.decisions).toHaveLength(1);
    expect(again.decisions[0]).toMatchObject({ value: "3", by: "Bo" });
  });

  it("writes into the decision the setting is about, keeping its words", () => {
    const manual = {
      whatItDoes: "Checks prices.",
      decisions: [
        {
          id: "tol",
          what: "Prices within 2% pass",
          why: "The brief.",
          value: "2%",
          kind: "client_setup",
          risk: "normal",
          status: "never_discussed",
          by: null,
          at: null,
        },
      ],
      decisionPoints: [],
      knownRisks: [],
    };
    const m = recordAdjustment(
      manual,
      { ...tolerance, decisionId: "tol" },
      "1",
      { name: "Ada", side: "client" },
      at,
    );
    expect(m.whatItDoes).toBe("Checks prices.");
    expect(m.decisions).toHaveLength(1);
    expect(m.decisions[0]).toMatchObject({
      id: "tol",
      what: "Prices within 2% pass",
      value: "1",
      status: "changed",
      by: "Ada",
      at,
      side: "client",
    });
  });

  it("names the client's person in the portal's manual, never ours", () => {
    const b = bundle();
    const client = recordAdjustment(undefined, tolerance, "1", { name: "Ada", side: "client" }, at);
    const ours = recordAdjustment(client, category, "Lumber", { name: "Op", side: "operator" }, at);
    const view = manualView({
      agent: { id: "a", name: "A" },
      bundle: { ...b, definition: { ...b.definition, manual: ours } } as never,
      learned: [],
      audience: "client",
    });
    expect(view.decisions.map((d) => [d.by, d.side, d.statusWords])).toEqual([
      ["Ada", "client", "Changed"],
      [null, "operator", "Changed"],
    ]);
    const ops = manualView({
      agent: { id: "a", name: "A" },
      bundle: { ...b, definition: { ...b.definition, manual: ours } } as never,
      learned: [],
      audience: "operator",
    });
    expect(ops.decisions.map((d) => d.by)).toEqual(["Ada", "Op"]);
  });
});

describe("adjustView", () => {
  it("shows words, bounds and the value now, never the skill, parameter or step", () => {
    const b = bundle();
    const rows = adjustView(b, (t) =>
      t.kind === "parameter" && t.parameter === "category" ? "Lumber" : undefined,
    );
    expect(rows.map((r) => [r.id, r.kind, r.current])).toEqual([
      ["param-tolerance", "number", "2"],
      ["param-limit", "money", "5000.00 USD"],
      ["param-category", "text", "Lumber"],
      ["schedule-main-t1", "schedule", "0 7 * * 1-5"],
    ]);
    const text = JSON.stringify(rows);
    for (const hidden of ["materials.match", "stepId", "triggerId", '"skill"', '"parameter"']) {
      expect(text).not.toContain(hidden);
    }
  });

  it("says who changed one last: the client's person by name, ours as us", () => {
    const b = bundle();
    const at = "2026-11-19T10:00:00.000Z";
    let manual = recordAdjustment(undefined, tolerance, "1", { name: "Ada", side: "client" }, at);
    manual = recordAdjustment(manual, category, "Lumber", { name: "Op", side: "operator" }, at);
    const withManual = { ...b, definition: { ...b.definition, manual } };
    const rows = adjustView(withManual);
    expect(rows[0]).toMatchObject({ changedBy: "Ada", changedSide: "client", changedAt: at });
    expect(rows[2]).toMatchObject({ changedBy: null, changedSide: "operator", changedAt: at });
    expect(rows[1]).toMatchObject({ changedBy: null, changedSide: null, changedAt: null });
    expect(adjustView(withManual, undefined, "operator")[2]?.changedBy).toBe("Op");
  });
});
