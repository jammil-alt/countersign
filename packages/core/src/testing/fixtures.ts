// Test fixtures shared by core's tests (not exported from the package).
import { cloneJson } from "../json";
import {
  type AgentBundle,
  type AgentBundleInput,
  AgentBundle as AgentBundleSchema,
} from "../schemas/agent";
import { EventTypeSpec as EventSchema, type EventTypeSpec } from "../schemas/event";
import { type SkillDefinition, SkillDefinition as SkillSchema } from "../schemas/skill";
import { ToolSpec as ToolSchema, type ToolSpec } from "../schemas/tool";
import type { Workflow } from "../schemas/workflow";
import type { ValidationContext } from "../workflow/validate";

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

const LINES = {
  type: "array",
  items: obj({ description: { type: "string" }, qty: { type: "number" } }),
};

export const tools: Record<string, ToolSpec> = Object.fromEntries(
  [
    {
      id: "docs.extract",
      description: "Extract a document",
      input: obj({ documentId: { type: "string" } }, ["documentId"]),
      output: obj({ documentId: { type: "string" }, total: { type: "string" }, lines: LINES }),
      sideEffect: "internal",
      verb: "create",
      source: "platform",
    },
    {
      id: "qbo.bill.query",
      description: "Find bills",
      input: obj({ vendor: { type: "string" } }),
      output: obj({ bills: { type: "array" } }),
      sideEffect: "none",
      verb: "read",
      source: "qbo",
      connector: "qbo",
    },
    {
      id: "qbo.bill.update_lines",
      description: "Itemize a bill",
      input: obj({ billId: { type: "string" }, lines: LINES }, ["billId"]),
      output: obj({ billId: { type: "string" } }),
      sideEffect: "external",
      verb: "update",
      source: "qbo",
      connector: "qbo",
    },
    {
      id: "qbo.attachable.upload",
      description: "Attach a document",
      input: obj({ documentId: { type: "string" }, billId: { type: "string" } }, ["documentId"]),
      output: obj({ attachableId: { type: "string" } }),
      sideEffect: "external",
      verb: "create",
      source: "qbo",
      connector: "qbo",
      summary: "Attached {{attachableId}}",
    },
  ].map((t) => [t.id, ToolSchema.parse(t)]),
);

export const skills: Record<string, SkillDefinition> = Object.fromEntries(
  [
    {
      schemaVersion: 1,
      id: "docs.extract",
      name: "Extract",
      description: "Extract an invoice",
      category: "documents",
      mode: "tool",
      handler: "docs.extract",
      tools: [],
      input: obj({ documentId: { type: "string" } }, ["documentId"]),
      output: obj({ documentId: { type: "string" }, total: { type: "string" }, lines: LINES }),
    },
    {
      schemaVersion: 1,
      id: "test.itemize",
      name: "Itemize",
      description: "Itemize bills",
      category: "accounting",
      mode: "agent",
      instructions: "Itemize the bill",
      tools: ["qbo.bill.query", "qbo.bill.update_lines"],
      input: obj({ billId: { type: "string" } }),
      output: obj({ updated: { type: "boolean" } }),
      settings: [
        { key: "vendors", label: "Vendors", type: "string", default: "", clientSpecific: true },
        { key: "threshold", label: "Threshold", type: "number", default: 5 },
      ],
    },
    {
      schemaVersion: 1,
      id: "test.summarize",
      name: "Summarize",
      description: "Summarize a line",
      category: "general",
      mode: "agent",
      instructions: "Summarize",
      tools: [],
      input: obj({ text: { type: "string" } }, ["text"]),
      output: obj({ summary: { type: "string" } }),
    },
  ].map((s) => [s.id, SkillSchema.parse(s)]),
);

export const events: Record<string, EventTypeSpec> = {
  "document.received": EventSchema.parse({
    type: "document.received",
    description: "A document arrived",
    payload: obj({
      documentId: { type: "string" },
      vendor: { type: "string" },
      total: { type: "number" },
    }),
    sample: { documentId: "d1", vendor: "Acme", total: 120 },
  }),
};

export const ctx: ValidationContext = { tools, skills, events };

export function workflowInput(): Workflow {
  return {
    schemaVersion: 3,
    trigger: { id: "t1", on: { type: "event", event: "document.received" } },
    steps: [
      {
        id: "s1",
        name: "Extract",
        kind: "skill",
        skill: "docs.extract",
        input: { documentId: "{{trigger.documentId}}" },
      },
      {
        id: "s2",
        name: "Big?",
        kind: "fork",
        paths: [
          {
            id: "p1",
            name: "Big",
            when: { match: "all", rules: [{ field: "{{trigger.total}}", op: ">", value: 500 }] },
            steps: [
              {
                id: "s3",
                name: "Approve",
                kind: "person",
                mode: "approve",
                assignee: "client_admin",
                title: "Approve {{trigger.vendor}}",
                payload: { total: "{{trigger.total}}" },
                timeout: "5 days",
                channel: "inbox",
                onReject: "stop",
                onTimeout: "stop",
              },
            ],
          },
        ],
        otherwise: {
          id: "o1",
          steps: [
            { id: "s4", name: "Note", kind: "notify", channel: "thread", message: "Small one" },
          ],
        },
      },
      {
        id: "s5",
        name: "Each line",
        kind: "for_each",
        over: "{{steps.s1.output.lines}}",
        concurrency: 10,
        steps: [
          {
            id: "s6",
            name: "Summarize",
            kind: "skill",
            skill: "test.summarize",
            input: { text: "{{item.description}}" },
          },
        ],
      },
      {
        id: "s7",
        name: "Attach",
        kind: "action",
        tool: "qbo.attachable.upload",
        input: { documentId: "{{steps.s1.output.documentId}}" },
        approval: { required: "required", onReject: "stop" },
      },
    ],
  };
}

export function bundleInput(): AgentBundleInput {
  return {
    schemaVersion: 1,
    definition: {
      schemaVersion: 2,
      identity: { name: "Clerk", role: "Clerk", mission: "File invoices" },
      kind: "functional",
      model: { id: "claude-sonnet-4-5" },
      instructions: "Work carefully.",
      skills: [
        { skill: "docs.extract" },
        { skill: "test.itemize", settings: { threshold: 5 } },
        { skill: "test.summarize" },
      ],
      extraTools: ["qbo.attachable.upload"],
      permissions: { mode: "suggest_only" },
    },
    workflows: [{ slug: "intake", name: "Intake", workflow: workflowInput() }],
  };
}

export function bundle(): AgentBundle {
  return AgentBundleSchema.parse(bundleInput());
}

/** A deep copy changed by `fn`. */
export function edit<T>(value: T, fn: (draft: T) => void): T {
  const copy = cloneJson(value);
  fn(copy);
  return copy;
}
