import { describe, expect, it } from "vitest";
import type { Decision, SetupField } from "../build/build";
import { readStageState } from "../lifecycle/stage";
import { AgentBundle, type AnyAgentBundle, type ProcessAgentBundle } from "../schemas/agent";
import type { SkillDefinition } from "../schemas/skill";
import {
  applySetupSetting,
  buildSetupItems,
  draftWriteUses,
  matchConnector,
  readSetupAnswer,
  settingForDecision,
  settingValue,
  setupHolds,
  setupHoldText,
  setupItemDone,
  withSetupProgress,
} from "./checklist";
import { SetupChecklist, type SetupItem, type SetupProgress } from "./item";
import { setupView } from "./view";

const field = (id: string, over: Partial<SetupField> = {}): SetupField => ({
  id,
  label: `Field ${id}`,
  kind: "answer",
  hint: "",
  dropped: false,
  byOperator: false,
  ...over,
});

const dec = (id: string, over: Partial<Decision> = {}): Decision => ({
  id,
  what: `Decision ${id}`,
  why: "It differs by client.",
  kind: "client_setup",
  risk: "normal",
  status: "never_discussed",
  by: null,
  at: null,
  ...over,
});

const CONNECTORS = [
  { id: "qbo", name: "QuickBooks Online" },
  { id: "gmail", name: "Gmail" },
];

const draft = {
  definition: {
    skills: [{ skill: "materials.match", settings: {}, parameters: { tolerance: 2 } }],
  },
  workflows: [
    {
      slug: "main",
      name: "Main",
      enabled: true,
      workflow: {
        schemaVersion: 4,
        triggers: [],
        steps: [
          { id: "read", kind: "read", name: "Read", tool: "qbo.bill.list" },
          {
            id: "match",
            kind: "skill",
            name: "Match",
            skill: "materials.match",
            customize: { parameters: { limit: { amount: "5000.00", currency: "USD" } } },
          },
          { id: "post", kind: "write", name: "Post", tool: "qbo.bill.create" },
          { id: "vendor", kind: "write", name: "Vendor", action: "create_vendor" },
          { id: "mail", kind: "write", name: "Mail", tool: "gmail.send" },
          { id: "note", kind: "write", name: "Note", tool: "platform.note" },
        ],
      },
    },
  ],
} as unknown as ProcessAgentBundle;

const TOOLS = {
  "qbo.bill.list": { id: "qbo.bill.list", sideEffect: "none", verb: "read", source: "qbo" },
  "qbo.bill.create": {
    id: "qbo.bill.create",
    sideEffect: "external",
    verb: "create",
    source: "qbo",
    connector: "qbo",
    entity: "bill",
  },
  "gmail.send": {
    id: "gmail.send",
    sideEffect: "external",
    verb: "create",
    source: "gmail",
    connector: "gmail",
    recipient: { path: "to" },
  },
  "platform.note": { id: "platform.note", sideEffect: "internal", verb: "create", source: "x" },
} as never;

const SKILLS = {
  "materials.match": {
    id: "materials.match",
    parameters: [
      { name: "tolerance", label: "Price tolerance", type: "number", default: 1 },
      { name: "limit", label: "Bill limit", type: "money" },
      { name: "bands", label: "Bands", type: "buckets" },
    ],
  },
} as unknown as Record<string, SkillDefinition>;

const connected = (ids: string[]) => ({ connected: (c: string) => ids.includes(c) });

describe("setup checklist: built from a template build", () => {
  it("lists where the draft writes and what, by connector", () => {
    const uses = draftWriteUses(draft, { tools: TOOLS });
    expect(uses).toEqual([
      { connector: "qbo", known: true, key: "create-bill", what: "new bills", send: false },
      {
        connector: "accounting",
        known: false,
        key: "create-vendor",
        what: "new vendors",
        send: false,
      },
      { connector: "gmail", known: true, key: "send-records", what: "messages", send: true },
    ]);
  });

  it("matches a form's connect field to a connector by its name", () => {
    expect(matchConnector("QuickBooks Online", CONNECTORS)).toBe("qbo");
    expect(matchConnector("Connect your Gmail inbox", CONNECTORS)).toBe("gmail");
    expect(matchConnector("Your bank", CONNECTORS)).toBeUndefined();
  });

  it("finds the parameter a decision sets: by its starting value, else by its words", () => {
    expect(settingForDecision(dec("t", { stepId: "match", value: "2%" }), draft, SKILLS)).toEqual({
      skill: "materials.match",
      parameter: "tolerance",
      type: "number",
    });
    // The step's own value: the setting names the step.
    expect(
      settingForDecision(dec("l", { stepId: "match", value: "$5,000" }), draft, SKILLS),
    ).toEqual({ skill: "materials.match", parameter: "limit", type: "money", stepId: "match" });
    expect(
      settingForDecision(
        dec("w", { stepId: "match", what: "The price tolerance differs by client" }),
        draft,
        SKILLS,
      ),
    ).toMatchObject({ parameter: "tolerance" });
    // No step, a step that isn't a skill, or nothing that fits: no setting.
    expect(settingForDecision(dec("a", { value: "2" }), draft, SKILLS)).toBeNull();
    expect(settingForDecision(dec("b", { stepId: "post", value: "2" }), draft, SKILLS)).toBeNull();
    expect(settingForDecision(dec("c", { stepId: "match", value: "9" }), draft, SKILLS)).toBeNull();
  });

  it("makes the form, the client_setup decisions and the writing items, with stable ids", () => {
    const decisions = [
      dec("tolerance", { stepId: "match", value: "2%" }),
      dec("signer", { risk: "high", what: "Who approves bills over the limit" }),
      dec("freight", { kind: "assumption" }),
    ];
    const items = buildSetupItems({
      form: [
        field("books", { label: "QuickBooks Online", kind: "connect" }),
        field("list", { label: "Vendor list", kind: "file" }),
        field("old", { dropped: true }),
      ],
      decisions,
      writes: draftWriteUses(draft, { tools: TOOLS }),
      connectors: CONNECTORS,
      settingFor: (d) => settingForDecision(d, draft, SKILLS),
    });
    expect(items.map((i) => [i.id, i.kind, i.guards])).toEqual([
      ["form-books", "connect", "setup"],
      ["form-list", "file", "setup"],
      ["decision-tolerance", "answer", "setup"],
      ["decision-signer", "answer", "trial"],
      ["connect-gmail", "connect", "setup"],
      ["write-start-qbo", "confirm", "trial"],
      ["write-start-accounting", "confirm", "trial"],
      ["write-start-gmail", "confirm", "trial"],
      ["write-sign-qbo-create-bill", "confirm", "trial"],
      ["write-sign-accounting-create-vendor", "confirm", "trial"],
      ["write-sign-gmail-send-records", "confirm", "trial"],
    ]);
    const byId = new Map(items.map((i) => [i.id, i]));
    expect(byId.get("form-books")?.connector).toBe("qbo");
    expect(byId.get("decision-tolerance")).toMatchObject({
      suggested: "2%",
      setting: { parameter: "tolerance" },
    });
    expect(byId.get("write-start-qbo")?.label).toBe(
      "When do we start writing into QuickBooks Online?",
    );
    expect(byId.get("write-start-gmail")?.label).toBe(
      "When do we start sending messages through Gmail?",
    );
    expect(byId.get("write-sign-qbo-create-bill")?.label).toBe(
      "Who signs new bills in QuickBooks Online?",
    );
    expect(byId.get("write-sign-accounting-create-vendor")?.label).toBe(
      "Who signs new vendors in your accounting system?",
    );
    // Every item is a valid checklist row.
    expect(SetupChecklist.safeParse(items).success).toBe(true);
  });
});

describe("setup checklist: in the agent's version", () => {
  it("is optional: a bundle without one parses and keeps none", () => {
    const bundle = {
      schemaVersion: 1,
      definition: {
        schemaVersion: 2,
        identity: { name: "A", role: "r", mission: "m" },
        kind: "functional",
        model: { id: "claude-sonnet-4-5" },
        instructions: "",
        skills: [],
      },
      workflows: [],
    };
    expect("setup" in AgentBundle.parse(bundle).definition).toBe(false);
    const items: SetupItem[] = [
      { id: "form-a", label: "A", kind: "answer", hint: "", guards: "setup" },
    ];
    const withSetup = AgentBundle.parse({
      ...bundle,
      definition: { ...bundle.definition, setup: items },
    });
    expect(withSetup.definition.setup).toEqual(items);
  });
});

describe("setup checklist: a client copy's progress and its stages", () => {
  const items: SetupItem[] = [
    {
      id: "connect-qbo",
      label: "Connect QuickBooks",
      kind: "connect",
      hint: "",
      guards: "setup",
      connector: "qbo",
    },
    { id: "a", label: "Your tolerance?", kind: "answer", hint: "", guards: "setup" },
    {
      id: "b",
      label: "Who signs new bills in QuickBooks?",
      kind: "confirm",
      hint: "",
      guards: "trial",
    },
    { id: "c", label: "Your go-live date", kind: "answer", hint: "", guards: "live" },
  ];
  const done = (value?: string): SetupProgress => ({
    done: true,
    by: "u1",
    byName: "Ada",
    side: "client",
    at: "2026-11-19T10:00:00Z",
    ...(value ? { value } : {}),
  });

  it("is done by the connection for a connect item, by a person otherwise", () => {
    const connect = items[0] as SetupItem;
    expect(setupItemDone(connect, done(), connected([]))).toBe(false);
    expect(setupItemDone(connect, undefined, connected(["qbo"]))).toBe(true);
    expect(setupItemDone(items[1] as SetupItem, undefined, connected([]))).toBe(false);
    expect(setupItemDone(items[1] as SetupItem, done("2"), connected([]))).toBe(true);
    expect(setupItemDone(items[1] as SetupItem, { ...done(), done: false }, connected([]))).toBe(
      false,
    );
  });

  // Connectors C4 (docs/connectors-plan.md §7): connected and bound isn't done while the agent
  // still needs something there; the label says what.
  it("keeps a connect item open while the agent needs something there, and says what", () => {
    const connect = items[0] as SetupItem;
    const facts = {
      connected: (c: string) => c === "qbo",
      missing: (c: string) => (c === "qbo" ? "Allow create bills" : null),
    };
    expect(setupItemDone(connect, undefined, facts)).toBe(false);
    expect(setupItemDone(connect, undefined, { ...facts, missing: () => null })).toBe(true);
    const held = setupHolds(items, {}, facts, "trial");
    expect(held[0]?.label).toBe(`${connect.label.replace(/[.?]$/, "")}: allow create bills`);
    // Not connected: the label stays as it is (connecting is what's missing).
    expect(setupHolds(items, {}, connected([]), "trial")[0]?.label).toBe(connect.label);
  });

  it("holds the trial on setup and trial items, and sign-off and live on every item", () => {
    const progress = { a: done("2") };
    expect(setupHolds(items, progress, connected([]), "trial").map((i) => i.id)).toEqual([
      "connect-qbo",
      "b",
    ]);
    expect(setupHolds(items, progress, connected(["qbo"]), "signoff").map((i) => i.id)).toEqual([
      "b",
      "c",
    ]);
    expect(setupHolds(items, progress, connected(["qbo"]), "bench")).toEqual([]);
    expect(
      setupHolds(items, { ...progress, b: done(), c: done("Dec 1") }, connected(["qbo"]), "live"),
    ).toEqual([]);
  });

  it("says what holds a move in plain words", () => {
    expect(setupHoldText([])).toBe("");
    expect(setupHoldText(items.slice(0, 2))).toBe(
      "The setup checklist isn't done: Connect QuickBooks; Your tolerance.",
    );
    expect(setupHoldText(items)).toBe(
      "The setup checklist isn't done: Connect QuickBooks; Your tolerance; Who signs new bills in QuickBooks; and 1 more.",
    );
  });

  it("is kept on the stage state, which reads back and keeps the rest", () => {
    const state = withSetupProgress({ skipped: [] }, "a", done("2"));
    const read = readStageState(JSON.parse(JSON.stringify(state)));
    expect(read.setup?.a).toMatchObject({ done: true, value: "2", byName: "Ada" });
    expect(read.skipped).toEqual([]);
    // A state from before the checklist reads with none.
    expect(readStageState({ trial: undefined }).setup).toBeUndefined();
  });

  it("shows each item with who did it, and what holds the next stages", () => {
    const view = setupView(items, { a: done("2"), b: done() }, connected(["qbo"]));
    expect(view.done).toBe(3);
    expect(view.total).toBe(4);
    expect(view.items[0]).toMatchObject({
      id: "connect-qbo",
      done: true,
      byConnection: true,
      byName: null,
    });
    expect(view.items[1]).toMatchObject({ value: "2", byName: "Ada", side: "client" });
    expect(view.holds.trial).toBe("");
    expect(view.holds.live).toBe("The setup checklist isn't done: Your go-live date.");
  });
});

describe("setup checklist: answers", () => {
  it("are words for an item that sets nothing, and one of its options when it has them", () => {
    expect(readSetupAnswer({}, "  Dana in accounts ")).toEqual({
      ok: true,
      text: "Dana in accounts",
      value: "Dana in accounts",
    });
    expect(readSetupAnswer({}, " ")).toMatchObject({ ok: false });
    const options = { bounds: { options: ["Weekly", "Monthly"] } };
    expect(readSetupAnswer(options, "monthly")).toMatchObject({ ok: true, value: "Monthly" });
    expect(readSetupAnswer(options, "daily")).toEqual({
      ok: false,
      reason: "Pick one of: Weekly, Monthly.",
    });
  });

  it("are a value of the parameter's type within its bounds when they set one", () => {
    const tolerance = {
      setting: { skill: "s", parameter: "tolerance", type: "number" as const },
      bounds: { min: "0", max: "5" },
    };
    expect(readSetupAnswer(tolerance, "2.5%")).toEqual({ ok: true, text: "2.5", value: 2.5 });
    expect(readSetupAnswer(tolerance, "7")).toEqual({
      ok: false,
      reason: "It can't be more than 5.",
    });
    expect(readSetupAnswer(tolerance, "two")).toMatchObject({ ok: false });
    const limit = { setting: { skill: "s", parameter: "limit", type: "money" as const } };
    expect(readSetupAnswer(limit, "$5,000", { amount: "100.00", currency: "CAD" })).toEqual({
      ok: true,
      text: "5000.00 CAD",
      value: { amount: "5000.00", currency: "CAD" },
    });
    expect(readSetupAnswer(limit, "250 EUR")).toMatchObject({
      value: { amount: "250.00", currency: "EUR" },
    });
    const date = { setting: { skill: "s", parameter: "start", type: "date" as const } };
    expect(readSetupAnswer(date, "2026-12-01")).toMatchObject({ ok: true, value: "2026-12-01" });
    expect(readSetupAnswer(date, "next week")).toMatchObject({ ok: false });
  });

  it("write only the parameter they set: the agent's value, or the step's own", () => {
    const bundle = draft as unknown as AnyAgentBundle;
    const agentLevel = {
      skill: "materials.match",
      parameter: "tolerance",
      type: "number" as const,
    };
    const out = applySetupSetting(bundle, agentLevel, 3);
    if (!out.ok) throw new Error(out.reason);
    expect(settingValue(out.bundle, agentLevel)).toBe(3);
    // The bundle it came from is unchanged.
    expect(settingValue(bundle, agentLevel)).toBe(2);
    const onStep = { ...agentLevel, parameter: "limit", type: "money" as const, stepId: "match" };
    const step = applySetupSetting(bundle, onStep, { amount: "9000.00", currency: "USD" });
    if (!step.ok) throw new Error(step.reason);
    expect(settingValue(step.bundle, onStep)).toEqual({ amount: "9000.00", currency: "USD" });
    expect(JSON.stringify(step.bundle.workflows)).not.toBe(JSON.stringify(bundle.workflows));
    expect(step.bundle.definition).toEqual(bundle.definition);
    expect(applySetupSetting(bundle, { ...agentLevel, skill: "gone" }, 1)).toMatchObject({
      ok: false,
    });
    expect(applySetupSetting(bundle, { ...onStep, stepId: "gone" }, 1)).toMatchObject({
      ok: false,
    });
  });
});
