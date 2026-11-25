// A purchasing agent as an operator might build it in the Agent lab, for the API's tests only
// (docs/plan.md §1.63: packs ship skills and tools, not agents). Its one workflow, purchase intake,
// uses only the platform's skills and the Materials pack's: find the invoice for a new purchase, read
// it, match its lines to the catalog, record the prices and check them.

import {
  type AgentBundle,
  type AgentBundleInput,
  AgentBundle as AgentBundleSchema,
} from "@countersign/core";
import { DEFAULT_MODELS } from "@countersign/llm";

const doc = "{{steps.read.output.documentId}}";

const bundle: AgentBundleInput = {
  schemaVersion: 1,
  definition: {
    schemaVersion: 2,
    identity: {
      name: "Buyer",
      role: "Purchasing",
      mission: "Know what every material costs, from every vendor, and say so when a price moves.",
    },
    kind: "functional",
    model: { id: DEFAULT_MODELS.reasoning, maxTokens: 4096 },
    instructions: [
      "You look after what the shop pays for materials.",
      "Every invoice line is matched to the shop's catalog before its price is recorded, so prices compare across vendors in one unit.",
      "Cite the records you used. Never invent a price or a quantity; when something is unclear, ask a person.",
    ].join(" "),
    skills: [
      { skill: "docs.find-support", settings: {} },
      { skill: "docs.extract", settings: {} },
      { skill: "materials.match-lines", settings: {} },
      { skill: "materials.record-prices", settings: {} },
      { skill: "materials.price-check", settings: {} },
    ],
    extraTools: [],
    canCommand: [],
    permissions: { mode: "suggest_only" },
    budgets: { maxSteps: 12, maxCostUsd: "0.50" },
    memory: { enabled: true },
  },
  workflows: [
    {
      slug: "purchase-intake",
      name: "Purchase intake",
      workflow: {
        schemaVersion: 5,
        triggers: [{ id: "intake-trigger", on: { type: "event", event: "transaction.created" } }],
        outputs: [{ id: "out-done", name: "Done", kind: "nothing" }],
        steps: [
          {
            id: "find",
            name: "Find the invoice",
            client: { visible: true, label: "Found the invoice" },
            kind: "do",
            doneBy: "rules",
            uses: { type: "action", action: "docs.find_support" },
            input: { transactionId: "{{trigger.transactionId}}" },
          },
          {
            id: "no-document",
            name: "No document",
            kind: "fork",
            paths: [
              {
                id: "no-document-path",
                name: "No document",
                when: {
                  match: "all",
                  rules: [{ field: "{{steps.find.output.status}}", op: "!=", value: "found" }],
                },
                steps: [
                  {
                    id: "ask-for-invoice",
                    name: "Ask for the invoice",
                    client: { visible: true, label: "Asked you for the invoice" },
                    kind: "do",
                    doneBy: "person",
                    person: {
                      mode: "ask",
                      who: "client_admin",
                      question: "Forward or upload the invoice for this purchase",
                      show: { transactionId: "{{trigger.transactionId}}" },
                      deadline: {
                        after: "5 days",
                        hours: "clock",
                        ifNoAnswer: "stop",
                        remind: ["2 days"],
                        tell: ["operator"],
                      },
                      channel: "inbox",
                      onReject: "stop",
                    },
                  },
                  {
                    id: "stop-no-document",
                    name: "Stop until the invoice arrives",
                    client: { visible: false },
                    kind: "end",
                    outputs: ["out-done"],
                  },
                ],
              },
            ],
            otherwise: { id: "has-document", steps: [] },
          },
          {
            id: "read",
            name: "Read the invoice",
            client: { visible: true, label: "Read the invoice" },
            kind: "do",
            doneBy: "rules",
            uses: { type: "action", action: "docs.extract" },
            input: { documentId: "{{steps.find.output.documentIds.0}}" },
          },
          {
            id: "totals",
            name: "Totals don't add up",
            kind: "fork",
            paths: [
              {
                id: "totals-off",
                name: "Totals don't add up",
                when: {
                  match: "all",
                  rules: [{ field: "{{steps.read.output.totalsMatch}}", op: "=", value: false }],
                },
                steps: [
                  {
                    id: "check-totals",
                    name: "Check the totals",
                    client: { visible: true, label: "Checked the invoice totals with you" },
                    kind: "do",
                    doneBy: "person",
                    person: {
                      mode: "approve",
                      who: "client_admin",
                      question: "The totals on this invoice don't add up. Price its lines anyway?",
                      show: {
                        documentId: "{{steps.read.output.documentId}}",
                        problems: "{{steps.read.output.problems}}",
                      },
                      deadline: {
                        after: "5 days",
                        hours: "clock",
                        ifNoAnswer: "stop",
                        tell: ["operator"],
                      },
                      channel: "inbox",
                      onReject: "stop",
                    },
                  },
                ],
              },
            ],
            otherwise: { id: "totals-ok", steps: [] },
          },
          {
            id: "match",
            name: "Match the lines",
            client: { visible: true, label: "Matched the lines to your catalog" },
            kind: "do",
            doneBy: "rules",
            uses: { type: "action", action: "materials.match_lines" },
            input: { documentId: "{{steps.read.output.documentId}}" },
          },
          {
            id: "review",
            name: "Any line below threshold",
            kind: "fork",
            paths: [
              {
                id: "review-lines",
                name: "Any line below threshold",
                when: {
                  match: "all",
                  rules: [{ field: "{{steps.match.output.needsReview}}", op: ">", value: 0 }],
                },
                steps: [
                  {
                    id: "review-matches",
                    name: "Review the matches",
                    client: { visible: true, label: "Asked you about lines we weren't sure of" },
                    kind: "do",
                    doneBy: "person",
                    person: {
                      mode: "ask",
                      who: "client_admin",
                      question: "Which catalog items are these invoice lines?",
                      show: {
                        review: "materials.match",
                        documentId: "{{steps.read.output.documentId}}",
                        docLineIds: "{{steps.match.output.belowThreshold}}",
                      },
                      deadline: {
                        after: "5 days",
                        hours: "clock",
                        ifNoAnswer: "proceed",
                        remind: ["2 days"],
                      },
                      channel: "inbox",
                      onReject: "stop",
                    },
                  },
                ],
              },
            ],
            otherwise: { id: "all-matched", steps: [] },
          },
          {
            id: "prices",
            name: "Record the prices",
            client: { visible: true, label: "Recorded the prices" },
            kind: "do",
            doneBy: "rules",
            uses: { type: "action", action: "materials.prices.record" },
            input: { documentId: "{{steps.read.output.documentId}}" },
          },
          {
            id: "check",
            name: "Check the prices",
            client: { visible: true, label: "Checked the prices" },
            kind: "do",
            doneBy: "rules",
            uses: { type: "action", action: "materials.prices.check" },
            input: { documentId: "{{steps.read.output.documentId}}" },
          },
          { id: "end", kind: "end", name: "Done", outputs: ["out-done"] },
        ],
      },
    },
  ],
};

export const PURCHASING_TEST_BUNDLE: AgentBundle = AgentBundleSchema.parse(bundle);
