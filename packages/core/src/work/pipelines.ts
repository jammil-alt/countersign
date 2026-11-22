// Back office work (docs/plan.md §1.124; docs/cases-plan.md §3): the pipelines, their stages, the
// line under each stage saying what Reggie does there, and the sections' tabs. The words are the
// agreed prototype's (docs/design/pipelines.html, PIPES and SECTIONS).

import { z } from "zod";

export const WORK_URGENCIES = ["critical", "high", "normal", "low"] as const;
export const WorkUrgency = z.enum(WORK_URGENCIES);
export type WorkUrgency = z.infer<typeof WorkUrgency>;

export const WORK_ISSUE_STAGES = ["reported", "cause", "fix", "verify", "closed"] as const;
export const WorkIssueStage = z.enum(WORK_ISSUE_STAGES);
export type WorkIssueStage = z.infer<typeof WorkIssueStage>;

export const WORK_CAUSE_KINDS = ["setup", "data", "agent", "platform", "not_a_bug"] as const;
export const WorkCauseKind = z.enum(WORK_CAUSE_KINDS);
export type WorkCauseKind = z.infer<typeof WorkCauseKind>;

export const WORK_ISSUE_SOURCES = [
  "portal",
  "sloan",
  "email",
  "feedback",
  "error_report",
  "ops",
  "reggie",
  "legacy_request",
  "trial_rejection",
  // A security check of an agent that didn't verify (docs/agent-assurance-plan.md §6, migration 0075).
  "assurance",
] as const;
export const WorkIssueSource = z.enum(WORK_ISSUE_SOURCES);
export type WorkIssueSource = z.infer<typeof WorkIssueSource>;

export const WORK_BUILD_STAGES = [
  "requirements",
  "building",
  "connect",
  "bench",
  "trial",
  "signoff",
  "live",
] as const;
export const WorkBuildStage = z.enum(WORK_BUILD_STAGES);
export type WorkBuildStage = z.infer<typeof WorkBuildStage>;

export const WORK_ENHANCEMENT_STAGES = [
  "captured",
  "grouped",
  "decided",
  "built",
  "shipped",
] as const;
export const WorkEnhancementStage = z.enum(WORK_ENHANCEMENT_STAGES);
export type WorkEnhancementStage = z.infer<typeof WorkEnhancementStage>;

export const WORK_ENHANCEMENT_DECISIONS = ["do", "later", "no", "sell"] as const;
export const WorkEnhancementDecision = z.enum(WORK_ENHANCEMENT_DECISIONS);
export type WorkEnhancementDecision = z.infer<typeof WorkEnhancementDecision>;

export const WORK_DEAL_NEW_STAGES = [
  "lead",
  "qualified",
  "diagnostic",
  "proposal",
  "setup",
  "live",
] as const;
export const WORK_DEAL_EXPANSION_STAGES = [
  "spotted",
  "pitch",
  "offered",
  "agreed",
  "billed",
] as const;

export const WORK_WAITING_ON = ["operator", "reggie", "client"] as const;
export const WorkWaitingOn = z.enum(WORK_WAITING_ON);
export type WorkWaitingOn = z.infer<typeof WorkWaitingOn>;

export type PipelineId = "new" | "grow" | "issues" | "builds" | "enh";

export interface PipelineStage {
  id: string;
  name: string;
  /** Sales only: how likely a deal at this stage is to close, for the weighted total. */
  p?: number;
  /** What Reggie does in this stage. */
  auto: string;
}

export interface Pipeline {
  id: PipelineId;
  section: "sales" | "build";
  name: string;
  /** The kind's short name, in a column or a tag. */
  short: string;
  noun: string;
  /** The due date's label. */
  due: string;
  stages: readonly PipelineStage[];
}

export const PIPELINES: Readonly<Record<PipelineId, Pipeline>> = {
  new: {
    id: "new",
    section: "sales",
    name: "New accounts",
    short: "New",
    noun: "deal",
    due: "Next step due",
    stages: [
      {
        id: "lead",
        name: "Lead",
        p: 0.1,
        auto: "Reggie reads their site and drafts the first reply.",
      },
      {
        id: "qualified",
        name: "Qualified",
        p: 0.25,
        auto: "Reggie scores the fit and books the diagnostic.",
      },
      {
        id: "diagnostic",
        name: "Diagnostic",
        p: 0.4,
        auto: "Reggie prepares the call and writes up the plan.",
      },
      {
        id: "proposal",
        name: "Proposal and contract",
        p: 0.6,
        auto: "Reggie drafts the proposal; you send the contract and add the signed copy.",
      },
      {
        id: "setup",
        name: "Set up the account",
        p: 0.9,
        auto: "Reggie sets up the client and opens a build per agent sold.",
      },
      { id: "live", name: "First agent live", p: 1, auto: "Reggie sends the first Weekly Table." },
    ],
  },
  grow: {
    id: "grow",
    section: "sales",
    name: "Expansion",
    short: "Expansion",
    noun: "deal",
    due: "Next step due",
    stages: [
      {
        id: "spotted",
        name: "Spotted",
        p: 0.2,
        auto: "Reggie watches every live client nightly and opens these with evidence.",
      },
      { id: "pitch", name: "Pitch", p: 0.4, auto: "Reggie drafts the pitch in their numbers." },
      {
        id: "offered",
        name: "Offered",
        p: 0.6,
        auto: "You agree the terms and record them. Reggie nudges after 5 days.",
      },
      { id: "agreed", name: "Agreed", p: 0.9, auto: "Reggie opens the agent builds." },
      {
        id: "billed",
        name: "Live and billed",
        p: 1,
        auto: "Reggie puts the new price on the bill from go-live.",
      },
    ],
  },
  issues: {
    id: "issues",
    section: "build",
    name: "Issues",
    short: "Issue",
    noun: "issue",
    due: "Fix by",
    stages: [
      {
        id: "reported",
        name: "Reported",
        auto: "Reggie tells them we have it, sets the urgency, holds the agent if critical.",
      },
      { id: "cause", name: "Finding the cause", auto: "Reggie finds the cause and its kind." },
      { id: "fix", name: "Fix", auto: "Reggie drafts the fix; changes to an agent are yours." },
      { id: "verify", name: "Verify", auto: "Reggie re-runs and asks the client to confirm." },
      {
        id: "closed",
        name: "Closed",
        auto: "Reggie tells them what fixed it and checks other clients.",
      },
    ],
  },
  builds: {
    id: "builds",
    section: "build",
    name: "Agent builds",
    short: "Agent build",
    noun: "build",
    due: "Promised",
    stages: [
      {
        id: "requirements",
        name: "Requirements request",
        auto: "Reggie sends the intake questionnaire and chases it.",
      },
      {
        id: "building",
        name: "Building",
        auto: "New agents only: the Builder's phases, intake to QA.",
      },
      { id: "connect", name: "Connect", auto: "Reggie says which tools are missing and chases." },
      {
        id: "bench",
        name: "Bench test",
        auto: "Reggie runs tests on their data; you start the trial.",
      },
      { id: "trial", name: "Trial", auto: "The client signs every write; Reggie reports weekly." },
      { id: "signoff", name: "Sign-off", auto: "The client admin signs going live." },
      { id: "live", name: "Live", auto: "Reggie tells the client and starts billing." },
    ],
  },
  enh: {
    id: "enh",
    section: "build",
    name: "Enhancements",
    short: "Enhancement",
    noun: "enhancement",
    due: "Decide by",
    stages: [
      {
        id: "captured",
        name: "Captured",
        auto: "Reggie thanks them and asks one question if needed.",
      },
      { id: "grouped", name: "Grouped", auto: "Reggie merges the same ask across clients." },
      { id: "decided", name: "Decided", auto: "Do it, later, no or sell it: yours." },
      { id: "built", name: "Built", auto: "A template or client version; you approve it." },
      { id: "shipped", name: "Shipped and told", auto: "Reggie tells everyone who asked." },
    ],
  },
};

export const SALES_TABS = ["all", "new", "grow"] as const;
export const BUILD_TABS = ["all", "issues", "builds", "enh"] as const;
export const BuildTab = z.enum(BUILD_TABS);
export type BuildTab = z.infer<typeof BuildTab>;

export const WORK_SECTIONS = {
  sales: {
    name: "Sales",
    tabs: [
      ["all", "All deals"],
      ["new", "New accounts"],
      ["grow", "Expansion"],
    ],
    pipes: ["new", "grow"],
  },
  build: {
    name: "Build",
    tabs: [
      ["all", "All work"],
      ["issues", "Issues"],
      ["builds", "Agent builds"],
      ["enh", "Enhancements"],
    ],
    pipes: ["issues", "builds", "enh"],
  },
} as const satisfies Record<
  "sales" | "build",
  { name: string; tabs: readonly (readonly [string, string])[]; pipes: readonly PipelineId[] }
>;

/** The stage's name in its pipeline, or the id when it isn't one. */
export function stageName(pipe: PipelineId, stage: string): string {
  return PIPELINES[pipe].stages.find((s) => s.id === stage)?.name ?? stage;
}
