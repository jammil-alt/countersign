// Builds (docs/plan.md §1.108): the rows, and a build as the screen shows it. What a phase's work
// is read live (the draft's problems, its test results, the client's trial) so it never goes stale;
// only the operator's and the Builder's records are stored. Every function runs in the request's
// operator transaction: RLS shows a build only to operators serving its client and test client.

import {
  convertLookup,
  existingBundle,
  getAgent,
  latestVersion,
  skillContext,
  validateForPublish,
} from "@countersign/agents";
import {
  AnyAgentBundle,
  type BuildClientTestView,
  type BuildDetail,
  type BuildDraftView,
  type BuildEventView,
  BuildItemState,
  type BuildItemView,
  type BuildMessageView,
  type BuildPhase,
  type BuildPocView,
  BuildProposal,
  type BuildSummary,
  type DraftProblem,
  gateReasons,
  groupProblems,
  howItWorks,
  itemOpen,
  nextPhase,
  orderProblem,
  PHASE_WORDS,
  ProposalState,
  phaseIndex,
  phasesOf,
  processes,
  proposalUndo,
  QA_MAX_REJECTED,
  QA_WORDS,
  type QaCheck,
  type QaCheckId,
  readBrief,
  readFitGap,
  readQa,
  readRequirements,
  readTestPlan,
  sliceWhole,
  toProcessBundle,
  withDecisionRisk,
  writingStepIds,
} from "@countersign/core";
import {
  appUser,
  build,
  buildEvent,
  builderSession,
  buildItem,
  buildMessage,
  externalAction,
  inboxItem,
  run,
  skillVersion,
  type Tx,
  tenant,
  testCase,
  testCaseResult,
  testSuiteRun,
} from "@countersign/db";
import { and, asc, desc, eq, gte, inArray, isNull, like, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { stepRequests } from "../dev-queue/store";
import { iso, notFound, type Services } from "../http";
import { goLiveView } from "../lifecycle/stages";
import { fullSuiteRun, notPendingTry, staleRun } from "../testbench/partial";
import { buildFacts, buildStageOf, buildStanding } from "../work/work-list";
import { trySandbox, tryViews } from "./tries";
import { failureWhy } from "./why";

export type BuildRow = typeof build.$inferSelect;
export type BuildItemRow = typeof buildItem.$inferSelect;
type MessageRow = typeof buildMessage.$inferSelect;

export interface StoreCtx {
  tx: Tx;
  services: Pick<Services, "platform">;
  now(): Date;
}

/** The build, when the session may see it (RLS), locked when asked. */
export async function readBuild(tx: Tx, id: string, lock = false): Promise<BuildRow> {
  const q = tx.select().from(build).where(eq(build.id, id));
  const [row] = lock ? await q.for("update") : await q;
  if (!row) throw notFound("build");
  return row;
}

async function names(tx: Tx, table: "tenant" | "user", ids: (string | null)[]) {
  const wanted = [...new Set(ids.filter((x): x is string => !!x))];
  const out = new Map<string, string>();
  if (wanted.length === 0) return out;
  if (table === "tenant") {
    for (const r of await tx
      .select({ id: tenant.id, name: tenant.name })
      .from(tenant)
      .where(inArray(tenant.id, wanted))) {
      out.set(r.id, r.name);
    }
  } else {
    for (const r of await tx
      .select({ id: appUser.id, name: appUser.name, email: appUser.email })
      .from(appUser)
      .where(inArray(appUser.id, wanted))) {
      out.set(r.id, r.name ?? r.email);
    }
  }
  return out;
}

/** Open items and those the client has, per build. */
async function itemCounts(tx: Tx, ids: string[]) {
  const out = new Map<string, { open: number; client: number }>();
  if (ids.length === 0) return out;
  const rows = await tx
    .select({
      buildId: buildItem.buildId,
      open: sql<number>`count(*) filter (where ${buildItem.state} not in ('done', 'deferred'))::int`,
      client: sql<number>`count(*) filter (where ${buildItem.state} not in ('done', 'deferred') and ${buildItem.owner} = 'client')::int`,
    })
    .from(buildItem)
    .where(inArray(buildItem.buildId, ids))
    .groupBy(buildItem.buildId);
  for (const r of rows) out.set(r.buildId, { open: r.open, client: r.client });
  return out;
}

export async function summaries(tx: Tx, rows: BuildRow[]): Promise<BuildSummary[]> {
  const clients = await names(
    tx,
    "tenant",
    rows.flatMap((r) => [r.clientId, r.testClientId]),
  );
  const users = await names(
    tx,
    "user",
    rows.map((r) => r.createdBy),
  );
  const counts = await itemCounts(
    tx,
    rows.map((r) => r.id),
  );
  // docs/plan.md §1.124: where each build stands in Build's Agent builds pipeline.
  const facts = await buildFacts(tx, rows);
  return rows.map((r) => {
    const c = counts.get(r.id);
    const f = facts.get(r.id);
    return {
      id: r.id,
      kind: r.kind,
      title: r.title,
      client: r.clientId ? { id: r.clientId, name: clients.get(r.clientId) ?? "Client" } : null,
      phase: r.phase,
      status: r.status,
      agentId: r.agentId,
      skillId: r.skillId,
      testAgentId: r.testAgentId,
      testClient: r.testClientId
        ? { id: r.testClientId, name: clients.get(r.testClientId) ?? "Client" }
        : null,
      openItems: c?.open ?? 0,
      waitingOnClient: c?.client ?? 0,
      createdBy: r.createdBy ? (users.get(r.createdBy) ?? null) : null,
      createdAt: iso(r.createdAt) as string,
      updatedAt: iso(r.updatedAt) as string,
      phaseAt: iso(r.phaseAt) as string,
      path: r.path,
      flow: r.flow,
      templateId: r.templateId,
      promisedOn: r.promisedOn,
      origin: r.originKind && r.originId ? { kind: r.originKind, id: r.originId } : null,
      requirements: readRequirements(r.requirements),
      pipelineStage: buildStageOf(r, f),
      standing: buildStanding(r, f),
      waitingOn: r.waitingOn,
      statusLine: r.statusLine,
      stuck: r.stuck,
    };
  });
}

export function itemView(r: BuildItemRow): BuildItemView {
  const ref = (r.ref ?? {}) as Record<string, unknown>;
  const str = (k: string) => (typeof ref[k] === "string" ? { [k]: ref[k] as string } : {});
  return {
    id: r.id,
    phase: r.phase,
    kind: r.kind,
    title: r.title,
    detail: r.detail,
    owner: r.owner,
    state: r.state,
    stepId: r.stepId,
    ref: {
      ...str("testCaseId"),
      ...str("runId"),
      ...str("actionId"),
      ...str("buildId"),
      ...str("codeRequestId"),
      ...str("codeRequestRef"),
    },
    key: r.key ?? null,
    createdAt: iso(r.createdAt) as string,
    resolvedAt: iso(r.resolvedAt),
  };
}

/** A proposal as its message keeps it (ops-builds.ts writes it). */
const SavedProposal = BuildProposal.extend({
  state: ProposalState,
  result: z.string().optional(),
  before: BuildItemState.nullable().optional(),
});

/**
 * What the operator decided about a proposal. Messages are never changed (insert only), so a
 * decision is its own message ("Agreed.", "Not this.", "Undo that."), naming the proposal's.
 */
export const ProposalDecision = z.object({
  decides: z.string(),
  /** STATE-3: `proposed` puts a proposal back when the change agreed to it failed. */
  decision: z.enum(["proposed", "agreed", "unchanged", "declined", "undone"]),
  /** Agreed: an item's state before the change, for its undo. */
  before: BuildItemState.nullable().optional(),
  /** What was done, in words ("Changed: …"), shown under the proposal. */
  result: z.string().optional(),
  /** A draft edit made but the issue it was for still open. */
  unresolved: z.boolean().optional(),
  /**
   * docs/plan.md §1.169: the item a draft edit settled, closed by it, and its state before, so
   * the edit's undo opens it again.
   */
  closed: z.object({ itemId: z.string(), before: BuildItemState }).optional(),
  /** A draft edit's changes to the steps, one line each. */
  changes: z.array(z.string()).optional(),
  /** A draft edit: the Builder session and turn that made it, its changes and the saved version. */
  edit: z
    .object({
      sessionId: z.string(),
      turnId: z.string(),
      changeIds: z.array(z.string()),
      versionId: z.string().nullable(),
    })
    .optional(),
});
export type ProposalDecision = z.infer<typeof ProposalDecision>;

export function decisionOf(meta: unknown): ProposalDecision | null {
  const d = ProposalDecision.safeParse(meta);
  return d.success ? d.data : null;
}

/** Each message with the latest decision on its proposal, if it has one. */
export function withDecisions<M extends { id: string; meta: unknown }>(
  rows: readonly M[],
): [M, ProposalDecision | null][] {
  const latest = new Map<string, ProposalDecision>();
  for (const r of rows) {
    const d = decisionOf(r.meta);
    if (d) latest.set(d.decides, d);
  }
  return rows.map((r) => [r, latest.get(r.id) ?? null]);
}

function messageView(r: MessageRow, decided: ProposalDecision | null = null): BuildMessageView {
  const meta = (r.meta ?? {}) as {
    chips?: unknown;
    changes?: unknown;
    failed?: unknown;
    about?: unknown;
    proposal?: unknown;
  };
  const proposal = SavedProposal.safeParse(
    meta.proposal && decided
      ? {
          ...(meta.proposal as object),
          state: decided.decision,
          before: decided.before ?? null,
          ...(decided.result
            ? { result: decided.result }
            : decided.decision === "agreed"
              ? { result: (meta.proposal as { summary?: unknown }).summary }
              : {}),
        }
      : meta.proposal,
  );
  const editUndo = (decided?.edit?.changeIds.length ?? 0) > 0;
  const strings = (v: unknown) =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  return {
    id: r.id,
    phase: r.phase,
    role: r.role,
    text: r.text,
    chips: strings(meta.chips),
    changes: strings(meta.changes),
    ...(meta.failed ? { failed: true } : {}),
    ...(typeof meta.about === "string" ? { about: meta.about } : {}),
    ...(proposal.success
      ? {
          proposal: {
            summary: proposal.data.summary,
            action: proposal.data.action,
            state: proposal.data.state,
            ...(proposal.data.result ? { result: proposal.data.result } : {}),
            ...(decided?.decision === "agreed" && decided.unresolved ? { unresolved: true } : {}),
            ...(decided?.decision === "agreed" && decided.changes?.length
              ? { changes: decided.changes }
              : {}),
            ...(proposal.data.state === "agreed" &&
            (proposalUndo(proposal.data.action, proposal.data.before ?? null) || editUndo)
              ? { undo: true }
              : {}),
          },
        }
      : {}),
    createdAt: iso(r.createdAt) as string,
  };
}

// ── Writes ───────────────────────────────────────────────────────────────────────────────────────

export async function addMessage(
  tx: Tx,
  row: BuildRow,
  m: { role: "operator" | "builder"; text: string; meta?: Record<string, unknown> },
): Promise<void> {
  await tx.insert(buildMessage).values({
    buildId: row.id,
    phase: row.phase,
    role: m.role,
    text: sliceWhole(m.text, 20_000),
    meta: m.meta ?? {},
  });
}

export async function addEvent(
  tx: Tx,
  row: BuildRow,
  e: {
    kind: "phase" | "record" | "qa" | "decision";
    from?: BuildPhase | null;
    to?: BuildPhase | null;
    payload?: Record<string, unknown>;
    reason?: string | null;
    userId: string | null;
  },
): Promise<void> {
  await tx.insert(buildEvent).values({
    buildId: row.id,
    kind: e.kind,
    fromPhase: e.from ?? null,
    toPhase: e.to ?? null,
    payload: e.payload ?? {},
    reason: e.reason ?? null,
    userId: e.userId,
  });
}

export interface NewItem {
  phase: BuildPhase;
  kind: BuildItemRow["kind"];
  title: string;
  detail?: string | undefined;
  owner?: BuildItemRow["owner"] | undefined;
  stepId?: string | null | undefined;
  ref?: Record<string, string> | undefined;
  /** Made from something (a fit-gap row, a case, a write): made once. */
  key?: string | null | undefined;
  /** Default open; a known risk starts put off. */
  state?: BuildItemRow["state"] | undefined;
}

/** Adds items; one whose key the build already has is left as it is. */
export async function addItems(
  tx: Tx,
  row: BuildRow,
  items: readonly NewItem[],
  userId: string | null,
): Promise<number> {
  let added = 0;
  for (const i of items) {
    const inserted = await tx
      .insert(buildItem)
      .values({
        buildId: row.id,
        phase: i.phase,
        kind: i.kind,
        title: sliceWhole(i.title, 300),
        detail: sliceWhole(i.detail ?? "", 2000),
        owner: i.owner ?? "operator",
        stepId: i.stepId ?? null,
        ref: i.ref ?? {},
        key: i.key ?? null,
        state: i.state ?? "open",
        resolvedAt: i.state && !itemOpen(i.state) ? new Date() : null,
        createdBy: userId,
        // Items are listed by created_at, then id. now() is the transaction's start, so items
        // added together tied, and a v7 id is random within its millisecond: they came back in
        // any order (a flaky builds test, 2026-11-19). The clock's time keeps them in this order.
        createdAt: sql`clock_timestamp()`,
      })
      .onConflictDoNothing()
      .returning({ id: buildItem.id });
    added += inserted.length;
  }
  return added;
}

/** The key an item made from a case or a write carries, so it is made once. */
export function refKey(
  ref: { testCaseId?: string | undefined; actionId?: string | undefined } | undefined,
): string | null {
  if (ref?.testCaseId) return `case:${ref.testCaseId}`;
  if (ref?.actionId) return `action:${ref.actionId}`;
  return null;
}

// ── What a phase's work is now (read live) ──────────────────────────────────────────────────────

/** The skill a skill build's Builder conversation saved, once it has. */
async function sessionSkill(tx: Tx, row: BuildRow): Promise<string | null> {
  if (row.skillId) return row.skillId;
  if (!row.sessionId) return null;
  const [s] = await tx
    .select({ skillId: builderSession.skillId })
    .from(builderSession)
    .where(eq(builderSession.id, row.sessionId));
  return s?.skillId ?? null;
}

interface DraftFacts {
  view: BuildDraftView | null;
  /** The latest version's bundle as processes (agents). */
  bundle: ReturnType<typeof toProcessBundle> | null;
  liveVersions: boolean;
  latestVersionId: string | null;
  agentRow: Awaited<ReturnType<typeof getAgent>> | null;
}

/**
 * Where a problem is, by name: its step's name and its workflow's (the latter only where the agent
 * has more than one), so the screen can say "In Read document (Vendor flow)".
 */
export function problemPlace(
  bundle: DraftFacts["bundle"],
  workflow: string | null,
  stepId: string | null,
): { stepName: string | null; workflowName: string | null } {
  if (!bundle) return { stepName: null, workflowName: null };
  const flows = workflow ? bundle.workflows.filter((w) => w.slug === workflow) : bundle.workflows;
  for (const w of flows) {
    const found = stepId
      ? processes.allSteps(w.workflow).find((l) => l.step.id === stepId)?.step
      : null;
    if (found || (!stepId && workflow)) {
      return {
        stepName: found ? found.name || null : null,
        workflowName: bundle.workflows.length > 1 ? w.name : null,
      };
    }
  }
  return { stepName: null, workflowName: null };
}

/**
 * The draft's problems as the build shows and counts them: grouped as the workflow builder groups
 * them (core `groupProblems`: one step's references to the same later step are one), each with
 * its own key (BUILDER_QA CONS-6).
 */
// DECISION: a problem keeps its old key (workflow|step|field|code) when that names it alone; one
// with the same key adds the reference it is about, then a number, so the keys of problems already
// talked about stay as they were.
export function draftProblems(
  errors: readonly {
    workflow?: string;
    stepId: string | null;
    field: string;
    code: string;
    message: string;
  }[],
  bundle: DraftFacts["bundle"],
): DraftProblem[] {
  const seen = new Set<string>();
  return groupProblems(errors).flatMap((group) => {
    const e = group[0];
    if (!e) return [];
    const order = orderProblem(e);
    const base = [e.workflow ?? "", e.stepId ?? "", e.field, e.code].join("|");
    let key = base;
    if (seen.has(key)) {
      const ref = order
        ? `after:${order.after}`
        : (/^\{\{([^}]*)\}\}/.exec(e.message)?.[1]?.trim() ?? "");
      if (ref) key = `${base}|${ref}`;
    }
    for (let n = 2; seen.has(key); n += 1) key = `${base}|${n}`;
    seen.add(key);
    const refs = group.map((x) => orderProblem(x)?.ref).filter((r): r is string => !!r);
    return [
      {
        key,
        code: e.code,
        // One line for the group, as the workflow builder shows it.
        title:
          order && refs.length > 1
            ? `${refs.map((r) => `{{${r}}}`).join(", ")}: step "${order.after}" does not run before this one on its path`
            : e.message,
        stepId: e.stepId ?? null,
        workflow: e.workflow ?? null,
        ...problemPlace(bundle, e.workflow ?? null, e.stepId ?? null),
      },
    ];
  });
}

/**
 * An agent draft's step ids by workflow slug, so what the Builder names (a proposal's step, a
 * generated case's workflow and steps) is checked against the draft (BUILDER_QA AI-4, AI-6).
 */
export async function draftWorkflowSteps(
  ctx: StoreCtx,
  row: BuildRow,
): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  if (row.kind !== "agent") return out;
  const { bundle } = await draftFacts(ctx, row);
  for (const w of bundle?.workflows ?? []) {
    out.set(w.slug, new Set(processes.allSteps(w.workflow).map(({ step }) => step.id)));
  }
  return out;
}

/** An agent draft's step ids, in any of its workflows. */
export async function draftStepIds(ctx: StoreCtx, row: BuildRow): Promise<Set<string>> {
  const ids = new Set<string>();
  for (const steps of (await draftWorkflowSteps(ctx, row)).values()) {
    for (const s of steps) ids.add(s);
  }
  return ids;
}

/** The longest outline of the draft's steps sent with a Builder turn. */
const OUTLINE_STEPS = 80;

/**
 * The draft's steps, one line each with its id, for the Builder in a build: so a proposed edit
 * names a real step. Agents only (a skill's draft lives in its own conversation).
 */
export async function draftOutline(ctx: StoreCtx, row: BuildRow): Promise<string[]> {
  if (row.kind !== "agent") return [];
  const { bundle, view } = await draftFacts(ctx, row);
  if (!bundle) return [];
  const lines: string[] = [];
  for (const w of bundle.workflows) {
    for (const { step } of processes.allSteps(w.workflow)) {
      if (lines.length >= OUTLINE_STEPS) return [...lines, "Draft: more steps not listed"];
      lines.push(
        `Draft v${view?.version ?? "?"} step [${step.id}] ${step.name || "(no name)"} (${step.kind}), in "${w.name}"`,
      );
    }
  }
  return lines;
}

/** The most steps of a draft the build's page lists; the workflow shows the rest. */
const DRAFT_STEPS_SHOWN = 60;

/** STATE-4: the key of an open item for a fit-gap change made after the draft (the move adds it). */
export const STALE_DRAFT_KEY = "draft:fitgap:";

/**
 * The draft's problems that aren't in its bundle, each holding the draft gate: the draft agent
 * discarded under the build (STATE-5), and a fit-gap change it doesn't cover yet, until its item
 * is closed (STATE-4).
 */
// DECISION (STATE-5): a discarded draft is a draft problem rather than a discard refused while a
// build points at it: the agents registry knows nothing of builds, and Restore brings it back.
async function heldProblems(
  tx: Tx,
  row: BuildRow,
  agentRow: DraftFacts["agentRow"],
): Promise<BuildDraftView["problems"]> {
  const out: BuildDraftView["problems"] = [];
  if (agentRow?.status === "disabled") {
    out.push({
      key: "draft:discarded",
      code: "draft_discarded",
      title: "The draft was discarded. Restore it on its page to go on.",
      stepId: null,
      workflow: null,
    });
  }
  const stale = await tx
    .select({ state: buildItem.state })
    .from(buildItem)
    .where(and(eq(buildItem.buildId, row.id), like(buildItem.key, `${STALE_DRAFT_KEY}%`)));
  if (stale.some((i) => itemOpen(i.state))) {
    out.push({
      key: "draft:fitgap",
      code: "draft_stale",
      title:
        "The fit-gap changed after the draft was made. Change the draft to match, then close its item.",
      stepId: null,
      workflow: null,
    });
  }
  return out;
}

async function draftFacts(ctx: StoreCtx, row: BuildRow): Promise<DraftFacts> {
  const facts = await bundleDraftFacts(ctx, row);
  if (!facts.view) return facts;
  const held = await heldProblems(ctx.tx, row, facts.agentRow);
  return held.length === 0
    ? facts
    : { ...facts, view: { ...facts.view, problems: [...held, ...facts.view.problems] } };
}

/** The draft as its latest version reads, with its validation problems. */
async function bundleDraftFacts(ctx: StoreCtx, row: BuildRow): Promise<DraftFacts> {
  const none: DraftFacts = {
    view: null,
    bundle: null,
    liveVersions: false,
    latestVersionId: null,
    agentRow: null,
  };
  if (row.kind === "skill") {
    const skillId = await sessionSkill(ctx.tx, row);
    if (!skillId && !row.sessionId) return none;
    return {
      ...none,
      view: {
        agentId: null,
        skillId,
        sessionId: row.sessionId,
        versionId: null,
        version: null,
        live: false,
        steps: [],
        problems: skillId
          ? []
          : [
              {
                key: "skill:unsaved",
                code: "skill_unsaved",
                title: "The skill isn't saved yet: save it in its Builder conversation.",
                stepId: null,
                workflow: null,
              },
            ],
      },
    };
  }
  if (!row.agentId) return none;
  const agentRow = await getAgent(ctx.tx, row.agentId).catch(() => null);
  if (!agentRow) return none;
  const latest = await latestVersion(ctx.tx, agentRow.id);
  if (!latest) {
    return {
      ...none,
      agentRow,
      view: {
        agentId: agentRow.id,
        skillId: null,
        sessionId: null,
        versionId: null,
        version: null,
        live: false,
        steps: [],
        problems: [],
      },
    };
  }
  const { platform } = ctx.services;
  const errors = await validateForPublish(ctx.tx, agentRow, latest.bundle, platform.ctx, {
    previous: await existingBundle(ctx.tx, latest),
  });
  let bundle: DraftFacts["bundle"] = null;
  try {
    bundle = toProcessBundle(
      AnyAgentBundle.parse(latest.bundle),
      convertLookup(platform.catalog, platform.tools),
    );
  } catch {
    bundle = null;
  }
  return {
    view: {
      agentId: agentRow.id,
      skillId: null,
      sessionId: null,
      versionId: latest.id,
      version: latest.version,
      live: agentRow.liveVersionId === latest.id,
      problems: draftProblems(errors, bundle),
      // docs/plan.md §1.165: the flow as written, in words, for the build's page.
      steps: bundle ? howItWorks(bundle).slice(0, DRAFT_STEPS_SHOWN) : [],
    },
    bundle,
    liveVersions: agentRow.liveVersionId !== null,
    latestVersionId: latest.id,
    agentRow,
  };
}

async function suitePoc(
  tx: Tx,
  targetKind: "template" | "skill",
  targetId: string,
  versionId: string | null,
  buildId: string,
): Promise<BuildPocView> {
  // builder-plan.md B1: a try waiting to be kept isn't a case yet, and a run of some cases (a
  // try's) isn't the latest run: both show as tries.
  const cases = await tx
    .select({ id: testCase.id, name: testCase.name, required: testCase.required })
    .from(testCase)
    .where(
      and(
        eq(testCase.targetKind, targetKind),
        eq(testCase.targetId, targetId),
        isNull(testCase.archivedAt),
        notPendingTry(),
      ),
    );
  const [latest] = await tx
    .select()
    .from(testSuiteRun)
    .where(
      and(
        eq(testSuiteRun.targetKind, targetKind),
        eq(testSuiteRun.targetId, targetId),
        fullSuiteRun(),
      ),
    )
    .orderBy(desc(testSuiteRun.createdAt))
    .limit(1);
  const required = cases.filter((c) => c.required);
  let failures: BuildPocView["failures"] = [];
  let requiredFailing = required.length;
  if (latest) {
    const results = await tx
      .select({
        caseId: testCaseResult.testCaseId,
        status: testCaseResult.status,
        runId: testCaseResult.runId,
        diff: testCaseResult.diff,
      })
      .from(testCaseResult)
      .where(eq(testCaseResult.suiteRunId, latest.id));
    const byCase = new Map(results.map((r) => [r.caseId, r]));
    failures = cases
      .filter((c) => byCase.get(c.id) && byCase.get(c.id)?.status !== "pass")
      .map((c) => ({
        caseId: c.id,
        name: c.name,
        status: byCase.get(c.id)?.status ?? "error",
        runId: byCase.get(c.id)?.runId ?? null,
        why: failureWhy(byCase.get(c.id)?.diff),
      }));
    requiredFailing = required.filter((c) => byCase.get(c.id)?.status !== "pass").length;
  }
  const current = !!latest && (versionId === null || latest.versionId === versionId);
  const done = latest?.status === "done";
  const passed = cases.length > 0 && !!latest && current && done && requiredFailing === 0;
  const detail =
    cases.length === 0
      ? "There are no test cases yet."
      : !latest
        ? "The test cases haven't run yet."
        : !current
          ? "The latest test run is of an older version: run the cases again."
          : !done
            ? latest.status === "running" && !staleRun(latest, latest.total)
              ? "The test cases are running."
              : "The latest test run failed to finish."
            : requiredFailing > 0
              ? requiredFailing === 1
                ? "1 required case doesn't pass."
                : `${requiredFailing} required cases don't pass.`
              : "Every required case passes.";
  return {
    mode: "suite",
    cases: cases.length,
    required: required.length,
    latest: latest
      ? {
          id: latest.id,
          status: staleRun(latest, latest.total) ? "failed" : latest.status,
          total: latest.total,
          passed: latest.passed,
          failed: latest.failed,
          at: iso(latest.createdAt) as string,
          current,
        }
      : null,
    failures,
    tries: await tryViews(tx, { kind: targetKind, id: targetId }, buildId, versionId),
    trySandbox: await trySandbox(tx),
    testRuns: null,
    passed,
    detail,
  };
}

async function testRunPoc(
  tx: Tx,
  agentId: string,
  versionId: string | null,
): Promise<BuildPocView> {
  const rows = versionId
    ? await tx
        .select({ id: run.id, status: run.status })
        .from(run)
        .where(
          and(eq(run.agentId, agentId), eq(run.agentVersionId, versionId), eq(run.mode, "test")),
        )
        .orderBy(desc(run.createdAt))
        .limit(50)
    : [];
  const succeeded = rows.filter((r) => r.status === "succeeded").length;
  return {
    mode: "test_runs",
    cases: 0,
    required: 0,
    latest: null,
    failures: [],
    tries: [],
    trySandbox: null,
    testRuns: { total: rows.length, succeeded, latestRunId: rows[0]?.id ?? null },
    passed: succeeded > 0,
    detail:
      succeeded > 0
        ? "The latest version has a passing test run."
        : rows.length > 0
          ? "No test run of the latest version has passed yet."
          : "The latest version hasn't had a test run yet.",
  };
}

/** A skill's newest version, the one its tests run on. */
export async function latestSkillVersion(tx: Tx, skillId: string): Promise<string | null> {
  const [v] = await tx
    .select({ id: skillVersion.id })
    .from(skillVersion)
    .where(eq(skillVersion.skillId, skillId))
    .orderBy(desc(skillVersion.version))
    .limit(1);
  return v?.id ?? null;
}

async function pocFacts(
  ctx: StoreCtx,
  row: BuildRow,
  draft: DraftFacts,
): Promise<BuildPocView | null> {
  if (row.kind === "skill") {
    const skillId = draft.view?.skillId ?? null;
    return skillId
      ? suitePoc(ctx.tx, "skill", skillId, await latestSkillVersion(ctx.tx, skillId), row.id)
      : null;
  }
  if (!draft.agentRow) return null;
  return draft.agentRow.kind === "template"
    ? suitePoc(ctx.tx, "template", draft.agentRow.id, draft.latestVersionId, row.id)
    : testRunPoc(ctx.tx, draft.agentRow.id, draft.latestVersionId);
}

async function clientTestFacts(ctx: StoreCtx, row: BuildRow): Promise<BuildClientTestView | null> {
  if (!row.testAgentId || !row.testClientId) return null;
  const agentRow = await getAgent(ctx.tx, row.testAgentId).catch(() => null);
  if (!agentRow) return null;
  const goLive = await goLiveView(ctx.tx, agentRow, ctx.services.platform.ctx, ctx.now());
  const since = goLive.trial ? new Date(goLive.trial.startedAt) : null;
  const actions = await ctx.tx
    .select({
      id: externalAction.id,
      status: externalAction.status,
      tool: externalAction.tool,
      runId: externalAction.runId,
      createdAt: externalAction.createdAt,
      resolution: inboxItem.resolution,
    })
    .from(externalAction)
    .innerJoin(run, eq(run.id, externalAction.runId))
    .leftJoin(inboxItem, eq(inboxItem.id, externalAction.inboxItemId))
    .where(
      and(
        eq(run.agentId, agentRow.id),
        eq(run.mode, "live"),
        ...(since ? [gte(externalAction.createdAt, since)] : []),
      ),
    )
    .orderBy(desc(externalAction.createdAt))
    .limit(500);
  const reasonOf = (resolution: unknown): string | null => {
    if (!resolution || typeof resolution !== "object") return null;
    const r = resolution as Record<string, unknown>;
    for (const k of ["reason", "note", "comment"]) {
      if (typeof r[k] === "string" && (r[k] as string).trim())
        return (r[k] as string).slice(0, 500);
    }
    return null;
  };
  const clients = await names(ctx.tx, "tenant", [row.testClientId]);
  return {
    client: { id: row.testClientId, name: clients.get(row.testClientId) ?? "Client" },
    agentId: agentRow.id,
    stage: goLive.stage,
    trial: goLive.trial
      ? {
          days: goLive.trial.days,
          minDays: goLive.trial.minDays,
          runs: goLive.trial.runs,
          minRuns: goLive.trial.minRuns,
          ready: goLive.trial.ready,
        }
      : null,
    writes: {
      signed: actions.filter((a) => a.status !== "proposed" && a.status !== "rejected").length,
      rejected: actions.filter((a) => a.status === "rejected").length,
      waiting: actions.filter((a) => a.status === "proposed").length,
    },
    rejections: actions
      .filter((a) => a.status === "rejected")
      .slice(0, 20)
      .map((a) => ({
        actionId: a.id,
        runId: a.runId,
        tool: a.tool,
        reason: reasonOf(a.resolution),
        at: iso(a.createdAt) as string,
      })),
  };
}

/**
 * Every loosening anywhere in the bundle (invariant 8), as core counts them: steps' approvals,
 * conversations' messages sent without a person's yes, and process steps' approval overrides.
 */
function loosenedApprovals(bundle: NonNullable<DraftFacts["bundle"]>): number {
  return processes.bundleLoosenings(bundle).length;
}

function qaChecks(
  row: BuildRow,
  draft: DraftFacts,
  poc: BuildPocView | null,
  test: BuildClientTestView | null,
): QaCheck[] {
  const qa = readQa(row.qa);
  const check = (id: QaCheckId, state: "pass" | "fail" | "unknown", detail: string): QaCheck => {
    const accepted = qa.accepted[id];
    return {
      id,
      label: QA_WORDS[id],
      state: state === "fail" && accepted ? "accepted" : state,
      detail,
      reason: accepted?.reason ?? null,
    };
  };
  const out: QaCheck[] = [
    check("tests", poc?.passed ? "pass" : "fail", poc?.detail ?? "No tests yet."),
  ];
  if (row.kind === "agent") {
    if (test) {
      const done = test.stage === "signoff" || test.stage === "live" || !!test.trial?.ready;
      out.push(
        check(
          "trial",
          done ? "pass" : "fail",
          test.trial
            ? `${test.trial.days} of ${test.trial.minDays} days · ${test.trial.runs} of ${test.trial.minRuns} runs`
            : `Stage: ${test.stage ?? "not started"}`,
        ),
      );
      const decided = test.writes.signed + test.writes.rejected;
      const share = decided > 0 ? test.writes.rejected / decided : 0;
      out.push(
        check(
          "rejections",
          decided === 0 ? "unknown" : share <= QA_MAX_REJECTED ? "pass" : "fail",
          decided === 0
            ? "No writes decided yet."
            : `${test.writes.rejected} of ${decided} · ${Math.round(share * 100)}%`,
        ),
      );
    } else {
      out.push(check("trial", "unknown", "No client test."));
    }
    const loose = draft.bundle ? loosenedApprovals(draft.bundle) : 0;
    out.push(
      check(
        "approvals",
        draft.bundle ? (loose === 0 ? "pass" : "fail") : "unknown",
        loose === 0 ? "Every write asks a person first." : `${loose} approvals loosened.`,
      ),
    );
    out.push(
      check(
        "rollback",
        draft.liveVersions ? "pass" : "fail",
        draft.liveVersions ? "A published version stays to go back to." : "Nothing published yet.",
      ),
    );
  }
  return out;
}

/**
 * The draft's steps that write to a client's tool or contact people, by the process validator's
 * helpers over the platform's tools, the built-in skills and the client's own (and shared) custom
 * skills, as publish resolves them (`skillContext`). A skill found nowhere counts as writing
 * (core's `writingStepIds`), so a decision on its step is high risk.
 */
// DECISION (docs/open.md G4): a custom skill's step is decided by the skill's own version and its
// tools, read twice: the version a run would use (the live one, or the one pinned) and the newest
// one saved (a skill drafted beside the build, not published yet, has only that). A step writes
// when either writes or reaches people; only a skill with no version anywhere counts as writing
// unread.
export async function draftWritingSteps(
  ctx: Pick<StoreCtx, "services" | "tx">,
  draft: Pick<DraftFacts, "bundle" | "agentRow">,
): Promise<Set<string>> {
  const { bundle } = draft;
  if (!bundle) return new Set();
  const { platform } = ctx.services;
  const tenantId = draft.agentRow?.tenantId ?? null;
  const live = await skillContext(ctx.tx, { tenantId, bundle, catalog: platform.catalog });
  const newest = await skillContext(ctx.tx, {
    tenantId,
    bundle,
    catalog: platform.catalog,
    newest: true,
  });
  const tools = platform.tools.specs();
  // A ref with no live version is read from its newest one in both.
  const runs = { ...newest.skills, ...live.skills };
  return new Set([
    ...writingStepIds(bundle, { tools, skills: runs }),
    ...writingStepIds(bundle, { tools, skills: newest.skills }),
  ]);
}

/** The build as the screen shows it. */
export async function buildDetail(ctx: StoreCtx, row: BuildRow): Promise<BuildDetail> {
  const { tx } = ctx;
  const [summary] = await summaries(tx, [row]);
  if (!summary) throw notFound("build");
  const messages = await tx
    .select()
    .from(buildMessage)
    .where(eq(buildMessage.buildId, row.id))
    .orderBy(asc(buildMessage.createdAt), asc(buildMessage.id));
  const items = await tx
    .select()
    .from(buildItem)
    .where(eq(buildItem.buildId, row.id))
    .orderBy(asc(buildItem.createdAt), asc(buildItem.id));
  const events = await tx
    .select()
    .from(buildEvent)
    .where(eq(buildEvent.buildId, row.id))
    .orderBy(desc(buildEvent.createdAt))
    .limit(100);
  const users = await names(
    tx,
    "user",
    events.map((e) => e.userId),
  );

  const brief = readBrief(row.brief);
  const testPlan = readTestPlan(row.testPlan);
  const qa = readQa(row.qa);
  const draft = await draftFacts(ctx, row);
  // docs/builder-plan.md §4.2: a decision's risk is worked out by code from the draft as it is
  // now (a step that writes or contacts people), on top of the Builder's flag.
  const stored = readFitGap(row.fitgap);
  const fitgap = {
    ...stored,
    decisions: withDecisionRisk(stored.decisions, await draftWritingSteps(ctx, draft)),
  };
  const poc = await pocFacts(ctx, row, draft);
  const clientTest = await clientTestFacts(ctx, row);
  const checks = qaChecks(row, draft, poc, clientTest);
  const open = items.filter((i) => itemOpen(i.state)).length;
  const reasons =
    row.status !== "open"
      ? []
      : gateReasons({
          kind: row.kind,
          phase: row.phase,
          brief,
          fitgap,
          draft: row.kind === "skill" ? !!draft.view?.skillId : !!draft.view?.versionId,
          draftErrors: draft.view?.problems.length ?? 0,
          poc: poc
            ? { passed: poc.passed, detail: poc.detail }
            : { passed: false, detail: "No tests yet." },
          trialDone:
            !!clientTest &&
            (clientTest.stage === "signoff" ||
              clientTest.stage === "live" ||
              !!clientTest.trial?.ready),
          qaSigned: !!qa.signedAt,
          openItems: open,
        });
  const at = phaseIndex(row.kind, row.phase);
  return {
    build: { ...summary, brief, fitgap, testPlan, qa },
    phases: phasesOf(row.kind).map((phase, i) => ({
      phase,
      label: PHASE_WORDS[phase].label,
      state: row.status === "live" || i < at ? "done" : i === at ? "current" : "todo",
    })),
    gate: { next: row.status === "open" ? nextPhase(row.kind, row.phase) : null, reasons },
    messages: withDecisions(messages).map(([m, d]) => messageView(m, d)),
    items: items.map(itemView),
    draft: draft.view,
    poc,
    clientTest,
    qaChecks: checks,
    events: events.map(
      (e): BuildEventView => ({
        id: e.id,
        kind: e.kind,
        from: e.fromPhase,
        to: e.toPhase,
        reason: e.reason,
        who: e.userId ? (users.get(e.userId) ?? null) : null,
        at: iso(e.createdAt) as string,
      }),
    ),
    codeRequests: await stepRequests(ctx.tx, [row.id]),
  };
}

/** Builds for the board: open ones by phase (or of one status), newest moves first. */
export async function listBuilds(
  tx: Tx,
  q: {
    status?: BuildRow["status"] | undefined;
    agent?: string | undefined;
    path?: "new" | "template" | "all" | undefined;
  },
): Promise<BuildRow[]> {
  const where = [
    // docs/plan.md §1.124: the Agent lab's Drafts (the old Builder board) keeps new agents; template builds are Build's.
    ...(q.path && q.path !== "all" ? [eq(build.path, q.path)] : []),
    q.status ? eq(build.status, q.status) : ne(build.status, "stopped"),
    ...(q.agent ? [sql`(${build.agentId} = ${q.agent} or ${build.testAgentId} = ${q.agent})`] : []),
  ];
  return tx
    .select()
    .from(build)
    .where(and(...where))
    .orderBy(desc(build.updatedAt))
    .limit(200);
}

/** Open items across builds, newest first. */
export async function openItemsAcross(tx: Tx, rows: BuildRow[]) {
  const ids = rows.filter((r) => r.status === "open").map((r) => r.id);
  if (ids.length === 0) return [];
  const titles = new Map(rows.map((r) => [r.id, r.title]));
  const items = await tx
    .select()
    .from(buildItem)
    .where(
      and(inArray(buildItem.buildId, ids), sql`${buildItem.state} not in ('done', 'deferred')`),
    )
    .orderBy(desc(buildItem.createdAt))
    .limit(100);
  return items.map((i) => ({
    ...itemView(i),
    buildId: i.buildId,
    buildTitle: titles.get(i.buildId) ?? "",
  }));
}
