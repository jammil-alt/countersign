// The Dev queue's moves (docs/plan.md §1.125), one function each, shared by the back office's
// routes, the MCP tools and the build's proposals, so every front door goes through the same
// guards (core's `requestMoves`, `acceptReasons`, `closeProblem`, `prProblem`) and writes the same
// events. The model (the reuse check's judge) runs outside any transaction; the request is read
// and saved in short operator-scoped ones (`inTx`). Only a person accepts or closes; Shipped is
// the system's (./ship.ts).

import { BuilderError, type CatalogEntry, runReuseCheck, searchCatalog } from "@countersign/agents";
import {
  acceptReasons,
  type CandidateVerdict,
  type CloseReason,
  type CodeRequestActor,
  type CodeRequestDetail,
  type CodeRequestLinkInput,
  closeProblem,
  coveredBy,
  dqNumber,
  duplicateOf,
  type FiledCodeRequest,
  type NewCodeRequest,
  prProblem,
  type ReuseCandidate,
  type ReuseCheck,
  readReuseCheck,
  requestMoves,
  requestOpen,
  type UpdateCodeRequest,
} from "@countersign/core";
import { build, buildItem, codeRequest, codeRequestLink, type Tx } from "@countersign/db";
import { createLlmClient, type LlmCallRecord } from "@countersign/llm";
import { and, desc, eq, inArray, lte, or, sql } from "drizzle-orm";
import type { z } from "zod";
import { addMessage } from "../build/store";
import { clientModels } from "../compliance/models";
import { HttpError, type Scoped, type Services } from "../http";
import { meterModelCalls } from "../metering";
import { notifyDepsFromEnv } from "../notify/tick";
import { reportHandled } from "../observability/report";
import { reuseIndex } from "./catalog";
import { notifyRequest } from "./notify";
import {
  addRequestEvent,
  factsOf,
  findRequest,
  linkRequest,
  type RequestRow,
  requestDetail,
  requestForStep,
  requestSummaries,
} from "./store";

export interface DqCtx {
  services: Services;
  inTx<T>(work: (scoped: Scoped) => Promise<T>): Promise<T>;
  userId: string;
  /** Who is acting: the operator, a Claude Code session (MCP), or the Builder (a build's card). */
  actor: CodeRequestActor;
  now(): Date;
  /**
   * The clients whose words the request carries (a client asked from their account): the reuse
   * check's judge is held to each one's HIPAA mode, as it is for a build's clients.
   */
  clients?: readonly string[];
}

const refused = (reason: string) => new HttpError(409, "refused", reason);

/**
 * The judge's model, held to the HIPAA mode of every client whose build the request is linked to
 * (its words may carry that build's work). A refused call sends nothing: the candidates come back
 * unjudged, for the operator to judge.
 */
function llmFor(services: Services, clients: readonly string[], calls?: LlmCallRecord[]) {
  return createLlmClient({
    transport: clientModels(services, { clients, read: services.db }),
    ...(calls ? { onCall: (record: LlmCallRecord) => void calls.push(record) } : {}),
  });
}

/** The clients of the builds linked to a request, or of one build about to be. */
async function clientsOf(tx: Tx, q: { requestId?: string; buildId?: string }): Promise<string[]> {
  const ids = q.buildId
    ? [q.buildId]
    : q.requestId
      ? (
          await tx
            .select({ id: codeRequestLink.buildId })
            .from(codeRequestLink)
            .where(eq(codeRequestLink.requestId, q.requestId))
        ).map((r) => r.id)
      : [];
  if (ids.length === 0) return [];
  const rows = await tx
    .select({ c: build.clientId, t: build.testClientId })
    .from(build)
    .where(inArray(build.id, ids));
  return [...new Set(rows.flatMap((r) => [r.c, r.t]).filter((x): x is string => !!x))];
}

/** The reuse check, or an unjudged one when the model can't be reached (said on the request). */
async function checkReuse(
  ctx: DqCtx,
  input: { title: string; kind: RequestRow["kind"]; spec: ReturnType<typeof factsOf>["spec"] },
  about: { requestId?: string; buildId?: string },
): Promise<ReuseCheck> {
  const selfId = about.requestId;
  const { index, bctx, clients } = await ctx.inTx(async (scoped) => {
    const r = await reuseIndex(scoped, ctx.services);
    const linked = await clientsOf(scoped.tx, about);
    return {
      index: r.index,
      bctx: r.ctx,
      clients: [...new Set([...linked, ...(ctx.clients ?? [])])],
    };
  });
  const base = {
    title: input.title,
    kind: input.kind,
    spec: input.spec,
    index,
    ctx: bctx,
    ...(selfId ? { selfId } : {}),
  };
  // §1.210: the judge's calls are ours (the dev queue is the platform's work), on the request's
  // one client when it has exactly one; a judge that failed spent them too.
  const calls: LlmCallRecord[] = [];
  try {
    return (
      await runReuseCheck(base, { llm: llmFor(ctx.services, clients, calls), now: ctx.now() })
    ).check;
  } catch (error) {
    if (!(error instanceof BuilderError)) throw error;
    reportHandled("the reuse check's judge failed", error, { kind: "dev_queue" });
    return (await runReuseCheck(base, { llm: null, now: ctx.now() })).check;
  } finally {
    if (calls.length > 0) {
      await ctx
        .inTx(({ tx }) =>
          meterModelCalls(tx, {
            tenantId: clients.length === 1 ? (clients[0] ?? null) : null,
            source: "dev_queue",
            key: `dev_queue:${crypto.randomUUID()}`,
            calls,
          }),
        )
        .catch((error: unknown) =>
          reportHandled("the reuse check's cost was not recorded", error, { kind: "dev_queue" }),
        );
    }
  }
}

/** Verdicts the filer or an operator gave, kept on the candidates (added if not found). */
export function withVerdicts(
  check: ReuseCheck,
  verdicts: readonly CandidateVerdict[],
  by: "operator" | "builder",
  options: { override: boolean },
): ReuseCheck {
  const candidates: ReuseCandidate[] = check.candidates.map((c) => {
    const v = verdicts.find((x) => x.partId === c.partId);
    if (!v || (!options.override && c.verdict)) return c;
    return {
      ...c,
      relevant: true,
      verdict: v.verdict,
      reason: v.reason,
      missing: v.missing,
      judgedBy: by,
    };
  });
  for (const v of verdicts) {
    if (candidates.some((c) => c.partId === v.partId)) continue;
    candidates.push({
      partType: v.partId.includes("#") ? "operation" : "tool",
      partId: v.partId,
      name: v.partId,
      score: 0,
      relevant: true,
      verdict: v.verdict,
      reason: v.reason,
      missing: v.missing,
      judgedBy: by,
      number: null,
      open: null,
    });
  }
  return {
    ...check,
    candidates: candidates.slice(0, 20),
    unjudged: candidates.some((c) => c.relevant && !c.verdict),
  };
}

export async function getRequest(ctx: DqCtx, ref: string): Promise<CodeRequestDetail> {
  return ctx.inTx(async ({ tx }) =>
    requestDetail(tx, await findRequest(tx, ref), ctx.now(), ctx.userId),
  );
}

export async function listRequests(
  tx: Tx,
  q: {
    status: string;
    kind?: string | undefined;
    build?: string | undefined;
    environment?: "staging" | "production" | undefined;
    limit: number;
  },
) {
  const where = [];
  if (q.status === "open") {
    where.push(inArray(codeRequest.status, ["triage", "accepted", "in_progress"]));
  } else if (q.status !== "all") {
    where.push(eq(codeRequest.status, q.status as RequestRow["status"]));
  }
  if (q.kind) where.push(eq(codeRequest.kind, q.kind as RequestRow["kind"]));
  if (q.environment === "staging") where.push(sql`${codeRequest.shippedStagingAt} is not null`);
  if (q.environment === "production") {
    where.push(sql`${codeRequest.shippedProductionAt} is not null`);
  }
  if (q.build) {
    where.push(
      inArray(
        codeRequest.id,
        tx
          .select({ id: codeRequestLink.requestId })
          .from(codeRequestLink)
          .where(eq(codeRequestLink.buildId, q.build)),
      ),
    );
  }
  const rows = await tx
    .select()
    .from(codeRequest)
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(codeRequest.createdAt), desc(codeRequest.number))
    .limit(q.limit);
  const [open] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(codeRequest)
    .where(inArray(codeRequest.status, ["triage", "accepted", "in_progress"]));
  return { requests: await requestSummaries(tx, rows), openCount: open?.n ?? 0 };
}

/**
 * Files a request. One request per capability: an open request already linked to this build's
 * step, or one with the same title, is returned instead; so is an open request the reuse check's
 * judge calls the same capability (proposed, never merged on its own). Otherwise the request opens
 * in Triage with the check done and, when a part already does it, the suggested decision `exists`.
 */
export async function fileRequest(ctx: DqCtx, body: NewCodeRequest): Promise<FiledCodeRequest> {
  const same = await ctx.inTx(async ({ tx }) => {
    const byStep = body.link ? await requestForStep(tx, body.link) : null;
    if (byStep) return byStep;
    const [byTitle] = await tx
      .select()
      .from(codeRequest)
      .where(
        and(
          sql`lower(${codeRequest.title}) = lower(${body.title})`,
          inArray(codeRequest.status, ["triage", "accepted", "in_progress"]),
        ),
      )
      .limit(1);
    return byTitle ?? null;
  });
  if (same) {
    return {
      request: null,
      duplicate: { id: same.id, ref: dqNumber(same.number), title: same.title },
    };
  }
  const judged = await checkReuse(
    ctx,
    { title: body.title, kind: body.kind, spec: body.spec },
    body.link ? { buildId: body.link.buildId } : {},
  );
  const dup = duplicateOf(judged);
  if (dup) {
    return {
      request: null,
      duplicate: { id: dup.partId, ref: dqNumber(dup.number ?? 0), title: dup.name },
    };
  }
  const check = withVerdicts(judged, body.considered, "builder", { override: false });
  const covered = coveredBy(check);
  return ctx.inTx(async ({ tx }) => {
    const [row] = await tx
      .insert(codeRequest)
      .values({
        title: body.title,
        kind: body.kind,
        spec: body.spec,
        openQuestions: body.openQuestions,
        reuseCheck: check,
        decision: covered ? "exists" : (body.decision ?? null),
        decisionReason: covered
          ? `The reuse check found “${covered.name}”: ${covered.reason}`.slice(0, 2000)
          : (body.decisionReason ?? null),
        otherUses: body.otherUses,
        owner: body.owner ?? "Mezonas engineering",
        createdBy: body.createdBy,
        createdByUser: ctx.userId,
        lastEventAt: ctx.now(),
      })
      .returning();
    if (!row) throw new Error("code request insert returned nothing");
    await addRequestEvent(tx, row.id, {
      kind: "status",
      actor: ctx.actor,
      userId: ctx.userId,
      body: {
        to: "triage",
        createdBy: body.createdBy,
        ...(covered && body.decision ? { filedAs: body.decision } : {}),
      },
    });
    await addRequestEvent(tx, row.id, {
      kind: "reuse_check",
      actor: "system",
      userId: null,
      body: reuseSummary(check),
    });
    if (body.link) await linkRequest(tx, row, body.link, ctx.userId);
    return {
      request: await requestDetail(tx, row, ctx.now(), ctx.userId),
      duplicate: null,
    };
  });
}

function reuseSummary(check: ReuseCheck): Record<string, unknown> {
  const count = (v: string) => check.candidates.filter((c) => c.verdict === v).length;
  const covered = coveredBy(check);
  return {
    candidates: check.candidates.length,
    use: count("use"),
    extend: count("extend"),
    reject: count("reject"),
    unjudged: check.unjudged,
    ...(covered ? { covered: covered.partId } : {}),
  };
}

/** The reuse check again: on demand, and on claim. */
export async function rerunReuse(ctx: DqCtx, ref: string): Promise<CodeRequestDetail> {
  const row = await ctx.inTx(({ tx }) => findRequest(tx, ref));
  const moves = requestMoves(factsOf(row), ctx.now(), { userId: ctx.userId });
  if (!moves.rerun_reuse.allowed) throw refused(moves.rerun_reuse.reason);
  const facts = factsOf(row);
  const fresh = await checkReuse(
    ctx,
    { title: row.title, kind: row.kind, spec: facts.spec },
    { requestId: row.id },
  );
  // The operator's own verdicts stay on the candidates they judged.
  const kept = (facts.reuseCheck?.candidates ?? [])
    .filter((c) => c.judgedBy === "operator" && c.verdict)
    .map((c) => ({
      partId: c.partId,
      verdict: c.verdict as NonNullable<ReuseCandidate["verdict"]>,
      reason: c.reason,
      missing: c.missing,
    }));
  const check = withVerdicts(fresh, kept, "operator", { override: true });
  return ctx.inTx(async ({ tx }) => {
    const locked = await findRequest(tx, row.id, true);
    await tx
      .update(codeRequest)
      .set({ reuseCheck: check, updatedAt: ctx.now() })
      .where(eq(codeRequest.id, locked.id));
    await addRequestEvent(tx, locked.id, {
      kind: "reuse_check",
      actor: ctx.actor,
      userId: ctx.userId,
      body: reuseSummary(check),
    });
    return requestDetail(tx, await findRequest(tx, locked.id), ctx.now(), ctx.userId);
  });
}

/** Triage: the spec, questions, decision and verdicts. Only while in triage (owner while open). */
export async function updateRequest(
  ctx: DqCtx,
  ref: string,
  patch: z.infer<typeof UpdateCodeRequest>,
): Promise<CodeRequestDetail> {
  return ctx.inTx(async ({ tx }) => {
    const row = await findRequest(tx, ref, true);
    const triageOnly = Object.keys(patch).filter((k) => k !== "owner");
    if (triageOnly.length > 0 && row.status !== "triage") {
      throw refused("Only a request in triage is changed. Close it and file a new one instead.");
    }
    if (!requestOpen(row.status)) throw refused("It's no longer open.");
    const check = readReuseCheck(row.reuseCheck);
    const set: Partial<typeof codeRequest.$inferInsert> = { updatedAt: ctx.now() };
    if (patch.title !== undefined) set.title = patch.title;
    if (patch.kind !== undefined) set.kind = patch.kind;
    if (patch.spec !== undefined) set.spec = patch.spec;
    if (patch.openQuestions !== undefined) set.openQuestions = patch.openQuestions;
    if (patch.decision !== undefined) {
      set.decision = patch.decision;
      // A different decision needs its own approval.
      if (patch.decision !== "one_off") {
        set.oneOffApprovedAt = null;
        set.oneOffApprovedBy = null;
      }
    }
    if (patch.decisionReason !== undefined) set.decisionReason = patch.decisionReason;
    if (patch.otherUses !== undefined) set.otherUses = patch.otherUses;
    if (patch.owner !== undefined) set.owner = patch.owner;
    if (patch.verdicts?.length) {
      set.reuseCheck = withVerdicts(
        check ?? { ranAt: ctx.now().toISOString(), candidates: [], unjudged: false },
        patch.verdicts,
        "operator",
        { override: true },
      );
    }
    await tx.update(codeRequest).set(set).where(eq(codeRequest.id, row.id));
    await addRequestEvent(tx, row.id, {
      kind: "note",
      actor: ctx.actor,
      userId: ctx.userId,
      body: { edited: Object.keys(patch) },
    });
    return requestDetail(tx, await findRequest(tx, row.id), ctx.now(), ctx.userId);
  });
}

/** Triage → Accepted, by a person, guarded; then everyone is told. */
export async function acceptRequest(ctx: DqCtx, ref: string): Promise<CodeRequestDetail> {
  if (ctx.actor === "builder") throw refused("Only a person accepts a request.");
  const id = await ctx.inTx(async ({ tx }) => {
    const row = await findRequest(tx, ref, true);
    const reasons = acceptReasons(factsOf(row), ctx.now());
    if (reasons.length > 0) throw refused(reasons.join(" "));
    await tx
      .update(codeRequest)
      .set({ status: "accepted", updatedAt: ctx.now() })
      .where(eq(codeRequest.id, row.id));
    await addRequestEvent(tx, row.id, {
      kind: "status",
      actor: ctx.actor,
      userId: ctx.userId,
      body: { from: "triage", to: "accepted" },
    });
    return row.id;
  });
  await notifyRequest(
    ctx.services.db,
    notifyDepsFromEnv(ctx.services.env, ctx.services.deps.fetch?.(ctx.services.env)),
    id,
    { kind: "accepted" },
    { at: ctx.now() },
  );
  return getRequest(ctx, id);
}

export async function approveOneOff(ctx: DqCtx, ref: string): Promise<CodeRequestDetail> {
  if (ctx.actor === "builder") throw refused("Only a person approves a one-off.");
  return ctx.inTx(async ({ tx }) => {
    const row = await findRequest(tx, ref, true);
    const move = requestMoves(factsOf(row), ctx.now(), { userId: ctx.userId }).approve_one_off;
    if (!move.allowed) throw refused(move.reason);
    await tx
      .update(codeRequest)
      .set({ oneOffApprovedAt: ctx.now(), oneOffApprovedBy: ctx.userId, updatedAt: ctx.now() })
      .where(eq(codeRequest.id, row.id));
    await addRequestEvent(tx, row.id, {
      kind: "status",
      actor: ctx.actor,
      userId: ctx.userId,
      body: { approved: "one_off" },
    });
    return requestDetail(tx, await findRequest(tx, row.id), ctx.now(), ctx.userId);
  });
}

/**
 * Claims an accepted request, or one whose claim lapsed (2 hours with no event), in one statement
 * so two sessions can't both have it. The reuse check runs again on claim.
 */
export async function claimRequest(ctx: DqCtx, ref: string): Promise<CodeRequestDetail> {
  const now = ctx.now();
  const claimed = await ctx.inTx(async ({ tx }) => {
    const row = await findRequest(tx, ref);
    const lapseBefore = new Date(now.getTime() - 2 * 3_600_000);
    const [won] = await tx
      .update(codeRequest)
      .set({ status: "in_progress", claimedBy: ctx.userId, claimedAt: now, updatedAt: now })
      .where(
        and(
          eq(codeRequest.id, row.id),
          or(
            eq(codeRequest.status, "accepted"),
            and(eq(codeRequest.status, "in_progress"), lte(codeRequest.lastEventAt, lapseBefore)),
          ),
        ),
      )
      .returning();
    if (!won) {
      const move = requestMoves(factsOf(row), now, { userId: ctx.userId }).claim;
      throw refused(move.allowed ? "Someone else claimed it just now." : move.reason);
    }
    await addRequestEvent(tx, row.id, {
      kind: "claim",
      actor: ctx.actor,
      userId: ctx.userId,
      body: {
        from: row.status,
        ...(row.status === "in_progress" && row.claimedBy ? { lapsedClaim: row.claimedBy } : {}),
      },
      at: now,
    });
    return row.id;
  });
  try {
    return await rerunReuse(ctx, claimed);
  } catch (error) {
    reportHandled("the reuse check on claim failed", error, { kind: "dev_queue" });
    return getRequest(ctx, claimed);
  }
}

export async function attachPr(
  ctx: DqCtx,
  ref: string,
  prUrl: string,
  expectedPartId: string,
): Promise<CodeRequestDetail> {
  return ctx.inTx(async ({ tx }) => {
    const row = await findRequest(tx, ref, true);
    const move = requestMoves(factsOf(row), ctx.now(), { userId: ctx.userId }).attach_pr;
    if (!move.allowed) throw refused(move.reason);
    const problem = prProblem(prUrl, expectedPartId);
    if (problem) throw new HttpError(422, "bad_pr", problem);
    await tx
      .update(codeRequest)
      .set({ prUrl: prUrl.trim(), expectedPartId: expectedPartId.trim(), updatedAt: ctx.now() })
      .where(eq(codeRequest.id, row.id));
    await addRequestEvent(tx, row.id, {
      kind: "pr",
      actor: ctx.actor,
      userId: ctx.userId,
      body: { prUrl: prUrl.trim(), expectedPartId: expectedPartId.trim() },
    });
    return requestDetail(tx, await findRequest(tx, row.id), ctx.now(), ctx.userId);
  });
}

export async function noteRequest(ctx: DqCtx, ref: string, text: string) {
  return ctx.inTx(async ({ tx }) => {
    const row = await findRequest(tx, ref);
    await addRequestEvent(tx, row.id, {
      kind: "note",
      actor: ctx.actor,
      userId: ctx.userId,
      body: { text },
    });
    return requestDetail(tx, await findRequest(tx, row.id), ctx.now(), ctx.userId);
  });
}

/**
 * Closes a request, by a person, with a reason. Its builds are told: a `config` close carries the
 * recipe (the note), which the Builder offers as a draft edit; a merge moves the builds' links and
 * gap items to the request it merged into; any other reason hands the gap back to the operator.
 */
export async function closeRequest(
  ctx: DqCtx,
  ref: string,
  reason: CloseReason,
  mergedIntoRef: string | null,
  note: string | null,
): Promise<CodeRequestDetail> {
  if (ctx.actor === "builder") throw refused("Only a person closes a request.");
  if (reason === "config" && !(note ?? "").trim()) {
    throw refused("A config close needs the recipe: what to set, where.");
  }
  return ctx.inTx(async ({ tx }) => {
    const row = await findRequest(tx, ref, true);
    const into = mergedIntoRef ? await findRequest(tx, mergedIntoRef) : null;
    const problem = closeProblem(factsOf(row), reason, into?.id ?? null);
    if (problem) throw refused(problem);
    if (into && !requestOpen(into.status) && into.status !== "shipped") {
      throw refused(`${dqNumber(into.number)} is closed: merge into an open or shipped request.`);
    }
    await tx
      .update(codeRequest)
      .set({
        status: "closed",
        closeReason: reason,
        mergedIntoId: into?.id ?? null,
        closedAt: ctx.now(),
        updatedAt: ctx.now(),
      })
      .where(eq(codeRequest.id, row.id));
    await addRequestEvent(tx, row.id, {
      kind: "status",
      actor: ctx.actor,
      userId: ctx.userId,
      body: {
        from: row.status,
        to: "closed",
        reason,
        ...(into ? { mergedInto: dqNumber(into.number) } : {}),
        ...(note ? { note } : {}),
      },
    });
    const links = await tx
      .select()
      .from(codeRequestLink)
      .where(eq(codeRequestLink.requestId, row.id));
    if (into) {
      for (const l of links) {
        await linkRequest(
          tx,
          into,
          {
            buildId: l.buildId,
            ...(l.workflowId ? { workflowId: l.workflowId } : {}),
            ...(l.stepId ? { stepId: l.stepId } : {}),
            ...(l.issueId ? { issueId: l.issueId } : {}),
          },
          ctx.userId,
        );
      }
      await addRequestEvent(tx, into.id, {
        kind: "merge",
        actor: ctx.actor,
        userId: ctx.userId,
        body: { from: dqNumber(row.number), links: links.length },
      });
    }
    await tellBuildsClosed(tx, row, links, reason, into, note);
    return requestDetail(tx, await findRequest(tx, row.id), ctx.now(), ctx.userId);
  });
}

async function tellBuildsClosed(
  tx: Tx,
  row: RequestRow,
  links: (typeof codeRequestLink.$inferSelect)[],
  reason: CloseReason,
  into: RequestRow | null,
  note: string | null,
): Promise<void> {
  const ref = dqNumber(row.number);
  const buildIds = [...new Set(links.map((l) => l.buildId))];
  if (buildIds.length === 0) return;
  const builds = await tx.select().from(build).where(inArray(build.id, buildIds));
  for (const b of builds) {
    const mine = links.filter((l) => l.buildId === b.id);
    const issue = mine.find((l) => l.issueId)?.issueId ?? null;
    const step = mine.find((l) => l.stepId)?.stepId ?? null;
    const about = issue ? { about: `item:${issue}` } : {};
    if (into) {
      await addMessage(tx, b, {
        role: "builder",
        text: `${ref} was merged into ${dqNumber(into.number)}: ${into.title}. This step waits on that one now.`,
        meta: about,
      });
      continue;
    }
    // Not merged: the gap is the operator's again, with the request's outcome.
    if (issue && reason !== "config") {
      await tx
        .update(buildItem)
        .set({ owner: "operator", state: "open" })
        .where(and(eq(buildItem.id, issue), eq(buildItem.buildId, b.id)));
    }
    if (reason === "config" && note) {
      const editable = b.phase === "draft" || b.phase === "poc";
      await addMessage(tx, b, {
        role: "builder",
        text: `${ref} is closed: what exists does it with the right settings. The recipe: ${note}`,
        meta: {
          ...about,
          ...(editable
            ? {
                proposal: {
                  summary: `Set it up as ${ref}'s recipe says`,
                  action: {
                    do: "edit_draft",
                    request: `Set the step up this way, with what the catalog has: ${note}`.slice(
                      0,
                      1000,
                    ),
                    ...(step ? { stepId: step } : {}),
                  },
                  state: "proposed",
                },
              }
            : {}),
        },
      });
      continue;
    }
    const words: Record<CloseReason, string> = {
      exists: "what it asks for exists already",
      config: "configuration does it",
      merged: "it was merged",
      not_worth_it: "it isn't worth building",
      not_possible: "the provider's API doesn't allow it",
      superseded: "something else replaced it",
    };
    await addMessage(tx, b, {
      role: "builder",
      text: `${ref} is closed: ${words[reason]}.${note ? ` ${note}` : ""} The gap is yours to decide again.`,
      meta: about,
    });
  }
}

/** Links a build to a request (a duplicate agreed, or a link by hand); a merge says so. */
export async function linkToRequest(
  ctx: DqCtx,
  ref: string,
  link: CodeRequestLinkInput,
  merge: boolean,
): Promise<CodeRequestDetail> {
  return ctx.inTx(async ({ tx }) => {
    const row = await findRequest(tx, ref, true);
    if (row.status === "closed") throw refused("It's closed: link the request it was merged into.");
    const out = await linkRequest(tx, row, link, ctx.userId);
    if (out.created) {
      await addRequestEvent(tx, row.id, {
        kind: merge ? "merge" : "note",
        actor: ctx.actor,
        userId: ctx.userId,
        body: {
          linked: link.buildId,
          ...(link.stepId ? { stepId: link.stepId } : {}),
        },
      });
    }
    return requestDetail(tx, await findRequest(tx, row.id), ctx.now(), ctx.userId);
  });
}

/** §3's search, as the reuse check runs it, for the screen and the MCP tool. */
export async function searchParts(
  ctx: DqCtx,
  q: { query: string; inputs?: string[]; outputs?: string[]; kind?: RequestRow["kind"] },
  limit: number,
) {
  const index: CatalogEntry[] = await ctx.inTx(
    async (scoped) => (await reuseIndex(scoped, ctx.services)).index,
  );
  return searchCatalog(index, q, limit).map((h) => ({
    partType: h.partType,
    partId: h.partId,
    name: h.name,
    description: h.description,
    inputs: h.inputs,
    outputs: h.outputs,
    score: h.score,
    ref: h.partType === "request" && h.number ? dqNumber(h.number) : null,
  }));
}
