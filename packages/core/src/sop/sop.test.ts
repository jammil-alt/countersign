import { describe, expect, it } from "vitest";
import { FORBIDDEN_PORTAL_FIELD } from "../api/contract";
import { effectiveMode } from "../lifecycle/stage";
import { decideToolCall } from "../permissions/decide";
import type { AnyAgentBundle } from "../schemas/agent";
import type { SkillDefinition } from "../schemas/skill";
import { runModel } from "../skills/model";
import { moneyWords, pathWords, sopView } from "./build";
import { sopChanges, sopFingerprint } from "./changes";
import { ADA, BEN, bundle, CARA, input, SKILLS } from "./fixtures.test-helper";
import { type SopStepLine, SopView } from "./view";

// The agent's SOP (docs/sop-plan.md): made by code from the setup, so these test it against the
// gate's own decision and the runtime's own model rule, not against copies of them.

const step = (view: SopView, id: string) =>
  view.procedure.find((l): l is SopStepLine => l.line === "step" && l.id === id) as SopStepLine;

describe("the agent's SOP, made by code (docs/sop-plan.md)", () => {
  it("parses, numbers the steps with the path's step under its if, and never carries the bundle", () => {
    const view = sopView(input());
    expect(SopView.parse(view)).toBeTruthy();
    expect(view.code).toBe("SOP-PUR-03");
    expect(view.procedure.map((l) => (l.line === "step" ? l.number : `${l.label}`))).toEqual([
      "1",
      "2",
      "3",
      "4",
      "if",
      "4 A1",
      "otherwise",
      "5",
      "6",
    ]);
    const json = JSON.stringify(view);
    expect(json).not.toContain("SECRET INSTRUCTIONS");
    expect(json).not.toContain("operator detail");
    const keys = new Set<string>();
    const walk = (v: unknown) => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object")
        for (const [k, x] of Object.entries(v)) {
          keys.add(k);
          walk(x);
        }
    };
    walk(view);
    for (const k of keys) expect(FORBIDDEN_PORTAL_FIELD.test(k), k).toBe(false);
  });

  it("says how each step works, and names the model the runtime would call", () => {
    const view = sopView(input());
    expect(step(view, "read").method).toBe("ai");
    expect(step(view, "read").model).toBe("Claude Sonnet 5.5");
    expect(step(view, "vendor").method).toBe("rules");
    expect(step(view, "vendor").model).toBeNull();
    expect(step(view, "match").method).toBe("rules_then_ai");
    expect(step(view, "match").model).toBe("Claude Haiku 5.5");
    expect(step(view, "review").method).toBe("person");
    expect(view.summary).toMatchObject({
      steps: 7,
      ai: 1,
      rulesThenAi: 1,
      person: 1,
      writesByRules: true,
    });
    // The runtime's own rule picks the same model.
    const m = runModel({
      agentModel: { id: "claude-sonnet-5-5" },
      skill: SKILLS["builtin:match-lines@1"] as SkillDefinition,
    });
    expect(m.id).toBe("claude-haiku-5-5");
  });

  it("names a step's doer only when it isn't the agent, and leaves the agent out of the people table", () => {
    const view = sopView(input());
    expect(step(view, "read").who).toBeNull();
    expect(step(view, "review").who?.name).toBe("Cara Lin");
    expect(view.matrix.parties.map((p) => p.name)).not.toContain("Bills in");
    expect(view.matrix.parties.map((p) => p.name)).toEqual(
      expect.arrayContaining(["Pia", "Cara Lin", "Ada Ruiz", "Ben Ortiz"]),
    );
  });

  it("uses the step's purpose, else a plain line made by code", () => {
    const view = sopView(input());
    expect(step(view, "vendor").purpose).toBe(
      "Looks the vendor up so the bill goes to the right vendor.",
    );
    expect(step(view, "vendor").purposeWritten).toBe(true);
    expect(step(view, "create").purposeWritten).toBe(false);
    expect(step(view, "create").purpose).toBe("Adds bills to QuickBooks Online.");
  });

  it("names approvers in routing order: the client's rule with an amount, then the step's approver", () => {
    const view = sopView(input());
    const create = step(view, "create");
    expect(create.approval?.level).toBe("ask");
    expect(create.approval?.approvers).toEqual([
      { party: { key: ADA, kind: "person", name: "Ada Ruiz" }, condition: "over $5,000" },
      { party: { key: BEN, kind: "person", name: "Ben Ortiz" }, condition: "up to $5,000" },
    ]);
    expect(
      view.controls.some((c) => c.name === "Changes over $5,000 need Ada Ruiz's approval"),
    ).toBe(true);
  });

  it("agrees with the gate for every mode, stage, matrix level, grant and step setting", () => {
    const levels = ["auto", "approval", "off"] as const;
    for (const stage of ["bench", "trial", "signoff", "live"]) {
      for (const mode of ["act", "suggest_only"] as const) {
        for (const update of levels) {
          for (const grant of [null, { verbs: { update: "approval" as const } }]) {
            for (const attach of ["required", "not_required"] as const) {
              const matrix = {
                read: "auto" as const,
                create: "approval" as const,
                update,
                delete: "off" as const,
              };
              const view = sopView(
                input({ stage, matrix, grant, b: bundle({ attachApproval: attach, mode }) }),
              );
              const gate = decideToolCall({
                sideEffect: "external",
                verb: "update",
                matrix,
                grant,
                stepApproval: attach,
                agentMode: effectiveMode({ permissions: { mode } }, stage),
              });
              const want = gate === "run" ? "auto" : gate === "approval" ? "ask" : "off";
              expect(
                step(view, "attach").approval?.level,
                `${stage} ${mode} ${update} ${JSON.stringify(grant)} ${attach}`,
              ).toBe(want);
            }
          }
        }
      }
    }
  });

  it("lists the systems with what the agent may do, and the data with where it lives", () => {
    const view = sopView(input());
    expect(view.systems).toHaveLength(1);
    expect(view.systems[0]).toMatchObject({
      id: "S1",
      name: "QuickBooks Online",
      read: "auto",
      create: "ask",
      update: "auto",
      delete: "off",
    });
    expect(view.data.map((d) => d.livesIn)).toEqual(
      expect.arrayContaining(["Your QuickBooks Online", "Your records in Mezonas: Purchasing"]),
    );
    expect(
      view.data.find((d) => d.record === "Bill" && d.livesIn === "Your records in Mezonas")
        ?.readByAi,
    ).toBe("Step 1, Claude Sonnet 5.5");
  });

  it("shows nothing that waits on anyone: decisions say who set them, never a status", () => {
    const view = sopView(input());
    expect(view.decisions[0]).toMatchObject({
      what: "Freight lines stay out of the catalog",
      setBy: "Us",
      step: "3",
    });
    expect(JSON.stringify(view)).not.toMatch(/never_discussed|Never discussed|Waiting on you/);
    expect(view.scope.notCovered).toEqual(["Bills in another currency. A person handles it."]);
  });

  it("makes a new revision exactly when what the SOP says changes, and says what changed", async () => {
    const before = sopView(input());
    const same = sopView(
      input({ asOf: "2026-12-01T00:00:00.000Z", measures: [{ label: "x", value: "9" }] }),
    );
    expect(await sopFingerprint(same)).toBe(await sopFingerprint(before));

    const after = sopView(
      input({ matrix: { read: "auto", create: "approval", update: "approval", delete: "off" } }),
    );
    expect(await sopFingerprint(after)).not.toBe(await sopFingerprint(before));
    const words = sopChanges(before, after).map(
      (c) => `${c.words}${c.was ? ` (was ${c.was})` : ""}`,
    );
    expect(words).toContain("Step 6, Attach the PDF: Ask me first (was On its own)");
    expect(words).toContain("QuickBooks Online update: Ask me first (was On its own)");
    expect(sopChanges(null, before)[0]?.words).toBe("First recorded revision of this SOP.");
  });

  it("says a paused agent is paused, without a new revision for the pause or the resume", async () => {
    const live = sopView(input());
    expect(live.paused).toBe(false);
    const base = input();
    const paused = sopView({ ...base, agent: { ...base.agent, runStatus: "paused" } });
    expect(paused.paused).toBe(true);
    expect(paused.stage).toEqual({ id: "live", words: "Live" });
    expect(await sopFingerprint(paused)).toBe(await sopFingerprint(live));
    // A view stored before `paused` existed reads as not paused.
    const { paused: _p, ...stored } = live;
    expect(SopView.parse(stored).paused).toBe(false);
  });

  it("writes money by string, never a float", () => {
    expect(moneyWords("5000.00", "USD")).toBe("$5,000");
    expect(moneyWords("1234567.5", "EUR")).toBe("€1,234,567.50");
    expect(moneyWords("10", "CHF")).toBe("CHF 10");
  });

  it("words a path's rules over a template field and a symbol", () => {
    expect(
      pathWords({
        name: "Matched",
        when: {
          match: "all",
          rules: [{ field: "{{steps.find.output.match_status}}", op: "=", value: "matched" }],
        },
      }),
    ).toBe("match status is matched");
    expect(
      pathWords({ name: "Big", describe: "a bill over $5,000", when: { match: "all", rules: [] } }),
    ).toBe("a bill over $5,000");
  });

  it("walks an if inside an if's path, numbering on from it", () => {
    const b = bundle() as unknown as { workflows: { workflow: { steps: unknown[] } }[] };
    const look = b.workflows[0]?.workflow.steps[3] as { paths: { steps: unknown[] }[] };
    look.paths[0]?.steps.push({
      id: "inner",
      name: "Which price?",
      kind: "if",
      paths: [
        {
          id: "ip",
          name: "High",
          when: { match: "all", rules: [] },
          steps: [
            {
              id: "deep",
              name: "Tell Cara",
              kind: "notify",
              notify: { to: [CARA], channel: "inbox", message: "x" },
            },
          ],
        },
      ],
      otherwise: { id: "io", steps: [] },
    });
    const view = sopView(input({ b: b as unknown as AnyAgentBundle }));
    const numbers = view.procedure
      .filter((l): l is SopStepLine => l.line === "step")
      .map((l) => `${l.number} ${l.name}`);
    expect(numbers).toContain("4 A2 Which price?");
    expect(numbers).toContain("4 A2 A1 Tell Cara");
    // The paths' letters, as on the chart: A, then Otherwise as B.
    expect(
      view.procedure.flatMap((l) => (l.line === "path" ? [`${l.depth}${l.letter}`] : [])),
    ).toEqual(["1A", "2A", "2B", "1B"]);
    expect(step(view, "deep").told.map((p) => p.name)).toEqual(["Cara Lin"]);
  });

  it("outlines the process for the chart: every step once, with its line, place and paths", async () => {
    const view = sopView(input());
    const lines = view.procedure.filter((l): l is SopStepLine => l.line === "step");
    // Every outline step has its step line (the chart's card), with the same number, in run order.
    expect(view.outline.map((o) => `${o.number} ${o.id}`)).toEqual(
      lines.map((l) => `${l.number} ${l.id}`),
    );
    const look = view.outline.find((o) => o.id === "look");
    expect(look?.kind).toBe("if");
    expect(look?.paths?.map((p) => `${p.letter}${p.otherwise ? " otherwise" : ""}`)).toEqual([
      "A",
      "B otherwise",
    ]);
    // A path's step sits in that path, as the builder names its containers.
    const first = look?.paths?.[0];
    const inPath = view.outline.find((o) => o.number === "4 A1");
    expect(inPath?.container).toBe(`path:${first?.id}`);
    expect(inPath?.depth).toBe(1);
    expect(view.outline.find((o) => o.number === "1")?.container).toBe("root");
    // Only these fields: no tool, skill, prompt or anything else of the bundle's.
    for (const o of view.outline) {
      expect(Object.keys(o).sort()).toEqual(
        ["container", "depth", "id", "kind", "number", "paths", "workflow"].sort(),
      );
    }
    // The outline repeats the procedure's shape: it never makes a revision on its own.
    expect(await sopFingerprint({ ...view, outline: [] })).toBe(await sopFingerprint(view));
  });

  it("says a new way of writing SOPs once, without listing changes nobody made", () => {
    const now = sopView(input());
    const older = { ...now, format: now.format - 1, purpose: "Old words" };
    expect(sopChanges(older, now)).toEqual([
      {
        section: "header",
        ref: null,
        words: "We changed how SOPs are written. How the agent works is the same.",
        was: null,
      },
    ]);
  });
});
