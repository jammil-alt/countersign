// Skill model (2026-11-10; docs/plan.md §1.86 "Skill model"): step patterns for the template
// stream. Skills think, tools act: each pattern is skills that turn data into data, If steps that
// route on what they found (never logic inside a skill), a person where one is needed, and a write
// step for every change, "Save to records" for our own records (approval off by default) and
// "Change in <connector>" for a client's tool (approval on, invariant 8). Every step id is fixed
// (merges depend on them, invariant 3); a prefix keeps two uses of a pattern apart.
//
// "Process a vendor invoice":
//   Read document (AI) → Check totals → If they don't add up: a person → Save to records: the
//   reading → Look up existing → If any open: Match the unmatched (AI) → Check matches → If any
//   needs a person: a person → Save to records: the matches and aliases → Compare to historicals →
//   Save to records: the prices → If any alert: Save to records: raise the alerts.

import type { processes } from "@countersign/core";

type Step = processes.Step;

/** The manual trigger with a document id, for running a pattern on its own. */
export const DOCUMENT_TRIGGER = {
  id: "trg-document",
  on: {
    type: "manual" as const,
    input: {
      type: "object",
      properties: { documentId: { type: "string", format: "uuid" } },
      required: ["documentId"],
      additionalProperties: false,
    },
  },
};

const PERSON_DEADLINE = {
  after: "3 days",
  hours: "business" as const,
  remind: ["1 day"],
  ifNoAnswer: "stop" as const,
};

/** Read and check a document, a person when the totals don't add up, then record the reading. */
export function readInvoiceSteps(documentId: string, prefix = ""): Step[] {
  const id = (s: string) => `${prefix}${s}`;
  return [
    {
      id: id("read"),
      name: "Read the invoice",
      kind: "skill",
      skill: "docs.read-document",
      input: { documentId },
      client: { visible: true, label: "Read the invoice" },
    },
    {
      id: id("totals"),
      name: "Check the totals",
      kind: "skill",
      skill: "docs.check-totals",
      input: { reading: `{{steps.${id("read")}.output}}` },
      client: { visible: false },
    },
    {
      id: id("totals-off"),
      name: "Totals don't add up?",
      kind: "if",
      paths: [
        {
          id: id("totals-off-path"),
          name: "They don't",
          when: {
            match: "all",
            rules: [
              { field: `{{steps.${id("totals")}.output.totalsMatch}}`, op: "=", value: false },
            ],
          },
          steps: [
            {
              id: id("totals-person"),
              name: "Ask a person to check the totals",
              kind: "person",
              mode: "approve",
              assignee: "client_admin",
              title: `Check the totals on {{steps.${id("totals")}.output.vendorName}} invoice {{steps.${id("totals")}.output.invoiceNumber}}`,
              payload: {
                documentId,
                problems: `{{steps.${id("totals")}.output.problems}}`,
              },
              deadline: PERSON_DEADLINE,
              channel: "inbox",
              onReject: "stop",
              client: { visible: true, label: "Asked you to check an invoice's totals" },
            },
          ],
        },
      ],
      otherwise: { id: id("totals-ok"), steps: [] },
    },
    {
      id: id("save-reading"),
      name: "Save to records: the reading",
      kind: "write",
      tool: "docs.reading.record",
      input: { documentId, reading: `{{steps.${id("totals")}.output.reading}}` },
      client: { visible: false },
    },
  ];
}

/** Match a recorded document's lines to the catalog, a person for what the rules veto, record. */
export function matchLinesSteps(documentId: string, prefix = ""): Step[] {
  const id = (s: string) => `${prefix}${s}`;
  return [
    {
      id: id("lookup"),
      name: "Look up existing",
      kind: "skill",
      skill: "materials.lookup-existing",
      input: { documentId },
      client: { visible: false },
    },
    {
      id: id("open"),
      name: "Any lines left open?",
      kind: "if",
      paths: [
        {
          id: id("open-path"),
          name: "Some",
          when: {
            match: "all",
            rules: [{ field: `{{steps.${id("lookup")}.output.openCount}}`, op: ">", value: 0 }],
          },
          steps: [
            {
              id: id("match"),
              name: "Match the unmatched",
              kind: "skill",
              skill: "materials.match-unmatched",
              input: { lines: `{{steps.${id("lookup")}.output.open}}` },
              client: { visible: false },
            },
            {
              id: id("check"),
              name: "Check matches",
              kind: "skill",
              skill: "materials.check-matches",
              input: {
                lines: `{{steps.${id("lookup")}.output.lines}}`,
                answers: `{{steps.${id("match")}.output.answers}}`,
              },
              client: { visible: false },
            },
            {
              id: id("needs-person"),
              name: "Any line for a person?",
              kind: "if",
              paths: [
                {
                  id: id("needs-person-path"),
                  name: "Some",
                  when: {
                    match: "all",
                    rules: [
                      {
                        field: `{{steps.${id("check")}.output.anyNeedsReview}}`,
                        op: "=",
                        value: true,
                      },
                    ],
                  },
                  steps: [
                    {
                      id: id("person"),
                      name: "Ask a person about the lines we weren't sure of",
                      kind: "person",
                      mode: "approve",
                      assignee: "client_admin",
                      title: `{{steps.${id("check")}.output.needsReview}} invoice lines need you`,
                      payload: { documentId, lines: `{{steps.${id("check")}.output.lines}}` },
                      deadline: PERSON_DEADLINE,
                      channel: "inbox",
                      onReject: "stop",
                      client: { visible: true, label: "Asked you about lines we weren't sure of" },
                    },
                  ],
                },
              ],
              otherwise: { id: id("needs-person-none"), steps: [] },
            },
            {
              id: id("save-open"),
              name: "Save to records: the matches",
              kind: "write",
              tool: "materials.matches.record",
              input: { lines: `{{steps.${id("check")}.output.lines}}` },
              client: { visible: false },
            },
          ],
        },
      ],
      otherwise: {
        id: id("open-none"),
        steps: [
          {
            id: id("check-settled"),
            name: "Check matches",
            kind: "skill",
            skill: "materials.check-matches",
            input: { lines: `{{steps.${id("lookup")}.output.lines}}`, answers: [] },
            client: { visible: false },
          },
          {
            id: id("save-settled"),
            name: "Save to records: the matches",
            kind: "write",
            tool: "materials.matches.record",
            input: { lines: `{{steps.${id("check-settled")}.output.lines}}` },
            client: { visible: false },
          },
        ],
      },
    },
  ];
}

/** Compare a matched document's prices, record them, and raise the alerts that fire. */
export function priceSteps(documentId: string, prefix = ""): Step[] {
  const id = (s: string) => `${prefix}${s}`;
  return [
    {
      id: id("compare"),
      name: "Compare to historicals",
      kind: "skill",
      skill: "materials.compare-prices",
      input: { documentId },
      client: { visible: false },
    },
    {
      id: id("save-prices"),
      name: "Save to records: the prices",
      kind: "write",
      tool: "materials.prices.record",
      input: { documentId },
      client: { visible: false },
    },
    {
      id: id("alerts"),
      name: "Any alert?",
      kind: "if",
      paths: [
        {
          id: id("alerts-path"),
          name: "Some",
          when: {
            match: "all",
            rules: [{ field: `{{steps.${id("compare")}.output.anyAlerts}}`, op: "=", value: true }],
          },
          steps: [
            {
              id: id("save-alerts"),
              name: "Save to records: raise the alerts",
              kind: "write",
              tool: "materials.prices.check",
              input: { documentId },
              client: { visible: true, label: "Raised price alerts" },
            },
          ],
        },
      ],
      otherwise: { id: id("alerts-none"), steps: [] },
    },
  ];
}

/** "Process a vendor invoice", whole: read, match, price. */
export function vendorInvoiceProcess(): processes.Process {
  const documentId = "{{trigger.documentId}}";
  return {
    schemaVersion: 4,
    triggers: [DOCUMENT_TRIGGER],
    steps: [
      ...readInvoiceSteps(documentId),
      ...matchLinesSteps(documentId),
      ...priceSteps(documentId),
    ],
  } as processes.Process;
}

/** The skills the pattern uses (an agent lists them in `definition.skills`). */
export const VENDOR_INVOICE_SKILLS = [
  "docs.read-document",
  "docs.check-totals",
  "materials.lookup-existing",
  "materials.match-unmatched",
  "materials.check-matches",
  "materials.compare-prices",
] as const;

/** The tools its write steps call (an agent lists them in `definition.extraTools`). */
export const VENDOR_INVOICE_WRITES = [
  "docs.reading.record",
  "materials.matches.record",
  "materials.prices.record",
  "materials.prices.check",
] as const;
