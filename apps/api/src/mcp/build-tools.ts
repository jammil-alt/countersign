// Builds through the MCP server (docs/plan.md §1.34, "Builds and step settings"): the back
// office's Build page as tools, so an operator can build an agent with the Builder from Claude.
// Every tool runs the build's own route as this operator (`invokeRoute`: the same roles, client
// scope, checks, Builder and audit row), so nothing here decides anything a build page doesn't.
//
// DECISION (owner, 2026-11-24): drafting and testing only. A build goes from its draft to Publish
// (owner, 2026-11-27), and its Publish is in the back office (agent_publish only publishes a new
// version of an agent already live). Moving a build is limited to its draft: back to it, or into
// it from the fit-gap. Stopping a build takes the two-step confirm. Drafts start with approval on as they always do,
// and tries and test runs never write (invariant 8).

import {
  type BuildDetail as BuildDetailT,
  BuildItemKind,
  BuildItemOwner,
  BuildItemState,
  BuildKind,
  BuildPath,
  type BuildPhase,
  BuildStatus,
  DecisionOperatorStatus,
  FitVerdict,
  isUuid,
  type RouteSpec,
  routes,
  SettleWay,
  TryRecordKind,
  UpdateBuild,
} from "@countersign/core";
import { z } from "zod";
import { invokeRoute, type RouteInput } from "../http";
import { CONFIRM_ARG } from "./confirm";
import type { OpsToolCtx } from "./ops-tools";
import { clip, dataResult } from "./output";
import type { Tool } from "./protocol";
import { issueFor, useToken } from "./two-step";

const READ = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;
const WRITE = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;

const Id = z.string().refine(isUuid, "not an id").describe("A Mezonas id (uuid)");
const BuildId = Id.describe("A build's id (uuid), from builds_list or build_start");
const ConfirmToken = z
  .string()
  .min(1)
  .max(4000)
  .optional()
  .describe("From the first call's answer; leave out to preview");

/** The phase a build may be moved to from here: its draft (owner, 2026-11-27). */
export const MCP_BUILD_PHASES = ["draft"] as const satisfies readonly BuildPhase[];

function route<R extends RouteSpec>(ctx: OpsToolCtx, spec: R, raw: RouteInput = {}) {
  return invokeRoute(ctx.app, ctx.c, ctx.session, spec, raw, ctx.via ?? "mcp");
}

/** A build's message, its text and proposal kept, for a tool result. */
function messageView(m: BuildDetailT["messages"][number]) {
  return {
    id: m.id,
    phase: m.phase,
    role: m.role,
    text: m.text.length > 3000 ? `${m.text.slice(0, 3000)}…` : m.text,
    ...(m.chips.length ? { chips: m.chips } : {}),
    ...(m.changes.length ? { changes: m.changes } : {}),
    ...(m.failed ? { failed: true } : {}),
    ...(m.about ? { about: m.about } : {}),
    ...(m.proposal
      ? {
          proposal: {
            summary: m.proposal.summary,
            state: m.proposal.state,
            ...(m.proposal.result ? { result: m.proposal.result } : {}),
            ...(m.proposal.changes?.length ? { changes: m.proposal.changes } : {}),
          },
        }
      : {}),
    at: m.createdAt,
  };
}

/**
 * A build as a tool hands it back: where it is, why it can't move on, the last of the
 * conversation, what's open, the draft's steps and problems, and the tests. `full` adds the brief,
 * fit-gap, test plan, QA and history.
 */
export function buildView(d: BuildDetailT, opts: { messages?: number; full?: boolean } = {}) {
  const n = opts.messages ?? 6;
  const b = d.build;
  const open = d.items.filter((i) => i.state !== "done");
  return {
    build: {
      id: b.id,
      title: b.title,
      kind: b.kind,
      path: b.path,
      flow: b.flow,
      client: b.client,
      phase: b.phase,
      status: b.status,
      agentId: b.agentId,
      skillId: b.skillId,
      templateId: b.templateId,
      openItems: b.openItems,
      waitingOnClient: b.waitingOnClient,
      statusLine: b.statusLine,
      stuck: b.stuck,
      updatedAt: b.updatedAt,
    },
    phases: d.phases.map((p) => `${p.label}: ${p.state}`),
    gate: d.gate,
    messages: d.messages.slice(-n).map(messageView),
    earlierMessages: Math.max(0, d.messages.length - n),
    openItems: open.map((i) => ({
      id: i.id,
      phase: i.phase,
      kind: i.kind,
      title: i.title,
      ...(i.detail ? { detail: i.detail } : {}),
      owner: i.owner,
      state: i.state,
      ...(i.stepId ? { stepId: i.stepId } : {}),
    })),
    decisions: b.fitgap.decisions.map((x) => ({
      id: x.id,
      what: x.what,
      value: x.value ?? null,
      why: x.why ?? null,
      risk: x.risk,
      status: x.status,
    })),
    draft: d.draft
      ? {
          agentId: d.draft.agentId,
          skillId: d.draft.skillId,
          versionId: d.draft.versionId,
          version: d.draft.version,
          live: d.draft.live,
          problems: d.draft.problems.map((p) => ({
            code: p.code,
            title: p.title,
            stepId: p.stepId,
            workflow: p.workflow,
          })),
          steps: d.draft.steps,
        }
      : null,
    tests: d.poc
      ? {
          mode: d.poc.mode,
          cases: d.poc.cases,
          required: d.poc.required,
          passed: d.poc.passed,
          detail: d.poc.detail,
          latest: d.poc.latest,
          failures: d.poc.failures,
          tries: d.poc.tries.map((t) => ({ ...t, output: clip(t.output, 1500) })),
        }
      : null,
    ...(d.codeRequests?.length ? { codeRequests: d.codeRequests } : {}),
    ...(opts.full
      ? {
          brief: b.brief,
          fitgap: { ...b.fitgap, decisions: undefined },
          testPlan: b.testPlan,
          clientTest: d.clientTest,
          qa: { record: b.qa, checks: d.qaChecks },
          events: d.events.slice(-20),
          doneItems: d.items.filter((i) => i.state === "done").length,
        }
      : {}),
  };
}

/** What a write hands back: our sentence, then the build as it is now. */
function built(source: string, summary: string, d: BuildDetailT, messages = 6) {
  return dataResult(source, summary, buildView(d, { messages }));
}

// ── Reads ────────────────────────────────────────────────────────────────────────────────────

const buildsList: Tool<OpsToolCtx> = {
  name: "builds_list",
  title: "List builds",
  description:
    "Builds of agents and skills with the Builder, newest first: what each is, for which client, its phase (intake, fitgap or draft; from the draft it is published), status and open items, and the open items across them. path: new (the Agent lab's drafts, default), template (forks of a template for a client) or all.",
  input: z.strictObject({
    status: BuildStatus.optional(),
    path: z.enum(["new", "template", "all"]).default("all"),
    agent: Id.optional().describe("Only builds of this agent"),
  }),
  annotations: READ,
  async run(ctx, args) {
    const a = args as { status?: string; path: string; agent?: string };
    const out = await route(ctx, routes.opsBuilds, {
      query: {
        path: a.path,
        ...(a.status ? { status: a.status } : {}),
        ...(a.agent ? { agent: a.agent } : {}),
      },
    });
    return dataResult(
      "builds_list",
      `${out.builds.length} build${out.builds.length === 1 ? "" : "s"}.`,
      {
        builds: out.builds.map((b) => ({
          id: b.id,
          title: b.title,
          kind: b.kind,
          path: b.path,
          client: b.client,
          phase: b.phase,
          status: b.status,
          agentId: b.agentId,
          openItems: b.openItems,
          statusLine: b.statusLine,
          stuck: b.stuck,
          updatedAt: b.updatedAt,
        })),
        items: out.items.slice(0, 50),
      },
    );
  },
};

const buildGet: Tool<OpsToolCtx> = {
  name: "build_get",
  title: "Get a build",
  description:
    "One build in full: its phase and what stops it moving on (gate), the conversation with the Builder (message ids for build_proposal), open items, the Builder's decisions, the brief, fit-gap and test plan, the draft's steps and problems, and its tests and tries. The draft's agentId opens its steps with agent_steps.",
  input: z.strictObject({
    id: BuildId,
    messages: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(20)
      .describe("How many of the last messages"),
  }),
  annotations: READ,
  async run(ctx, args) {
    const a = args as { id: string; messages: number };
    const d = await route(ctx, routes.opsBuild, { params: { id: a.id } });
    return dataResult(
      "build_get",
      `The build, ${d.build.phase} phase.`,
      buildView(d, { messages: a.messages, full: true }),
    );
  },
};

// ── Drafting ─────────────────────────────────────────────────────────────────────────────────

const buildStart: Tool<OpsToolCtx> = {
  name: "build_start",
  title: "Start a build",
  description:
    "Start a build with the Builder: a new agent (kind agent) or skill (kind skill), for one client (client) or for everyone (a template). path template forks a template (template) into that client to build on. It starts at intake: talk it through with build_say, or skip the questions with build_draft_now. Nothing reaches the client until someone puts it at the client from the back office.",
  input: z.strictObject({
    kind: BuildKind,
    title: z.string().trim().min(1).max(200),
    client: Id.optional().describe(
      "A client's id (uuid), from clients_list; leave out for a template",
    ),
    path: BuildPath.optional(),
    template: Id.optional().describe("With path template: the template's agent id"),
  }),
  annotations: WRITE,
  async run(ctx, args) {
    const a = args as {
      kind: string;
      title: string;
      client?: string;
      path?: string;
      template?: string;
    };
    const d = await route(ctx, routes.opsStartBuild, {
      body: {
        kind: a.kind,
        title: a.title,
        ...(a.client ? { clientId: a.client } : {}),
        ...(a.path ? { path: a.path } : {}),
        ...(a.template ? { templateId: a.template } : {}),
      },
    });
    ctx.audit.target = { build: d.build.id };
    return built("build_start", `Started the build "${d.build.title}".`, d);
  },
};

const buildUpdate: Tool<OpsToolCtx> = {
  name: "build_update",
  title: "Change a build",
  description:
    "Change a build's title, brief, fit-gap, test plan, promised date, who it waits on, status line or stuck flag (each optional; give only what changes). Read the current values with build_get first: a brief, fit-gap or test plan is replaced whole.",
  input: z.strictObject({ id: BuildId, changes: UpdateBuild }),
  annotations: WRITE,
  async run(ctx, args) {
    const a = args as { id: string; changes: unknown };
    ctx.audit.target = { build: a.id };
    const d = await route(ctx, routes.opsUpdateBuild, { params: { id: a.id }, body: a.changes });
    return built("build_update", "Changed.", d);
  },
};

const buildSay: Tool<OpsToolCtx> = {
  name: "build_say",
  title: "Talk to the Builder",
  description:
    "Your words in the build's conversation; the Builder answers for the build's phase (it asks the intake questions, writes the fit-gap, drafts, proposes changes). It may take a minute. about names an open issue the words are about; settle picks how to settle it (process, skill or code). Without text, the Builder's last turn is tried again. A proposed change waits for build_proposal.",
  input: z.strictObject({
    id: BuildId,
    text: z.string().trim().min(1).max(4000).optional(),
    about: z.string().min(1).max(160).optional(),
    settle: SettleWay.optional(),
  }),
  annotations: WRITE,
  async run(ctx, args) {
    const a = args as { id: string; text?: string; about?: string; settle?: string };
    ctx.audit.target = { build: a.id };
    const d = await route(ctx, routes.opsBuildTurn, {
      params: { id: a.id },
      body: {
        ...(a.text ? { text: a.text } : {}),
        ...(a.about ? { about: a.about } : {}),
        ...(a.settle ? { settle: a.settle } : {}),
      },
    });
    return built("build_say", "The Builder answered.", d, 4);
  },
};

const buildProposal: Tool<OpsToolCtx> = {
  name: "build_proposal",
  title: "Decide a Builder proposal",
  description:
    "Agree the Builder's proposed change in a message (it is made, as you, through the build's own routes), decline it, or undo one agreed. message is the message's id from build_get or build_say.",
  input: z.strictObject({
    id: BuildId,
    message: Id.describe("The message's id"),
    decide: z.enum(["agree", "decline", "undo"]),
  }),
  annotations: WRITE,
  async run(ctx, args) {
    const a = args as { id: string; message: string; decide: string };
    ctx.audit.target = { build: a.id, message: a.message };
    const d = await route(ctx, routes.opsBuildProposal, {
      params: { id: a.id, messageId: a.message },
      body: { decide: a.decide },
    });
    return built("build_proposal", `Proposal: ${a.decide}.`, d, 3);
  },
};

const buildVerdict: Tool<OpsToolCtx> = {
  name: "build_verdict",
  title: "Change a fit-gap verdict",
  description:
    "Change a fit-gap row's verdict (native, configure, build, figure_out, not_possible) with why. To more work it changes at once; to less work it's a challenge the Builder answers against the catalog.",
  input: z.strictObject({
    id: BuildId,
    row: z.string().min(1).max(40).describe("The fit-gap row's id, from build_get"),
    to: FitVerdict,
    reason: z.string().trim().min(1).max(1000),
  }),
  annotations: WRITE,
  async run(ctx, args) {
    const a = args as { id: string; row: string; to: string; reason: string };
    ctx.audit.target = { build: a.id };
    const d = await route(ctx, routes.opsBuildVerdict, {
      params: { id: a.id },
      body: { rowId: a.row, to: a.to, reason: a.reason },
    });
    return built("build_verdict", "Changed the verdict.", d, 3);
  },
};

const buildMove: Tool<OpsToolCtx> = {
  name: "build_move",
  title: "Move a build",
  description:
    "Move a build back to its draft with a reason, or on into its draft from the fit-gap when its gate passes (the Builder drafts it). Its only move from the draft is Publish, in the back office, which makes it live.",
  input: z.strictObject({
    id: BuildId,
    to: z.enum(MCP_BUILD_PHASES),
    reason: z.string().trim().min(1).max(500).optional(),
  }),
  annotations: WRITE,
  async run(ctx, args) {
    const a = args as { id: string; to: string; reason?: string };
    ctx.audit.target = { build: a.id };
    const d = await route(ctx, routes.opsMoveBuild, {
      params: { id: a.id },
      body: { to: a.to, ...(a.reason ? { reason: a.reason } : {}) },
    });
    return built("build_move", `The build is in ${d.build.phase}.`, d, 3);
  },
};

const buildDraftNow: Tool<OpsToolCtx> = {
  name: "build_draft_now",
  title: "Draft it now",
  description:
    "Draft an agent or skill build at once from a description of the work (or the brief as it is), without the intake questions or the fit-gap: the Builder decides what it can, what the catalog can't do becomes an open item, and the build lands in its draft with approvals on. It may take a minute or two.",
  input: z.strictObject({
    id: BuildId,
    description: z.string().trim().min(1).max(4000).optional(),
  }),
  annotations: WRITE,
  async run(ctx, args) {
    const a = args as { id: string; description?: string };
    ctx.audit.target = { build: a.id };
    const d = await route(ctx, routes.opsDraftBuildNow, {
      params: { id: a.id },
      body: a.description ? { description: a.description } : {},
    });
    return built("build_draft_now", "Drafted.", d, 3);
  },
};

// ── Testing ──────────────────────────────────────────────────────────────────────────────────

const buildTests: Tool<OpsToolCtx> = {
  name: "build_tests",
  title: "Make or run test cases",
  description:
    "do make_cases: the Builder makes test cases from the test plan. do run: run the draft's test cases (a test run, never writes); results show on the build.",
  input: z.strictObject({ id: BuildId, do: z.enum(["make_cases", "run"]) }),
  annotations: WRITE,
  async run(ctx, args) {
    const a = args as { id: string; do: "make_cases" | "run" };
    ctx.audit.target = { build: a.id };
    if (a.do === "make_cases") {
      const d = await route(ctx, routes.opsBuildCases, { params: { id: a.id } });
      return built(
        "build_tests",
        `Made ${d.created} test case${d.created === 1 ? "" : "s"}.`,
        d,
        2,
      );
    }
    const d = await route(ctx, routes.opsBuildRunTests, { params: { id: a.id } });
    return built("build_tests", "Ran the test cases.", d, 2);
  },
};

const buildTry: Tool<OpsToolCtx> = {
  name: "build_try",
  title: "Try the draft",
  description:
    "Try the draft once on a real example, as a test (never writes): give exactly one of document (a Sandbox document's id), record (a Sandbox record: kind transaction or receivable, and its id), input (a skill's input or a template's trigger payload) or again (a try's case id, run again on the latest version). workflow picks a template's workflow by slug. Keep or discard it with build_try_decide.",
  input: z.strictObject({
    id: BuildId,
    document: Id.optional(),
    record: z.strictObject({ kind: TryRecordKind, id: Id }).optional(),
    input: z.unknown().optional(),
    again: Id.optional(),
    workflow: z.string().trim().min(1).max(100).optional(),
  }),
  annotations: WRITE,
  async run(ctx, args) {
    const a = args as {
      id: string;
      document?: string;
      record?: unknown;
      input?: unknown;
      again?: string;
      workflow?: string;
    };
    ctx.audit.target = { build: a.id };
    const d = await route(ctx, routes.opsBuildTry, {
      params: { id: a.id },
      body: {
        ...(a.document ? { documentId: a.document } : {}),
        ...(a.record ? { record: a.record } : {}),
        ...(a.input !== undefined ? { input: a.input } : {}),
        ...(a.again ? { caseId: a.again } : {}),
        ...(a.workflow ? { workflow: a.workflow } : {}),
      },
    });
    return built("build_try", "Tried it.", d, 2);
  },
};

const buildTryDecide: Tool<OpsToolCtx> = {
  name: "build_try_decide",
  title: "Keep or discard a try",
  description:
    "Keep a try as a required test case, its result the expected answer, or discard it. case is the try's caseId from the build's tests.",
  input: z.strictObject({
    id: BuildId,
    case: Id.describe("The try's caseId"),
    decide: z.enum(["keep", "discard"]),
  }),
  annotations: WRITE,
  async run(ctx, args) {
    const a = args as { id: string; case: string; decide: string };
    ctx.audit.target = { build: a.id, case: a.case };
    const d = await route(ctx, routes.opsBuildTryDecide, {
      params: { id: a.id, caseId: a.case },
      body: { decide: a.decide },
    });
    return built("build_try_decide", a.decide === "keep" ? "Kept." : "Discarded.", d, 2);
  },
};

// ── Items and decisions ──────────────────────────────────────────────────────────────────────

const buildItem: Tool<OpsToolCtx> = {
  name: "build_item",
  title: "Add or change an open item",
  description:
    "Without item: add an open item to the build (title, and optionally detail, kind, owner, stepId). With item: change it (title, detail, owner, state) or drop it as not needed (drop true). A question, gap, test or feedback item is closed by its own step or by drop, not by state done.",
  input: z.strictObject({
    id: BuildId,
    item: Id.optional().describe("The item's id, to change it"),
    title: z.string().trim().min(1).max(300).optional(),
    detail: z.string().trim().max(2000).optional(),
    kind: BuildItemKind.optional(),
    owner: BuildItemOwner.optional(),
    state: BuildItemState.optional(),
    stepId: z.string().min(1).max(100).optional(),
    drop: z.literal(true).optional(),
  }),
  annotations: WRITE,
  async run(ctx, args) {
    const { id, item, ...rest } = args as { id: string; item?: string } & Record<string, unknown>;
    const fields = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
    ctx.audit.target = { build: id, ...(item ? { item } : {}) };
    if (item) {
      const d = await route(ctx, routes.opsUpdateBuildItem, {
        params: { id, itemId: item },
        body: fields,
      });
      return built("build_item", "Changed the item.", d, 0);
    }
    const d = await route(ctx, routes.opsAddBuildItem, { params: { id }, body: fields });
    return built("build_item", "Added the item.", d, 0);
  },
};

const buildDecision: Tool<OpsToolCtx> = {
  name: "build_decision",
  title: "Look at a Builder decision",
  description:
    "One of the Builder's decisions (ids in build_get's decisions): mark it discussed, confirmed or never_discussed (status), or put it in your own words (what, and optionally value and why; it is marked changed, by you). A high-risk decision is worth a look before the draft is published.",
  input: z.strictObject({
    id: BuildId,
    decision: z.string().min(1).max(40),
    status: DecisionOperatorStatus.optional(),
    what: z.string().trim().min(1).max(1000).optional(),
    value: z.string().trim().max(1000).nullable().optional(),
    why: z.string().trim().max(1000).optional(),
  }),
  annotations: WRITE,
  async run(ctx, args) {
    const a = args as {
      id: string;
      decision: string;
      status?: string;
      what?: string;
      value?: string | null;
      why?: string;
    };
    ctx.audit.target = { build: a.id, decision: a.decision };
    const params = { id: a.id, decisionId: a.decision };
    let d: BuildDetailT | undefined;
    if (a.what !== undefined) {
      d = await route(ctx, routes.opsBuildDecisionWords, {
        params,
        body: {
          what: a.what,
          ...(a.why !== undefined ? { why: a.why } : {}),
          ...(a.value !== undefined ? { value: a.value } : {}),
        },
      });
    }
    if (a.status) {
      d = await route(ctx, routes.opsBuildDecisionStatus, { params, body: { status: a.status } });
    }
    if (!d) {
      d = await route(ctx, routes.opsBuild, { params: { id: a.id } });
      return built("build_decision", "Nothing to change: give status, or what.", d, 0);
    }
    return built("build_decision", "Changed the decision.", d, 0);
  },
};

const buildStop: Tool<OpsToolCtx> = {
  name: "build_stop",
  title: "Stop a build",
  description:
    "Stop a build, with a reason (its draft and records stay). Two steps: call it without confirm_token to see what it will do and get a token; then call it again with the same id and reason and that confirm_token.",
  input: z.strictObject({
    id: BuildId,
    reason: z.string().trim().min(1).max(500),
    [CONFIRM_ARG]: ConfirmToken,
  }),
  annotations: { ...WRITE, destructiveHint: true },
  async run(ctx, args) {
    const a = args as { id: string; reason: string; [CONFIRM_ARG]?: string };
    const bound = { id: a.id, reason: a.reason };
    ctx.audit.target = { build: a.id };
    const token = a[CONFIRM_ARG];
    if (!token) {
      const d = await route(ctx, routes.opsBuild, { params: { id: a.id } });
      const issued = await issueFor(ctx, "build_stop", bound);
      return dataResult(
        "build_stop",
        [
          `Preview, nothing changed yet. This will stop the build "${d.build.title}" (${d.build.phase}) as you, in Mezonas ${ctx.config.environment}. Its draft and records stay.`,
          issued.offer,
        ].join("\n"),
        buildView(d, { messages: 0 }),
      );
    }
    await useToken(ctx, "build_stop", bound, token);
    const d = await route(ctx, routes.opsStopBuild, {
      params: { id: a.id },
      body: { reason: a.reason },
    });
    ctx.audit.outcome = "done";
    return built("build_stop", "Stopped.", d, 0);
  },
};

export const BUILD_TOOLS: readonly Tool<OpsToolCtx>[] = [
  buildsList,
  buildGet,
  buildStart,
  buildUpdate,
  buildSay,
  buildProposal,
  buildVerdict,
  buildMove,
  buildDraftNow,
  buildTests,
  buildTry,
  buildTryDecide,
  buildItem,
  buildDecision,
  buildStop,
];
