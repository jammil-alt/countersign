// Test answers for Describe it and Check the steps (F5): a build as `GET /api/ops/builds/:id`
// answers it, its draft agent as `GET /api/ops/agents/:id`, and the Builder session routes. Only
// the tests import this.
import type { AnyAgentBundleInput, BuildDetail } from "@countersign/core";
import { AGENT_SUMMARY, PROCESS_BUNDLE_INPUT } from "../../test/fixtures";
import type { Process } from "./types";

export const BUILD_ID = "00000000-0000-4000-8000-0000000b0f05";
export const DRAFT_AGENT_ID = "00000000-0000-4000-8000-00000000f005";
export const DRAFT_VERSION = "00000000-0000-4000-8000-0000000ef001";
export const SAVED_VERSION = "00000000-0000-4000-8000-0000000ef002";
export const SESSION_ID = "00000000-0000-4000-8000-0000000c5005";
const at = "2026-11-21T10:00:00.000Z";

/** A new agent build: in intake with no draft, or (`agentId`) drafted at once. */
export function buildDetail(
  over: { agentId?: string | null; words?: string; clientId?: string } = {},
): BuildDetail {
  const agentId = over.agentId ?? null;
  return {
    build: {
      id: BUILD_ID,
      kind: "agent",
      title: "Invoice intake",
      client: over.clientId ? { id: over.clientId, name: "Harbor Millwork" } : null,
      phase: agentId ? "draft" : "intake",
      status: "open",
      agentId,
      skillId: null,
      testAgentId: null,
      testClient: null,
      openItems: 0,
      waitingOnClient: 0,
      createdBy: "Ann",
      createdAt: at,
      updatedAt: at,
      phaseAt: at,
      path: "new",
      flow: "phases",
      templateId: null,
      promisedOn: null,
      origin: null,
      requirements: null,
      pipelineStage: "building",
      standing: "you",
      waitingOn: "operator",
      statusLine: "",
      stuck: false,
      brief: over.words ? { goal: { text: over.words, state: "assumed" } } : {},
      fitgap: { rows: [], needsTrue: [], setup: [], decisions: [] },
      testPlan: { datasets: [] },
      qa: { accepted: {}, signedBy: null, signedAt: null, decision: null },
    },
    phases: [
      { phase: "intake", label: "Intake", state: agentId ? "done" : "current" },
      { phase: "fitgap", label: "Fit-gap", state: agentId ? "done" : "todo" },
      { phase: "draft", label: "Draft", state: agentId ? "current" : "todo" },
      { phase: "poc", label: "POC test", state: "todo" },
      { phase: "client_test", label: "Client test", state: "todo" },
      { phase: "qa", label: "QA and go / no-go", state: "todo" },
    ],
    gate: { next: agentId ? "poc" : "fitgap", reasons: [] },
    messages: over.words
      ? [
          {
            id: "m1",
            phase: "intake",
            role: "operator",
            text: over.words,
            chips: [],
            changes: [],
            createdAt: at,
          },
        ]
      : [],
    items: [],
    draft: agentId
      ? {
          agentId,
          skillId: null,
          sessionId: null,
          versionId: DRAFT_VERSION,
          version: 1,
          live: false,
          problems: [],
          steps: [],
        }
      : null,
    poc: null,
    clientTest: null,
    qaChecks: [],
    events: [],
  };
}

/** The draft's process: read the invoice, a decision on duplicates, create the bill. */
export function draftProcess(): Process {
  return {
    schemaVersion: 4,
    triggers: [{ id: "t-doc", on: { type: "event", event: "document.received" } }],
    steps: [
      { id: "s-read", kind: "skill", name: "Read the invoice", skill: "docs.extract", input: {} },
      {
        id: "s-dup",
        kind: "if",
        name: "Duplicate",
        paths: [
          {
            id: "p-dup",
            name: "the invoice is a duplicate",
            when: { match: "all", rules: [] },
            steps: [
              {
                id: "s-tell",
                kind: "notify",
                name: "Tell Dana",
                notify: { to: ["client_admin"], channel: "inbox", message: "" },
              },
            ],
          },
        ],
        otherwise: { id: "o-dup", steps: [] },
      },
      {
        id: "s-bill",
        kind: "write",
        name: "Create the bill",
        tool: "qbo.bill.create",
        input: {},
        checks: {
          approval: { required: "required", mode: "in_turn", ifNoAnswer: "stop", onReject: "stop" },
        },
      },
    ],
  };
}

export function draftBundle(process: Process = draftProcess()): AnyAgentBundleInput {
  return {
    ...PROCESS_BUNDLE_INPUT,
    workflows: [
      { slug: "invoice-intake", name: "Invoice intake", workflow: process as never },
    ] as AnyAgentBundleInput["workflows"],
  };
}

const version = (id: string, n: number) => ({
  id,
  agentId: DRAFT_AGENT_ID,
  version: n,
  status: "draft",
  bundleHash: `hash-${n}`,
  changeNote: null,
  releaseNote: null,
  authorType: "operator",
  authorId: null,
  parentVersionId: n > 1 ? DRAFT_VERSION : null,
  basedOnTemplateVersionId: null,
  mergedFromVersionIds: null,
  createdAt: at,
});

/** The draft agent: a template with its v1 draft. */
export function agentDetail(bundle: AnyAgentBundleInput = draftBundle()) {
  return {
    agent: {
      ...AGENT_SUMMARY,
      id: DRAFT_AGENT_ID,
      tenantId: null,
      kind: "template" as const,
      slug: "invoice-intake",
      name: "Invoice intake",
      liveVersionId: null,
      status: "draft",
      bindings: {},
    },
    versions: [version(DRAFT_VERSION, 1)],
    live: null,
    latest: { ...version(DRAFT_VERSION, 1), bundle },
    update: null,
  };
}

export function savedVersion() {
  return { version: version(SAVED_VERSION, 2), errors: [] };
}

const turn = {
  id: "00000000-0000-4000-8000-0000000c7001",
  seq: 1,
  role: "builder" as const,
  text: "Filled.",
  command: null,
  changes: [],
  questions: [],
  gaps: [],
  notes: [],
  errors: [],
  savedVersionId: null,
  costUsd: "0",
  undoneAt: null,
  createdAt: at,
};

/** A Builder session about the draft agent. */
export function sessionDetail() {
  return {
    session: {
      id: SESSION_ID,
      kind: "agent" as const,
      clientId: null,
      clientName: null,
      agentId: DRAFT_AGENT_ID,
      skillId: null,
      baseVersionId: SAVED_VERSION,
      status: "open" as const,
      bundle: draftBundle(),
      errors: [],
      closest: [],
      createdAt: at,
      updatedAt: at,
    },
    turns: [turn],
  };
}

export const sessionTurn = () => ({ ...sessionDetail(), turn });

export const sessionSave = () => ({
  ...sessionDetail(),
  turn,
  agent: { id: DRAFT_AGENT_ID, slug: "invoice-intake" },
  skill: null,
  version: { id: "00000000-0000-4000-8000-0000000ef003", version: 3 },
  cases: [],
  errors: [],
});
