// The agent manual (docs/builder-plan.md §5, B3): its schema on the definition (old bundles parse
// and hash unchanged), "How it works" from the process by code, decision points, filling it from a
// build, the step's never-discussed decisions, the client-safe view, and diff and merge treating it
// as a field.
import { describe, expect, it } from "vitest";
import { forbiddenPortalFields } from "../api/contract";
import { Decision } from "../build/build";
import { diffBundles } from "../bundle/diff";
import { mergeBundles } from "../bundle/merge";
import { bundleHash } from "../canonical";
import { AgentBundle } from "../schemas/agent";
import { bundle, edit } from "../testing/fixtures";
import {
  AgentManual,
  decisionPointsOf,
  fillManual,
  howItWorks,
  inSentence,
  ManualView,
  manualView,
  readSetupLines,
  readUndiscussed,
  riskHits,
  riskWords,
  undiscussedFor,
  whatItDoesFrom,
  whoWords,
} from "./manual";

const decision = (over: Partial<Decision> & { id: string; what: string }): Decision =>
  Decision.parse({ kind: "assumption", ...over });

/** A v4 bundle: read, an if with a write inside, a person step, a write with approval off. */
function processBundle(): AgentBundle {
  return AgentBundle.parse({
    schemaVersion: 1,
    definition: {
      schemaVersion: 2,
      identity: { name: "Invoice intake", role: "AP", mission: "Keep the books right" },
      kind: "functional",
      model: { id: "claude-sonnet-5-5" },
      instructions: "SECRET INSTRUCTIONS: never shown to a client.",
      skills: [],
    },
    workflows: [
      {
        slug: "main",
        name: "Read an invoice",
        workflow: {
          schemaVersion: 4,
          triggers: [{ id: "t", on: { type: "manual", input: {} } }],
          steps: [
            { id: "read", kind: "read", name: "Read the invoice", tool: "testkit.record.get" },
            {
              id: "big",
              kind: "if",
              name: "Is it large?",
              paths: [
                {
                  id: "yes",
                  name: "Large",
                  when: { match: "all", rules: [{ field: "{{trigger.n}}", op: ">", value: 1 }] },
                  steps: [
                    {
                      id: "post",
                      kind: "write",
                      name: "Post the bill",
                      tool: "testkit.record.update",
                    },
                  ],
                },
              ],
              otherwise: { id: "no", steps: [] },
            },
            {
              id: "ask",
              kind: "person",
              name: "Check the vendor",
              mode: "ask",
              assignee: "client_admin",
              title: "Is this vendor right?",
              deadline: { after: "2 days", hours: "business" },
            },
            {
              id: "note",
              kind: "write",
              name: "Add a note",
              tool: "testkit.record.update",
              checks: { approval: { required: "not_required" } },
            },
          ],
        },
      },
    ],
  });
}

describe("the manual on the definition", () => {
  it("is optional: a bundle without it parses and hashes as it did", async () => {
    const before = bundle();
    const raw = JSON.parse(JSON.stringify(before));
    const again = AgentBundle.parse(raw);
    expect("manual" in again.definition).toBe(false);
    expect(await bundleHash(again)).toBe(await bundleHash(before));
  });

  it("is kept on the definition with its rows, and an unknown field is dropped", () => {
    const b = edit(bundle(), (d) => {
      (d.definition as Record<string, unknown>).manual = {
        whatItDoes: "Reads invoices.",
        decisions: [{ id: "freight", what: "Freight stays out", kind: "assumption" }],
        knownRisks: [{ id: "multi", what: "Several invoices in one file" }],
        extra: true,
      };
    });
    const parsed = AgentBundle.parse(b);
    expect(parsed.definition.manual).toEqual({
      whatItDoes: "Reads invoices.",
      decisions: [
        {
          id: "freight",
          what: "Freight stays out",
          why: "",
          kind: "assumption",
          risk: "normal",
          status: "never_discussed",
          by: null,
          at: null,
        },
      ],
      decisionPoints: [],
      knownRisks: [{ id: "multi", what: "Several invoices in one file", detail: "" }],
    });
  });

  it("is diffed and merged as a field of the definition", () => {
    const base = bundle();
    const withManual = edit(base, (d) => {
      d.definition.manual = AgentManual.parse({ whatItDoes: "Reads invoices." });
    });
    expect(diffBundles(base, withManual).map((c) => c.path)).toEqual(["bundle#/definition/manual"]);
    const changed = edit(withManual, (d) => {
      (d.definition.manual as AgentManual).whatItDoes = "Reads invoices and receipts.";
    });
    expect(diffBundles(withManual, changed)).toEqual([
      {
        kind: "changed",
        entity: "bundle",
        path: "bundle#/definition/manual/whatItDoes",
        before: "Reads invoices.",
        after: "Reads invoices and receipts.",
      },
    ]);
    // One side changes the manual, the other the name: both carry.
    const renamed = edit(withManual, (d) => {
      d.definition.identity.name = "Intake";
    });
    const merged = mergeBundles(withManual, changed, renamed);
    expect(merged.conflicts).toEqual([]);
    expect(merged.bundle.definition.manual?.whatItDoes).toBe("Reads invoices and receipts.");
    expect(merged.bundle.definition.identity.name).toBe("Intake");
    // Both sides change it differently: a conflict on that field, as any other.
    const other = edit(withManual, (d) => {
      (d.definition.manual as AgentManual).whatItDoes = "Reads bills.";
    });
    expect(mergeBundles(withManual, changed, other).conflicts.map((c) => c.path)).toEqual([
      "bundle#/definition/manual/whatItDoes",
    ]);
  });
});

describe("how it works", () => {
  it("lists the steps in run order, by name and kind in words, nested ones deeper", () => {
    expect(howItWorks(processBundle()).map((l) => [l.stepId, l.depth, l.name, l.words])).toEqual([
      ["read", 0, "Read the invoice", "Reads from your tools"],
      ["big", 0, "Is it large?", "Chooses a path"],
      ["post", 1, "Post the bill", "Updates your tools, after a person approves"],
      ["ask", 0, "Check the vendor", "A person answers"],
      ["note", 0, "Add a note", "Updates your tools"],
    ]);
  });

  it("never reads instructions or prompts", () => {
    expect(JSON.stringify(howItWorks(processBundle()))).not.toContain("SECRET");
  });

  it("reads a stored v3 workflow too, and leaves a switched-off one out", () => {
    const b = edit(bundle(), (d) => {
      d.workflows.push({
        slug: "v3",
        name: "Old",
        enabled: true,
        workflow: {
          schemaVersion: 3,
          trigger: { id: "t3", on: { type: "manual", input: { type: "object" } } },
          steps: [{ id: "w", name: "Wait a bit", kind: "wait", for: "1 hour" }],
        },
      });
    });
    const lines = howItWorks(b);
    expect(lines.find((l) => l.stepId === "w")).toMatchObject({ words: "Waits 1 hour" });
    const off = edit(b, (d) => {
      for (const w of d.workflows) w.enabled = false;
    });
    expect(howItWorks(off)).toEqual([]);
  });
});

describe("decision points", () => {
  it("are the person steps, the writes waiting for approval and the decision points named", () => {
    const decisions = [
      decision({
        id: "who",
        what: "The admin checks new vendors",
        kind: "decision_point",
        stepId: "ask",
      }),
      decision({ id: "loose", what: "A person picks the GL account", kind: "decision_point" }),
      decision({ id: "a", what: "Not a point", stepId: "read" }),
    ];
    expect(decisionPointsOf(processBundle(), decisions)).toEqual([
      { stepId: "post", what: "Approve: Post the bill", who: null, byWhen: null, decisionId: null },
      {
        stepId: "ask",
        what: "Check the vendor",
        who: "client_admin",
        byWhen: "2 days in business hours",
        decisionId: "who",
      },
      {
        stepId: null,
        what: "A person picks the GL account",
        who: null,
        byWhen: null,
        decisionId: "loose",
      },
    ]);
  });

  it("say who in words, never an id", () => {
    expect(whoWords("client_admin")).toBe("Your admin");
    expect(whoWords("lead")).toBe("Your Mezonas lead");
    expect(whoWords("0192f7a0-0000-7000-8000-00000000c001")).toBe("A person you named");
    expect(whoWords("{{trigger.owner}}")).toBe("The person the run names");
    expect(whoWords("ap_clerk")).toBe("Ap clerk");
    expect(whoWords(null)).toBeNull();
  });
});

describe("filling the manual from a build", () => {
  it("writes what it does from the brief, the decisions, the points and the known risks", () => {
    const manual = fillManual({
      brief: {
        goal: { text: "Read each invoice into the vendor's items", state: "confirmed" },
        measure: { text: "Every line lands on the right item", state: "confirmed" },
      },
      decisions: [
        decision({
          id: "freight",
          what: "Freight stays out of the catalog",
          stepId: "post",
          risk: "high",
        }),
      ],
      knownRisks: [
        { id: "item-1", what: "Several invoices in one file", detail: "A person splits it." },
      ],
      bundle: processBundle(),
    });
    expect(manual.whatItDoes).toBe(
      "Read each invoice into the vendor's items. Done well means: Every line lands on the right item.",
    );
    expect(manual.decisions.map((d) => [d.id, d.risk, d.status])).toEqual([
      ["freight", "high", "never_discussed"],
    ]);
    expect(manual.decisionPoints.map((p) => p.stepId)).toEqual(["post", "ask"]);
    expect(manual.knownRisks).toEqual([
      { id: "item-1", what: "Several invoices in one file", detail: "A person splits it." },
    ]);
  });

  it("keeps what it does when the brief says nothing", () => {
    const before = AgentManual.parse({ whatItDoes: "Reads invoices." });
    const manual = fillManual({
      brief: {},
      decisions: [],
      knownRisks: [],
      bundle: processBundle(),
      before,
    });
    expect(manual.whatItDoes).toBe("Reads invoices.");
    expect(whatItDoesFrom({})).toBe("");
  });
});

describe("the step's never-discussed decisions", () => {
  const definition = {
    manual: AgentManual.parse({
      decisions: [
        {
          id: "freight",
          what: "Freight stays out of the catalog",
          kind: "assumption",
          stepId: "post",
        },
        {
          id: "talked",
          what: "Tax stays in",
          kind: "assumption",
          stepId: "post",
          status: "discussed",
        },
        { id: "elsewhere", what: "Another step's", kind: "assumption", stepId: "read" },
      ],
    }),
  };

  it("are the decisions on this step nobody has discussed", () => {
    expect(undiscussedFor(definition, "post")).toEqual([
      { id: "freight", what: "Freight stays out of the catalog" },
    ]);
    expect(undiscussedFor(definition, "note")).toEqual([]);
    expect(undiscussedFor({}, "post")).toEqual([]);
    expect(undiscussedFor({ manual: { decisions: "not a list" } }, "post")).toEqual([]);
  });

  it("read back from a card's payload leniently, and end a sentence", () => {
    expect(readUndiscussed([{ id: "a", what: " Freight stays out " }, { what: 3 }, "x"])).toEqual([
      { id: "a", what: "Freight stays out" },
    ]);
    expect(readUndiscussed(undefined)).toEqual([]);
    expect(inSentence("Freight stays out of the catalog.")).toBe(
      "freight stays out of the catalog",
    );
    expect(inSentence("QBO bills wait a day")).toBe("QBO bills wait a day");
    expect(inSentence("Freight stays out. . \t\n")).toBe("freight stays out");
    expect(inSentence("...")).toBe("");
    // CodeQL (polynomial regex): a long run of tabs before the end is quick, not quadratic.
    const started = Date.now();
    expect(inSentence(`A${"\t".repeat(100_000)}b`)).toBe(`a${"\t".repeat(100_000)}b`);
    expect(Date.now() - started).toBeLessThan(500);
  });
});

describe("the view", () => {
  const b = edit(processBundle(), (d) => {
    d.definition.manual = AgentManual.parse({
      whatItDoes: "Reads invoices.",
      decisions: [
        {
          id: "freight",
          what: "Freight stays out of the catalog",
          kind: "assumption",
          stepId: "post",
          status: "confirmed",
          by: "Dana Operator",
          at: "2026-11-19T00:00:00.000Z",
        },
        { id: "who", what: "The admin checks vendors", kind: "decision_point", stepId: "ask" },
      ],
      knownRisks: [{ id: "multi", what: "Several invoices in one file" }],
    });
    (d.definition as Record<string, unknown>).setup = [
      { label: "When do we start writing into QuickBooks?", answer: "After the trial" },
      { question: "Who signs bills over $5,000?" },
      { nothing: true },
    ];
  });
  const learned = [{ id: "n1", note: "Acme sends two PDFs", at: "2026-11-18T00:00:00.000Z" }];

  it("is made by code, with no bundle, instructions, prompts or cost", () => {
    const view = manualView({
      agent: { id: "a1", name: "Intake" },
      bundle: b,
      learned,
      audience: "client",
    });
    expect(ManualView.parse(view)).toEqual(view);
    expect(forbiddenPortalFields(ManualView)).toEqual([]);
    const text = JSON.stringify(view);
    expect(text).not.toContain("SECRET");
    expect(text).not.toContain("claude-sonnet");
    expect(view.written).toBe(true);
    expect(view.decisions[0]).toMatchObject({
      what: "Freight stays out of the catalog",
      statusWords: "Confirmed",
      step: "Post the bill",
      // The portal never names who on our side looked at it.
      by: null,
    });
    expect(view.decisionPoints.find((p) => p.stepId === "ask")).toMatchObject({
      who: "Your admin",
      notDiscussed: true,
    });
    expect(view.setup).toEqual([
      { label: "When do we start writing into QuickBooks?", answer: "After the trial" },
      { label: "Who signs bills over $5,000?", answer: null },
    ]);
    expect(view.learned).toEqual(learned);
    expect(view.howItWorks).toHaveLength(5);
    expect(view.reads.length).toBeGreaterThan(0);
  });

  it("names who looked in the back office, and falls back when nothing is written", () => {
    const ops = manualView({
      agent: { id: "a1", name: "Intake" },
      bundle: b,
      learned: [],
      audience: "operator",
    });
    expect(ops.decisions[0]?.by).toBe("Dana Operator");
    const none = manualView({
      agent: { id: "a1", name: "Intake" },
      bundle: processBundle(),
      learned: [],
      audience: "client",
      fallbackWhat: "Reads your invoices.",
    });
    expect(none).toMatchObject({
      written: false,
      whatItDoes: "Reads your invoices.",
      decisions: [],
      setup: [],
    });
    expect(none.howItWorks.length).toBe(5);
  });

  it("reads setup items leniently, and nothing when there are none", () => {
    expect(readSetupLines(undefined)).toEqual([]);
    expect(readSetupLines({ items: [{ title: "Connect QuickBooks", value: true }] })).toEqual([
      { label: "Connect QuickBooks", answer: "true" },
    ]);
  });
});

describe("known risks counted from runs (G5)", () => {
  const risks = [
    { id: "multi", what: "Several receipts in one photo" },
    { id: "fx", what: "Another currency" },
    { id: "none", what: "A to B" },
  ];

  it("reads a risk's own words, without fillers or short ones", () => {
    expect(riskWords("Several receipts in one photo")).toEqual(["sever", "recei", "photo"]);
    expect(riskWords("Another currency")).toEqual(["curre"]);
    expect(riskWords("A to B")).toEqual([]);
  });

  it("counts each run once when people's words name two of the risk's words", () => {
    const hits = riskHits(risks, [
      { runId: "r1", text: "Two receipts on this photo" },
      { runId: "r1", text: "Receipts in one photo again" },
      { runId: "r2", text: "Wrong receipt" },
      { runId: "r3", text: "Check the receipt" },
      { runId: "r3", text: "photos are blurry" },
      { runId: "r4", text: "Paid in a foreign currency" },
    ]);
    expect(Object.fromEntries(hits)).toEqual({ multi: 2, fx: 1, none: 0 });
  });

  it("is shown on the view when counted, and null when not", () => {
    const b = { workflows: [], definition: { manual: { knownRisks: risks.slice(0, 1) } } };
    const view = (hits?: Map<string, number>) =>
      manualView({
        agent: { id: "a", name: "A" },
        bundle: b,
        learned: [],
        audience: "operator",
        hits,
      });
    expect(view(new Map([["multi", 3]])).knownRisks[0]?.hits).toBe(3);
    expect(view(new Map()).knownRisks[0]?.hits).toBe(0);
    expect(view().knownRisks[0]?.hits).toBeNull();
  });
});
