// The SOP's test fixture (docs/sop-plan.md): "Bills in" at Harbor Millwork, used by the SOP's tests
// and the agent assurance tests (docs/agent-assurance-plan.md), which read the same setup.
import type { AnyAgentBundle } from "../schemas/agent";
import type { PermissionMatrix } from "../schemas/permissions";
import type { SkillDefinition } from "../schemas/skill";
import type { ToolSpec } from "../schemas/tool";
import { type SopConnection, type SopInput, sopCode } from "./build";

export const ADA = "0199a000-0000-7000-8000-00000000000a";
export const BEN = "0199a000-0000-7000-8000-00000000000b";
export const CARA = "0199a000-0000-7000-8000-00000000000c";
export const RULE = "0199a000-0000-7000-8000-0000000000f1";

const tool = (
  t: Partial<ToolSpec> & Pick<ToolSpec, "id" | "sideEffect" | "verb" | "source">,
): ToolSpec => ({ description: t.id, input: {}, output: {}, ...t }) as ToolSpec;

export const TOOLS: Record<string, ToolSpec> = {
  "doc.read": tool({
    id: "doc.read",
    sideEffect: "internal",
    verb: "create",
    source: "platform",
    entity: "bill",
    usesModel: "reads PDFs",
  }),
  "qbo.vendor.find": tool({
    id: "qbo.vendor.find",
    sideEffect: "none",
    verb: "read",
    source: "qbo",
    connector: "qbo",
    entity: "vendor",
  }),
  "materials.match": tool({
    id: "materials.match",
    sideEffect: "internal",
    verb: "create",
    source: "materials",
    entity: "catalog_match",
    area: "purchasing",
  }),
  "qbo.bill.create": tool({
    id: "qbo.bill.create",
    sideEffect: "external",
    verb: "create",
    source: "qbo",
    connector: "qbo",
    entity: "bill",
  }),
  "qbo.bill.attach": tool({
    id: "qbo.bill.attach",
    sideEffect: "external",
    verb: "update",
    source: "qbo",
    connector: "qbo",
    entity: "bill",
  }),
};

export const SKILLS: Record<string, SkillDefinition> = {
  "builtin:read-bill@1": {
    mode: "task",
    method: "ai",
    model: { id: "claude-sonnet-5-5" },
    tools: ["doc.read"],
  } as unknown as SkillDefinition,
  "builtin:match-lines@1": {
    mode: "task",
    method: "rules_then_ai",
    model: { id: "claude-haiku-5-5" },
    tools: ["materials.match"],
  } as unknown as SkillDefinition,
};

export function bundle(
  over: { attachApproval?: "required" | "not_required"; mode?: "act" | "suggest_only" } = {},
): AnyAgentBundle {
  return {
    schemaVersion: 1,
    definition: {
      schemaVersion: 2,
      identity: { name: "Bills in", role: "clerk", mission: "bills" },
      kind: "functional",
      model: { id: "claude-sonnet-5-5", maxTokens: 4000 },
      instructions: "SECRET INSTRUCTIONS",
      skills: [],
      extraTools: [],
      canCommand: [],
      permissions: { mode: over.mode ?? "act" },
      budgets: { maxSteps: 20, maxCostUsd: 1 },
      memory: { enabled: false },
      manual: {
        whatItDoes: "Enter every vendor bill into QuickBooks",
        decisions: [
          {
            id: "d1",
            what: "Freight lines stay out of the catalog",
            why: "",
            kind: "assumption",
            risk: "normal",
            status: "never_discussed",
            by: null,
            at: null,
            stepId: "match",
          },
        ],
        decisionPoints: [],
        knownRisks: [{ id: "r1", what: "Bills in another currency", detail: "operator detail" }],
      },
    },
    workflows: [
      {
        slug: "main",
        name: "Bills in",
        enabled: true,
        workflow: {
          schemaVersion: 4,
          triggers: [{ id: "t1", on: { type: "event", event: "document.received" } }],
          steps: [
            {
              id: "read",
              name: "Read the bill",
              kind: "skill",
              skill: "builtin:read-bill@1",
              input: {},
            },
            {
              id: "vendor",
              name: "Find the vendor",
              kind: "read",
              tool: "qbo.vendor.find",
              input: {},
              purpose: "Looks the vendor up so the bill goes to the right vendor",
            },
            {
              id: "match",
              name: "Match each line",
              kind: "skill",
              skill: "builtin:match-lines@1",
              input: {},
            },
            {
              id: "look",
              name: "Does a person need to look first?",
              kind: "if",
              paths: [
                {
                  id: "p1",
                  name: "Alert",
                  describe: "a price alert or a new vendor",
                  when: {
                    match: "any",
                    rules: [{ field: "steps.match.output.alert", op: "eq", value: true }],
                  },
                  steps: [
                    {
                      id: "review",
                      name: "Review the price alert",
                      kind: "person",
                      mode: "ask",
                      assignee: CARA,
                      title: "Review",
                      payload: {},
                      deadline: {
                        after: "1d",
                        hours: "business",
                        ifNoAnswer: {
                          escalate: {
                            to: "lead",
                            deadline: { after: "1d", hours: "business", ifNoAnswer: "stop" },
                          },
                        },
                      },
                      channel: "inbox",
                      onReject: "stop",
                    },
                  ],
                },
              ],
              otherwise: { id: "o1", steps: [] },
            },
            {
              id: "create",
              name: "Create the bill in QuickBooks",
              kind: "write",
              tool: "qbo.bill.create",
              input: {},
              checks: {
                approval: {
                  required: "required",
                  mode: "in_turn",
                  approvers: [{ who: BEN }],
                  ifNoAnswer: "stop",
                  onReject: "stop",
                },
              },
            },
            {
              id: "attach",
              name: "Attach the PDF",
              kind: "write",
              tool: "qbo.bill.attach",
              input: {},
              checks: {
                approval: {
                  required: over.attachApproval ?? "not_required",
                  mode: "in_turn",
                  ifNoAnswer: "stop",
                  onReject: "stop",
                },
              },
            },
          ],
        },
      },
    ],
  } as unknown as AnyAgentBundle;
}

export const QBO = (
  matrix: Partial<PermissionMatrix>,
  grant: SopConnection["grant"] = null,
): SopConnection => ({
  key: "qbo",
  connector: "qbo",
  id: "0199a000-0000-7000-8000-0000000000c1",
  name: "QuickBooks Online",
  account: "Harbor Millwork LLC",
  connected: true,
  connectedBy: "Ada Ruiz",
  matrix,
  grant,
});

export const NAMES: Record<string, string> = {
  [ADA]: "Ada Ruiz",
  [BEN]: "Ben Ortiz",
  [CARA]: "Cara Lin",
};

export function input(
  over: Partial<SopInput> & {
    stage?: string;
    matrix?: Partial<PermissionMatrix>;
    grant?: SopConnection["grant"];
    b?: AnyAgentBundle;
  } = {},
): SopInput {
  return {
    agent: {
      id: "0199a000-0000-7000-8000-0000000000a1",
      slug: "bills-in",
      name: "Bills in",
      area: "purchasing",
      stage: over.stage ?? "live",
      runStatus: "active",
      approver: null,
    },
    client: "Harbor Millwork",
    code: sopCode("purchasing", 3),
    bundle: over.b ?? bundle(),
    skills: SKILLS,
    tools: TOOLS,
    connections: [
      QBO(
        over.matrix ?? { read: "auto", create: "approval", update: "auto", delete: "off" },
        over.grant ?? null,
      ),
    ],
    party: (who) =>
      NAMES[who]
        ? { key: who, kind: "person", name: NAMES[who] as string }
        : who === "lead"
          ? { key: "lead", kind: "person", name: "Sam Patel" }
          : {
              key: `role:${who}`,
              kind: "team",
              name: who === "client_admin" ? "Your admin" : "Your team",
            },
    agentParty: (slug) => ({ key: `agent:${slug}`, kind: "agent", name: slug }),
    accountable: [{ key: ADA, kind: "person", name: "Ada Ruiz" }],
    owner: {
      party: { key: "owner:purchasing", kind: "agent", name: "Pia" },
      model: "claude-opus-5-5",
    },
    lead: { key: "lead", kind: "person", name: "Sam Patel" },
    approverRules: [
      {
        id: RULE,
        match: { connector: "qbo", amountOver: { value: "5000.00", currency: "USD" } },
        approver: { kind: "user", userId: ADA },
        setBy: "client",
      },
    ],
    clientApprover: null,
    businessHours: "Monday to Friday, 8:00 to 17:00 Central",
    modelName: (id) =>
      ({
        "claude-sonnet-5-5": "Claude Sonnet 5.5",
        "claude-haiku-5-5": "Claude Haiku 5.5",
        "claude-opus-5-5": "Claude Opus 5.5",
      })[id] ?? null,
    hipaa: false,
    measures: [{ label: "Bills entered, this month", value: "142" }],
    policies: ["Writing into your tools"],
    takesOverFrom: [],
    knowledge: [],
    settings: [],
    learned: null,
    fallbackPurpose: null,
    asOf: "2026-11-21T09:14:00.000Z",
    revision: null,
    previous: null,
    history: [],
    ...over,
  };
}
