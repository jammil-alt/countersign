// Sloan's core rules (docs/plan.md §1.47): who may ask for what, drafted changes that would loosen
// a rule are found, the publish guard refuses connector and external tools, the views carry
// nothing the portal may not show, and every language has the words.

import { describe, expect, it } from "vitest";
import { forbiddenPortalFields } from "../api/contract";
import type { ApproverRule } from "../approvals/rules";
import { LOCALES } from "../i18n/locale";
import { AgentBundle, type AgentBundleInput } from "../schemas/agent";
import { AutomationDefinition } from "../schemas/automation";
import type { SkillDefinition } from "../schemas/skill";
import type { ToolSpec } from "../schemas/tool";
import {
  AccountChange,
  changeProblem,
  looseningProblems,
  mayAskFor,
  readStoredAccountChange,
  signerRules,
} from "./changes";
import { accountAgentProblems } from "./guard";
import {
  AccountRunSummary,
  AccountRunView,
  AccountService,
  AccountWaitExplanation,
  AccountWaitingItem,
} from "./views";
import { ACCOUNT_WORDS } from "./words";

const LISA = "11111111-1111-4111-8111-111111111111";
const RULE: ApproverRule = {
  id: "22222222-2222-4222-8222-222222222222",
  match: { connector: "qbo" },
  approver: { kind: "operator" },
  setBy: "operator",
};

const addSigner = (over: Record<string, unknown> = {}) =>
  AccountChange.parse({
    kind: "add_signer",
    email: "Lisa@Shop.example.com",
    name: "Lisa",
    rules: [
      {
        match: { tool: "qbo.bill.create", amountOver: { value: "2000", currency: "USD" } },
        approver: "client_admin",
      },
      { match: { tool: "qbo.bill.create" } },
    ],
    ...over,
  });

describe("who may ask Sloan for what", () => {
  it("lets any client person read and pass to the lead; only the admin pauses and drafts", () => {
    expect(mayAskFor("client_user", "read")).toBe(true);
    expect(mayAskFor("client_user", "pass")).toBe(true);
    expect(mayAskFor("client_user", "pause")).toBe(false);
    expect(mayAskFor("client_user", "draft")).toBe(false);
    expect(mayAskFor("client_admin", "pause")).toBe(true);
    expect(mayAskFor("client_admin", "draft")).toBe(true);
    // Sloan answers client people only.
    expect(mayAskFor("operator", "read")).toBe(false);
    expect(mayAskFor(null, "read")).toBe(false);
  });
});

describe("drafted changes", () => {
  it("adds a signer's rules after the client's own, never overriding one", () => {
    const change = addSigner();
    if (change.kind !== "add_signer") throw new Error("kind");
    expect(change.email).toBe("lisa@shop.example.com");
    expect(change.role).toBe("client_user");
    const next = signerRules([RULE], change.rules, LISA);
    expect(next[0]).toBe(RULE);
    expect(next.slice(1).map((r) => r.approver)).toEqual([
      { kind: "client_admin" },
      { kind: "user", userId: LISA },
    ]);
    expect(looseningProblems(change, [RULE])).toEqual([]);
  });

  it("finds a draft that would loosen: a new admin", () => {
    const change = addSigner({ role: "client_admin" });
    expect(looseningProblems(change, []).map((p) => p.code)).toEqual(["new_admin"]);
  });

  it("refuses an approver who approves nothing but has rules", () => {
    expect(changeProblem(addSigner({ canSign: false }))).toMatch(/approves nothing/);
    expect(changeProblem(addSigner({ canSign: false, rules: [] }))).toBeNull();
  });

  it("edits a person's details and addresses only through the portal's contact fields", () => {
    expect(
      AccountChange.safeParse({ kind: "edit_person", contactId: LISA, fields: { title: "Buyer" } })
        .success,
    ).toBe(true);
    // Addresses are change_contact's; autonomy is nobody's to draft (the operator's alone).
    expect(
      AccountChange.safeParse({ kind: "edit_person", contactId: LISA, fields: { email: "x@y.co" } })
        .success,
    ).toBe(false);
    expect(
      AccountChange.safeParse({
        kind: "edit_person",
        contactId: LISA,
        fields: { autonomy: { email: "auto" } },
      }).success,
    ).toBe(false);
    expect(
      AccountChange.safeParse({
        kind: "change_contact",
        contactId: LISA,
        addresses: { email: "lisa@shop.example.com" },
      }).success,
    ).toBe(true);
    expect(
      AccountChange.safeParse({ kind: "change_contact", contactId: LISA, addresses: {} }).success,
    ).toBe(false);
  });

  it("reads a stored change back, and nothing else", () => {
    const stored = {
      change: addSigner(),
      now: ["Lisa is not on your team."],
      after: ["Lisa joins your team and approves changes."],
      askedBy: LISA,
      threadId: null,
      runId: null,
      agentVersionId: null,
      sources: [],
    };
    expect(readStoredAccountChange({ accountChange: stored })?.change.kind).toBe("add_signer");
    expect(readStoredAccountChange({ accountChange: { change: {} } })).toBeNull();
    expect(readStoredAccountChange(null)).toBeNull();
  });
});

const tool = (id: string, over: Partial<ToolSpec> = {}): ToolSpec => ({
  id,
  description: id,
  input: { type: "object" },
  output: { type: "object" },
  sideEffect: "none",
  verb: "read",
  source: "platform",
  ...over,
});

const TOOLS: Record<string, ToolSpec> = {
  "health.runs": tool("health.runs"),
  "testkit.record.get": tool("testkit.record.get", { source: "testkit" }),
  "testkit.record.update": tool("testkit.record.update", {
    source: "testkit",
    sideEffect: "external",
    verb: "update",
  }),
};

const SKILLS: Record<string, SkillDefinition> = {
  "sloan.read": {
    schemaVersion: 1,
    id: "sloan.read",
    name: "Read",
    description: "Reads a record",
    category: "test",
    mode: "agent",
    instructions: "Read.",
    tools: ["health.runs", "testkit.record.get"],
    input: { type: "object" },
    output: { type: "object" },
    settings: [],
    requiresConnectors: [],
    requiresPacks: [],
    producesAlerts: false,
  },
};

function bundle(over: {
  extraTools?: string[];
  skill?: string;
  kind?: "platform" | "functional";
}): AgentBundle {
  return AgentBundle.parse({
    schemaVersion: 1,
    definition: {
      schemaVersion: 2,
      identity: { name: "Sloan", role: "account", mission: "help" },
      kind: over.kind ?? "platform",
      model: { id: "claude-opus-5-5", maxTokens: 1024 },
      instructions: "Help.",
      skills: over.skill ? [{ skill: over.skill, settings: {} }] : [],
      extraTools: over.extraTools ?? [],
      canCommand: [],
      permissions: { mode: "suggest_only" },
      budgets: { maxSteps: 8, maxCostUsd: "0.30" },
      memory: { enabled: true },
    },
    workflows: [
      {
        slug: "fix",
        name: "Fix",
        workflow: {
          schemaVersion: 3,
          trigger: { id: "trg", on: { type: "manual", input: {} } },
          steps: [
            {
              id: "write",
              name: "Write",
              kind: "action",
              tool: "testkit.record.update",
              input: {},
            },
          ],
        },
      },
    ],
  } satisfies AgentBundleInput);
}

describe("the account agent's publish guard", () => {
  it("looks inside the automations its use steps pin", () => {
    const b = bundle({});
    const w = b.workflows[0];
    if (!w) throw new Error("no workflow");
    w.workflow.steps = [
      {
        id: "use",
        name: "Use",
        kind: "use_automation",
        automation: "fix-it@1",
        input: {},
      } as never,
    ];
    const automation = AutomationDefinition.parse({
      schemaVersion: 1,
      slug: "fix-it",
      name: "Fix it",
      steps: [{ id: "write", name: "Write", kind: "action", tool: "testkit.record.update" }],
    });
    const errors = accountAgentProblems({
      slug: "supervisor",
      bundle: b,
      skills: SKILLS,
      tools: TOOLS,
      automations: { "fix-it@1": automation },
    });
    expect(errors.map((e) => [e.stepId, e.field, e.code])).toEqual([
      ["use", "automation", "tool_not_allowed"],
    ]);
  });

  it("refuses connector and external tools wherever they appear, and any binding", () => {
    const errors = accountAgentProblems({
      slug: "supervisor",
      bundle: bundle({ extraTools: ["testkit.record.get", "health.runs"], skill: "sloan.read" }),
      skills: SKILLS,
      tools: TOOLS,
      bindings: { testkit: LISA },
    });
    expect(errors.map((e) => [e.field, e.code])).toEqual([
      ["definition.extraTools.0", "tool_not_allowed"],
      ["definition.skills.0.skill", "tool_not_allowed"],
      ["tool", "tool_not_allowed"],
      ["bindings", "tool_not_allowed"],
    ]);
    expect(errors[2]?.stepId).toBe("write");
  });

  it("leaves every other agent alone", () => {
    const args = {
      bundle: bundle({ extraTools: ["testkit.record.get"] }),
      skills: SKILLS,
      tools: TOOLS,
    };
    expect(accountAgentProblems({ ...args, slug: "records-clerk" })).toEqual([]);
    expect(
      accountAgentProblems({
        ...args,
        slug: "supervisor",
        bundle: bundle({ extraTools: ["testkit.record.get"], kind: "functional" }),
      }),
    ).toEqual([]);
  });

  // R9: the supervisor's v4 version holds processes; their read and write steps count, nested too.
  it("refuses a v4 process's read and write steps on a client's tool, inside an if", () => {
    const b = bundle({});
    const w = b.workflows[0];
    if (!w) throw new Error("no workflow");
    w.workflow = {
      schemaVersion: 4,
      triggers: [{ id: "trg", on: { type: "manual", input: {} } }],
      steps: [
        { id: "look", name: "Look", kind: "read", tool: "testkit.record.get", input: {} },
        {
          id: "when",
          name: "When",
          kind: "if",
          paths: [
            {
              id: "yes",
              name: "Yes",
              when: { match: "all", rules: [] },
              steps: [
                { id: "fix", name: "Fix", kind: "write", tool: "testkit.record.update", input: {} },
              ],
            },
          ],
          otherwise: { id: "no", steps: [] },
        },
      ],
    } as never;
    const errors = accountAgentProblems({
      slug: "supervisor",
      bundle: b,
      skills: SKILLS,
      tools: TOOLS,
    });
    expect(errors.map((e) => [e.stepId, e.field, e.code])).toEqual([
      ["look", "tool", "tool_not_allowed"],
      ["fix", "tool", "tool_not_allowed"],
    ]);
  });
});

describe("what Sloan reads", () => {
  it("carries no field a portal response may not (bundles, prompts, cost)", () => {
    for (const schema of [
      AccountService,
      AccountRunSummary,
      AccountRunView,
      AccountWaitingItem,
      AccountWaitExplanation,
    ]) {
      expect(forbiddenPortalFields(schema)).toEqual([]);
    }
  });
});

describe("the words", () => {
  it("are there in every language", () => {
    for (const locale of LOCALES) {
      const w = ACCOUNT_WORDS[locale];
      expect(w.title.addSigner("Lisa")).toContain("Lisa");
      expect(w.field("email", "a@b.co")).toContain("a@b.co");
      expect(w.signs("Rule", w.admins)).toContain(w.admins);
      expect(w.askedBy("Ana")).toContain("Ana");
    }
  });
});
