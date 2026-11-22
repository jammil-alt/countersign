// Builds (docs/plan.md §1.108): the routes of a build's way from intake to go-live. The Builder's
// turns and the moves that make things (the draft, test cases, the client's copy) are slow routes
// (mountLong): the model and the back office's own routes run outside any transaction, each of
// those routes as the operator through `invokeRoute` (its roles, scope, checks and audit row,
// marked as the build's), and the build is saved in short operator-scoped transactions.

import {
  BuilderError,
  buildTurn,
  fork,
  getAgent,
  latestVersion,
  makeTestCases,
  reviewBrief,
} from "@countersign/agents";
import {
  AnyAgentBundle,
  BRIEF_FIELDS,
  BRIEF_LABELS,
  type Brief,
  type BriefFieldKey,
  type BuildAction,
  type BuildDetail,
  type BuildIssue,
  BuildItemState,
  type BuildPhase,
  type BuildProposal,
  BuildProposal as BuildProposalSchema,
  buildHasSetupForm,
  buildIssues,
  CODE_REQUEST_STATUS_WORDS,
  ComplianceRefusal,
  type DecisionDraft,
  decisionUnreviewed,
  dqNumber,
  FIT_WORDS,
  type FitGap,
  type FitRow,
  fitChangeKind,
  fitScope,
  gapSteps,
  issueByKey,
  issueLine,
  isUuid,
  itemOpen,
  mergeBrief,
  mergeDecisions,
  mergeFitGap,
  NOT_NEEDED_NOTE,
  nextPhase,
  operatorFitGap,
  PHASE_WORDS,
  ProposalState,
  parseDqNumber,
  phaseIndex,
  processes,
  proposalUndo,
  readBrief,
  readFitGap,
  readQa,
  readTestPlan,
  routes,
  SETTLE_OWNER,
  SETTLE_WORDS,
  SETUP_WORDS,
  type SettleWay,
  setDecisionStatus,
  settledByStep,
  settleFits,
  sliceWhole,
  testCaseProblems,
  withNote,
} from "@countersign/core";
import {
  build,
  buildEvent,
  buildItem,
  buildMessage,
  codeRequest,
  codeRequestLink,
  skillVersion,
  type Tx,
} from "@countersign/db";
import { DEFAULT_MODELS, type LlmTransport } from "@countersign/llm";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { Hono } from "hono";
import { freeSlug, moveToClientTest } from "../build/client-test";
import { withBuildManual } from "../build/manual";
import { draftSetupItems, withSetupItems } from "../build/setup";
import {
  addEvent,
  addItems,
  addMessage,
  type BuildRow,
  buildDetail,
  draftOutline,
  draftStepIds,
  draftWorkflowSteps,
  latestSkillVersion,
  listBuilds,
  type NewItem,
  openItemsAcross,
  readBuild,
  refKey,
  STALE_DRAFT_KEY,
  summaries,
  withDecisions,
} from "../build/store";
import { testCaseFacts } from "../build/why";
import { clientModels, clientsRefusingModel } from "../compliance/models";
import { acceptRequest, type DqCtx, fileRequest, linkToRequest } from "../dev-queue/service";
import { settleShipped } from "../dev-queue/ship";
import {
  type AppContext,
  type AppEnv,
  ensureClient,
  HttpError,
  invokeRoute,
  mount,
  mountLong,
  notFound,
  type RouteInput,
  type Scoped,
  type Services,
  toHttpError,
} from "../http";
import { meterDepsOf, meteredLlm, tokensMeta } from "../metering";
import { reportHandled, reportProblem } from "../observability/report";
import { bindTestCopy } from "./ops-agents";
import { builderContext, builderHttpError } from "./ops-builder";

/**
 * The model transport for a build, held to its client's HIPAA mode (§1.35); a build for everyone
 * is no client's data. The model runs outside any transaction here, so the database reads it.
 */
function transport(services: Pick<Services, "deps" | "env" | "db">, row: BuildRow): LlmTransport {
  // A template's build tested at a client carries that client's name and its people's words.
  return clientModels(services, {
    clients: [row.clientId, row.testClientId],
    read: services.db,
  });
}

const now = () => new Date();

function refuseClosed(row: BuildRow): void {
  if (row.status !== "open") {
    throw new HttpError(409, "build_closed", `this build is ${row.status}`);
  }
}

/** The description the Builder drafts from: the confirmed brief and the agreed fit-gap. */
export function draftDescription(
  row: Pick<BuildRow, "title" | "kind" | "clientId">,
  brief: Brief,
  fitgap: FitGap,
): string {
  const lines = [`${row.title}.`];
  for (const key of BRIEF_FIELDS) {
    const f = brief[key];
    if (f?.text.trim()) lines.push(`${BRIEF_LABELS[key]}: ${f.text.trim()}`);
  }
  const inScope = fitgap.rows.filter((r) => !r.dropped && !r.later && r.verdict !== "not_possible");
  if (inScope.length > 0) {
    lines.push("", "What it does, and how (the normal case):");
    for (const r of inScope) {
      const changed = r.override
        ? `; the operator changed it from ${FIT_WORDS[r.override.from]}: ${r.override.reason}`
        : "";
      lines.push(`- ${r.need} (${FIT_WORDS[r.verdict]}${changed}): ${r.how}`);
    }
  }
  // Happy path first (owner, 2026-11-17): known risks are named so the draft leaves them out.
  const later = fitgap.rows.filter((r) => !r.dropped && r.later && r.verdict !== "not_possible");
  if (later.length > 0) {
    lines.push(
      "",
      "Known risks, not built in this version (when one happens, the run hands it to a person; no steps or missing steps for them):",
    );
    for (const r of later) lines.push(`- ${r.need}`);
  }
  const out = fitgap.rows.filter((r) => r.dropped || r.verdict === "not_possible");
  if (out.length > 0) {
    lines.push("", "Not in scope:");
    for (const r of out) lines.push(`- ${r.need}${r.how ? `: ${r.how}` : ""}`);
  }
  if (fitgap.needsTrue.length > 0 && !buildHasSetupForm(row)) {
    lines.push("", "What needs to be true:");
    for (const n of fitgap.needsTrue) lines.push(`- ${n.text}`);
  }
  const asked = fitgap.setup.filter((f) => !f.dropped);
  if (asked.length > 0 && buildHasSetupForm(row)) {
    lines.push("", "What we get from each client to set it up:");
    for (const f of asked) lines.push(`- ${f.label} (${SETUP_WORDS[f.kind]})`);
  }
  // docs/builder-plan.md §4: the decisions made so far, so the draft follows them.
  if (fitgap.decisions.length > 0) {
    lines.push("", "Decisions already made (follow them; a decision point is a person step):");
    for (const d of fitgap.decisions) {
      lines.push(`- ${d.what}${d.value ? ` (starts at ${d.value})` : ""}`);
    }
  }
  const text = lines.join("\n");
  return text.length > 4000 ? `${text.slice(0, 3990)}…` : text;
}

/**
 * Items the agreed fit-gap leaves: what to build or find, and, for one client, what must be true.
 * A template has no client: what it needs from one is its intake form, which makes no items.
 * A known risk is a gap put off from the start: listed, holding nothing, reopened when it shows up.
 */
export function fitGapItems(fitgap: FitGap, template: boolean): NewItem[] {
  const out: NewItem[] = [];
  for (const r of fitgap.rows) {
    if (r.dropped) continue;
    if (r.later) {
      out.push({
        phase: "fitgap",
        kind: "gap",
        title: r.need,
        detail: `Known risk, not in the first version: until it shows up in runs, a person handles it.${r.how ? ` Later: ${r.how}` : ""}`,
        owner: r.verdict === "figure_out" ? "engineering" : "builder",
        state: "deferred",
        key: `fit:${r.id}`,
      });
      continue;
    }
    if (r.verdict === "build" || r.verdict === "figure_out") {
      out.push({
        phase: "fitgap",
        kind: "gap",
        title: r.need,
        detail: r.override
          ? `${r.how} You set it to ${FIT_WORDS[r.verdict]}: ${r.override.reason}`
          : r.how,
        owner: r.verdict === "build" ? "builder" : "engineering",
        key: `fit:${r.id}`,
      });
    }
  }
  for (const n of template ? [] : fitgap.needsTrue) {
    if (!n.done) {
      out.push({
        phase: "fitgap",
        kind: "precondition",
        title: n.text,
        owner: "client",
        key: `need:${n.id}`,
      });
    }
  }
  return out;
}

/** The brief's open fields, as questions that carry over. */
function briefItems(brief: Brief): NewItem[] {
  return BRIEF_FIELDS.filter((k) => brief[k]?.state === "open").map((k) => ({
    phase: "intake" as const,
    kind: "question" as const,
    title: `${BRIEF_LABELS[k]}: ${brief[k]?.text.trim() || "still open"}`,
    key: `brief:${k}`,
  }));
}

/** The Builder's answers to the operator's challenges, as the build's record. */
function answeredChallenges(before: FitGap, after: FitGap) {
  const out: { rowId: string; need: string; wanted: string; from: string; to: string }[] = [];
  for (const p of before.rows) {
    if (!p.challenge) continue;
    const a = after.rows.find((r) => r.id === p.id);
    out.push({
      rowId: p.id,
      need: a?.need ?? p.need,
      wanted: p.challenge.wanted,
      from: p.verdict,
      to: a?.verdict ?? "removed",
    });
  }
  return out;
}

/**
 * One line per thing the turn changed, for the conversation: only what was stored (BUILDER_QA
 * AI-5), so a brief field kept as the operator had it or a decision with no room isn't claimed.
 */
function changeLines(
  answer: Awaited<ReturnType<typeof buildTurn>>["answer"],
  stored: {
    brief: readonly BriefFieldKey[];
    fitgap: boolean;
    testPlan: boolean;
    decisions: ReadonlySet<string>;
  },
): string[] {
  const out: string[] = [];
  if (answer.brief) {
    for (const key of BRIEF_FIELDS) {
      const f = answer.brief[key];
      if (!f || !stored.brief.includes(key)) continue;
      // QA (2026-11-17): a field the turn left open read as filled ("+ Brief: done well means").
      const state =
        f.state === "open" ? " (still open)" : f.state === "assumed" ? " (assumed)" : "";
      out.push(`Brief: ${BRIEF_LABELS[key].toLowerCase()}${state}`);
    }
  }
  if (answer.fitgap && stored.fitgap) {
    const n = answer.fitgap.rows.length;
    out.push(`Fit-gap: ${n} ${n === 1 ? "row" : "rows"}`);
  }
  if (answer.testPlan && stored.testPlan) {
    const n = answer.testPlan.datasets.length;
    out.push(`Test plan: ${n} ${n === 1 ? "dataset" : "datasets"}`);
  }
  for (const i of answer.items) out.push(`Open item: ${i.title}`);
  for (const d of answer.decisions) {
    if (stored.decisions.has(d.id)) out.push(`Decision: ${d.what}`);
  }
  return out;
}

/** A slow build route's context; the process interview's draft (§1.217) passes its own. */
export interface LongCtx {
  c: AppContext;
  app: Hono<AppEnv>;
  session: Parameters<typeof invokeRoute>[2];
  services: Services;
  inTx<T>(work: (scoped: Scoped) => Promise<T>): Promise<T>;
}

function detailIn(scoped: Scoped, services: Services, row: BuildRow): Promise<BuildDetail> {
  return buildDetail({ tx: scoped.tx, services, now }, row);
}

/** A back-office route, run as this operator, audited as the build's (§1.35). */
function call<R extends Parameters<typeof invokeRoute>[3]>(
  ctx: LongCtx,
  spec: R,
  raw: RouteInput = {},
) {
  return invokeRoute(ctx.app, ctx.c, ctx.session, spec, raw, "build");
}

/** What a failed turn left undone, by phase. */
function phaseNotDone(phase: BuildPhase): string {
  return phase === "fitgap"
    ? "The fit-gap isn't written yet"
    : phase === "poc"
      ? "The test plan isn't written yet"
      : "Nothing changed";
}

/** What the conversation says when the Builder's turn fails, by what went wrong. */
function failedTurnText(phase: BuildPhase, error: unknown): { code: string; text: string } {
  const what = phaseNotDone(phase);
  // HIPAA mode (§1.35): nothing was sent; the turn says why rather than "try again".
  if (error instanceof ComplianceRefusal) {
    return { code: "hipaa", text: `${error.message}. ${what}.` };
  }
  const code =
    error instanceof BuilderError
      ? error.code === "invalid_answer" &&
        (error.details as { code?: string } | undefined)?.code === "max_tokens"
        ? "cut_off"
        : error.code
      : "error";
  if (code === "model_unavailable") {
    return {
      code,
      text: `I couldn't reach my model just now. ${what}. Press Retry, or ask again in a minute.`,
    };
  }
  if (code === "cut_off") {
    return {
      code,
      text: `My answer ran too long and was cut off before I could save it. ${what}. Press Retry; we've logged it.`,
    };
  }
  // BUILDER_QA AI-7: the model declined; its answer's form had nothing to do with it.
  if (code === "refusal") {
    return {
      code,
      text: `My model declined to answer that. ${what}. Try saying it another way, or press Retry; we've logged it.`,
    };
  }
  return {
    code,
    text: `My answer came back in a form I couldn't save. ${what}. Press Retry; we've logged it.`,
  };
}

/**
 * The Builder's turn in the build's phase: `words` are the operator's (saved first), or null when
 * the Builder opens a phase. With `retry`, the phase's last turn is tried again: the failed answers
 * at the end of the conversation are passed over, and the operator's words before them are
 * answered again without being saved twice (or, with none, the Builder opens the phase again).
 * A turn that fails says so in the conversation, with nothing changed, and is reported (Sentry).
 */
// DECISION (QA on staging, 2026-11-16): a failed turn is a Builder message, not an HTTP error.
// The error used to reach the screen as the raw validation text, vanish on reload and leave the
// operator's words with no answer; the failure was never reported.
async function turn(
  ctx: LongCtx,
  id: string,
  words: string | null,
  opts: { retry?: boolean; about?: string | null } = {},
): Promise<void> {
  const { retry = false } = opts;
  const prep = await ctx.inTx(async (scoped) => {
    const row = await readBuild(scoped.tx, id, true);
    refuseClosed(row);
    const all = await scoped.tx
      .select({
        role: buildMessage.role,
        text: buildMessage.text,
        phase: buildMessage.phase,
        meta: buildMessage.meta,
      })
      .from(buildMessage)
      .where(eq(buildMessage.buildId, row.id))
      .orderBy(asc(buildMessage.createdAt), asc(buildMessage.id));
    const failed = (m: (typeof all)[number]) =>
      m.role === "builder" && !!(m.meta as { failed?: unknown } | null)?.failed;
    // Failed answers say nothing about the work: the model never sees them.
    const history = all.filter((m) => !failed(m)).map(({ role, text }) => ({ role, text }));
    let said = words;
    let about = opts.about ?? null;
    if (retry && !words) {
      const last = all.filter((m) => !failed(m)).at(-1);
      if (last?.role === "operator" && last.phase === row.phase) {
        history.pop();
        said = last.text;
        about = metaAbout(last.meta) ?? about;
      }
    }
    const detail = await detailIn(scoped, ctx.services, row);
    const issues = buildIssues(detail);
    // An issue that isn't the build's (gone, or never was) is no focus.
    // docs/builder-plan.md §4: any decision can be talked about, not only the ones that are issues.
    const focused = about ? issueByKey(detail, about, issues) : null;
    if (words && !retry) {
      await addMessage(scoped.tx, row, {
        role: "operator",
        text: words,
        meta: focused ? { about: focused.key } : {},
      });
    }
    // Its thread: what was said about it, however long ago (the history keeps only the latest).
    const thread = focused
      ? all
          .filter((m) => !failed(m) && metaAbout(m.meta) === focused.key)
          .slice(-THREAD_MAX)
          .map((m) => ({ role: m.role, text: sliceWhole(m.text, 600) }))
      : [];
    const facts = [
      ...(detail.draft?.problems.map((p) => `Draft problem: ${p.title}`) ?? []),
      ...(detail.poc ? [`Tests: ${detail.poc.detail}`] : []),
      // builder-plan.md B0, B1: why each failing case fails, and what each try did.
      ...testCaseFacts(detail.poc),
      ...(detail.clientTest
        ? [
            `Client test at ${detail.clientTest.client.name}: stage ${detail.clientTest.stage ?? "none"}, ${detail.clientTest.writes.signed} writes signed, ${detail.clientTest.writes.rejected} rejected, ${detail.clientTest.writes.waiting} waiting.`,
            ...detail.clientTest.rejections.map(
              (r) => `Rejected ${r.tool}: ${r.reason ?? "no reason given"}`,
            ),
          ]
        : []),
      ...detail.qaChecks.map((c) => `QA ${c.label}: ${c.state} (${c.detail})`),
      // docs/builder-plan.md §4.2: high-risk decisions nobody has looked at hold the client test.
      ...detail.build.fitgap.decisions
        .filter(decisionUnreviewed)
        .map((d) => `High-risk decision not looked at yet [decision:${d.id}]: ${d.what}`),
      ...(detail.gate.reasons.length > 0
        ? [`Can't move on yet: ${detail.gate.reasons.join(" ")}`]
        : []),
      // The draft's steps by id, so a proposed edit names a real one.
      ...(row.phase === "draft" || row.phase === "poc"
        ? await draftOutline({ tx: scoped.tx, services: ctx.services, now }, row)
        : []),
      // docs/plan.md §1.125: what this build waits on in the Dev queue, and what is open there,
      // so a second build links to the first build's request instead of filing again.
      ...(await devQueueFacts(scoped.tx, row.id)),
    ];
    // Owner (2026-11-17): the catalog in every phase, and the other work the operator can see.
    const bctx = await builderContext({ ...scoped, services: ctx.services }, row.clientId);
    const otherWork = await otherWorkLines(scoped.tx, ctx.services, row);
    const client = detail.build.client?.name ?? null;
    return {
      row,
      history,
      facts,
      bctx,
      otherWork,
      client,
      said,
      detail,
      issues,
      focused,
      thread,
    };
  });
  const { row } = prep;
  let result: Awaited<ReturnType<typeof buildTurn>>;
  // §1.210: an answer's cost is saved on its message; a turn that fails, or whose answer isn't
  // saved, keeps none, so its calls are recorded as ours once the request ends.
  const metered = meteredLlm(meterDepsOf(ctx), {
    transport: transport(ctx.services, row),
    tenantId: row.clientId,
    source: "build",
  });
  try {
    result = await buildTurn(
      {
        phase: row.phase,
        kind: row.kind,
        title: row.title,
        clientName: prep.client,
        brief: readBrief(row.brief),
        // The decisions with their risk worked out by code, as the build shows them.
        fitgap: prep.detail.build.fitgap,
        testPlan: readTestPlan(row.testPlan),
        issues: prep.issues.map(issueLine),
        focus: prep.focused ? { line: issueLine(prep.focused), thread: prep.thread } : null,
        facts: prep.facts,
        history: prep.history,
        words: prep.said,
        ctx: prep.bctx,
        otherWork: prep.otherWork,
      },
      { llm: metered.llm },
    );
  } catch (error) {
    await failTurn(ctx, id, row.phase, failedTurnText(row.phase, error), error);
    return;
  }
  const { answer } = result;
  try {
    await ctx.inTx(async (scoped) => {
      const fresh = await readBuild(scoped.tx, id, true);
      // BUILDER_QA STATE-2: a build stopped (or gone live) while the model answered keeps its
      // record as it was when it closed: the answer is refused, nothing of it is saved.
      refuseClosed(fresh);
      // The phase may have moved while the model answered: only that phase's record changes.
      const set: Partial<BuildRow> = {};
      let briefChanged: BriefFieldKey[] = [];
      if (fresh.phase === row.phase) {
        if (answer.brief) {
          // BUILDER_QA AI-2: never lowers a field's state, so the operator's confirmed words stay.
          const merged = mergeBrief(readBrief(fresh.brief), answer.brief);
          briefChanged = merged.changed;
          if (briefChanged.length > 0) set.brief = merged.brief;
        }
        if (answer.fitgap) {
          const before = readFitGap(fresh.fitgap);
          const merged = mergeFitGap(before, answer.fitgap);
          set.fitgap = merged;
          for (const a of answeredChallenges(before, merged)) {
            await addEvent(scoped.tx, fresh, {
              kind: "record",
              payload: { verdict: { ...a, as: "builder" } },
              userId: null,
            });
          }
        }
        if (answer.testPlan) set.testPlan = answer.testPlan;
        // docs/builder-plan.md §4: the Builder's new and changed decisions, onto the build's record.
        if (answer.decisions.length > 0) {
          const base = set.fitgap ? readFitGap(set.fitgap) : readFitGap(fresh.fitgap);
          set.fitgap = { ...base, decisions: mergeDecisions(base.decisions, answer.decisions) };
        }
      }
      if (Object.keys(set).length > 0)
        await scoped.tx.update(build).set(set).where(eq(build.id, id));
      else await scoped.tx.update(build).set({ updatedAt: now() }).where(eq(build.id, id));
      await addItems(
        scoped.tx,
        fresh,
        answer.items.map((i) => ({ ...i, phase: fresh.phase })),
        ctx.session.user.id,
      );
      // BUILDER_QA AI-8: only the operator's words answer a question. A turn the Builder opens
      // (no words) closes nothing, whatever it lists as answered.
      const answered = prep.said ? await closeAnswered(scoped.tx, fresh, answer.answered) : [];
      // The issue it answered about, and its proposal, only as they fit the build as it was asked.
      const about =
        (answer.about && issueByKey(prep.detail, answer.about, prep.issues)
          ? answer.about
          : null) ??
        prep.focused?.key ??
        null;
      const fit = answer.proposal
        ? fitProposal(
            answer.proposal,
            prep.detail,
            fresh.phase,
            await proposalFacts(scoped.tx, ctx.services, fresh, answer.proposal),
          )
        : null;
      const proposal = fit && "proposal" in fit ? fit.proposal : null;
      // Staging (2026-11-21, Sentry MEZONAS-API-9 again): "Build a skill" on an issue whose step
      // already had its skill build. The Builder proposed it anyway; the card was dropped, the
      // Builder's words said it was started, and nothing happened. A change that is already under
      // way is said so in the message, not reported: nothing is wrong. Anything else is reported
      // with why, so the next one says which rule it broke.
      const already = fit && "why" in fit && fit.why === "already_settled" ? fit.said : null;
      if (answer.proposal && fit && "why" in fit && fit.why !== "already_settled") {
        reportProblem("the Builder proposed a change that doesn't fit the build", {
          kind: "build",
          action: answer.proposal.action.do,
          why: fit.why,
          build: id,
        });
      }
      // BUILDER_QA AI-5: the change lines say what was stored, not what the answer sent.
      const kept =
        fresh.phase === row.phase ? readFitGap(set.fitgap ?? fresh.fitgap).decisions : [];
      await addMessage(scoped.tx, fresh, {
        role: "builder",
        text: already ? `${answer.text}\n\n${already}` : answer.text,
        meta: {
          chips: answer.chips,
          changes: [
            ...changeLines(answer, {
              brief: briefChanged,
              fitgap: !!set.fitgap && !!answer.fitgap,
              testPlan: !!set.testPlan,
              decisions: new Set(kept.map((d) => d.id)),
            }),
            ...answered.map((t) => `Answered: ${t}`),
          ],
          costUsd: result.costUsd,
          model: result.calls[0]?.model ?? null,
          ...tokensMeta(result.calls),
          ...(about ? { about } : {}),
          ...(proposal ? { proposal: { ...proposal, state: "proposed" } } : {}),
          // docs/plan.md §1.165: the Builder's word that the operator asked for this change. Only
          // on a turn with the operator's words: one the Builder opens asks for nothing.
          ...(proposal && answer.asked && prep.said ? { asked: true } : {}),
        },
      });
    });
    metered.settled();
  } catch (error) {
    if (error instanceof HttpError) throw error;
    // BUILDER_QA INPUT-3: an answer the database wouldn't take is a failed turn with Retry, as a
    // failed model call is, never a 500 that loses the operator's words.
    await failTurn(
      ctx,
      id,
      row.phase,
      {
        code: "save_failed",
        text: `I couldn't save my answer. ${phaseNotDone(row.phase)}. Press Retry; we've logged it.`,
      },
      error,
    );
  }
}

/**
 * Made at once (docs/plan.md §1.165): the change the Builder just proposed, when it is one the
 * operator asked for. With a way chosen on the issue (`settle`), the proposal that way asks for
 * (a draft edit, a skill, a code request); with none, a draft edit the Builder says the operator's
 * words asked for. It is made by the proposal's own decision (`decideProposal`), so its checks, its claim
 * and its undo are the same. Anything else stays a proposal to agree.
 */
// DECISION (owner, 2026-11-21: "if we get it written then we can see the flows and keep editing
// it"): a change asked for doesn't wait for a second yes. A draft edit can be undone; a skill
// build or a code request made by an issue's own button is the operator's choice already. A
// change that can't be made is put back as a proposal with the Builder's reason (the route's own
// `guarded`), and the turn's answer stands.
async function makeAtOnce(ctx: LongCtx, id: string, settle: SettleWay | null): Promise<void> {
  const found = await ctx.inTx(async (scoped) => {
    const [last] = await scoped.tx
      .select({ id: buildMessage.id, role: buildMessage.role, meta: buildMessage.meta })
      .from(buildMessage)
      .where(eq(buildMessage.buildId, id))
      .orderBy(desc(buildMessage.createdAt), desc(buildMessage.id))
      .limit(1);
    if (last?.role !== "builder") return null;
    const meta = (last.meta ?? {}) as { proposal?: unknown; asked?: unknown };
    const stored = StoredProposal.safeParse(meta.proposal);
    if (!stored.success || stored.data.state !== "proposed") return null;
    if (!settle && meta.asked !== true) return null;
    return settleFits(settle, stored.data.action.do) ? last.id : null;
  });
  if (!found) return;
  await decideProposal(ctx, id, found, "agree", true).catch((error: unknown) =>
    reportHandled("a change asked for in a build couldn't be made at once", error, {
      kind: "build",
      build: id,
    }),
  );
}

/**
 * docs/plan.md §1.169 (owner, 2026-11-21: "give it an action, not just mark it"): a way chosen on
 * an item gives it to whoever takes that step (the Builder, or Mezonas engineering) and starts it;
 * one put off is taken back up. What closes it is the step's result, never this.
 */
async function giveTo(ctx: LongCtx, id: string, about: string, way: SettleWay): Promise<void> {
  const itemId = /^item:([0-9a-f-]{36})$/i.exec(about)?.[1];
  if (!itemId) return;
  await ctx.inTx(async (scoped) => {
    const row = await readBuild(scoped.tx, id, true);
    refuseClosed(row);
    const [item] = await scoped.tx
      .select({ id: buildItem.id, state: buildItem.state })
      .from(buildItem)
      .where(and(eq(buildItem.id, itemId), eq(buildItem.buildId, row.id)));
    if (!item || item.state === "done") return;
    await scoped.tx
      .update(buildItem)
      .set({
        owner: SETTLE_OWNER[way],
        state: item.state === "waiting" ? "waiting" : "in_progress",
        resolvedAt: null,
      })
      .where(eq(buildItem.id, item.id));
  });
}

/** A failed Builder turn, said in the conversation and reported (Sentry). */
async function failTurn(
  ctx: LongCtx,
  id: string,
  phase: BuildPhase,
  failure: { code: string; text: string },
  error: unknown,
): Promise<void> {
  reportHandled("a Builder turn in a build failed", error, {
    kind: "build",
    phase,
    failure: failure.code,
    build: id,
  });
  await ctx.inTx(async (scoped) => {
    const fresh = await readBuild(scoped.tx, id, true);
    // BUILDER_QA STATE-2: a stopped build's conversation is as it was when it stopped.
    refuseClosed(fresh);
    await addMessage(scoped.tx, fresh, {
      role: "builder",
      text: failure.text,
      meta: { failed: failure.code },
    });
  });
}

/** A proposal as saved on its message: what was decided, and an item's state before it. */
const StoredProposal = BuildProposalSchema.extend({
  state: ProposalState,
  before: BuildItemState.nullable().optional(),
});

/**
 * The open questions the operator's words answered (the turn's `answered`), closed as done; their
 * titles. QA (2026-11-17, fourth run): the operator answered eight questions in the chat, the
 * Builder wrote the answers into the brief, and the questions stayed open. Only open items of
 * kind question close this way: the operator's answer is the decision. Anything else is closed
 * by a proposal the operator agrees to.
 */
async function closeAnswered(tx: Tx, row: BuildRow, keys: readonly string[]): Promise<string[]> {
  const ids = [
    ...new Set(keys.map((k) => /^item:([0-9a-f-]{36})$/i.exec(k)?.[1]).filter((x) => !!x)),
  ] as string[];
  if (ids.length === 0) return [];
  const rows = await tx
    .select({
      id: buildItem.id,
      title: buildItem.title,
      kind: buildItem.kind,
      state: buildItem.state,
    })
    .from(buildItem)
    .where(and(eq(buildItem.buildId, row.id), inArray(buildItem.id, ids)));
  const closing = rows.filter((r) => r.kind === "question" && itemOpen(r.state));
  if (closing.length === 0) return [];
  await tx
    .update(buildItem)
    .set({ state: "done", resolvedAt: now() })
    .where(
      and(
        eq(buildItem.buildId, row.id),
        inArray(
          buildItem.id,
          closing.map((r) => r.id),
        ),
      ),
    );
  return closing.map((r) => r.title);
}

/** A short, stable fingerprint of a brief: which one was reviewed. */
function briefHash(brief: Brief): string {
  const text = JSON.stringify(BRIEF_FIELDS.map((k) => [k, brief[k]?.state, brief[k]?.text]));
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * The review before a brief is confirmed (`reviewBrief`): once a build. Concerns become open
 * questions and the Builder lists them; the build stays in intake (true). Already reviewed,
 * nothing found, or a review that couldn't run: the move goes on (false).
 */
// QA (2026-11-17, fourth run): once per brief as it read meant every answer changed the brief and
// the next Confirm reviewed it again, eight more questions a press (7, 14, then 37 open). Once a
// build: answering the questions is how the brief gets better, and the second Confirm goes on.
async function reviewHolds(ctx: LongCtx, row: BuildRow): Promise<boolean> {
  const brief = readBrief(row.brief);
  const hash = briefHash(brief);
  const prep = await ctx.inTx(async (scoped) => {
    const events = await scoped.tx
      .select({ payload: buildEvent.payload })
      .from(buildEvent)
      .where(and(eq(buildEvent.buildId, row.id), eq(buildEvent.kind, "record")));
    const reviewed = events.some(
      (e) => (e.payload as { review?: unknown } | null)?.review !== undefined,
    );
    if (reviewed) return null;
    const detail = await detailIn(scoped, ctx.services, row);
    return {
      issues: buildIssues(detail)
        .filter((i) => i.open)
        .map((i) => i.title),
      otherWork: await otherWorkLines(scoped.tx, ctx.services, row),
      bctx: await builderContext({ ...scoped, services: ctx.services }, row.clientId),
      client: detail.build.client?.name ?? null,
    };
  });
  if (!prep) return false;
  let concerns: Awaited<ReturnType<typeof reviewBrief>>["concerns"];
  try {
    concerns = (
      await reviewBrief(
        {
          title: row.title,
          kind: row.kind,
          clientName: prep.client,
          brief,
          otherWork: prep.otherWork,
          issues: prep.issues,
          ctx: prep.bctx,
        },
        // §1.210: the review's calls are ours; nothing else keeps their cost.
        {
          llm: meteredLlm(meterDepsOf(ctx), {
            transport: transport(ctx.services, row),
            tenantId: row.clientId,
            source: "build",
          }).llm,
        },
      )
    ).concerns;
  } catch (error) {
    // A review that couldn't run doesn't hold the build: it says so and goes on.
    reportHandled("a brief's review failed", error, { kind: "build", build: row.id });
    await ctx.inTx(async (scoped) => {
      await addMessage(scoped.tx, await readBuild(scoped.tx, row.id, true), {
        role: "builder",
        text:
          error instanceof ComplianceRefusal
            ? `I couldn't give the brief its second look: ${error.message}. It goes on as it is.`
            : "I couldn't give the brief its second look just now, so it goes on as it is.",
      });
    });
    return false;
  }
  await ctx.inTx(async (scoped) => {
    const fresh = await readBuild(scoped.tx, row.id, true);
    await addEvent(scoped.tx, fresh, {
      kind: "record",
      payload: { review: { brief: hash, concerns: concerns.length } },
      userId: ctx.session.user.id,
    });
    if (concerns.length === 0) return;
    await addItems(
      scoped.tx,
      fresh,
      concerns.map((c, i) => ({
        title: c.title,
        detail: c.detail,
        kind: "question" as const,
        owner: "operator" as const,
        phase: "intake" as const,
        key: `review:${hash}:${c.checklist ?? i}`,
      })),
      ctx.session.user.id,
    );
    const n = concerns.length;
    await addMessage(scoped.tx, fresh, {
      role: "builder",
      text: `Before you confirm, I gave the brief a second look. ${n === 1 ? "One thing it doesn't settle yet" : `${n} things it doesn't settle yet`}: ${concerns
        .map((c, i) => `${i + 1}. ${c.title}`)
        .join(
          " ",
        )} They're in the issues. Answer them here, or press "Confirm the brief" again to go on with them open: a first draft can start without them, and I won't add more at this step.`,
      meta: { chips: ["Take the first one"] },
    });
  });
  return concerns.length > 0;
}

/** At most this many lines of other work go with a turn. */
const OTHER_WORK_MAX = 40;

/**
 * Other builds the operator can see (RLS scopes them to the clients they serve), each with its
 * phase, and their open issues: so the Builder can name work this one overlaps (QA, 2026-11-16:
 * AP Invoice Review already had an open item for a vendor management flow).
 */
async function otherWorkLines(tx: Tx, services: Services, row: BuildRow): Promise<string[]> {
  const listed = (await listBuilds(tx, { status: "open" })).filter((b) => b.id !== row.id);
  // DECISION: another client's build is left out where that client's HIPAA mode refuses the
  // Builder's model (§1.35), rather than refusing this build's turn for it.
  const refusing = await clientsRefusingModel(
    services,
    { clients: listed.flatMap((b) => [b.clientId, b.testClientId]), read: tx },
    DEFAULT_MODELS.builder,
  );
  const others = listed.filter(
    (b) => !refusing.has(b.clientId ?? "") && !refusing.has(b.testClientId ?? ""),
  );
  if (others.length === 0) return [];
  const items = await openItemsAcross(tx, others);
  const lines: string[] = [];
  for (const b of others) {
    const open = items.filter((i) => i.buildId === b.id).map((i) => `“${i.title}”`);
    lines.push(
      `Build “${b.title}” (${PHASE_WORDS[b.phase].label.toLowerCase()})${open.length ? `: open issues ${open.slice(0, 6).join(", ")}` : ""}`,
    );
    if (lines.length >= OTHER_WORK_MAX) break;
  }
  return lines;
}

/** Messages of an issue's thread sent with a turn about it. */
const THREAD_MAX = 12;

function metaAbout(meta: unknown): string | null {
  const v = (meta as { about?: unknown } | null)?.about;
  return typeof v === "string" ? v : null;
}

/** What a proposal names, read from the build as it is now (BUILDER_QA AI-4). */
interface ProposalFacts {
  /** An agent draft's step ids, when the proposal names a step; null when nothing is checked. */
  stepIds: ReadonlySet<string> | null;
  /** The Dev queue request it names, if there is one, and whether this build waits on it. */
  request: { id: string; number: number; status: string; waitedOn: boolean } | null;
}

async function proposalFacts(
  tx: Tx,
  services: Services,
  row: BuildRow,
  p: BuildProposal,
): Promise<ProposalFacts> {
  const a = p.action;
  const out: ProposalFacts = { stepIds: null, request: null };
  if (a.do === "edit_draft" && a.stepId && row.kind === "agent") {
    out.stepIds = await draftStepIds({ tx, services, now }, row);
  }
  if (a.do === "link_code_request" || a.do === "approve_code_request") {
    const n = isUuid(a.requestId) ? null : parseDqNumber(a.requestId);
    if (isUuid(a.requestId) || n !== null) {
      const [r] = await tx
        .select({ id: codeRequest.id, number: codeRequest.number, status: codeRequest.status })
        .from(codeRequest)
        .where(
          isUuid(a.requestId) ? eq(codeRequest.id, a.requestId) : eq(codeRequest.number, n ?? 0),
        );
      if (r) {
        const [link] = await tx
          .select({ id: codeRequestLink.id })
          .from(codeRequestLink)
          .where(and(eq(codeRequestLink.requestId, r.id), eq(codeRequestLink.buildId, row.id)))
          .limit(1);
        out.request = { ...r, waitedOn: !!link };
      }
    }
  }
  return out;
}

/** Why a proposal doesn't fit the build. `already_settled`: what it asks for is already under way. */
type ProposalMiss =
  | "already_settled"
  | "not_an_open_item"
  | "not_a_closed_item"
  | "not_a_failed_check"
  | "not_an_earlier_phase"
  | "wrong_phase"
  | "unknown_step"
  | "unknown_request";

/** A proposal as it fits the build, or why it doesn't (and, when already settled, what to say). */
type ProposalFit =
  | { proposal: BuildProposal }
  | { why: Exclude<ProposalMiss, "already_settled"> }
  | { why: "already_settled"; said: string };

/**
 * The Builder's proposal if it fits the build: an item it names is this build's and in the state
 * the change needs, a check is failing in QA, going back is to an earlier phase, tests run in the
 * POC, a step it names is in the draft, a request it names exists under its ref (and one to approve
 * is in triage and this build waits on it). The route that makes the change checks again when the
 * operator agrees.
 */
function fitProposal(
  p: BuildProposal,
  d: BuildDetail,
  phase: BuildPhase,
  f: ProposalFacts,
): ProposalFit {
  const a = p.action;
  const itemOf = (raw: string) => d.items.find((i) => i.id === raw.replace(/^item:/, ""));
  const ok = (proposal: BuildProposal): ProposalFit => ({ proposal });
  const no = (why: Exclude<ProposalMiss, "already_settled">): ProposalFit => ({ why });
  switch (a.do) {
    case "close_item": {
      const item = itemOf(a.itemId);
      if (!item || !itemOpen(item.state)) return no("not_an_open_item");
      // docs/plan.md §1.169: the Builder doesn't close by saying so what only its step closes;
      // it may put one off. Nothing is wrong, so it is said in the message, not reported.
      if (a.state === "done" && settledByStep(item.kind)) {
        return {
          why: "already_settled",
          said: `“${item.title}” closes when its step is settled, not by saying so, so I left it open.`,
        };
      }
      return ok({ ...p, action: { ...a, itemId: item.id } });
    }
    case "reopen_item": {
      const item = itemOf(a.itemId);
      return item && !itemOpen(item.state)
        ? ok({ ...p, action: { ...a, itemId: item.id } })
        : no("not_a_closed_item");
    }
    case "accept_check":
      return phase === "qa" && d.qaChecks.some((c) => c.id === a.check && c.state === "fail")
        ? ok(p)
        : no("not_a_failed_check");
    case "go_back":
      return phaseIndex(d.build.kind, a.to) >= 0 &&
        phaseIndex(d.build.kind, a.to) < phaseIndex(d.build.kind, phase)
        ? ok(p)
        : no("not_an_earlier_phase");
    case "run_tests":
      return phase === "poc" && d.draft ? ok(p) : no("wrong_phase");
    case "edit_draft":
      // BUILDER_QA AI-4: a step it names is one of the draft's.
      if (a.stepId && f.stepIds && !f.stepIds.has(a.stepId)) return no("unknown_step");
      // The draft is what the POC tests; from the client test on, the change goes back first.
      return (phase === "draft" || phase === "poc") &&
        (d.build.kind === "agent" ? !!d.draft?.versionId : !!d.draft?.sessionId)
        ? ok(p)
        : no("wrong_phase");
    // docs/plan.md §1.125: a gap's two buckets, and the Dev queue's link and approval.
    case "file_code_request":
    case "link_code_request":
    case "draft_skill": {
      if (phase !== "fitgap" && phase !== "draft" && phase !== "poc") return no("wrong_phase");
      // BUILDER_QA AI-4: the request to link is there, under the ref it names, and still open.
      if (a.do === "link_code_request") {
        const r = f.request;
        if (!r || parseDqNumber(a.ref) !== r.number || r.status === "closed") {
          return no("unknown_request");
        }
      }
      // A step that already has its skill build is settled that way.
      if (
        a.do === "draft_skill" &&
        a.stepId &&
        d.items.some((i) => i.stepId === a.stepId && i.ref.buildId && itemOpen(i.state))
      ) {
        return {
          why: "already_settled",
          said: "That step already has a skill build under way, so I didn't start another. It's in the issues list.",
        };
      }
      const item = a.itemId ? itemOf(a.itemId) : undefined;
      // QA on staging (2026-11-19, Sentry MEZONAS-API-9): in the draft the issues are the draft's
      // problems, so the Builder named a `problem:` key (or no open gap) and the whole proposal
      // was dropped: it said it had proposed the skill, and no card showed. A key that isn't an
      // open gap is left out instead; the change makes its own gap item, as a request's link does.
      // docs/plan.md §1.169: a gap put off (a known risk) is settled the same way; the change
      // takes it back up.
      if (!item || item.state === "done" || item.kind !== "gap") {
        const { itemId: _, ...rest } = a;
        return ok({ ...p, action: rest });
      }
      // A gap already waiting on a request, or with its skill build, is settled that way.
      if (item.ref.codeRequestId || (a.do === "draft_skill" && item.ref.buildId)) {
        return {
          why: "already_settled",
          said: item.ref.codeRequestId
            ? `“${item.title}” is already waiting on a code request, so I left it as it is.`
            : `“${item.title}” already has a skill build under way, so I didn't start another.`,
        };
      }
      return ok({ ...p, action: { ...a, itemId: item.id } });
    }
    case "approve_code_request": {
      // BUILDER_QA AI-4: only a request this build waits on, under its own ref, still in triage.
      const r = f.request;
      return r?.waitedOn && r.status === "triage" && parseDqNumber(a.ref) === r.number
        ? ok(p)
        : no("unknown_request");
    }
  }
}

type EditAction = Extract<BuildAction, { do: "edit_draft" }>;

interface Edit {
  sessionId: string;
  turnId: string;
  changes: { id: string; label: string }[];
  text: string;
  versionId: string | null;
}

/** An agreed draft edit as its decision keeps it, for its undo. */
interface SavedEdit {
  sessionId: string;
  turnId: string;
  changeIds: string[];
  versionId: string | null;
}

/**
 * Makes an agreed draft edit: a Builder session on the draft (an agent's: a new one from its latest
 * version, so nothing older is saved over it; a skill's: the build's own conversation), one turn
 * with the request (about its step when it names one), and the result saved as a draft version.
 */
async function applyEdit(ctx: LongCtx, id: string, a: EditAction, summary: string): Promise<Edit> {
  const row = await ctx.inTx((scoped) => readBuild(scoped.tx, id, true));
  let sessionId: string;
  if (row.kind === "agent") {
    if (!row.agentId) throw new HttpError(409, "no_draft", "there's no draft to change yet");
    const started = await call(ctx, routes.opsStartBuilderSession, {
      body: { kind: "agent", agentId: row.agentId },
    });
    sessionId = started.session.id;
  } else {
    if (!row.sessionId) throw new HttpError(409, "no_draft", "there's no draft to change yet");
    sessionId = row.sessionId;
  }
  let turn: {
    id: string;
    text: string;
    changes: { id: string; label: string; undoes?: unknown }[];
  };
  try {
    const out = await call(ctx, routes.opsBuilderTurn, {
      params: { id: sessionId },
      body: { text: a.request, ...(a.stepId ? { focusStepId: a.stepId } : {}) },
    });
    turn = out.turn;
  } catch (error) {
    reportHandled("a draft edit in a build failed", error, { kind: "build", build: id });
    throw new HttpError(
      503,
      "edit_failed",
      "I couldn't make the change just now, so the draft is as it was. Press Agree to try again.",
    );
  }
  const changes = turn.changes.filter((c) => !c.undoes).map((c) => ({ id: c.id, label: c.label }));
  let versionId: string | null = null;
  if (changes.length > 0) {
    const saved = await call(ctx, routes.opsBuilderSave, {
      params: { id: sessionId },
      body: { changeNote: clip(summary, 300) },
    });
    versionId = saved.version.id;
  }
  return { sessionId, turnId: turn.id, changes, text: turn.text, versionId };
}

/**
 * Undoes an agreed draft edit: its changes, newest first, in its Builder session, saved again. An
 * agent's draft with a newer version than the edit's is not saved over: undo it there instead.
 */
async function undoEdit(ctx: LongCtx, id: string, edit: SavedEdit, summary: string): Promise<void> {
  const row = await ctx.inTx((scoped) => readBuild(scoped.tx, id, true));
  const agentId = row.kind === "agent" ? row.agentId : null;
  if (agentId && edit.versionId) {
    const latest = await ctx.inTx((scoped) => latestVersion(scoped.tx, agentId));
    if (latest?.id !== edit.versionId) {
      throw new HttpError(
        409,
        "draft_moved",
        "The draft has changed since this edit, so undoing it here could lose that change. Undo it in the workflow instead.",
      );
    }
  }
  for (const changeId of [...edit.changeIds].reverse()) {
    await call(ctx, routes.opsBuilderUndo, {
      params: { id: edit.sessionId },
      body: { turnId: edit.turnId, changeId },
    });
  }
  await call(ctx, routes.opsBuilderSave, {
    params: { id: edit.sessionId },
    body: { changeNote: clip(`Undo: ${summary}`, 300) },
  });
}

/**
 * Runs the POC's test cases on the draft's latest version (the test bench's suite run). Called by
 * the build's Run button and by an agreed "run the tests" proposal: a slow route isn't reachable
 * through `invokeRoute`, so the proposal calls this, not the route (Sentry MEZONAS-API-7).
 */
async function runBuildTests(ctx: LongCtx, id: string): Promise<void> {
  const target = await ctx.inTx(async (scoped) => {
    const row = await readBuild(scoped.tx, id);
    refuseClosed(row);
    const detail = await detailIn(scoped, ctx.services, row);
    if (row.kind === "skill") {
      const skillId = detail.draft?.skillId;
      const versionId = skillId ? await latestSkillVersion(scoped.tx, skillId) : null;
      if (!skillId || !versionId) throw new HttpError(409, "no_draft", "the skill isn't saved yet");
      return { targetKind: "skill" as const, targetId: skillId, versionId };
    }
    const versionId = detail.draft?.versionId;
    if (!detail.draft?.agentId || !versionId)
      throw new HttpError(409, "no_draft", "there is no draft yet");
    if (detail.poc?.mode !== "suite") {
      throw new HttpError(409, "test_runs", "a client agent is tested with test runs on its page");
    }
    return { targetKind: "template" as const, targetId: detail.draft.agentId, versionId };
  });
  await call(ctx, routes.opsRunTests, { body: target });
}

/** Makes an agreed change through the build's own route, as the operator. */
async function runAction(ctx: LongCtx, id: string, a: BuildAction): Promise<void> {
  switch (a.do) {
    case "close_item":
    case "reopen_item":
      await call(ctx, routes.opsUpdateBuildItem, {
        params: { id, itemId: a.itemId },
        body: { state: a.do === "close_item" ? a.state : "open" },
      });
      return;
    case "accept_check":
      await call(ctx, routes.opsBuildQa, {
        params: { id },
        body: { accept: a.check, reason: a.reason },
      });
      return;
    case "go_back":
      await move(ctx, id, a.to, a.reason);
      return;
    case "run_tests":
      await runBuildTests(ctx, id);
      return;
    case "edit_draft":
      throw new Error("a draft edit is made by applyEdit");
    case "file_code_request":
    case "link_code_request":
    case "approve_code_request":
    case "draft_skill":
      throw new Error("a Dev queue proposal is made by runDevQueueAction");
  }
}

/** The Dev queue's moves as this build's operator (docs/plan.md §1.125). */
function dqCtx(ctx: LongCtx, actor: "operator" | "builder"): DqCtx {
  return {
    services: ctx.services,
    inTx: ctx.inTx,
    userId: ctx.session.user.id,
    actor,
    now,
  };
}

type DevQueueAction = Extract<
  BuildAction,
  { do: "file_code_request" | "link_code_request" | "approve_code_request" | "draft_skill" }
>;

function isDevQueueAction(a: BuildAction): a is DevQueueAction {
  return (
    a.do === "file_code_request" ||
    a.do === "link_code_request" ||
    a.do === "approve_code_request" ||
    a.do === "draft_skill"
  );
}

/**
 * Makes an agreed Dev queue proposal: files the request (the reuse check runs; an open request
 * for the same capability comes back as a link to propose instead), links to one, approves one
 * (the same guarded move as the request page's Accept), or starts a skill build for a gap that
 * catalog parts can make (bucket A). Returns what the Builder says next, and a follow-up proposal.
 */
async function runDevQueueAction(
  ctx: LongCtx,
  id: string,
  a: DevQueueAction,
): Promise<{ text: string; proposal?: BuildProposal; about?: string }> {
  switch (a.do) {
    case "file_code_request": {
      const r = a.request;
      const link = {
        buildId: id,
        ...(a.workflowId ? { workflowId: a.workflowId } : {}),
        ...(a.stepId ? { stepId: a.stepId } : {}),
        ...(a.itemId ? { issueId: a.itemId } : {}),
      };
      const filed = await fileRequest(dqCtx(ctx, "builder"), {
        title: r.title,
        kind: r.kind,
        spec: {
          summary: r.summary,
          inputs: r.inputs,
          outputs: r.outputs,
          rules: r.rules,
          acceptance: r.acceptance,
          parts: [r.part],
          packages: [],
        },
        openQuestions: r.questions.map((q) => ({ ...q, answer: null })),
        decision: r.decision,
        decisionReason: r.decisionReason,
        otherUses: r.otherUses,
        considered: r.considered,
        link,
        createdBy: "builder",
      });
      if (filed.duplicate) {
        const d = filed.duplicate;
        return {
          text: `This looks like ${d.ref}: ${d.title}. I'd link this step to it rather than file it twice.`,
          proposal: {
            summary: `Link this step to ${d.ref}`,
            action: {
              do: "link_code_request",
              requestId: d.id,
              ref: d.ref,
              ...(a.itemId ? { itemId: a.itemId } : {}),
              ...(a.stepId ? { stepId: a.stepId } : {}),
              ...(a.workflowId ? { workflowId: a.workflowId } : {}),
            },
          },
        };
      }
      const q = filed.request as NonNullable<typeof filed.request>;
      const flag = q.coveredBy
        ? ` The reuse check thinks “${q.coveredBy.name}” may already do it, so it's suggested as exists: look at that first.`
        : "";
      const reasons = q.moves.accept.allowed
        ? ""
        : ` Before it can be approved: ${q.moves.accept.reason}`;
      return {
        text: `Filed ${q.ref}: ${q.title}. It's in triage in the Dev queue, owned by Mezonas engineering.${flag}${reasons} The draft's problem on this step holds the move to the POC test until it ships; open questions and other gaps don't.`,
        ...(q.moves.accept.allowed
          ? {
              proposal: {
                summary: `Approve ${q.ref}: ${q.title}`.slice(0, 300),
                action: { do: "approve_code_request", requestId: q.id, ref: q.ref },
              },
            }
          : {}),
      };
    }
    case "link_code_request": {
      const q = await linkToRequest(
        dqCtx(ctx, "builder"),
        a.requestId,
        {
          buildId: id,
          ...(a.workflowId ? { workflowId: a.workflowId } : {}),
          ...(a.stepId ? { stepId: a.stepId } : {}),
          ...(a.itemId ? { issueId: a.itemId } : {}),
        },
        true,
      );
      return { text: `Linked to ${q.ref}. The step waits on it, and I'll say here when it ships.` };
    }
    case "approve_code_request": {
      const q = await acceptRequest(dqCtx(ctx, "operator"), a.requestId);
      return { text: `${q.ref} approved: ${q.title}. Building it next.` };
    }
    case "draft_skill":
      return draftSkill(ctx, id, a);
  }
}

/**
 * Bucket A (docs/plan.md §1.125): a gap catalog parts can fill as a skill (rules or an AI step over
 * existing tools) is drafted in the same flow, as a skill build of its own: its brief filled from
 * the step's need, its draft the skill Builder's, its tests the test bench's. The gap item names it
 * (`ref.buildId`) and is the Builder's while it runs.
 */
// DECISION: the skill build starts with its brief filled and stays in intake for the operator's
// Confirm, so its own review, fit-gap, draft and test bench run as any skill build's do; nothing
// is queued and nothing deploys.
async function draftSkill(
  ctx: LongCtx,
  id: string,
  a: Extract<BuildAction, { do: "draft_skill" }>,
): Promise<{ text: string }> {
  const parent = await ctx.inTx((scoped) => readBuild(scoped.tx, id, true));
  const started = await call(ctx, routes.opsStartBuild, {
    body: {
      kind: "skill",
      title: a.title,
      ...(parent.clientId ? { clientId: parent.clientId } : {}),
    },
  });
  const skillBuild = started.build.id;
  const field = (text: string) => ({ text: clip(text, 1000), state: "assumed" as const });
  await call(ctx, routes.opsUpdateBuild, {
    params: { id: skillBuild },
    body: {
      brief: {
        goal: field(a.goal),
        trigger: field(`Called as a step of the build “${parent.title}”.`),
        dataIn: field(a.dataIn),
        dataOut: field(a.dataOut),
        ...(a.rules ? { rules: field(a.rules) } : {}),
      },
    },
  });
  await ctx.inTx(async (scoped) => {
    const made = await readBuild(scoped.tx, skillBuild, true);
    await addMessage(scoped.tx, made, {
      role: "builder",
      text: `I filled this brief from a step of “${parent.title}” that catalog parts can do as a skill. Check it and confirm; then I'll draft the skill and we test it on the test bench before it goes back there.`,
      meta: {},
    });
    if (a.itemId) {
      await scoped.tx
        .update(buildItem)
        .set({
          owner: "builder",
          state: "in_progress",
          ref: sql`${buildItem.ref} || ${JSON.stringify({ buildId: skillBuild })}::jsonb`,
        })
        .where(and(eq(buildItem.id, a.itemId), eq(buildItem.buildId, id)));
    } else {
      // No gap named: one for the skill build, as a request's link makes one (keyed, made once).
      await scoped.tx
        .insert(buildItem)
        .values({
          buildId: parent.id,
          phase: parent.phase,
          kind: "gap",
          title: clip(a.title, 300),
          detail: `Drafted as the skill build “${clip(a.title, 200)}”.`,
          owner: "builder",
          state: "in_progress",
          stepId: a.stepId ?? null,
          ref: { buildId: skillBuild },
          key: `skill:${skillBuild}`,
          createdBy: ctx.session.user.id,
        })
        .onConflictDoNothing();
    }
  });
  return {
    text: `I started the skill build “${a.title}” with its brief filled from this step. Confirm its brief there; it drafts the skill and tests it on the test bench, then it comes back to this step.`,
  };
}

/** The Dev queue as the Builder sees it from a build: what it waits on, and what is open. */
async function devQueueFacts(tx: Tx, buildId: string): Promise<string[]> {
  const mine = await tx
    .select({
      id: codeRequest.id,
      number: codeRequest.number,
      title: codeRequest.title,
      status: codeRequest.status,
      stepId: codeRequestLink.stepId,
    })
    .from(codeRequestLink)
    .innerJoin(codeRequest, eq(codeRequest.id, codeRequestLink.requestId))
    .where(eq(codeRequestLink.buildId, buildId));
  const open = await tx
    .select({
      id: codeRequest.id,
      number: codeRequest.number,
      title: codeRequest.title,
      status: codeRequest.status,
    })
    .from(codeRequest)
    .where(inArray(codeRequest.status, ["triage", "accepted", "in_progress"]))
    .orderBy(asc(codeRequest.number))
    .limit(30);
  const words = (s: string) =>
    CODE_REQUEST_STATUS_WORDS[s as keyof typeof CODE_REQUEST_STATUS_WORDS] ?? s;
  return [
    ...mine.map(
      (r) =>
        `This build waits on ${dqNumber(r.number)} (${words(r.status)}, request id ${r.id})${r.stepId ? ` for step ${r.stepId}` : ""}: ${r.title}`,
    ),
    ...open
      .filter((r) => !mine.some((m) => m.id === r.id))
      .map(
        (r) =>
          `Open in the Dev queue: ${dqNumber(r.number)} (${words(r.status)}, request id ${r.id}): ${r.title}`,
      ),
  ];
}

const clip = (text: string, max: number) =>
  text.length > max ? `${sliceWhole(text, max - 1)}…` : text;

/** The first `n` sentences of a reply, for a one-line account of what was done. */
function firstSentences(text: string, n: number): string {
  // A sentence ends at . ! or ? followed by a space or the end, so "15.00" stays whole.
  const parts = text.trim().split(/(?<=[.!?])\s+/);
  return clip(parts.slice(0, n).join(" ").trim() || text.trim(), 600);
}

/**
 * The issue an agreed draft edit was for, if it is still open after it: the issue the
 * conversation was on, else a problem still on the step the edit named.
 */
function stillOpen(d: BuildDetail, about: string | null, stepId: string | null): BuildIssue | null {
  const issues = buildIssues(d);
  // An open item can't be checked this way (only closing it settles it): the draft's problems,
  // failing tests and checks can, since they're read from the draft.
  const onIt = about
    ? issues.find((i) => i.key === about && i.open && i.source !== "item")
    : undefined;
  if (onIt) return onIt;
  if (!stepId) return null;
  const problem = d.draft?.problems.find((p) => p.stepId === stepId);
  return problem ? (issues.find((i) => i.key === `problem:${problem.key}`) ?? null) : null;
}

/** What the conversation says after an agreed change, and the next open issue to take. */
function doneText(summary: string, next: BuildIssue | undefined, changed: string[] = []): string {
  // A draft edit says what it changed in the Builder's words; anything else, what was agreed.
  const done =
    changed.length > 0
      ? `Changed the draft: ${changed.join(" ")}`
      : `Done: ${summary.replace(/[.\s]+$/, "")}.`;
  return next
    ? `${done} Next open issue: “${next.title}”. Shall we take it?`
    : `${done} That was the last open issue.`;
}

/**
 * Makes the draft (once): the Builder's own route, as the operator. With the decisions the
 * drafter made (docs/builder-plan.md §4), which the build keeps. A draft that already exists is
 * kept (`kept`); what changed in the fit-gap since it was made is flagged by the move (STATE-4).
 */
async function makeDraft(
  ctx: LongCtx,
  row: BuildRow,
  // docs/plan.md §1.165: draft it now gives its own description and asks for a draft that runs.
  atOnce: { description: string } | null = null,
): Promise<{
  set: Partial<BuildRow>;
  decisions: DecisionDraft[];
  kept: boolean;
  summary?: string;
  gaps?: string[];
  gapSteps?: (string | null)[];
}> {
  const description =
    atOnce?.description ?? draftDescription(row, readBrief(row.brief), readFitGap(row.fitgap));
  if (row.kind === "agent") {
    if (row.agentId) return { set: {}, decisions: [], kept: true };
    const out = await call(ctx, routes.opsDraftAgent, {
      body: {
        description,
        name: row.title,
        ...(row.clientId ? { clientId: row.clientId } : {}),
        ...(atOnce ? { worksFirst: true } : {}),
      },
    });
    return {
      set: { agentId: out.agent.id },
      decisions: out.decisions ?? [],
      kept: false,
      summary: out.summary,
      gaps: out.gaps,
      ...(out.gapSteps ? { gapSteps: out.gapSteps } : {}),
    };
  }
  if (row.sessionId) return { set: {}, decisions: [], kept: true };
  const started = await call(ctx, routes.opsStartBuilderSession, {
    body: { kind: "skill", name: row.title, ...(row.clientId ? { clientId: row.clientId } : {}) },
  });
  // FLOW-5: the skill's first draft. A model that can't answer fails the move as an agent's draft
  // does (503, the build stays in the fit-gap to try again), never "look at the draft" over an
  // empty conversation.
  // DECISION: the Builder session started for a first draft that failed is left unused (the build
  // doesn't point at it); the next try starts a new one from the brief and the fit-gap.
  await call(ctx, routes.opsBuilderTurn, {
    params: { id: started.session.id },
    body: { text: description },
  });
  return { set: { sessionId: started.session.id }, decisions: [], kept: false };
}

/**
 * The draft's step standing for each gap, or null: the one the drafter named (F-C), when the saved
 * draft has it, else the step core's word match finds (a person step that asks, or a missing step).
 */
// DECISION (F-C): the drafter's own answer first, the word match only for a gap it named no step
// for, so a draft whose model leaves `gapSteps` out reads as before.
async function draftGapSteps(
  tx: Tx,
  agentId: string | null | undefined,
  gaps: readonly string[],
  named: readonly (string | null)[] = [],
): Promise<(string | null)[]> {
  const latest = agentId ? await latestVersion(tx, agentId) : null;
  const parsed = latest ? AnyAgentBundle.safeParse(latest.bundle) : null;
  if (!parsed?.success) return gaps.map(() => null);
  const drafted = parsed.data.workflows.flatMap((w) =>
    w.workflow.schemaVersion === 4 ? [w.workflow] : [],
  );
  const ids = new Set(drafted.flatMap((p) => processes.allSteps(p).map(({ step }) => step.id)));
  const matched = gapSteps(gaps, drafted);
  return gaps.map((_, i) => {
    const said = named[i];
    return said && ids.has(said) ? said : (matched[i] ?? null);
  });
}

/** A short, stable fingerprint of a fit-gap's first version. */
function fitGapHash(fitgap: FitGap): string {
  const rows = fitgap.rows
    .filter((r) => fitScope(r) === "main")
    .map((r) => [r.id, r.need, r.verdict, r.how]);
  const text = JSON.stringify(rows);
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * STATE-4: what changed in the fit-gap's first version since an earlier fit-gap, one line each in
 * the need's own words: a row new to it, changed (its need, verdict or how), or taken out.
 */
function fitGapChanges(before: FitGap, after: FitGap): string[] {
  const main = (f: FitGap) =>
    new Map(f.rows.filter((r) => fitScope(r) === "main").map((r) => [r.id, r]));
  const was = main(before);
  const is = main(after);
  const out: string[] = [];
  for (const [rowId, r] of is) {
    const w = was.get(rowId);
    if (!w) out.push(`${r.need} (new)`);
    else if (w.need !== r.need || w.verdict !== r.verdict || w.how !== r.how) {
      out.push(`${r.need} (changed)`);
    }
  }
  for (const [rowId, w] of was) if (!is.has(rowId)) out.push(`${w.need} (taken out)`);
  return out;
}

/** The fit-gap as the build's last move out of the fit-gap recorded it (its `build_event`). */
async function lastFitGapRecord(tx: Tx, buildId: string): Promise<FitGap | null> {
  const [e] = await tx
    .select({ payload: buildEvent.payload })
    .from(buildEvent)
    .where(
      and(
        eq(buildEvent.buildId, buildId),
        eq(buildEvent.kind, "record"),
        sql`${buildEvent.payload} ? 'fitgap'`,
      ),
    )
    .orderBy(desc(buildEvent.createdAt), desc(buildEvent.id))
    .limit(1);
  return e ? readFitGap((e.payload as { fitgap?: unknown }).fitgap) : null;
}

/** What the Builder says once a build is in its draft: what the move did, by what happened. */
function draftMovedText(
  kind: BuildRow["kind"],
  kept: boolean,
  changes: string[] | null,
  problems: number,
): string {
  const open =
    kind === "skill"
      ? "Open its Builder conversation to look at it and save it; its problems show here."
      : problems === 0
        ? "It has no problems; open the workflow to look it over."
        : `${problems === 1 ? "1 problem is" : `${problems} problems are`} left to fix: missing steps are where the catalog has nothing yet. Open the workflow to work on them.`;
  if (!kept) {
    return kind === "skill"
      ? `I drafted the skill from the brief and the fit-gap in its own Builder conversation. ${open}`
      : `I drafted it from the brief and the fit-gap. ${open}`;
  }
  if (changes && changes.length > 0) {
    return `I kept the draft from before. It was made before the fit-gap changed, so it doesn't cover: ${changes.join(", ")}. I added an item to change the draft to match; the draft can't go to the POC test until you close it. ${open}`;
  }
  return changes
    ? `I kept the draft from before: the fit-gap's first version hasn't changed since. ${open}`
    : `I kept the draft from before. ${open}`;
}

/**
 * Writes what the build owns into the draft, as one new version through the back office's own
 * save, as the operator, when it changes the draft: the agent's manual (docs/builder-plan.md §5,
 * B3) and, for a template build, its setup checklist (`definition.setup`, §6, B4), which a client
 * copy forked from the template carries to the client. A skill build has neither. A failure is
 * reported and never holds the move. Nothing is written once the build has left `phase` or closed.
 */
// DECISION: written on the moves into the draft and the POC test only, never per turn, so a
// conversation doesn't add a version each time the Builder records a decision; the manual is
// written again on the next move.
// DECISION: only a template build (one with a client intake form) makes a checklist; a build for
// one client keeps its open items, as its fit-gap does today.
// DECISION: the manual and the checklist go in one version per move (merged from B3 and B4), so a
// move adds at most one version.
async function writeDraftFromBuild(ctx: LongCtx, id: string, phase: BuildPhase): Promise<void> {
  const next = await ctx.inTx(async (scoped) => {
    const r = await readBuild(scoped.tx, id);
    // STATE-2b: a build stopped (or moved on) since its move is left as it is.
    if (r.status !== "open" || r.phase !== phase) return null;
    if (r.kind !== "agent" || !r.agentId) return null;
    const latest = await latestVersion(scoped.tx, r.agentId);
    if (!latest) return null;
    const parsed = AnyAgentBundle.safeParse(latest.bundle);
    if (!parsed.success) return null;
    // The decisions with their risk worked out by code, as the build shows them.
    const detail = await detailIn(scoped, ctx.services, r);
    const withManual = withBuildManual(detail, parsed.data);
    let bundle: unknown = withManual ?? latest.bundle;
    let withSetup: unknown | null = null;
    if (buildHasSetupForm(r)) {
      const items = draftSetupItems(ctx.services, detail.build.fitgap, bundle);
      withSetup = items ? withSetupItems(bundle, items) : null;
      if (withSetup) bundle = withSetup;
    }
    const changeNote =
      withManual && withSetup
        ? "The manual and setup checklist, written from the build"
        : withManual
          ? "The manual, written from the build"
          : withSetup
            ? "Setup checklist from the build"
            : null;
    return changeNote ? { agentId: r.agentId, versionId: latest.id, bundle, changeNote } : null;
  });
  if (!next) return;
  try {
    await call(ctx, routes.opsSaveVersion, {
      params: { id: next.agentId },
      body: {
        bundle: next.bundle,
        parentVersionId: next.versionId,
        changeNote: next.changeNote,
      },
    });
  } catch (error) {
    reportHandled("writing an agent's manual or setup checklist from its build failed", error, {
      kind: "build",
      build: id,
    });
  }
}

/** Draft it now: the description the Builder drafts from, with whatever the brief already says. */
export function nowDescription(
  row: Pick<BuildRow, "title" | "kind" | "clientId">,
  brief: Brief,
  fitgap: FitGap,
  given: string | null,
): string {
  if (!given) return draftDescription(row, brief, fitgap);
  // The operator's own words stand in for the goal; anything else the brief holds follows them.
  const { goal: _goal, ...rest } = brief;
  const more = draftDescription(row, rest, fitgap).split("\n").slice(1).join("\n").trim();
  const text = [`${row.title}.`, given, more].filter(Boolean).join("\n\n");
  return text.length > 4000 ? `${sliceWhole(text, 3990)}…` : text;
}

/** What the Builder says after a draft made at once: what it built, what it decided, what's next. */
export function draftedNowText(o: {
  summary: string;
  decisions: number;
  gaps: readonly string[];
  bound: number;
  problems: number;
}): string {
  // To the point (owner, 2026-11-21): what it is, what was decided for you, what is next.
  const lines = [`I drafted it from your description. ${firstSentences(o.summary.trim(), 2)}`];
  const notes: string[] = [];
  if (o.decisions > 0) {
    notes.push(
      `I made ${o.decisions === 1 ? "1 decision" : `${o.decisions} decisions`} to get it running instead of asking (under Decisions).`,
    );
  }
  if (o.gaps.length > 0) {
    notes.push(
      o.gaps.length === 1
        ? "One part isn't in the catalog yet, so a person does it for now."
        : `${o.gaps.length} parts aren't in the catalog yet, so a person does them for now.`,
    );
  }
  if (o.bound > 0) notes.push("It is bound to the client's connections.");
  if (notes.length > 0) lines.push(notes.join(" "));
  lines.push(
    o.problems === 0
      ? "Next: move to the POC test and try it on a real example, then tell me what to change."
      : `${o.problems === 1 ? "1 problem is" : `${o.problems} problems are`} left before it can be tried: use the buttons on each issue.`,
  );
  return lines.join("\n\n");
}

/**
 * Draft it now (docs/plan.md §1.165): an agent build goes from its intake or fit-gap straight to
 * its draft, made from the operator's description (or the brief as it is). No questions, no brief
 * review and no fit-gap: the Builder decides what it can and records each decision, a person does
 * what the catalog can't (a gap, put off), and a client's agent is bound to that client's
 * connections. Nothing here loosens anything: the draft's writes keep approval on (the guards),
 * and what it may do at a client is still that client's connection settings.
 */
// DECISION (owner, 2026-11-21): "we are taking a few simple steps and making it into a huge
// challenge... apply defaults to the settings and make decisions and tweak after it is built".
// The phases stay (a build can still go back to its intake or fit-gap with a reason); this is the
// way past them. Agent builds only: a skill is drafted in its own Builder conversation.
/** Draft it now (§1.165); the process interview drafts its build through it too (§1.217). */
export async function draftNow(ctx: LongCtx, id: string, given: string | null): Promise<void> {
  const userId = ctx.session.user.id;
  // 1. The build is an open agent build with no draft yet, and there is something to draft from.
  //    The move is claimed by the phase, as a move into the draft is (STATE-1).
  const row = await ctx.inTx(async (scoped) => {
    const r = await readBuild(scoped.tx, id, true);
    refuseClosed(r);
    if (r.kind !== "agent") {
      throw new HttpError(422, "not_an_agent", "a skill is drafted in its own conversation");
    }
    if (r.phase !== "intake" && r.phase !== "fitgap") {
      throw new HttpError(409, "same_phase", "this build already has its draft");
    }
    if (r.agentId) {
      throw new HttpError(409, "has_draft", "this build already has a draft: move on to it");
    }
    const brief = readBrief(r.brief);
    if (!given && !brief.goal?.text.trim()) {
      throw new HttpError(400, "nothing_to_draft", "say what it should do first");
    }
    // The operator's words are kept: in the conversation whole, and as the brief's goal (as far
    // as a field holds) when it has none, so the manual's "What it does" has them.
    const next: Brief =
      given && !brief.goal?.text.trim()
        ? { ...brief, goal: { text: sliceWhole(given, 1000), state: "assumed" } }
        : brief;
    // Messages are insert only, so a second try after a failed draft doesn't say them twice.
    if (given) {
      const [last] = await scoped.tx
        .select({ role: buildMessage.role, text: buildMessage.text })
        .from(buildMessage)
        .where(eq(buildMessage.buildId, r.id))
        .orderBy(desc(buildMessage.createdAt), desc(buildMessage.id))
        .limit(1);
      if (last?.role !== "operator" || last.text !== given) {
        await addMessage(scoped.tx, r, { role: "operator", text: given });
      }
    }
    await scoped.tx.update(build).set({ brief: next, phase: "draft" }).where(eq(build.id, r.id));
    return { ...r, brief: next };
  });
  const from = row.phase;
  const unchanged = (r: BuildRow) => r.phase === "draft" && r.agentId === row.agentId;
  const putBack = async (tx: Tx, r: BuildRow) => {
    if (unchanged(r)) await tx.update(build).set({ phase: from }).where(eq(build.id, id));
  };
  // 2. The draft, outside any transaction.
  let made: Awaited<ReturnType<typeof makeDraft>>;
  try {
    made = await makeDraft(ctx, row, {
      description: nowDescription(row, readBrief(row.brief), readFitGap(row.fitgap), given),
    });
  } catch (error) {
    await ctx.inTx(async (scoped) => putBack(scoped.tx, await readBuild(scoped.tx, id, true)));
    throw error;
  }
  const gaps = (made.gaps ?? []).slice(0, 10);
  // 3. The move, its record, the decisions and the gaps a person covers for now.
  const done = await ctx.inTx(async (scoped) => {
    const r = await readBuild(scoped.tx, id, true);
    if (r.status !== "open" || !unchanged(r)) {
      await putBack(scoped.tx, r);
      return { refused: r.status !== "open" ? r.status : "moved", bound: 0 };
    }
    const fitgap = readFitGap(r.fitgap);
    await scoped.tx
      .update(build)
      .set({
        ...made.set,
        ...(made.decisions.length > 0
          ? { fitgap: { ...fitgap, decisions: mergeDecisions(fitgap.decisions, made.decisions) } }
          : {}),
        phase: "draft",
        phaseAt: now(),
      })
      .where(eq(build.id, id));
    await addEvent(scoped.tx, r, {
      kind: "phase",
      from,
      to: "draft",
      reason: "Drafted at once from the description, without the questions or the fit-gap.",
      userId,
    });
    await addEvent(scoped.tx, r, {
      kind: "record",
      payload: { brief: readBrief(r.brief) },
      userId,
    });
    // docs/builder-plan.md §12.4: each gap names the step that stands for it, when one clearly does.
    const onSteps =
      gaps.length > 0
        ? await draftGapSteps(scoped.tx, made.set.agentId, gaps, made.gapSteps ?? [])
        : [];
    await addItems(
      scoped.tx,
      r,
      gaps.map((g, i) => ({
        phase: "draft" as const,
        kind: "gap" as const,
        title: clip(g, 300),
        detail:
          "Not in the catalog yet, so a person does this part in the first version. Build it when the runs show it is worth it.",
        owner: "builder" as const,
        state: "deferred" as const,
        stepId: onSteps[i] ?? null,
        key: `now:gap:${i}`,
      })),
      userId,
    );
    // A client's agent is bound to that client's connections, as its operator would bind it.
    let bound = 0;
    const agentId = made.set.agentId;
    if (r.clientId && agentId) {
      const agentRow = await getAgent(scoped.tx, agentId);
      const latest = await latestVersion(scoped.tx, agentId);
      const parsed = latest ? AnyAgentBundle.safeParse(latest.bundle) : null;
      if (parsed?.success) {
        const after = await bindTestCopy(
          { tx: scoped.tx, services: ctx.services, session: ctx.session },
          agentRow,
          parsed.data,
        );
        bound = Object.keys(after.bindings).length - Object.keys(agentRow.bindings).length;
      }
    }
    return { refused: null, bound };
  });
  if (done.refused) {
    const orphan = made.set.agentId;
    if (orphan) {
      await call(ctx, routes.opsDiscardAgent, { params: { id: orphan } }).catch((error: unknown) =>
        reportHandled("discarding a draft made for a refused draft-now failed", error, {
          kind: "build",
          build: id,
        }),
      );
    }
    throw done.refused === "moved"
      ? new HttpError(409, "moved", "the build moved while this ran: look at it again")
      : new HttpError(409, "build_closed", `this build is ${done.refused}`);
  }
  // 4. The manual and a template's setup checklist, as any move into the draft writes them.
  await writeDraftFromBuild(ctx, id, "draft");
  await ctx.inTx(async (scoped) => {
    const r = await readBuild(scoped.tx, id, true);
    if (r.status !== "open" || r.phase !== "draft") return;
    const detail = await detailIn(scoped, ctx.services, r);
    await addMessage(scoped.tx, r, {
      role: "builder",
      text: draftedNowText({
        summary: made.summary ?? "",
        decisions: made.decisions.length,
        gaps,
        bound: done.bound,
        problems: detail.draft?.problems.length ?? 0,
      }),
    });
  });
}

async function move(
  ctx: LongCtx,
  id: string,
  to: BuildPhase,
  reason: string | null,
): Promise<void> {
  const userId = ctx.session.user.id;
  // 1. The move is allowed: back to any earlier phase with a reason, or on to the next when its
  //    gate passes (a client test may move on with a reason).
  const row = await ctx.inTx(async (scoped) => {
    const r = await readBuild(scoped.tx, id, true);
    refuseClosed(r);
    const from = phaseIndex(r.kind, r.phase);
    const at = phaseIndex(r.kind, to);
    if (at < 0) throw new HttpError(400, "bad_phase", `a ${r.kind} build has no ${to} phase`);
    if (at === from) throw new HttpError(409, "same_phase", `the build is already in ${to}`);
    if (at < from) {
      if (!reason) throw new HttpError(400, "reason_required", "say why it goes back");
      return r;
    }
    if (nextPhase(r.kind, r.phase) !== to) {
      throw new HttpError(409, "skip_phase", "a build moves on one phase at a time");
    }
    if (to === "client_test" && !r.testAgentId) {
      throw new HttpError(
        409,
        "use_client_test",
        "start the client test with the client it runs at",
      );
    }
    if (to === "client_test" && !r.clientId && r.agentId && r.testAgentId !== r.agentId) {
      // STATE-8: the client's copy of a template is from the version it was forked from; a
      // template changed since goes back through the client test's own start, which updates it.
      const copy = await latestVersion(scoped.tx, r.testAgentId as string);
      const template = await latestVersion(scoped.tx, r.agentId);
      if (template && copy?.basedOnTemplateVersionId !== template.id) {
        throw new HttpError(
          409,
          "copy_behind",
          "The client's copy is from an older version of the template, so its trial wouldn't run your changes. Start the client test again to update it.",
        );
      }
    }
    const detail = await detailIn(scoped, ctx.services, r);
    const skip = r.phase === "client_test" && !!reason;
    // Moving into the draft makes it: the draft gate is the fit-gap's.
    if (detail.gate.reasons.length > 0 && !skip) {
      throw new HttpError(409, "gate", detail.gate.reasons.join(" "), detail.gate.reasons);
    }
    // STATE-1: the move into the draft is claimed here, before the draft is made outside any
    // transaction: from now on the build is in its draft, so a second press (another tab, a
    // double click) is refused as already there and never makes a second draft.
    // DECISION: the claim is the build's phase itself (no new column): its record (the phase
    // event) is written once the draft is made, and a draft that can't be made puts the phase
    // back. A Worker that dies mid-move leaves the build in its draft with "There is no draft
    // yet"; going back to the fit-gap and on again makes it.
    if (to === "draft") {
      await scoped.tx.update(build).set({ phase: to }).where(eq(build.id, r.id));
    }
    return r;
  });
  const from = row.phase;
  const forward = phaseIndex(row.kind, to) > phaseIndex(row.kind, from);
  const claimed = forward && to === "draft";
  // What the build must still be for the move to finish: in the phase it claimed (else the one it
  // is leaving), with the draft it had. Anything else is another request's move.
  const unchanged = (r: BuildRow) =>
    r.phase === (claimed ? to : from) && r.agentId === row.agentId && r.sessionId === row.sessionId;
  /** A claimed move that doesn't finish leaves the build in the phase it was in. */
  const putBack = async (tx: Tx, r: BuildRow) => {
    if (claimed && unchanged(r)) {
      await tx.update(build).set({ phase: from }).where(eq(build.id, id));
    }
  };
  // 1b. Owner (2026-11-17): a brief gets a second look before it is confirmed. What it doesn't
  //     settle becomes open questions and the build stays in intake; confirming the same brief
  //     again goes on with them open.
  if (forward && from === "intake" && (await reviewHolds(ctx, row))) return;
  // 2. What the move makes, outside any transaction.
  let made: Awaited<ReturnType<typeof makeDraft>> = { set: {}, decisions: [], kept: false };
  if (claimed) {
    try {
      made = await makeDraft(ctx, row);
    } catch (error) {
      await ctx.inTx(async (scoped) => putBack(scoped.tx, await readBuild(scoped.tx, id, true)));
      throw error;
    }
  }
  // 3. The move, its record and the items it leaves.
  const done = await ctx.inTx(async (scoped) => {
    const r = await readBuild(scoped.tx, id, true);
    // STATE-1, STATE-2b: the build is still as the move found it: open (a stop while the draft
    // was being made wins, I11) and not moved by another request.
    if (r.status !== "open" || !unchanged(r)) {
      await putBack(scoped.tx, r);
      return { refused: r.status !== "open" ? r.status : "moved", changes: null };
    }
    const qa = readQa(r.qa);
    const fitgap = readFitGap(r.fitgap);
    await scoped.tx
      .update(build)
      .set({
        ...made.set,
        ...(made.decisions.length > 0
          ? { fitgap: { ...fitgap, decisions: mergeDecisions(fitgap.decisions, made.decisions) } }
          : {}),
        phase: to,
        phaseAt: now(),
        // Going back before QA undoes its signature and decision: QA is done again.
        ...(forward ? {} : { qa: { ...qa, signedBy: null, signedAt: null, decision: null } }),
      })
      .where(eq(build.id, id));
    await addEvent(scoped.tx, r, { kind: "phase", from, to, reason, userId });
    if (forward && from === "intake") {
      await addEvent(scoped.tx, r, {
        kind: "record",
        payload: { brief: readBrief(r.brief) },
        userId,
      });
      await addItems(scoped.tx, r, briefItems(readBrief(r.brief)), userId);
    }
    let changes: string[] | null = null;
    if (forward && from === "fitgap") {
      // STATE-4: a draft kept from before is checked against the fit-gap the build last moved on
      // with (that move's record). What changed since becomes an open item, which holds the
      // draft gate as a draft problem until it is closed.
      // DECISION: the kept draft is flagged, not drafted again: a new draft would drop what was
      // changed in it since, and the Builder makes the change as an agreed draft edit.
      const before = made.kept ? await lastFitGapRecord(scoped.tx, id) : null;
      changes = before ? fitGapChanges(before, fitgap) : null;
      if (before && changes && changes.length > 0) {
        await addItems(
          scoped.tx,
          r,
          [
            {
              phase: "draft",
              kind: "note",
              title: clip(`Change the draft for the new fit-gap: ${changes.join(", ")}`, 300),
              detail:
                "The draft was made before the fit-gap changed. Change it to match (ask the Builder here, or open the workflow), then close this item.",
              key: `${STALE_DRAFT_KEY}${fitGapHash(before)}:${fitGapHash(fitgap)}`,
            },
          ],
          userId,
        );
      }
      await addEvent(scoped.tx, r, { kind: "record", payload: { fitgap }, userId });
      await addItems(scoped.tx, r, fitGapItems(fitgap, buildHasSetupForm(r)), userId);
    }
    if (forward && from === "poc") {
      await addEvent(scoped.tx, r, {
        kind: "record",
        payload: { testPlan: readTestPlan(r.testPlan) },
        userId,
      });
    }
    return { refused: null, changes };
  });
  if (done.refused) {
    // A draft made for a move that lost (the build stopped, or moved by another request) is
    // discarded, so no draft agent is left over that nothing points at.
    const orphan = made.set.agentId;
    if (orphan) {
      await call(ctx, routes.opsDiscardAgent, { params: { id: orphan } }).catch((error: unknown) =>
        reportHandled("discarding a draft made for a refused move failed", error, {
          kind: "build",
          build: id,
        }),
      );
    }
    throw done.refused === "moved"
      ? new HttpError(409, "moved", "the build moved while this ran: look at it again")
      : new HttpError(409, "build_closed", `this build is ${done.refused}`);
  }
  // 3b. docs/builder-plan.md §5 and §6: the agent's manual (from the brief, the decisions and the
  //     known risks) and a template's setup checklist (from the intake form, the client_setup
  //     decisions and the draft's writes), when it is drafted and when it goes to the POC test.
  if (forward && (to === "draft" || to === "poc")) await writeDraftFromBuild(ctx, id, to);
  // 4. The Builder opens the phases it has work in.
  // DECISION (docs/plan.md §1.165): a build drafted at once (it has no fit-gap) opens its POC
  // test with the try, not with the Builder writing a plan of made-up data first: real examples
  // come first (builder-plan.md §3), and a plan can still be asked for in the conversation.
  const atOnce = to === "poc" && readFitGap(row.fitgap).rows.length === 0;
  if (forward && (to === "fitgap" || to === "poc") && !atOnce) await turn(ctx, id, null);
  if (forward && atOnce) {
    await ctx.inTx(async (scoped) => {
      const r = await readBuild(scoped.tx, id, true);
      if (r.status !== "open" || r.phase !== to) return;
      await addMessage(scoped.tx, r, {
        role: "builder",
        text: r.clientId
          ? "Try it now: test-run it from the workflow (nothing is written), then tell me what it got wrong and I'll change it."
          : "Try it now on a real example: upload a document or give the input it starts from. It runs as a test, so nothing is written. Mark the result right or wrong, and tell me what to change.",
      });
    });
  }
  if (claimed) {
    await ctx.inTx(async (scoped) => {
      const r = await readBuild(scoped.tx, id, true);
      // STATE-2b: nothing more is said on a build stopped (or moved) since.
      if (r.status !== "open" || r.phase !== to) return;
      const detail = await detailIn(scoped, ctx.services, r);
      await addMessage(scoped.tx, r, {
        role: "builder",
        text: draftMovedText(r.kind, made.kept, done.changes, detail.draft?.problems.length ?? 0),
      });
    });
  }
}

/**
 * docs/plan.md §1.169: a draft edit made for a gap, a test or client feedback (the conversation on
 * it) settles it: the item closes, its detail ending with what changed. Its state before is kept
 * on the decision, so the edit's undo opens it again. A note or a precondition is left to a click.
 */
async function closeByEdit(
  tx: Tx,
  buildId: string,
  about: string | null,
  said: string,
): Promise<{ itemId: string; title: string; before: BuildItemState } | null> {
  const itemId = about ? /^item:([0-9a-f-]{36})$/i.exec(about)?.[1] : undefined;
  if (!itemId) return null;
  const [item] = await tx
    .select({
      id: buildItem.id,
      title: buildItem.title,
      kind: buildItem.kind,
      state: buildItem.state,
      detail: buildItem.detail,
    })
    .from(buildItem)
    .where(and(eq(buildItem.id, itemId), eq(buildItem.buildId, buildId)));
  if (!item || item.state === "done" || item.kind === "question" || !settledByStep(item.kind)) {
    return null;
  }
  await tx
    .update(buildItem)
    .set({
      state: "done",
      resolvedAt: now(),
      detail: withNote(item.detail, clip(`Settled by the change: ${said}`, 600)),
    })
    .where(eq(buildItem.id, item.id));
  return { itemId: item.id, title: item.title, before: item.state };
}

/**
 * The operator's decision on a proposal: agreed (the change is made, as the operator, through the
 * build's own routes), declined, or an agreed one undone. `asked` (docs/plan.md §1.165): the
 * change was asked for in words or by an issue's button and is made at once, so the claim is the
 * Builder's own line, not an "Agreed." the operator never said. Its own function, not only the
 * route: a slow route isn't reachable through `invokeRoute`, and a turn makes such a change itself.
 */
async function decideProposal(
  lc: LongCtx,
  id: string,
  messageId: string,
  decide: "agree" | "decline" | "undo",
  asked = false,
): Promise<void> {
  const found = await lc.inTx(async (scoped) => {
    const row = await readBuild(scoped.tx, id, true);
    refuseClosed(row);
    const [m] = await scoped.tx
      .select()
      .from(buildMessage)
      .where(and(eq(buildMessage.id, messageId), eq(buildMessage.buildId, row.id)));
    if (!m) throw notFound("message");
    const meta = (m.meta ?? {}) as Record<string, unknown>;
    const stored = StoredProposal.safeParse(meta.proposal);
    if (!stored.success) throw new HttpError(409, "no_proposal", "this message proposes nothing");
    // Its state is the latest decision about it (messages are insert only).
    const decisions = await scoped.tx
      .select({ id: buildMessage.id, meta: buildMessage.meta })
      .from(buildMessage)
      .where(eq(buildMessage.buildId, row.id))
      .orderBy(asc(buildMessage.createdAt), asc(buildMessage.id));
    const decided = withDecisions(decisions).find(([r]) => r.id === m.id)?.[1] ?? null;
    const p = {
      ...stored.data,
      state: decided?.decision ?? stored.data.state,
      before: decided?.before ?? null,
    };
    const wanted = decide === "undo" ? "agreed" : "proposed";
    if (p.state !== wanted) {
      throw new HttpError(409, "decided", `this proposal is ${p.state} already`);
    }
    if (decide === "undo") {
      const undoable = isDevQueueAction(p.action)
        ? false
        : p.action.do === "edit_draft"
          ? (decided?.edit?.changeIds.length ?? 0) > 0
          : !!proposalUndo(p.action, p.before);
      if (!undoable) throw new HttpError(409, "no_undo", "this change has no undo here");
    }
    const itemId = "itemId" in p.action ? p.action.itemId : null;
    const [item] = itemId
      ? await scoped.tx
          .select({ state: buildItem.state })
          .from(buildItem)
          .where(and(eq(buildItem.id, itemId), eq(buildItem.buildId, row.id)))
      : [];
    const before = item?.state ?? null;
    const about = metaAbout(meta);
    // STATE-3: the decision is claimed here, as the operator's message, in the transaction that
    // found the proposal still open (the build row locked): a second Agree (another tab, a
    // double click) finds it decided and is refused 409 `decided`. What the change did is
    // settled on the Builder's message after it; a change that fails puts the proposal back.
    const simple = !isDevQueueAction(p.action) && p.action.do !== "edit_draft";
    await addMessage(scoped.tx, row, {
      role: asked ? "builder" : "operator",
      text: asked
        ? "Making the change you asked for."
        : { agree: "Agreed.", decline: "Not this.", undo: "Undo that." }[decide],
      meta: {
        decides: messageId,
        decision: ({ agree: "agreed", decline: "declined", undo: "undone" } as const)[decide],
        ...(decide === "agree" && simple && before ? { before } : {}),
        ...(about ? { about } : {}),
      },
    });
    return { p, about, decided, edit: decided?.edit ?? null };
  });
  const { p, about } = found;
  if (decide === "decline") return;
  // The Builder's own message after a decision.
  const say = (text: string, meta: Record<string, unknown>) =>
    lc.inTx(async (scoped) => {
      const fresh = await readBuild(scoped.tx, id, true);
      await addMessage(scoped.tx, fresh, { role: "builder", text: clip(text, 3000), meta });
    });
  /** What the change did, settled on the Builder's message after it (the latest decision). */
  const settle = (decision: "agreed" | "unchanged", extra: Record<string, unknown>) => ({
    decides: messageId,
    decision,
    ...extra,
  });
  /**
   * Makes the agreed change (or its undo). One that fails puts the proposal back as it was, the
   * Builder saying why, so it can be agreed (or undone) again.
   */
  // DECISION (STATE-3): the proposal is put back by a decision on the Builder's message (the
  // decision before the claim, else "proposed"), never by removing the claim: messages are
  // insert only, and the conversation keeps why it didn't go through.
  const guarded = async <T>(change: () => Promise<T>): Promise<T> => {
    try {
      return await change();
    } catch (error) {
      const err = toHttpError(error);
      const why =
        err.status < 500 || err.status === 503
          ? err.message
          : "something went wrong on our side, and we've logged it";
      await lc
        .inTx(async (scoped) => {
          const fresh = await readBuild(scoped.tx, id, true);
          if (fresh.status !== "open") return;
          await addMessage(scoped.tx, fresh, {
            role: "builder",
            text: clip(
              `That didn't go through: ${why.trim().replace(/[.\s]+$/, "")}. Press ${decide === "agree" ? "Agree" : "Undo"} to try again.`,
              3000,
            ),
            meta: {
              ...(found.decided ?? {}),
              decides: messageId,
              decision: found.decided?.decision ?? "proposed",
              ...(about ? { about } : {}),
            },
          });
        })
        .catch((e: unknown) =>
          reportHandled("putting a build's proposal back failed", e, {
            kind: "build",
            build: id,
          }),
        );
      throw error;
    }
  };
  // docs/plan.md §1.125: filing, linking, approving a request, or starting a skill build.
  if (isDevQueueAction(p.action)) {
    const action = p.action;
    const out = await guarded(() => runDevQueueAction(lc, id, action));
    await say(out.text, {
      ...(about ? { about } : {}),
      ...(out.proposal ? { proposal: { ...out.proposal, state: "proposed" } } : {}),
      ...settle("agreed", { result: clip(out.text, 1000) }),
    });
    return;
  }
  let changed: string[] = [];
  let settled: Record<string, unknown> = {};
  if (p.action.do === "edit_draft") {
    // Owner (2026-11-17): the draft changes in the build's conversation, made by the workflow's
    // Builder (its guards, its labelled changes) and saved as a draft version; undo is its own.
    const action = p.action;
    if (decide === "agree") {
      const edit = await guarded(() => applyEdit(lc, id, action, p.summary));
      const said = firstSentences(edit.text, 2);
      if (edit.changes.length === 0) {
        await say(`I tried, and the draft didn't change: ${said}`, {
          ...(about ? { about } : {}),
          ...settle("unchanged", { result: clip(`Nothing changed: ${said}`, 500) }),
        });
        return;
      }
      // QA on staging (2026-11-17): "Done: Build the filter skill" was said when only a step's
      // description had changed and the step was still missing. What an edit did is checked
      // against the build after it, never taken from the proposal's own words.
      const left = await lc.inTx(async (scoped) =>
        stillOpen(
          await detailIn(scoped, lc.services, await readBuild(scoped.tx, id, true)),
          about,
          action.stepId ?? null,
        ),
      );
      settled = settle("agreed", {
        result: clip(left ? `Changed, still open: ${said}` : `Changed: ${said}`, 1000),
        changes: edit.changes.map((c) => clip(c.label, 300)).slice(0, 20),
        ...(left ? { unresolved: true } : {}),
        edit: {
          sessionId: edit.sessionId,
          turnId: edit.turnId,
          changeIds: edit.changes.map((c) => c.id),
          versionId: edit.versionId,
        },
      });
      if (left) {
        await say(
          `I changed the draft, but it isn't fixed: “${left.title}” is still open${left.detail ? ` (${left.detail})` : ""}. What I changed: ${said}`,
          { ...(about ? { about } : {}), chips: ["What would fix it?"], ...settled },
        );
        return;
      }
      changed = [said];
      // A part a request shipped, put in its step: the gap item closes once the step validates.
      const shipped = await lc.inTx(async (scoped) =>
        settleShipped(scoped.tx, lc.services.platform, await readBuild(scoped.tx, id, true), now()),
      );
      if (shipped.length > 0) {
        changed.push(`That settles ${shipped.map((t) => `“${t}”`).join(", ")}, so I closed it.`);
      }
      // docs/plan.md §1.169: the change made for an item is the step that settles it.
      const closed = await lc.inTx((scoped) => closeByEdit(scoped.tx, id, about, said));
      if (closed) {
        settled = { ...settled, closed: { itemId: closed.itemId, before: closed.before } };
        changed.push(`That settles “${closed.title}”, so I closed it. Undo opens it again.`);
      }
    } else {
      const edit = found.edit;
      if (!edit) throw new HttpError(409, "no_undo", "this change has no undo here");
      await guarded(() => undoEdit(lc, id, edit, p.summary));
      // The item the edit closed is open again, as it was before.
      const closed = found.decided?.closed;
      if (closed) {
        await lc.inTx(async (scoped) => {
          await scoped.tx
            .update(buildItem)
            .set({ state: closed.before, resolvedAt: null })
            .where(
              and(
                eq(buildItem.id, closed.itemId),
                eq(buildItem.buildId, id),
                eq(buildItem.state, "done"),
              ),
            );
        });
      }
    }
  } else {
    const action = decide === "agree" ? p.action : proposalUndo(p.action, p.before);
    if (!action) throw new HttpError(409, "no_undo", "this change has no undo here");
    await guarded(() => runAction(lc, id, action));
  }
  await lc.inTx(async (scoped) => {
    const fresh = await readBuild(scoped.tx, id, true);
    const issues = buildIssues(await detailIn(scoped, lc.services, fresh));
    const next = issues.find((i) => i.open && i.key !== about);
    const item = issues.find((i) => i.key === about && i.source === "item" && i.open);
    if (decide === "agree" && changed.length > 0 && item) {
      // A draft edit for an open item that a click closes (a note, a precondition): whether it
      // is done is the operator's to say. A gap, test or feedback item closed by it above.
      await addMessage(scoped.tx, fresh, {
        role: "builder",
        text: `Changed the draft: ${changed.join(" ")} “${item.title}” stays open until you mark it done.`,
        meta: { about: item.key, ...settled },
      });
      return;
    }
    const text =
      decide === "agree"
        ? doneText(p.summary, next, changed)
        : `Undone: ${p.summary}. It's as it was.`;
    await addMessage(scoped.tx, fresh, {
      role: "builder",
      text,
      meta: {
        // The thread moves to the next issue, so "yes" there carries on with it.
        ...(decide === "agree" && next ? { about: next.key } : about ? { about } : {}),
        chips: decide === "agree" && next ? ["Yes, take it", "What's left?"] : [],
        ...settled,
      },
    });
  });
  return;
}

export function opsBuildRoutes(app: Hono<AppEnv>): void {
  const long = (
    c: AppContext,
    session: LongCtx["session"],
    services: Services,
    inTx: LongCtx["inTx"],
  ): LongCtx => ({
    c,
    app,
    session,
    services,
    inTx,
  });
  const detailOf = async (ctx: { inTx: LongCtx["inTx"]; services: Services }, id: string) =>
    ctx.inTx(async (scoped) => detailIn(scoped, ctx.services, await readBuild(scoped.tx, id)));

  mount(app, routes.opsBuilds, async (ctx) => {
    const rows = await listBuilds(ctx.tx, ctx.query);
    return { builds: await summaries(ctx.tx, rows), items: await openItemsAcross(ctx.tx, rows) };
  });

  mount(app, routes.opsStartBuild, async (ctx) => {
    const clientId = ctx.body.clientId ?? null;
    if (clientId) ensureClient(ctx, clientId);
    // docs/plan.md §1.124: a build from a template forks it into the client at once, as Reggie's
    // agent_add does (the fork is the client's agent from here on); a new agent goes through the
    // Builder's phases.
    const path = ctx.body.path ?? "new";
    let agentId: string | null = null;
    if (path === "template" && clientId && ctx.body.templateId) {
      const template = await getAgent(ctx.tx, ctx.body.templateId);
      if (template.kind !== "template")
        throw new HttpError(422, "not_a_template", "not a template");
      if (!template.liveVersionId) {
        throw new HttpError(409, "no_live_version", "publish the template first");
      }
      const slug = await freeSlug(ctx.tx, clientId, template.slug);
      const created = await fork(ctx.tx, {
        tenantId: clientId,
        slug,
        templateVersionId: template.liveVersionId,
        actorId: ctx.session.user.id,
      });
      agentId = created.agent.id;
    }
    const [row] = await ctx.tx
      .insert(build)
      .values({
        kind: ctx.body.kind,
        title: ctx.body.title,
        clientId,
        createdBy: ctx.session.user.id,
        path,
        // docs/plan.md §1.172: a new agent build starts on the lab's Describe it (the only place
        // one starts since §1.170), so it opens in the one-screen builder. A build from a template
        // and a skill build keep the build page.
        // DECISION: the server says so, from what it is; the screens send nothing for it.
        flow: ctx.body.kind === "agent" && path === "new" ? "describe" : "phases",
        templateId: path === "template" ? (ctx.body.templateId ?? null) : null,
        agentId,
        originKind: ctx.body.origin?.kind ?? null,
        originId: ctx.body.origin?.id ?? null,
        promisedOn: ctx.body.promisedOn ?? null,
      })
      .returning();
    if (!row) throw new Error("build insert returned nothing");
    await addEvent(ctx.tx, row, { kind: "phase", to: "intake", userId: ctx.session.user.id });
    return buildDetail({ tx: ctx.tx, services: ctx.services, now }, row);
  });

  mount(app, routes.opsBuild, async (ctx) =>
    buildDetail(
      { tx: ctx.tx, services: ctx.services, now },
      await readBuild(ctx.tx, ctx.params.id),
    ),
  );

  mount(app, routes.opsUpdateBuild, async (ctx) => {
    const row = await readBuild(ctx.tx, ctx.params.id, true);
    refuseClosed(row);
    const { title, brief, testPlan, promisedOn, waitingOn, statusLine, stuck, flow } = ctx.body;
    // §1.172: only an agent build has the one-screen builder to open in.
    if (flow === "describe" && row.kind !== "agent") {
      throw new HttpError(422, "no_builder", "only an agent build opens in the builder");
    }
    let fitgap: FitGap | undefined;
    if (ctx.body.fitgap) {
      // What's in scope and what needs to be true; a verdict changes only with a reason.
      const out = operatorFitGap(readFitGap(row.fitgap), ctx.body.fitgap);
      if (!out.ok) throw new HttpError(409, "verdict_needs_reason", out.reason);
      fitgap = out.fitgap;
    }
    await ctx.tx
      .update(build)
      .set({
        ...(title ? { title } : {}),
        ...(brief ? { brief } : {}),
        ...(fitgap ? { fitgap } : {}),
        ...(testPlan ? { testPlan } : {}),
        // docs/plan.md §1.124: moving a promised date is the operator's (this route's only).
        ...(promisedOn !== undefined ? { promisedOn } : {}),
        ...(waitingOn ? { waitingOn } : {}),
        ...(statusLine !== undefined ? { statusLine } : {}),
        ...(stuck !== undefined ? { stuck } : {}),
        ...(flow ? { flow } : {}),
        updatedAt: now(),
      })
      .where(eq(build.id, row.id));
    return buildDetail(
      { tx: ctx.tx, services: ctx.services, now },
      await readBuild(ctx.tx, row.id),
    );
  });

  mountLong(app, routes.opsBuildTurn, async (ctx) => {
    const lc = long(ctx.c, ctx.session, ctx.services, ctx.inTx);
    // docs/plan.md §1.165: a way chosen on an issue speaks for itself when no words come with it.
    const settle = ctx.body.settle ?? null;
    if (settle && !ctx.body.about) {
      throw new HttpError(400, "settle_needs_issue", "say which issue it settles");
    }
    const text = ctx.body.text ?? (settle ? SETTLE_WORDS[settle].ask : null);
    if (settle && ctx.body.about) await giveTo(lc, ctx.params.id, ctx.body.about, settle);
    await turn(lc, ctx.params.id, text, { retry: !text, about: ctx.body.about ?? null });
    await makeAtOnce(lc, ctx.params.id, settle);
    return detailOf(ctx, ctx.params.id);
  });

  // Owner (2026-11-17): the Builder proposes, the operator agrees, the change is made through the
  // build's own route as the operator (its checks and audit row), then the Builder offers the next.
  mountLong(app, routes.opsBuildProposal, async (ctx) => {
    await decideProposal(
      long(ctx.c, ctx.session, ctx.services, ctx.inTx),
      ctx.params.id,
      ctx.params.messageId,
      ctx.body.decide,
      ctx.body.decide === "agree" && ctx.body.asked === true,
    );
    return detailOf(ctx, ctx.params.id);
  });

  mountLong(app, routes.opsBuildVerdict, async (ctx) => {
    const lc = long(ctx.c, ctx.session, ctx.services, ctx.inTx);
    const { rowId, to, reason } = ctx.body;
    const user = ctx.session.user;
    const words = await ctx.inTx(async (scoped) => {
      const row = await readBuild(scoped.tx, ctx.params.id, true);
      refuseClosed(row);
      if (row.phase !== "fitgap") {
        throw new HttpError(409, "not_fitgap", "verdicts change in the fit-gap");
      }
      const fitgap = readFitGap(row.fitgap);
      const r = fitgap.rows.find((x) => x.id === rowId);
      if (!r) throw notFound("fit-gap row");
      if (r.verdict === to) {
        throw new HttpError(409, "same_verdict", `"${r.need}" is already ${FIT_WORDS[to]}`);
      }
      if (r.challenge) {
        throw new HttpError(409, "challenged", `"${r.need}" is waiting on the Builder already`);
      }
      const as = fitChangeKind(r.verdict, to);
      const stamp = { reason, by: user.name ?? user.email, at: now().toISOString() };
      const next: FitRow =
        as === "override"
          ? { ...r, verdict: to, override: { from: r.override?.from ?? r.verdict, ...stamp } }
          : { ...r, challenge: { wanted: to, ...stamp } };
      await scoped.tx
        .update(build)
        .set({
          fitgap: { ...fitgap, rows: fitgap.rows.map((x) => (x.id === rowId ? next : x)) },
          updatedAt: now(),
        })
        .where(eq(build.id, row.id));
      await addEvent(scoped.tx, row, {
        kind: "record",
        payload: { verdict: { rowId, need: r.need, from: r.verdict, to, as } },
        reason,
        userId: user.id,
      });
      return as === "challenge"
        ? [
            `I'm challenging "${r.need}" (row ${r.id}): you have it as ${FIT_WORDS[r.verdict]}, I think it's ${FIT_WORDS[to]}.`,
            `Why: ${reason}`,
          ].join("\n")
        : null;
    });
    // Less work is the Builder's to decide: it checks the catalog and answers.
    if (words) await turn(lc, ctx.params.id, words);
    return detailOf(ctx, ctx.params.id);
  });

  mountLong(app, routes.opsMoveBuild, async (ctx) => {
    await move(
      long(ctx.c, ctx.session, ctx.services, ctx.inTx),
      ctx.params.id,
      ctx.body.to,
      ctx.body.reason ?? null,
    );
    return detailOf(ctx, ctx.params.id);
  });

  mountLong(app, routes.opsDraftBuildNow, async (ctx) => {
    await draftNow(
      long(ctx.c, ctx.session, ctx.services, ctx.inTx),
      ctx.params.id,
      ctx.body.description ?? null,
    );
    return detailOf(ctx, ctx.params.id);
  });

  mountLong(app, routes.opsBuildCases, async (ctx) => {
    const lc = long(ctx.c, ctx.session, ctx.services, ctx.inTx);
    const prep = await ctx.inTx(async (scoped) => {
      const row = await readBuild(scoped.tx, ctx.params.id);
      refuseClosed(row);
      if (row.phase !== "poc")
        throw new HttpError(409, "not_poc", "test cases are made in the POC test");
      const detail = await detailIn(scoped, ctx.services, row);
      return {
        row,
        detail,
        target: await caseTarget(scoped.tx, row, detail),
        // BUILDER_QA AI-6: the draft's workflows and steps, which a generated case must name.
        steps:
          row.kind === "agent"
            ? await draftWorkflowSteps({ tx: scoped.tx, services: ctx.services, now }, row)
            : null,
      };
    });
    const plan = readTestPlan(prep.row.testPlan);
    if (!plan.datasets.some((d) => d.source === "generate")) {
      throw new HttpError(409, "nothing_to_generate", "the test plan has no dataset to generate");
    }
    // §1.210: the cases' cost is saved on the message that says so; calls that end in an error
    // are recorded as ours once the request ends.
    const generating = meteredLlm(meterDepsOf(ctx), {
      transport: transport(ctx.services, prep.row),
      tenantId: prep.row.clientId,
      source: "build",
    });
    const made = await makeTestCases(
      { kind: prep.target.kind, testPlan: plan, target: prep.target.text },
      { llm: generating.llm },
    ).catch(builderHttpError);
    let created = 0;
    for (const c of made.cases) {
      const fields = {
        input: c.input,
        expected: c.expected,
        matcher: { kind: "subset" as const, tolerances: {} },
      };
      if (testCaseProblems(prep.target.kind, fields).length > 0) continue;
      if (prep.steps && !caseFitsDraft(prep.steps, c.input, c.expected)) {
        reportProblem("the Builder made a test case for steps the draft doesn't have", {
          kind: "build",
          build: prep.row.id,
        });
        continue;
      }
      await call(lc, routes.opsCreateTest, {
        body: {
          targetKind: prep.target.kind,
          targetId: prep.target.id,
          name: c.name,
          ...fields,
          required: c.required,
          source: "builder",
          sourceRef: `build:${prep.row.id}`,
        },
      })
        .then(() => {
          created += 1;
        })
        .catch(() => undefined);
    }
    await ctx.inTx(async (scoped) => {
      const row = await readBuild(scoped.tx, ctx.params.id, true);
      await addMessage(scoped.tx, row, {
        role: "builder",
        text:
          created === made.cases.length
            ? `I made ${created} test ${created === 1 ? "case" : "cases"} from the plan. Run them when you're ready.`
            : `I made ${created} test ${created === 1 ? "case" : "cases"} from the plan; ${made.cases.length - created} didn't fit the draft or the test bench and were left out.`,
        meta: { costUsd: made.costUsd, ...tokensMeta(made.calls) },
      });
    });
    generating.settled();
    return { ...(await detailOf(ctx, ctx.params.id)), created };
  });

  mountLong(app, routes.opsBuildRunTests, async (ctx) => {
    await runBuildTests(long(ctx.c, ctx.session, ctx.services, ctx.inTx), ctx.params.id);
    return detailOf(ctx, ctx.params.id);
  });

  mountLong(app, routes.opsBuildClientTest, async (ctx) => {
    const lc = long(ctx.c, ctx.session, ctx.services, ctx.inTx);
    const userId = ctx.session.user.id;
    const prep = await ctx.inTx(async (scoped) => {
      const row = await readBuild(scoped.tx, ctx.params.id, true);
      refuseClosed(row);
      if (row.kind !== "agent")
        throw new HttpError(409, "skill_build", "a skill has no client test");
      if (row.phase !== "poc")
        throw new HttpError(409, "not_poc", "the client test starts from the POC test");
      const detail = await detailIn(scoped, ctx.services, row);
      if (detail.gate.reasons.length > 0) {
        throw new HttpError(409, "gate", detail.gate.reasons.join(" "), detail.gate.reasons);
      }
      const clientId = row.clientId ?? ctx.body.clientId ?? null;
      if (!clientId)
        throw new HttpError(400, "client_required", "name the client it is tested with");
      ensureClient(scoped, clientId);
      return { row, detail, clientId };
    });
    const { row, detail, clientId } = prep;
    const agentId = detail.draft?.agentId;
    const versionId = detail.draft?.versionId;
    if (!agentId || !versionId) throw new HttpError(409, "no_draft", "there is no draft yet");
    if (!detail.draft?.live) {
      await call(lc, routes.opsPublish, { params: { id: agentId, vid: versionId } });
    }
    // A template is forked into the client, and the copy's version published (a copy in trial
    // runs its live version), then its trial starts with Activate. What stops either (a
    // connection not bound there yet, no passing test run there) becomes an open item, and the
    // build is at the client either way.
    const refused = (e: unknown) => {
      const err = toHttpError(e);
      const details = Array.isArray(err.details)
        ? err.details
            .map((d) => (typeof d === "string" ? d : (d as { message?: unknown })?.message))
            .filter((m): m is string => typeof m === "string")
        : [];
      return [err.message, ...details].join(": ").slice(0, 2000);
    };
    let testAgentId = agentId;
    let blocked: { title: string; detail: string } | null = null;
    // An item made once per copy, and once per template version for a copy brought up to date.
    let blockKey = "";
    // STATE-8: a template build back at the client test after a fix brings the copy its first
    // client test made up to the fixed template, so the trial runs the fix (a second fork
    // conflicted with the first copy). A copy the client ran (it has a live version) gets the
    // update merge any client agent gets from its template, and is published; a copy never
    // published there is discarded and forked again.
    // DECISION: a copy that ran is updated in place rather than replaced, so its trial, runs and
    // what the client set up on it stay; a merge that conflicts becomes an open item, as a refused
    // publish does.
    const earlier =
      !row.clientId && row.testAgentId && row.testClientId === clientId ? row.testAgentId : null;
    const before = earlier
      ? await ctx.inTx(async (scoped) => {
          const copyRow = await getAgent(scoped.tx, earlier);
          return {
            latest: await latestVersion(scoped.tx, earlier),
            live: copyRow.liveVersionId,
            slug: await freeSlug(scoped.tx, clientId, (await getAgent(scoped.tx, agentId)).slug),
          };
        })
      : null;
    if (earlier && before && !before.live) {
      await call(lc, routes.opsDiscardAgent, { params: { id: earlier } }).catch((e: unknown) =>
        reportHandled("discarding a client's unpublished copy before forking again failed", e, {
          kind: "build",
          build: row.id,
        }),
      );
    }
    const copy = earlier && before?.live ? earlier : null;
    if (copy && before) {
      testAgentId = copy;
      blockKey = `start:${copy}:${versionId}`;
      let target: string | null = before.latest?.id ?? null;
      if (before.latest?.basedOnTemplateVersionId !== versionId) {
        try {
          const updated = await call(lc, routes.opsUpdate, {
            params: { id: copy },
            body: { resolutions: [], changeNote: "The template's fix, for the client's trial" },
          });
          target = updated.version.id;
        } catch (e) {
          target = null;
          blocked = { title: "Update the client's copy to the fixed template", detail: refused(e) };
        }
      }
      if (target && target !== before.live) {
        const vid = target;
        blocked = await call(lc, routes.opsPublish, { params: { id: copy, vid } })
          .then(() => null)
          .catch((e: unknown) => ({ title: "Publish the client's copy", detail: refused(e) }));
      }
    } else if (!row.clientId) {
      const fork = await call(lc, routes.opsFork, {
        params: { id: agentId },
        body: { clientId, versionId, ...(before ? { slug: before.slug } : {}) },
      });
      testAgentId = fork.agent.id;
      blocked = await call(lc, routes.opsPublish, {
        params: { id: testAgentId, vid: fork.version.id },
      })
        .then(() => null)
        .catch((e: unknown) => ({ title: "Publish the client's copy", detail: refused(e) }));
    }
    if (!blocked) {
      blocked = await call(lc, routes.opsActivate, { params: { id: testAgentId } })
        .then(() => null)
        .catch((e: unknown) => ({
          title: "Start the trial: activate the client's copy",
          detail: refused(e),
        }));
    }
    await ctx.inTx(async (scoped) => {
      const r = await readBuild(scoped.tx, ctx.params.id, true);
      await moveToClientTest(scoped.tx, r, {
        clientId,
        testAgentId,
        userId,
        blocked,
        key: blockKey,
      });
    });
    return detailOf(ctx, ctx.params.id);
  });

  mount(app, routes.opsBuildQa, async (ctx) => {
    const row = await readBuild(ctx.tx, ctx.params.id, true);
    refuseClosed(row);
    if (row.phase !== "qa") throw new HttpError(409, "not_qa", "QA is the last phase");
    const qa = readQa(row.qa);
    const userId = ctx.session.user.id;
    const at = now().toISOString();
    if ("accept" in ctx.body) {
      qa.accepted[ctx.body.accept] = { reason: ctx.body.reason, by: userId, at };
      await addEvent(ctx.tx, row, {
        kind: "qa",
        payload: { accept: ctx.body.accept },
        reason: ctx.body.reason,
        userId,
      });
    } else {
      const detail = await buildDetail({ tx: ctx.tx, services: ctx.services, now }, row);
      const failing = detail.qaChecks.filter((c) => c.state === "fail");
      if (failing.length > 0) {
        throw new HttpError(
          409,
          "qa_failing",
          `accept or fix first: ${failing.map((c) => c.label.toLowerCase()).join(", ")}`,
        );
      }
      qa.signedBy = userId;
      qa.signedAt = at;
      await addEvent(ctx.tx, row, { kind: "qa", payload: { signed: true }, userId });
    }
    await ctx.tx.update(build).set({ qa }).where(eq(build.id, row.id));
    return buildDetail(
      { tx: ctx.tx, services: ctx.services, now },
      await readBuild(ctx.tx, row.id),
    );
  });

  mountLong(app, routes.opsBuildDecision, async (ctx) => {
    const lc = long(ctx.c, ctx.session, ctx.services, ctx.inTx);
    const userId = ctx.session.user.id;
    const body = ctx.body;
    if (!body.go) {
      await move(lc, ctx.params.id, body.to, body.reason);
      await ctx.inTx(async (scoped) => {
        const row = await readBuild(scoped.tx, ctx.params.id, true);
        refuseClosed(row);
        const qa = readQa(row.qa);
        await scoped.tx
          .update(build)
          .set({ qa: { ...qa, decision: "no_go" } })
          .where(eq(build.id, row.id));
        await addEvent(scoped.tx, row, {
          kind: "decision",
          payload: { go: false },
          reason: body.reason,
          userId,
        });
        await addItems(
          scoped.tx,
          row,
          [{ phase: row.phase, kind: "qa", title: `No-go: ${body.reason}` }],
          userId,
        );
      });
      return detailOf(ctx, ctx.params.id);
    }
    await ctx.inTx(async (scoped) => {
      const row = await readBuild(scoped.tx, ctx.params.id, true);
      refuseClosed(row);
      if (row.phase !== "qa") throw new HttpError(409, "not_qa", "go-live is decided in QA");
      const detail = await detailIn(scoped, ctx.services, row);
      if (detail.gate.reasons.length > 0) {
        throw new HttpError(409, "gate", detail.gate.reasons.join(" "), detail.gate.reasons);
      }
      const live =
        row.kind === "skill"
          ? !!detail.draft?.skillId
          : detail.clientTest
            ? detail.clientTest.stage === "live"
            : !!detail.draft?.live;
      if (!live) {
        throw new HttpError(
          409,
          "waiting_signoff",
          "it goes live when the client signs off: their go-live sign-off is on their Desk",
        );
      }
      const qa = readQa(row.qa);
      await scoped.tx
        .update(build)
        .set({ status: "live", qa: { ...qa, decision: "go" } })
        .where(eq(build.id, row.id));
      await addEvent(scoped.tx, row, { kind: "decision", payload: { go: true }, userId });
      // docs/plan.md §1.169: a skill build that goes live settles the issue that started it.
      if (row.kind === "skill") {
        const note = "Settled: its skill build went live.";
        await scoped.tx
          .update(buildItem)
          .set({
            state: "done",
            resolvedAt: now(),
            detail: sql`left(case when ${buildItem.detail} = '' then ${note} else ${buildItem.detail} || ${`\n${note}`} end, 2000)`,
          })
          .where(
            and(
              sql`${buildItem.ref}->>'buildId' = ${row.id}`,
              inArray(buildItem.state, ["open", "in_progress", "waiting", "deferred"]),
            ),
          );
      }
    });
    return detailOf(ctx, ctx.params.id);
  });

  mount(app, routes.opsAddBuildItem, async (ctx) => {
    const row = await readBuild(ctx.tx, ctx.params.id, true);
    refuseClosed(row);
    const b = ctx.body;
    await addItems(
      ctx.tx,
      row,
      [
        {
          phase: row.phase,
          kind: b.kind ?? "note",
          title: b.title,
          detail: b.detail,
          owner: b.owner,
          stepId: b.stepId ?? null,
          ref: b.ref as Record<string, string> | undefined,
          key: refKey(b.ref),
        },
      ],
      ctx.session.user.id,
    );
    await ctx.tx.update(build).set({ updatedAt: now() }).where(eq(build.id, row.id));
    return buildDetail(
      { tx: ctx.tx, services: ctx.services, now },
      await readBuild(ctx.tx, row.id),
    );
  });

  mount(app, routes.opsUpdateBuildItem, async (ctx) => {
    const row = await readBuild(ctx.tx, ctx.params.id, true);
    // INPUT-8: a stopped (or live) build's items don't change either (I11).
    refuseClosed(row);
    const [item] = await ctx.tx
      .select()
      .from(buildItem)
      .where(and(eq(buildItem.id, ctx.params.itemId), eq(buildItem.buildId, row.id)));
    if (!item) throw notFound("open item");
    const b = ctx.body;
    // docs/plan.md §1.169 (owner, 2026-11-21: "just because I say it is closed does not close
    // it"): a question, gap, test or client feedback is closed by its own step (its answer, the
    // change made for it, its skill build live, its request shipped), or dropped as not needed.
    if (b.state === "done" && !b.drop && item.state !== "done" && settledByStep(item.kind)) {
      throw new HttpError(
        409,
        "settled_by_its_step",
        item.kind === "question"
          ? "a question closes when it is answered: answer it, or drop it as not needed"
          : "this closes when the step that settles it is done: change the process, build a skill or ask for code, or drop it as not needed",
      );
    }
    const state = b.drop ? "done" : (b.state ?? item.state);
    const detail = b.drop ? withNote(b.detail ?? item.detail, NOT_NEEDED_NOTE) : b.detail;
    await ctx.tx
      .update(buildItem)
      .set({
        ...(b.title ? { title: b.title } : {}),
        ...(detail !== undefined ? { detail } : {}),
        ...(b.owner ? { owner: b.owner } : {}),
        state,
        resolvedAt: itemOpen(state) ? null : (item.resolvedAt ?? now()),
      })
      .where(eq(buildItem.id, item.id));
    await ctx.tx.update(build).set({ updatedAt: now() }).where(eq(build.id, row.id));
    return buildDetail(
      { tx: ctx.tx, services: ctx.services, now },
      await readBuild(ctx.tx, row.id),
    );
  });

  // docs/builder-plan.md §4: the operator marks one of the Builder's decisions discussed or
  // confirmed. Its words change only through the conversation (the Builder's rewrite, or a draft
  // edit the operator agrees), so a person's look stays tied to what they looked at.
  mount(app, routes.opsBuildDecisionStatus, async (ctx) => {
    const row = await readBuild(ctx.tx, ctx.params.id, true);
    refuseClosed(row);
    const fitgap = readFitGap(row.fitgap);
    // DECISION: who looked is kept as the operator's name (else their email), as the screen
    // says it ("confirmed by Ada"); the build's event row keeps their user id.
    const by = ctx.session.user.name?.trim() || ctx.session.user.email || null;
    const decisions = setDecisionStatus(
      fitgap.decisions,
      ctx.params.decisionId,
      ctx.body.status,
      by,
      now().toISOString(),
    );
    if (!decisions) throw notFound("decision");
    await ctx.tx
      .update(build)
      .set({ fitgap: { ...fitgap, decisions }, updatedAt: now() })
      .where(eq(build.id, row.id));
    await addEvent(ctx.tx, row, {
      kind: "record",
      payload: { decision: { id: ctx.params.decisionId, status: ctx.body.status } },
      userId: ctx.session.user.id,
    });
    return buildDetail(
      { tx: ctx.tx, services: ctx.services, now },
      await readBuild(ctx.tx, row.id),
    );
  });

  mount(app, routes.opsStopBuild, async (ctx) => {
    const row = await readBuild(ctx.tx, ctx.params.id, true);
    refuseClosed(row);
    await ctx.tx.update(build).set({ status: "stopped" }).where(eq(build.id, row.id));
    await addEvent(ctx.tx, row, {
      kind: "decision",
      payload: { stopped: true },
      reason: ctx.body.reason,
      userId: ctx.session.user.id,
    });
    return buildDetail(
      { tx: ctx.tx, services: ctx.services, now },
      await readBuild(ctx.tx, row.id),
    );
  });
}

/** What the test cases run against, in words the model can make cases for. */
/**
 * A generated template case names a workflow of the draft, and expects outputs only of that
 * workflow's steps (BUILDER_QA AI-6): one that doesn't can never pass, and would hold the gate.
 */
function caseFitsDraft(
  steps: ReadonlyMap<string, ReadonlySet<string>>,
  input: unknown,
  expected: unknown,
): boolean {
  const slug = (input as { workflow?: unknown } | null)?.workflow;
  const ids = typeof slug === "string" ? steps.get(slug) : undefined;
  if (!ids) return false;
  if (!expected || typeof expected !== "object") return false;
  return Object.keys(expected).every((id) => ids.has(id));
}

async function caseTarget(
  tx: Tx,
  row: BuildRow,
  detail: BuildDetail,
): Promise<{ kind: "template" | "skill"; id: string; text: string }> {
  if (row.kind === "skill") {
    const skillId = detail.draft?.skillId;
    if (!skillId) throw new HttpError(409, "no_draft", "the skill isn't saved yet");
    const versionId = await latestSkillVersion(tx, skillId);
    const [v] = versionId
      ? await tx.select().from(skillVersion).where(eq(skillVersion.id, versionId))
      : [];
    const def = (v?.definition ?? {}) as Record<string, unknown>;
    return {
      kind: "skill",
      id: skillId,
      text: JSON.stringify({
        name: def.name,
        description: def.description,
        input: def.input,
        output: def.output,
      }),
    };
  }
  const agentId = detail.draft?.agentId;
  if (!agentId || detail.poc?.mode !== "suite") {
    throw new HttpError(409, "test_runs", "a client agent is tested with test runs on its page");
  }
  const v = await latestVersion(tx, agentId);
  const bundle = (v?.bundle ?? {}) as { workflows?: { slug: string; workflow: unknown }[] };
  const workflows = (bundle.workflows ?? []).map((w) => ({ slug: w.slug, workflow: w.workflow }));
  const text = JSON.stringify({ workflows });
  return {
    kind: "template",
    id: agentId,
    text: text.length > 60_000 ? text.slice(0, 60_000) : text,
  };
}
