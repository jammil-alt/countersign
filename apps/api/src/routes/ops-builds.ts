// Builds (docs/plan.md §1.108): the routes of a build's way from intake to go-live. The Builder's
// turns and the moves that make things (the draft, test cases, the client's copy) are slow routes
// (mountLong): the model and the back office's own routes run outside any transaction, each of
// those routes as the operator through `invokeRoute` (its roles, scope, checks and audit row,
// marked as the build's), and the build is saved in short operator-scoped transactions.

import { buildTurn, latestVersion, makeTestCases } from "@countersign/agents";
import {
  BRIEF_FIELDS,
  BRIEF_LABELS,
  type Brief,
  type BuildDetail,
  type BuildPhase,
  FIT_WORDS,
  type FitGap,
  type FitRow,
  fitChangeKind,
  itemOpen,
  mergeFitGap,
  nextPhase,
  operatorFitGap,
  phaseIndex,
  readBrief,
  readFitGap,
  readQa,
  readTestPlan,
  routes,
  testCaseProblems,
} from "@countersign/core";
import { build, buildItem, buildMessage, skillVersion, type Tx } from "@countersign/db";
import { createLlmClient, type LlmTransport } from "@countersign/llm";
import { and, asc, eq } from "drizzle-orm";
import type { Hono } from "hono";
import {
  addEvent,
  addItems,
  addMessage,
  type BuildRow,
  buildDetail,
  latestSkillVersion,
  listBuilds,
  type NewItem,
  openItemsAcross,
  readBuild,
  refKey,
  summaries,
} from "../build/store";
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
import { workerTransport } from "../runs/execute";
import { builderContext, builderHttpError } from "./ops-builder";

function transport(services: Pick<Services, "deps" | "env">): LlmTransport {
  return services.deps.llm?.(services.env) ?? workerTransport(services.env);
}

const now = () => new Date();

function refuseClosed(row: BuildRow): void {
  if (row.status !== "open") {
    throw new HttpError(409, "build_closed", `this build is ${row.status}`);
  }
}

/** The description the Builder drafts from: the confirmed brief and the agreed fit-gap. */
export function draftDescription(
  row: Pick<BuildRow, "title">,
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
  if (fitgap.needsTrue.length > 0) {
    lines.push("", "What needs to be true:");
    for (const n of fitgap.needsTrue) lines.push(`- ${n.text}`);
  }
  const text = lines.join("\n");
  return text.length > 4000 ? `${text.slice(0, 3990)}…` : text;
}

/** Items the agreed fit-gap leaves: what to build or find, and what must be true. */
function fitGapItems(fitgap: FitGap): NewItem[] {
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
  for (const n of fitgap.needsTrue) {
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
      if (answer.brief[key]) out.push(`Brief: ${BRIEF_LABELS[key].toLowerCase()}`);
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

/**
 * The Builder's turn in the build's phase: `words` are the operator's (saved first), or null when
 * the Builder opens a phase. A model that can't be reached is said in the conversation when it
 * opens a phase, and is the answer's error when the operator asked.
 */
async function turn(ctx: LongCtx, id: string, words: string | null): Promise<void> {
  const prep = await ctx.inTx(async (scoped) => {
    const row = await readBuild(scoped.tx, id, true);
    refuseClosed(row);
    const history = await scoped.tx
      .select({ role: buildMessage.role, text: buildMessage.text })
      .from(buildMessage)
      .where(eq(buildMessage.buildId, row.id))
      .orderBy(asc(buildMessage.createdAt), asc(buildMessage.id));
    if (words) await addMessage(scoped.tx, row, { role: "operator", text: words });
    const detail = await detailIn(scoped, ctx.services, row);
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
    ];
    const bctx =
      row.phase === "fitgap" || row.phase === "poc"
        ? await builderContext({ ...scoped, services: ctx.services }, row.clientId)
        : null;
    const client = detail.build.client?.name ?? null;
    return { row, history, facts, bctx, client, items: detail.items };
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
        items: prep.items
          .filter((i) => itemOpen(i.state))
          .map((i) => `${i.title} (${i.owner}, ${i.state})`),
        facts: prep.facts,
        history: prep.history,
        words,
        ctx: prep.bctx,
      },
      { llm: createLlmClient({ transport: transport(ctx.services) }) },
    );
  } catch (error) {
    if (words) builderHttpError(error);
    await ctx.inTx(async (scoped) => {
      const fresh = await readBuild(scoped.tx, id, true);
      await addMessage(scoped.tx, fresh, {
        role: "builder",
        text: "I couldn't reach my model just now, so this phase has nothing from me yet. Ask me again in a minute.",
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
    await addMessage(scoped.tx, fresh, {
      role: "builder",
      text: answer.text,
      meta: {
        chips: answer.chips,
        changes: changeLines(answer),
        costUsd: result.costUsd,
        model: result.calls[0]?.model ?? null,
      },
    });
  });
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
      await addItems(scoped.tx, r, fitGapItems(readFitGap(r.fitgap)), userId);
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
    const [row] = await ctx.tx
      .insert(build)
      .values({
        kind: ctx.body.kind,
        title: ctx.body.title,
        clientId,
        createdBy: ctx.session.user.id,
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
    const { title, brief, testPlan } = ctx.body;
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
        updatedAt: now(),
      })
      .where(eq(build.id, row.id));
    return buildDetail(
      { tx: ctx.tx, services: ctx.services, now },
      await readBuild(ctx.tx, row.id),
    );
  });

  mountLong(app, routes.opsBuildTurn, async (ctx) => {
    await turn(long(ctx.c, ctx.session, ctx.services, ctx.inTx), ctx.params.id, ctx.body.text);
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
      { llm: createLlmClient({ transport: transport(ctx.services) }) },
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
