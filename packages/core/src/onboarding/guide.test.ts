// The guide (docs/cases-plan.md §4.2 step 3, O2; docs/plan.md §1.125.2): sections in covers'
// order, a shared question asked once, fields filled from `theirs` facts (known, to confirm, to
// ask), the operator's edits, the totals and progress; a template's form read into a card; a
// pack's area section from its manifest; answers checked and redacted; the portal's view.

import { describe, expect, it } from "vitest";
import { PackManifest } from "../schemas/pack";
import {
  agentSectionKey,
  buildGuide,
  type Covers,
  checkAnswer,
  factFieldKey,
  fieldFor,
  GENERAL_SECTION,
  type GuideFact,
  type GuideSectionSource,
  GuideSectionSource as GuideSectionSourceSchema,
  genericAreaSection,
  guideEditProblems,
  guideProgress,
  guideTotals,
  latestByField,
  mergeFields,
  portalSection,
  redactAnswer,
  sectionDone,
  templateSection,
  toolFieldKey,
  valueFromText,
  visibleSectionKeys,
} from "./index";

const T1 = "0192f0aa-0000-7000-8000-000000000001";

const purchasing: GuideSectionSource = GuideSectionSourceSchema.parse({
  kind: "area",
  area: "purchasing",
  title: "Purchasing",
  intro: "How you buy materials today.",
  fields: [
    {
      key: "purchasing.bills_to",
      label: "Where do vendors send bills?",
      kind: "text",
      fileSection: "processes",
    },
    { key: "purchasing.vendors", label: "About how many vendors?", kind: "number" },
    {
      key: "purchasing.approver",
      shareKey: "general.approver",
      label: "Who approves a purchase?",
      kind: "text",
      requiredToStart: true,
    },
  ],
});

const contracts = templateSection({
  id: T1,
  name: "Vendor contracts and invoice review",
  description: "Checks each bill against the vendor's contract before you pay it.",
  slug: "vendor-contracts",
  connectors: [{ id: "qbo", name: "QuickBooks" }],
  form: [
    { id: "qb", label: "Connect QuickBooks", kind: "connect", hint: "", dropped: false },
    { id: "files", label: "Your vendor contracts", kind: "file", hint: "PDFs", dropped: false },
    { id: "tol", label: "How far off can a price be?", kind: "answer", hint: "", dropped: false },
    { id: "gone", label: "Old question", kind: "answer", hint: "", dropped: true },
  ],
});

const covers: Covers = { general: true, areas: ["purchasing"], templateIds: [T1] };

function guideOf(facts: GuideFact[] = [], extra: Partial<Parameters<typeof buildGuide>[0]> = {}) {
  return buildGuide({
    covers,
    general: GENERAL_SECTION,
    areas: [purchasing],
    agents: [contracts],
    facts,
    ...extra,
  });
}

describe("building the guide", () => {
  it("orders the sections general, areas, agents, and leaves out what isn't covered", () => {
    const g = guideOf();
    expect(g.sections.map((s) => s.key)).toEqual([
      "general",
      "area:purchasing",
      agentSectionKey(T1),
    ]);
    const only = buildGuide({
      covers: { general: false, areas: ["purchasing"], templateIds: [] },
      general: GENERAL_SECTION,
      areas: [purchasing, genericAreaSection("sales")],
      agents: [contracts],
      facts: [],
    });
    expect(only.sections.map((s) => s.key)).toEqual(["area:purchasing"]);
  });

  it('asks "who approves" once, in the first card that asks it, required if any asker needs it', () => {
    const g = guideOf();
    const all = g.sections.flatMap((s) => s.fields);
    expect(all.filter((f) => f.key === "general.approver")).toHaveLength(1);
    const approver = all.find((f) => f.key === "general.approver");
    expect(approver).toMatchObject({ sectionKey: "general", alsoIn: ["area:purchasing"] });
    expect(approver?.requiredToStart).toBe(true);
  });

  it("asks for a tool once across cards, as a Connect field", () => {
    const other = templateSection({
      id: "0192f0aa-0000-7000-8000-000000000003",
      name: "Bill clerk",
      description: "Enters bills.",
      slug: "bill-clerk",
      connectors: [{ id: "qbo", name: "QuickBooks" }],
      form: [],
    });
    const g = buildGuide({
      covers: {
        general: false,
        areas: [],
        templateIds: [T1, "0192f0aa-0000-7000-8000-000000000003"],
      },
      general: null,
      areas: [],
      agents: [contracts, other],
      facts: [],
    });
    const tools = g.sections.flatMap((s) => s.fields).filter((f) => f.kind === "tool");
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ key: toolFieldKey("qbo"), connector: "qbo" });
    expect(tools[0]?.alsoIn).toEqual([agentSectionKey("0192f0aa-0000-7000-8000-000000000003")]);
    expect(g.totals.tools).toBe(1);
  });

  it("reads a template's form into its card: tools, answers, files; dropped fields left out", () => {
    expect(contracts.intro).toContain("contract");
    const kinds = contracts.fields.map((f) => [f.key, f.kind]);
    expect(kinds).toEqual([
      ["tool.qbo", "tool"],
      ["agent.vendor-contracts.files", "files"],
      ["agent.vendor-contracts.tol", "text"],
    ]);
    // A "connect" field naming a tool it doesn't need is a question about which account.
    const odd = templateSection({
      id: T1,
      name: "X",
      description: "",
      slug: "x",
      connectors: [],
      form: [
        {
          id: "portal",
          label: "Connect the supplier portal",
          kind: "connect",
          hint: "",
          dropped: false,
        },
      ],
    });
    expect(odd.fields[0]).toMatchObject({ kind: "text", label: "Connect the supplier portal" });
  });

  it("fills from theirs facts: confirmed is known, heard is to confirm, else asked", () => {
    const g = guideOf([
      {
        id: "f1",
        section: "processes",
        text: "ap@acme.com",
        sureness: "heard",
        fieldKey: "purchasing.bills_to",
      },
      {
        id: "f2",
        section: "volumes",
        text: "42",
        sureness: "confirmed",
        fieldKey: "purchasing.vendors",
      },
      // Not a number: the field is asked.
      {
        id: "f3",
        section: "volumes",
        text: "lots",
        sureness: "confirmed",
        fieldKey: "purchasing.vendors",
      },
    ]);
    const field = (k: string) => g.sections.flatMap((s) => s.fields).find((f) => f.key === k);
    expect(field("purchasing.bills_to")).toMatchObject({
      state: "to_confirm",
      weThink: { value: "ap@acme.com", text: "ap@acme.com", factIds: ["f1"] },
    });
    // The later of two equally sure facts wins; its words don't read as a number, so it's asked.
    expect(field("purchasing.vendors")?.state).toBe("to_ask");
    expect(field("general.what")?.state).toBe("to_ask");
  });

  it("shows a fact that names no question as its own line, on the general card", () => {
    const g = guideOf([
      {
        id: "0192f0aa-aaaa-7000-8000-00000000000f",
        section: "systems",
        text: "Bills come to ap@acme.com",
        sureness: "seen",
      },
      {
        id: "0192f0aa-aaaa-7000-8000-00000000001f",
        section: "people",
        text: "Dana runs AP",
        sureness: "confirmed",
      },
    ]);
    const general = g.sections[0];
    const line = general?.fields.find(
      (f) => f.key === factFieldKey("0192f0aa-aaaa-7000-8000-00000000000f"),
    );
    expect(line).toMatchObject({
      state: "to_confirm",
      kind: "long_text",
      label: "Tools you use",
      origin: "operator",
    });
    expect(line?.weThink?.text).toBe("Bills come to ap@acme.com");
    expect(g.totals.known).toBe(1);
    // Without a general card, it goes to the card that files into its section.
    const noGeneral = buildGuide({
      covers: { general: false, areas: ["purchasing"], templateIds: [] },
      general: null,
      areas: [purchasing],
      agents: [],
      facts: [{ id: "x1", section: "processes", text: "By email", sureness: "heard" }],
    });
    expect(noGeneral.sections[0]?.fields.at(-1)).toMatchObject({
      key: "fact.x1",
      sectionKey: "area:purchasing",
    });
  });

  it("applies the operator's drop, ask later, reword and add, and never a question for a secret", () => {
    const g = guideOf([], {
      edits: {
        drop: ["general.limits"],
        later: ["purchasing.vendors"],
        reword: [{ key: "general.what", label: "What does Acme do?" }],
        add: [
          { sectionKey: "area:purchasing", label: "Do you use purchase orders?", kind: "yes_no" },
          { sectionKey: "general", label: "What is your bank login password?", kind: "text" },
        ],
      },
    });
    const all = g.sections.flatMap((s) => s.fields);
    expect(all.some((f) => f.key === "general.limits")).toBe(false);
    expect(all.find((f) => f.key === "purchasing.vendors")?.state).toBe("later");
    expect(all.find((f) => f.key === "general.what")?.label).toBe("What does Acme do?");
    expect(all.find((f) => f.key === "ask.do-you-use-purchase-orders")).toMatchObject({
      origin: "operator",
      kind: "yes_no",
    });
    expect(all.some((f) => /password/i.test(f.label))).toBe(false);
    expect(
      guideEditProblems({
        add: [{ sectionKey: "general", label: "Your card number", kind: "text" }],
      }),
    ).toHaveLength(1);
    // A source's question that asks for a secret is left out too.
    const bad = buildGuide({
      covers: { general: true, areas: [], templateIds: [] },
      general: {
        ...GENERAL_SECTION,
        fields: [
          {
            ...GENERAL_SECTION.fields[0],
            key: "general.ssn",
            label: "Your social security number?",
          } as never,
        ],
      },
      areas: [],
      agents: [],
      facts: [],
    });
    expect(bad.sections[0]?.fields).toHaveLength(0);
  });

  it("counts what the operator sees, with minutes rounded up to five", () => {
    const g = guideOf([
      {
        id: "f1",
        section: "processes",
        text: "ap@acme.com",
        sureness: "heard",
        fieldKey: "purchasing.bills_to",
      },
    ]);
    expect(g.totals).toMatchObject({ known: 0, toConfirm: 1, later: 0, tools: 1 });
    expect(g.totals.toAsk).toBe(g.sections.flatMap((s) => s.fields).length - 2);
    expect(g.totals.minutes % 5).toBe(0);
    expect(g.totals.minutes).toBeGreaterThanOrEqual(15);
    expect(guideTotals([])).toEqual({
      known: 0,
      toConfirm: 0,
      toAsk: 0,
      later: 0,
      tools: 0,
      minutes: 0,
    });
  });

  it("merges by key, keeping the first card's field", () => {
    const g = guideOf();
    const again = mergeFields(g.sections);
    expect(again.flatMap((s) => s.fields)).toHaveLength(g.sections.flatMap((s) => s.fields).length);
  });

  it("reads words as a value only where they read as one", () => {
    expect(valueFromText({ kind: "number" }, "1,200")).toBe(1200);
    expect(valueFromText({ kind: "yes_no" }, "Yes")).toBe(true);
    expect(valueFromText({ kind: "choice", choices: ["Email", "Mail"] }, "email")).toBe("Email");
    expect(valueFromText({ kind: "choices", choices: ["A", "B"] }, "a, b")).toEqual(["A", "B"]);
    expect(valueFromText({ kind: "choices", choices: ["A"] }, "a, c")).toBeNull();
    expect(valueFromText({ kind: "money" }, "$40")).toBeNull();
    expect(valueFromText({ kind: "date" }, "2026-12-01")).toBe("2026-12-01");
  });
});

describe("progress", () => {
  it("counts answered and not sure per card, lists what's missing and who has it", () => {
    const g = guideOf();
    const p = guideProgress(
      g,
      [
        { fieldKey: "general.what", state: "answered" },
        { fieldKey: "general.approver", state: "answered" },
        // The latest answer counts.
        { fieldKey: "general.approver", state: "not_sure" },
        { fieldKey: "general.team", state: "confirmed" },
      ],
      {
        people: [
          { name: "Dana", sections: null, isAdmin: true },
          { name: "Mark", sections: [agentSectionKey(T1)], isAdmin: false },
        ],
        asked: [{ fieldKey: "general.approver", name: "Lee" }],
        decisions: { general: "start" },
      },
    );
    const general = p.find((s) => s.sectionKey === "general");
    expect(general).toMatchObject({ answered: 2, notSure: 1, total: 6, decision: "start" });
    expect(general?.missing).toEqual([
      { fieldKey: "general.approver", label: "Who approves payments and changes?", who: "Lee" },
    ]);
    const agent = p.find((s) => s.sectionKey === agentSectionKey(T1));
    expect(agent?.missing.every((m) => m.who === "Mark")).toBe(true);
    expect(agent && sectionDone(agent)).toBe(false);
    expect(sectionDone({ answered: 3, notSure: 1, total: 4 })).toBe(true);
  });
});

describe("answers", () => {
  it("are checked against their field's kind and choices", () => {
    expect(checkAnswer({ kind: "number" }, "12")).toMatchObject({ ok: false });
    expect(checkAnswer({ kind: "number" }, 12)).toEqual({ ok: true, value: 12 });
    expect(checkAnswer({ kind: "choice", choices: ["A"] }, "B")).toMatchObject({ ok: false });
    expect(checkAnswer({ kind: "money" }, { amount: "12.50", currency: "USD" })).toMatchObject({
      ok: true,
    });
    expect(checkAnswer({ kind: "money" }, { amount: 12.5, currency: "USD" })).toMatchObject({
      ok: false,
    });
  });

  it("never keep a card number or a social security number", () => {
    const check = checkAnswer(
      { kind: "long_text" },
      "Pay with 4111 1111 1111 1111, SSN 123-45-6789",
    );
    expect(check.ok && check.value).toBe("Pay with [card ending 1111], SSN [number removed]");
    expect(redactAnswer(["4111111111111111"])).toEqual(["[card ending 1111]"]);
  });

  it("keep the latest per field", () => {
    expect(
      latestByField([
        { fieldKey: "a", n: 1 },
        { fieldKey: "b", n: 2 },
        { fieldKey: "a", n: 3 },
      ]).map((a) => a.n),
    ).toEqual([2, 3]);
  });

  it("are taken only for a card the person sees (or one a shared question is in)", () => {
    const g = guideOf();
    const mine = visibleSectionKeys(g, ["area:purchasing"]);
    expect(mine).toEqual(["area:purchasing"]);
    expect(fieldFor(g, "general.approver", mine)?.key).toBe("general.approver");
    expect(fieldFor(g, "general.what", mine)).toBeNull();
    expect(visibleSectionKeys(g, null)).toHaveLength(3);
  });
});

describe("the portal's view of a card", () => {
  it("carries no fact ids or origin, and leaves out what is known", () => {
    const g = guideOf([
      {
        id: "f9",
        section: "people",
        text: "Dana",
        sureness: "confirmed",
        fieldKey: "general.approver",
      },
      {
        id: "f8",
        section: "processes",
        text: "ap@acme.com",
        sureness: "heard",
        fieldKey: "purchasing.bills_to",
      },
    ]);
    const shown = g.sections.map(portalSection);
    const json = JSON.stringify(shown);
    expect(json).not.toContain("factIds");
    expect(json).not.toContain("origin");
    expect(json).not.toContain("f8");
    expect(shown[0]?.fields.some((f) => f.key === "general.approver")).toBe(false);
    expect(shown[1]?.fields.find((f) => f.key === "purchasing.bills_to")?.weThink).toEqual({
      value: "ap@acme.com",
      text: "ap@acme.com",
    });
  });
});

describe("a pack's area section", () => {
  it("is data in its manifest, its own area's", () => {
    const base = {
      id: "demo",
      name: "Demo",
      version: "0.1.0",
      description: "d",
      events: [],
      tools: [],
      skills: [],
      templates: [],
      screens: [],
    };
    expect(PackManifest.safeParse({ ...base, intakeSection: purchasing }).success).toBe(true);
    expect(
      PackManifest.safeParse({ ...base, intakeSection: { ...purchasing, kind: "general" } })
        .success,
    ).toBe(false);
  });
});
