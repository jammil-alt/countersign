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
  BRIEF_FIELDS,
  BRIEF_LABELS,
  type Brief,
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
  dqNumber,
  FIT_WORDS,
  type FitGap,
  type FitRow,
  fitChangeKind,
  issueLine,
  itemOpen,
  mergeFitGap,
  nextPhase,
  operatorFitGap,
  PHASE_WORDS,
  ProposalState,
  phaseIndex,
  proposalUndo,
  readBrief,
  readFitGap,
  readQa,
  readTestPlan,
  routes,
  SETUP_WORDS,
  testCaseProblems,
} from "@countersign/core";
import {
  agent,
  build,
  buildEvent,
  buildItem,
  buildMessage,
  codeRequest,
  codeRequestLink,
  skillVersion,
  type Tx,
} from "@countersign/db";
import { createLlmClient, DEFAULT_MODELS, type LlmTransport } from "@countersign/llm";
import { and, asc, eq, inArray, like, sql } from "drizzle-orm";
import type { Hono } from "hono";
import {
  addEvent,
  addItems,
  addMessage,
  type BuildRow,
  buildDetail,
  draftOutline,
  latestSkillVersion,
  listBuilds,
  type NewItem,
  openItemsAcross,
  readBuild,
  refKey,
  summaries,
  withDecisions,
} from "../build/store";
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
import { reportHandled, reportProblem } from "../observability/report";
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

/** The template's slug in the client, or the first free `<slug>-2`, `-3`, … */
async function freeSlug(tx: Tx, clientId: string, slug: string): Promise<string> {
  const taken = new Set(
    (
      await tx
        .select({ slug: agent.slug })
        .from(agent)
        .where(and(eq(agent.tenantId, clientId), like(agent.slug, `${slug}%`)))
    ).map((r) => r.slug),
  );
  if (!taken.has(slug)) return slug;
  for (let n = 2; n < 100; n++) if (!taken.has(`${slug}-${n}`)) return `${slug}-${n}`;
  throw new HttpError(409, "slug_taken", "the client has too many agents from this template");
}

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
  const inScope = fitgap.rows.filter((r) => !r.dropped && r.verdict !== "not_possible");
  if (inScope.length > 0) {
    lines.push("", "What it does, and how:");
    for (const r of inScope) {
      const changed = r.override
        ? `; the operator changed it from ${FIT_WORDS[r.override.from]}: ${r.override.reason}`
        : "";
      lines.push(`- ${r.need} (${FIT_WORDS[r.verdict]}${changed}): ${r.how}`);
    }
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
  const text = lines.join("\n");
  return text.length > 4000 ? `${text.slice(0, 3990)}…` : text;
}

/**
 * Items the agreed fit-gap leaves: what to build or find, and, for one client, what must be true.
 * A template has no client: what it needs from one is its intake form, which makes no items.
 */
function fitGapItems(fitgap: FitGap, template: boolean): NewItem[] {
  const out: NewItem[] = [];
  for (const r of fitgap.rows) {
    if (r.dropped) continue;
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

/** One line per thing the turn changed, for the conversation. */
function changeLines(answer: Awaited<ReturnType<typeof buildTurn>>["answer"]): string[] {
  const out: string[] = [];
  if (answer.brief) {
    for (const key of BRIEF_FIELDS) {
      const f = answer.brief[key];
      if (!f) continue;
      // QA (2026-11-17): a field the turn left open read as filled ("+ Brief: done well means").
      const state =
        f.state === "open" ? " (still open)" : f.state === "assumed" ? " (assumed)" : "";
      out.push(`Brief: ${BRIEF_LABELS[key].toLowerCase()}${state}`);
    }
  }
  if (answer.fitgap) {
    const n = answer.fitgap.rows.length;
    out.push(`Fit-gap: ${n} ${n === 1 ? "row" : "rows"}`);
  }
  if (answer.testPlan) {
    const n = answer.testPlan.datasets.length;
    out.push(`Test plan: ${n} ${n === 1 ? "dataset" : "datasets"}`);
  }
  for (const i of answer.items) out.push(`Open item: ${i.title}`);
  return out;
}

interface LongCtx {
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

/** What the conversation says when the Builder's turn fails, by what went wrong. */
function failedTurnText(phase: BuildPhase, error: unknown): { code: string; text: string } {
  const what =
    phase === "fitgap"
      ? "The fit-gap isn't written yet"
      : phase === "poc"
        ? "The test plan isn't written yet"
        : "Nothing changed";
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
    const focused = about ? (issues.find((i) => i.key === about) ?? null) : null;
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
          .map((m) => ({ role: m.role, text: m.text.slice(0, 600) }))
      : [];
    const facts = [
      ...(detail.draft?.problems.map((p) => `Draft problem: ${p.title}`) ?? []),
      ...(detail.poc ? [`Tests: ${detail.poc.detail}`] : []),
      ...(detail.clientTest
        ? [
            `Client test at ${detail.clientTest.client.name}: stage ${detail.clientTest.stage ?? "none"}, ${detail.clientTest.writes.signed} writes signed, ${detail.clientTest.writes.rejected} rejected, ${detail.clientTest.writes.waiting} waiting.`,
            ...detail.clientTest.rejections.map(
              (r) => `Rejected ${r.tool}: ${r.reason ?? "no reason given"}`,
            ),
          ]
        : []),
      ...detail.qaChecks.map((c) => `QA ${c.label}: ${c.state} (${c.detail})`),
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
  try {
    result = await buildTurn(
      {
        phase: row.phase,
        kind: row.kind,
        title: row.title,
        clientName: prep.client,
        brief: readBrief(row.brief),
        fitgap: readFitGap(row.fitgap),
        testPlan: readTestPlan(row.testPlan),
        issues: prep.issues.map(issueLine),
        focus: prep.focused ? { line: issueLine(prep.focused), thread: prep.thread } : null,
        facts: prep.facts,
        history: prep.history,
        words: prep.said,
        ctx: prep.bctx,
        otherWork: prep.otherWork,
      },
      { llm: createLlmClient({ transport: transport(ctx.services, row) }) },
    );
  } catch (error) {
    const failure = failedTurnText(row.phase, error);
    reportHandled("a Builder turn in a build failed", error, {
      kind: "build",
      phase: row.phase,
      failure: failure.code,
      build: id,
    });
    await ctx.inTx(async (scoped) => {
      const fresh = await readBuild(scoped.tx, id, true);
      await addMessage(scoped.tx, fresh, {
        role: "builder",
        text: failure.text,
        meta: { failed: failure.code },
      });
    });
    return;
  }
  await ctx.inTx(async (scoped) => {
    const fresh = await readBuild(scoped.tx, id, true);
    // The phase may have moved while the model answered: only that phase's record changes.
    const { answer } = result;
    const set: Partial<BuildRow> = {};
    if (fresh.phase === row.phase) {
      if (answer.brief) set.brief = { ...readBrief(fresh.brief), ...answer.brief };
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
    }
    if (Object.keys(set).length > 0) await scoped.tx.update(build).set(set).where(eq(build.id, id));
    else await scoped.tx.update(build).set({ updatedAt: now() }).where(eq(build.id, id));
    await addItems(
      scoped.tx,
      fresh,
      answer.items.map((i) => ({ ...i, phase: fresh.phase })),
      ctx.session.user.id,
    );
    const answered = await closeAnswered(scoped.tx, fresh, answer.answered);
    // The issue it answered about, and its proposal, only as they fit the build as it was asked.
    const about =
      (answer.about && prep.issues.some((i) => i.key === answer.about) ? answer.about : null) ??
      prep.focused?.key ??
      null;
    const proposal = answer.proposal
      ? fitProposal(answer.proposal, prep.detail, fresh.phase)
      : null;
    if (answer.proposal && !proposal) {
      reportProblem("the Builder proposed a change that doesn't fit the build", {
        kind: "build",
        action: answer.proposal.action.do,
        build: id,
      });
    }
    await addMessage(scoped.tx, fresh, {
      role: "builder",
      text: answer.text,
      meta: {
        chips: answer.chips,
        changes: [...changeLines(answer), ...answered.map((t) => `Answered: ${t}`)],
        costUsd: result.costUsd,
        model: result.calls[0]?.model ?? null,
        ...(about ? { about } : {}),
        ...(proposal ? { proposal: { ...proposal, state: "proposed" } } : {}),
      },
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
        { llm: createLlmClient({ transport: transport(ctx.services, row) }) },
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

/**
 * The Builder's proposal if it fits the build: an item it names is this build's and in the state
 * the change needs, a check is failing in QA, going back is to an earlier phase, tests run in the
 * POC. The route that makes the change checks again when the operator agrees.
 */
function fitProposal(p: BuildProposal, d: BuildDetail, phase: BuildPhase): BuildProposal | null {
  const a = p.action;
  const itemOf = (raw: string) => d.items.find((i) => i.id === raw.replace(/^item:/, ""));
  switch (a.do) {
    case "close_item": {
      const item = itemOf(a.itemId);
      return item && itemOpen(item.state) ? { ...p, action: { ...a, itemId: item.id } } : null;
    }
    case "reopen_item": {
      const item = itemOf(a.itemId);
      return item && !itemOpen(item.state) ? { ...p, action: { ...a, itemId: item.id } } : null;
    }
    case "accept_check":
      return phase === "qa" && d.qaChecks.some((c) => c.id === a.check && c.state === "fail")
        ? p
        : null;
    case "go_back":
      return phaseIndex(d.build.kind, a.to) >= 0 &&
        phaseIndex(d.build.kind, a.to) < phaseIndex(d.build.kind, phase)
        ? p
        : null;
    case "run_tests":
      return phase === "poc" && d.draft ? p : null;
    case "edit_draft":
      // The draft is what the POC tests; from the client test on, the change goes back first.
      return (phase === "draft" || phase === "poc") &&
        (d.build.kind === "agent" ? !!d.draft?.versionId : !!d.draft?.sessionId)
        ? p
        : null;
    // docs/plan.md §1.125: a gap's two buckets, and the Dev queue's link and approval.
    case "file_code_request":
    case "link_code_request":
    case "draft_skill": {
      if (phase !== "fitgap" && phase !== "draft" && phase !== "poc") return null;
      if (!a.itemId) return p;
      const item = itemOf(a.itemId);
      if (!item || !itemOpen(item.state) || item.kind !== "gap") return null;
      // A gap already waiting on a request, or with its skill build, is settled that way.
      if (item.ref.codeRequestId || (a.do === "draft_skill" && item.ref.buildId)) return null;
      return { ...p, action: { ...a, itemId: item.id } };
    }
    case "approve_code_request":
      return p;
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
      await call(ctx, routes.opsBuildRunTests, { params: { id } });
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
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

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

/** Makes the draft (once): the Builder's own route, as the operator. */
async function makeDraft(ctx: LongCtx, row: BuildRow): Promise<Partial<BuildRow>> {
  const description = draftDescription(row, readBrief(row.brief), readFitGap(row.fitgap));
  if (row.kind === "agent") {
    if (row.agentId) return {};
    const out = await call(ctx, routes.opsDraftAgent, {
      body: { description, name: row.title, ...(row.clientId ? { clientId: row.clientId } : {}) },
    });
    return { agentId: out.agent.id };
  }
  if (row.sessionId) return {};
  const started = await call(ctx, routes.opsStartBuilderSession, {
    body: { kind: "skill", name: row.title, ...(row.clientId ? { clientId: row.clientId } : {}) },
  });
  // The skill's first draft: a model that can't answer leaves the conversation for the operator.
  await call(ctx, routes.opsBuilderTurn, {
    params: { id: started.session.id },
    body: { text: description },
  }).catch(() => undefined);
  return { sessionId: started.session.id };
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
    const detail = await detailIn(scoped, ctx.services, r);
    const skip = r.phase === "client_test" && !!reason;
    // Moving into the draft makes it: the draft gate is the fit-gap's.
    if (detail.gate.reasons.length > 0 && !skip) {
      throw new HttpError(409, "gate", detail.gate.reasons.join(" "), detail.gate.reasons);
    }
    return r;
  });
  const forward = phaseIndex(row.kind, to) > phaseIndex(row.kind, row.phase);
  // 1b. Owner (2026-11-17): a brief gets a second look before it is confirmed. What it doesn't
  //     settle becomes open questions and the build stays in intake; confirming the same brief
  //     again goes on with them open.
  if (forward && row.phase === "intake" && (await reviewHolds(ctx, row))) return;
  // 2. What the move makes, outside any transaction.
  const made = forward && to === "draft" ? await makeDraft(ctx, row) : {};
  // 3. The move, its record and the items it leaves.
  await ctx.inTx(async (scoped) => {
    const r = await readBuild(scoped.tx, id, true);
    const qa = readQa(r.qa);
    await scoped.tx
      .update(build)
      .set({
        ...made,
        phase: to,
        phaseAt: now(),
        // Going back before QA undoes its signature and decision: QA is done again.
        ...(forward ? {} : { qa: { ...qa, signedBy: null, signedAt: null, decision: null } }),
      })
      .where(eq(build.id, id));
    await addEvent(scoped.tx, r, { kind: "phase", from: r.phase, to, reason, userId });
    if (forward && r.phase === "intake") {
      await addEvent(scoped.tx, r, {
        kind: "record",
        payload: { brief: readBrief(r.brief) },
        userId,
      });
      await addItems(scoped.tx, r, briefItems(readBrief(r.brief)), userId);
    }
    if (forward && r.phase === "fitgap") {
      await addEvent(scoped.tx, r, {
        kind: "record",
        payload: { fitgap: readFitGap(r.fitgap) },
        userId,
      });
      await addItems(scoped.tx, r, fitGapItems(readFitGap(r.fitgap), buildHasSetupForm(r)), userId);
    }
    if (forward && r.phase === "poc") {
      await addEvent(scoped.tx, r, {
        kind: "record",
        payload: { testPlan: readTestPlan(r.testPlan) },
        userId,
      });
    }
  });
  // 4. The Builder opens the phases it has work in.
  if (forward && (to === "fitgap" || to === "poc")) await turn(ctx, id, null);
  if (forward && to === "draft") {
    await ctx.inTx(async (scoped) => {
      const r = await readBuild(scoped.tx, id, true);
      const detail = await detailIn(scoped, ctx.services, r);
      const n = detail.draft?.problems.length ?? 0;
      await addMessage(scoped.tx, r, {
        role: "builder",
        text:
          r.kind === "skill"
            ? "I started the skill in its own Builder conversation. Open it to look at the draft and save it; its problems show here."
            : n === 0
              ? "I drafted it from the brief and the fit-gap. It has no problems; open the workflow to look it over."
              : `I drafted it from the brief and the fit-gap. ${n === 1 ? "1 problem is" : `${n} problems are`} left to fix: missing steps are where the catalog has nothing yet. Open the workflow to work on them.`,
      });
    });
  }
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
    const { title, brief, testPlan, promisedOn, waitingOn, statusLine, stuck } = ctx.body;
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
        updatedAt: now(),
      })
      .where(eq(build.id, row.id));
    return buildDetail(
      { tx: ctx.tx, services: ctx.services, now },
      await readBuild(ctx.tx, row.id),
    );
  });

  mountLong(app, routes.opsBuildTurn, async (ctx) => {
    const text = ctx.body.text ?? null;
    await turn(long(ctx.c, ctx.session, ctx.services, ctx.inTx), ctx.params.id, text, {
      retry: !text,
      about: ctx.body.about ?? null,
    });
    return detailOf(ctx, ctx.params.id);
  });

  // Owner (2026-11-17): the Builder proposes, the operator agrees, the change is made through the
  // build's own route as the operator (its checks and audit row), then the Builder offers the next.
  mountLong(app, routes.opsBuildProposal, async (ctx) => {
    const lc = long(ctx.c, ctx.session, ctx.services, ctx.inTx);
    const { id, messageId } = ctx.params;
    const { decide } = ctx.body;
    const found = await ctx.inTx(async (scoped) => {
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
      const itemId = "itemId" in p.action ? p.action.itemId : null;
      const [item] = itemId
        ? await scoped.tx
            .select({ state: buildItem.state })
            .from(buildItem)
            .where(and(eq(buildItem.id, itemId), eq(buildItem.buildId, row.id)))
        : [];
      return {
        p,
        before: item?.state ?? null,
        about: metaAbout(meta),
        edit: decided?.edit ?? null,
      };
    });
    const { p, about } = found;
    // The operator's decision, as their message in the conversation.
    // The Builder's own message after a decision.
    const say = (text: string, meta: Record<string, unknown>) =>
      ctx.inTx(async (scoped) => {
        const fresh = await readBuild(scoped.tx, id, true);
        await addMessage(scoped.tx, fresh, { role: "builder", text: clip(text, 3000), meta });
      });
    const record = (
      decision: "agreed" | "unchanged" | "declined" | "undone",
      extra: Record<string, unknown> = {},
    ) =>
      ctx.inTx(async (scoped) => {
        const fresh = await readBuild(scoped.tx, id, true);
        await addMessage(scoped.tx, fresh, {
          role: "operator",
          text: { agree: "Agreed.", decline: "Not this.", undo: "Undo that." }[decide],
          meta: { decides: messageId, decision, ...extra, ...(about ? { about } : {}) },
        });
      });
    if (decide === "decline") {
      await record("declined");
      return detailOf(ctx, id);
    }
    // docs/plan.md §1.125: filing, linking, approving a request, or starting a skill build.
    if (isDevQueueAction(p.action)) {
      if (decide !== "agree") throw new HttpError(409, "no_undo", "this change has no undo here");
      const out = await runDevQueueAction(lc, id, p.action);
      await record("agreed", { result: clip(out.text, 1000) });
      await say(out.text, {
        ...(about ? { about } : {}),
        ...(out.proposal ? { proposal: { ...out.proposal, state: "proposed" } } : {}),
      });
      return detailOf(ctx, id);
    }
    let changed: string[] = [];
    if (p.action.do === "edit_draft") {
      // Owner (2026-11-17): the draft changes in the build's conversation, made by the workflow's
      // Builder (its guards, its labelled changes) and saved as a draft version; undo is its own.
      if (decide === "agree") {
        const edit = await applyEdit(lc, id, p.action, p.summary);
        const said = firstSentences(edit.text, 2);
        if (edit.changes.length === 0) {
          await record("unchanged", { result: clip(`Nothing changed: ${said}`, 500) });
          await say(`I tried, and the draft didn't change: ${said}`, about ? { about } : {});
          return detailOf(ctx, id);
        }
        // QA on staging (2026-11-17): "Done: Build the filter skill" was said when only a step's
        // description had changed and the step was still missing. What an edit did is checked
        // against the build after it, never taken from the proposal's own words.
        const left = await ctx.inTx(async (scoped) =>
          stillOpen(
            await detailIn(scoped, ctx.services, await readBuild(scoped.tx, id, true)),
            about,
            p.action.do === "edit_draft" ? (p.action.stepId ?? null) : null,
          ),
        );
        await record("agreed", {
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
            { ...(about ? { about } : {}), chips: ["What would fix it?"] },
          );
          return detailOf(ctx, id);
        }
        changed = [said];
        // A part a request shipped, put in its step: the gap item closes once the step validates.
        const settled = await ctx.inTx(async (scoped) =>
          settleShipped(
            scoped.tx,
            ctx.services.platform,
            await readBuild(scoped.tx, id, true),
            now(),
          ),
        );
        if (settled.length > 0) {
          changed.push(`That settles ${settled.map((t) => `“${t}”`).join(", ")}, so I closed it.`);
        }
      } else {
        if (!found.edit || found.edit.changeIds.length === 0) {
          throw new HttpError(409, "no_undo", "this change has no undo here");
        }
        await undoEdit(lc, id, found.edit, p.summary);
        await record("undone");
      }
    } else {
      const action = decide === "agree" ? p.action : proposalUndo(p.action, p.before);
      if (!action) throw new HttpError(409, "no_undo", "this change has no undo here");
      await runAction(lc, id, action);
      await record(
        decide === "agree" ? "agreed" : "undone",
        decide === "agree" && found.before ? { before: found.before } : {},
      );
    }
    await ctx.inTx(async (scoped) => {
      const fresh = await readBuild(scoped.tx, id, true);
      const issues = buildIssues(await detailIn(scoped, ctx.services, fresh));
      const next = issues.find((i) => i.open && i.key !== about);
      const item = issues.find((i) => i.key === about && i.source === "item" && i.open);
      if (decide === "agree" && changed.length > 0 && item) {
        // A draft edit for an open item: whether it settles the item is the operator's to say.
        await addMessage(scoped.tx, fresh, {
          role: "builder",
          text: `Changed the draft: ${changed.join(" ")} “${item.title}” stays open until you close it. Does this settle it?`,
          meta: { about: item.key, chips: ["Yes, close it", "Not yet"] },
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
        },
      });
    });
    return detailOf(ctx, id);
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

  mountLong(app, routes.opsBuildCases, async (ctx) => {
    const lc = long(ctx.c, ctx.session, ctx.services, ctx.inTx);
    const prep = await ctx.inTx(async (scoped) => {
      const row = await readBuild(scoped.tx, ctx.params.id);
      refuseClosed(row);
      if (row.phase !== "poc")
        throw new HttpError(409, "not_poc", "test cases are made in the POC test");
      const detail = await detailIn(scoped, ctx.services, row);
      return { row, detail, target: await caseTarget(scoped.tx, row, detail) };
    });
    const plan = readTestPlan(prep.row.testPlan);
    if (!plan.datasets.some((d) => d.source === "generate")) {
      throw new HttpError(409, "nothing_to_generate", "the test plan has no dataset to generate");
    }
    const made = await makeTestCases(
      { kind: prep.target.kind, testPlan: plan, target: prep.target.text },
      { llm: createLlmClient({ transport: transport(ctx.services, prep.row) }) },
    ).catch(builderHttpError);
    let created = 0;
    for (const c of made.cases) {
      const fields = {
        input: c.input,
        expected: c.expected,
        matcher: { kind: "subset" as const, tolerances: {} },
      };
      if (testCaseProblems(prep.target.kind, fields).length > 0) continue;
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
            : `I made ${created} test ${created === 1 ? "case" : "cases"} from the plan; ${made.cases.length - created} didn't fit the test bench and were left out.`,
        meta: { costUsd: made.costUsd },
      });
    });
    return { ...(await detailOf(ctx, ctx.params.id)), created };
  });

  mountLong(app, routes.opsBuildRunTests, async (ctx) => {
    const lc = long(ctx.c, ctx.session, ctx.services, ctx.inTx);
    const target = await ctx.inTx(async (scoped) => {
      const row = await readBuild(scoped.tx, ctx.params.id);
      refuseClosed(row);
      const detail = await detailIn(scoped, ctx.services, row);
      if (row.kind === "skill") {
        const skillId = detail.draft?.skillId;
        const versionId = skillId ? await latestSkillVersion(scoped.tx, skillId) : null;
        if (!skillId || !versionId)
          throw new HttpError(409, "no_draft", "the skill isn't saved yet");
        return { targetKind: "skill" as const, targetId: skillId, versionId };
      }
      const versionId = detail.draft?.versionId;
      if (!detail.draft?.agentId || !versionId)
        throw new HttpError(409, "no_draft", "there is no draft yet");
      if (detail.poc?.mode !== "suite") {
        throw new HttpError(
          409,
          "test_runs",
          "a client agent is tested with test runs on its page",
        );
      }
      return { targetKind: "template" as const, targetId: detail.draft.agentId, versionId };
    });
    await call(lc, routes.opsRunTests, { body: target });
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
    if (!row.clientId) {
      const fork = await call(lc, routes.opsFork, {
        params: { id: agentId },
        body: { clientId, versionId },
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
      await scoped.tx
        .update(build)
        .set({ phase: "client_test", phaseAt: now(), testClientId: clientId, testAgentId })
        .where(eq(build.id, r.id));
      await addEvent(scoped.tx, r, { kind: "phase", from: "poc", to: "client_test", userId });
      await addEvent(scoped.tx, r, {
        kind: "record",
        payload: { testPlan: readTestPlan(r.testPlan) },
        userId,
      });
      const moved = { ...r, phase: "client_test" as const };
      if (blocked) {
        await addItems(
          scoped.tx,
          moved,
          [
            {
              phase: "client_test",
              kind: "precondition",
              title: blocked.title,
              detail: blocked.detail,
              key: `start:${testAgentId}`,
            },
          ],
          userId,
        );
      }
      await addMessage(scoped.tx, moved, {
        role: "builder",
        text: blocked
          ? "It's at the client, but its trial hasn't started: it needs one thing first, now an open item."
          : "It's published and at the client, in its trial: every write it makes waits for the client's signature until sign-off.",
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
    const [item] = await ctx.tx
      .select()
      .from(buildItem)
      .where(and(eq(buildItem.id, ctx.params.itemId), eq(buildItem.buildId, row.id)));
    if (!item) throw notFound("open item");
    const b = ctx.body;
    const state = b.state ?? item.state;
    await ctx.tx
      .update(buildItem)
      .set({
        ...(b.title ? { title: b.title } : {}),
        ...(b.detail !== undefined ? { detail: b.detail } : {}),
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
