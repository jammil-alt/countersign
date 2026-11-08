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
        schemaVersion: 3,
        trigger: { id: "intake-trigger", on: { type: "event", event: "transaction.created" } },
        steps: [
          {
            id: "find",
            name: "Find the invoice",
            kind: "skill",
            skill: "docs.find-support",
            input: { transactionId: "{{trigger.transactionId}}" },
            client: { visible: true, label: "Found the invoice" },
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
                    kind: "person",
                    mode: "ask",
                    assignee: "client_admin",
                    title: "Forward or upload the invoice for this purchase",
                    payload: { transactionId: "{{trigger.transactionId}}" },
                    timeout: "5 days",
                    remindEvery: "2 days",
                    onTimeout: "notify_operator",
                    client: { visible: true, label: "Asked you for the invoice" },
                  },
                  // DECISION: the run ends after asking; the invoice, once forwarded or uploaded,
                  // is linked to the purchase and read, and the operator re-runs intake for it.
                  {
                    id: "stop-no-document",
                    name: "Stop until the invoice arrives",
                    kind: "stop",
                    status: "succeeded",
                    client: { visible: false },
                  },
                ],
              },
            ],
            otherwise: { id: "has-document", steps: [] },
          },
          {
            id: "read",
            name: "Read the invoice",
            kind: "skill",
            skill: "docs.extract",
            input: { documentId: "{{steps.find.output.documentIds.0}}" },
            client: { visible: true, label: "Read the invoice" },
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
                    kind: "person",
                    mode: "approve",
                    assignee: "client_admin",
                    title: "The totals on this invoice don't add up. Price its lines anyway?",
                    payload: { documentId: doc, problems: "{{steps.read.output.problems}}" },
                    timeout: "5 days",
                    onReject: "stop",
                    onTimeout: "notify_operator",
                    client: { visible: true, label: "Checked the invoice totals with you" },
                  },
                ],
              },
            ],
            otherwise: { id: "totals-ok", steps: [] },
          },
          {
            id: "match",
            name: "Match the lines",
            kind: "skill",
            skill: "materials.match-lines",
            input: { documentId: doc },
            client: { visible: true, label: "Matched the lines to your catalog" },
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
                    kind: "person",
                    mode: "ask",
                    assignee: "client_admin",
                    title: "Which catalog items are these invoice lines?",
                    // `review` tells the inbox to show the match review card (Match, New item,
                    // Skip) for these lines.
                    payload: {
                      review: "materials.match",
                      documentId: doc,
                      docLineIds: "{{steps.match.output.belowThreshold}}",
                    },
                    timeout: "5 days",
                    remindEvery: "2 days",
                    onTimeout: "continue",
                    client: { visible: true, label: "Asked you about lines we weren't sure of" },
                  },
                ],
              },
            ],
            otherwise: { id: "all-matched", steps: [] },
          },
          {
            id: "prices",
            name: "Record the prices",
            kind: "skill",
            skill: "materials.record-prices",
            input: { documentId: doc },
            client: { visible: true, label: "Recorded the prices" },
          },
          {
            id: "check",
            name: "Check the prices",
            kind: "skill",
            skill: "materials.price-check",
            input: { documentId: doc },
            client: { visible: true, label: "Checked the prices" },
          },
        ],
      },
    },
  ],
};

export const PURCHASING_TEST_BUNDLE: AgentBundle = AgentBundleSchema.parse(bundle);
