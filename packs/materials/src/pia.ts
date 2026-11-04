// The Pia template (ARCHITECTURE §12.2): purchasing, built only from platform parts and this pack's
// skills. Installing the pack adds her once as a template v1 the operator edits like any other;
// each client gets her through the usual fork. Her two workflows:
//
// purchase-intake (a new purchase): find the invoice (ask the client when there is none), read it
// (a person checks totals that don't add up), match its lines (a person reviews the unsure ones),
// record the prices and check them, raising alerts with their evidence.
//
// weekly-price-review (Mondays 7:00, the client's time): the week's digest, which the operator
// reviews before it goes to the client.
//
// DECISION: the QuickBooks steps (itemize the bill or purchase, attach the invoice) and the Gmail
// steps (draft to the purchaser, label "Processed") are not in v1 of the template: their tools
// arrive with M9 and M10, and a step naming a tool that isn't registered fails validation. They
// come to each client as a template update (a new version), behind approval like every write.
// Until then no step of Pia writes to a client's tool, so none needs an approval setting; the
// person steps are the human checks the architecture lists.

import type { AgentBundle, AgentBundleInput } from "@countersign/core";
import { AgentBundle as AgentBundleSchema } from "@countersign/core";
import { DEFAULT_MODELS } from "@countersign/llm";

export const PIA_SLUG = "pia";
/** What clients see the service called in the portal, unless the operator names it otherwise. */
export const PIA_SERVICE_NAME = "Material cost monitoring";

const doc = "{{steps.read.output.documentId}}";

const bundle: AgentBundleInput = {
  schemaVersion: 1,
  definition: {
    schemaVersion: 2,
    identity: {
      name: "Pia",
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
      { skill: "materials.vendor-compare", settings: {} },
      { skill: "materials.weekly-digest", settings: {} },
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
        trigger: { id: "pia-intake-trigger", on: { type: "event", event: "transaction.created" } },
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
    {
      slug: "weekly-price-review",
      name: "Weekly price review",
      workflow: {
        schemaVersion: 3,
        trigger: { id: "pia-weekly-trigger", on: { type: "schedule", cron: "0 7 * * 1" } },
        steps: [
          {
            id: "digest",
            name: "Sum up the week",
            kind: "skill",
            skill: "materials.weekly-digest",
            input: { asOf: "{{trigger.scheduledAt}}" },
            client: { visible: false },
          },
          {
            id: "review-digest",
            name: "Review the digest",
            kind: "person",
            mode: "approve",
            assignee: "operator",
            title: "Send this week's price digest?",
            payload: { message: "{{steps.digest.output.message}}" },
            timeout: "2 days",
            onReject: "stop",
            onTimeout: "stop",
            client: { visible: false },
          },
          {
            id: "send-digest",
            name: "Send the digest",
            kind: "notify",
            channel: "digest",
            message: "{{steps.digest.output.message}}",
            client: { visible: true, label: "Sent your weekly price digest" },
          },
        ],
      },
    },
  ],
};

export const PIA_BUNDLE: AgentBundle = AgentBundleSchema.parse(bundle);

export const PIA_TEMPLATE = { slug: PIA_SLUG, bundle: PIA_BUNDLE };
