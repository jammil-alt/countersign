// The vendor-first matching pattern (docs/plan.md §1.88): steps an operator copies into a process,
// automation-ready. Skills think, tools act; If steps route; a person decides what nobody is sure
// of; every change is a write step ("Save to records", approval off by default; an operator may
// turn on the optional approval on Register item, so a person confirms new master items).
// Step ids are fixed (merges depend on them, invariant 3); a prefix keeps two uses apart.
//
//   1 Match vendor → none: a person, then stop
//   2 Match by SKU (vendor) → Find the vendor's closest items (read)
//   3 Any open → Semantic match (vendor) (AI) → Check matches        (else Check matches alone)
//   4   Find master items (read) → any open → Master item manager (AI) → Check matches
//                                                                     (else Check matches alone)
//   5     Save to records: register the items → Save to records: embeddings
//   6     Anyone unsure → a person (ask) → Save to records: your answer → embeddings
//
// The If steps repeat the steps after them in each branch (with their own ids): a step inside an
// If path is not readable after it, and an AI skill with nothing to decide would still call its
// model.

import type { processes } from "@countersign/core";
import { DOCUMENT_TRIGGER } from "../patterns";

type Step = processes.Step;

const PERSON_DEADLINE = {
  after: "3 days",
  hours: "business" as const,
  remind: ["1 day"],
  ifNoAnswer: "stop" as const,
};

const out = (step: string, path = "") => `{{steps.${step}.output${path ? `.${path}` : ""}}}`;

/** Check matches over a step's looked-up lines and an AI skill's answers (none: `[]`). */
function checkStep(id: string, name: string, lines: string, answers: string | unknown[]): Step {
  return {
    id,
    name,
    kind: "skill",
    skill: "materials.check-matches",
    input: { lines, answers },
    client: { visible: false },
  };
}

/** Steps 5 and 6: register, embed, and the person's answer for what nobody was sure of. */
function registerSteps(
  ids: (s: string) => string,
  refs: {
    documentId: string;
    vendorId: string;
    check: string;
    resolved: string;
    hints: string | null;
  },
): Step[] {
  const id = ids;
  return [
    {
      id: id("register"),
      name: "Save to records: register the items",
      kind: "write",
      tool: "materials.vendor_items.register",
      input: {
        documentId: refs.documentId,
        vendorId: refs.vendorId,
        lines: out(refs.check, "lines"),
        resolved: out(refs.resolved, "lines"),
        ...(refs.hints ? { hints: refs.hints } : {}),
      },
      client: { visible: false },
    },
    {
      id: id("embed"),
      name: "Save to records: embeddings",
      kind: "write",
      tool: "materials.embeddings.write",
      input: {
        catalogItemIds: out(id("register"), "catalogItemIds"),
        vendorItemIds: out(id("register"), "vendorItemIds"),
      },
      client: { visible: false },
    },
    {
      id: id("unsure"),
      name: "Anyone unsure?",
      kind: "if",
      paths: [
        {
          id: id("unsure-path"),
          name: "Some lines",
          when: {
            match: "all",
            rules: [{ field: out(id("register"), "anyNeedsPerson"), op: "=", value: true }],
          },
          steps: [
            {
              id: id("person"),
              name: "Ask a person which items these are",
              kind: "person",
              mode: "ask",
              assignee: "client_admin",
              title: `${out(id("register"), "needsPersonCount")} invoice lines need you`,
              payload: {
                documentId: refs.documentId,
                vendorId: refs.vendorId,
                lines: out(id("register"), "needsPerson"),
                answer: "lines: [{ lineNo, catalogItemId }] or [{ lineNo, newItem: true }]",
              },
              deadline: PERSON_DEADLINE,
              channel: "inbox",
              onReject: "stop",
              client: { visible: true, label: "Asked you which items some invoice lines are" },
            },
            {
              id: id("register-answer"),
              name: "Save to records: your answer",
              kind: "write",
              tool: "materials.vendor_items.register",
              input: {
                documentId: refs.documentId,
                vendorId: refs.vendorId,
                answers: out(id("person"), "answer.lines"),
                decidedBy: out(id("person"), "by"),
              },
              client: { visible: false },
            },
            {
              id: id("embed-answer"),
              name: "Save to records: embeddings",
              kind: "write",
              tool: "materials.embeddings.write",
              input: {
                catalogItemIds: out(id("register-answer"), "catalogItemIds"),
                vendorItemIds: out(id("register-answer"), "vendorItemIds"),
              },
              client: { visible: false },
            },
          ],
        },
      ],
      otherwise: { id: id("unsure-none"), steps: [] },
    },
  ];
}

/** Step 4 and on: the master item manager for lines new to the vendor, then 5 and 6. */
function masterSteps(
  prefix: string,
  refs: { documentId: string; vendorId: string; check: string; hints: string | null },
): Step[] {
  const id = (s: string) => `${prefix}${s}`;
  return [
    {
      id: id("masters"),
      name: "Find master items for new lines",
      kind: "read",
      tool: "materials.master_items.candidates",
      input: { vendorId: refs.vendorId, lines: out(refs.check, "lines") },
      client: { visible: false },
    },
    {
      id: id("manager-needed"),
      name: "Any new line for the master item manager?",
      kind: "if",
      paths: [
        {
          id: id("manager-path"),
          name: "Some",
          when: {
            match: "all",
            rules: [{ field: out(id("masters"), "openCount"), op: ">", value: 0 }],
          },
          steps: [
            {
              id: id("manager"),
              name: "Master item manager",
              kind: "skill",
              skill: "materials.master-item-manager",
              input: { lines: out(id("masters"), "open") },
              client: { visible: false },
            },
            checkStep(
              id("check-masters"),
              "Check matches",
              out(id("masters"), "lines"),
              out(id("manager"), "answers"),
            ),
            ...registerSteps((s) => id(`m-${s}`), {
              ...refs,
              resolved: id("check-masters"),
            }),
          ],
        },
      ],
      otherwise: {
        id: id("manager-none"),
        steps: [
          checkStep(id("check-masters-settled"), "Check matches", out(id("masters"), "lines"), []),
          ...registerSteps((s) => id(`r-${s}`), {
            ...refs,
            resolved: id("check-masters-settled"),
          }),
        ],
      },
    },
  ];
}

/**
 * "Match a vendor's invoice lines to its catalog": the vendor, its items by SKU and wording, then
 * by meaning (AI, checked), the master item for what is new to the vendor (AI, checked), register,
 * and a person for what nobody is sure of. Needs a document already read.
 */
export function vendorCatalogSteps(documentId: string, prefix = ""): Step[] {
  const id = (s: string) => `${prefix}${s}`;
  const vendorId = out(id("vendor"), "vendorId");
  return [
    {
      id: id("vendor"),
      name: "Match vendor",
      kind: "skill",
      skill: "materials.match-vendor",
      input: { documentId },
      client: { visible: false },
    },
    {
      id: id("no-vendor"),
      name: "No vendor found?",
      kind: "if",
      paths: [
        {
          id: id("no-vendor-path"),
          name: "None",
          when: {
            match: "all",
            rules: [{ field: out(id("vendor"), "matched"), op: "=", value: false }],
          },
          steps: [
            {
              id: id("vendor-person"),
              name: "Ask a person which vendor sent it",
              kind: "person",
              mode: "ask",
              assignee: "client_admin",
              title: `Which vendor sent the invoice from ${out(id("vendor"), "read.name")}?`,
              payload: { documentId, candidates: out(id("vendor"), "candidates") },
              deadline: PERSON_DEADLINE,
              channel: "inbox",
              onReject: "stop",
              client: { visible: true, label: "Asked you which vendor sent an invoice" },
            },
            { id: id("vendor-stop"), name: "Stop here", kind: "stop", status: "succeeded" },
          ],
        },
      ],
      otherwise: { id: id("vendor-found"), steps: [] },
    },
    {
      id: id("sku"),
      name: "Match by SKU (vendor)",
      kind: "skill",
      skill: "materials.match-sku-vendor",
      input: { documentId, vendorId },
      client: { visible: false },
    },
    {
      id: id("similar"),
      name: "Find the vendor's closest items",
      kind: "read",
      tool: "materials.vendor_items.similar",
      input: { vendorId, lines: out(id("sku"), "lines") },
      client: { visible: false },
    },
    {
      id: id("semantic-needed"),
      name: "Any line for the semantic match?",
      kind: "if",
      paths: [
        {
          id: id("semantic-path"),
          name: "Some",
          when: {
            match: "all",
            rules: [{ field: out(id("similar"), "openCount"), op: ">", value: 0 }],
          },
          steps: [
            {
              id: id("semantic"),
              name: "Semantic match (vendor)",
              kind: "skill",
              skill: "materials.semantic-match-vendor",
              input: { lines: out(id("similar"), "open") },
              client: { visible: false },
            },
            checkStep(
              id("check"),
              "Check matches",
              out(id("similar"), "lines"),
              out(id("semantic"), "answers"),
            ),
            ...masterSteps(id("o-"), {
              documentId,
              vendorId,
              check: id("check"),
              hints: out(id("semantic"), "answers"),
            }),
          ],
        },
      ],
      otherwise: {
        id: id("semantic-none"),
        steps: [
          checkStep(id("check-settled"), "Check matches", out(id("similar"), "lines"), []),
          ...masterSteps(id("s-"), {
            documentId,
            vendorId,
            check: id("check-settled"),
            hints: null,
          }),
        ],
      },
    },
  ];
}

/** The pattern as a process of its own: a manual trigger with a document already read. */
export function vendorCatalogProcess(): processes.Process {
  return {
    schemaVersion: 4,
    triggers: [DOCUMENT_TRIGGER],
    steps: vendorCatalogSteps("{{trigger.documentId}}"),
  } as processes.Process;
}

/** The skills the pattern uses (an agent lists them in `definition.skills`). */
export const VENDOR_CATALOG_SKILLS = [
  "materials.match-vendor",
  "materials.match-sku-vendor",
  "materials.semantic-match-vendor",
  "materials.master-item-manager",
  "materials.check-matches",
] as const;

/** The tools its read and write steps call (an agent lists them in `definition.extraTools`). */
export const VENDOR_CATALOG_TOOLS = [
  "materials.vendor_items.similar",
  "materials.master_items.candidates",
  "materials.vendor_items.register",
  "materials.embeddings.write",
  // The AI skills' retrieval reads.
  "materials.vendor_items.list",
  "materials.catalog.search",
] as const;
