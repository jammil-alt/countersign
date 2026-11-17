// The Dev queue's reads and writes (docs/plan.md §1.125): a request by its id or its number, its
// guards' facts, its views, its events (every change writes one) and its links to the builds and
// steps waiting on it. Everything runs in the caller's operator-scoped transaction: a request and
// its events are visible to every operator session, a link only with its build (RLS).

import {
  type CodeRequestActor,
  type CodeRequestDetail,
  type CodeRequestEventKind,
  type CodeRequestLinkInput,
  type CodeRequestSummary,
  coveredBy,
  dqNumber,
  isUuid,
  parseDqNumber,
  type RequestFacts,
  readQuestions,
  readReuseCheck,
  readSpec,
  requestMoves,
  type StepCodeRequest,
} from "@countersign/core";
import {
  appUser,
  build,
  buildItem,
  codeRequest,
  codeRequestEvent,
  codeRequestLink,
  type Tx,
} from "@countersign/db";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { HttpError, notFound } from "../http";

export type RequestRow = typeof codeRequest.$inferSelect;
export type LinkRow = typeof codeRequestLink.$inferSelect;

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

/** A request by its id or its number (DQ-012); locked when asked. */
export async function findRequest(tx: Tx, ref: string, lock = false): Promise<RequestRow> {
  const where = isUuid(ref)
    ? eq(codeRequest.id, ref)
    : (() => {
        const n = parseDqNumber(ref);
        if (n === null)
          throw new HttpError(422, "bad_ref", "name a request by its id or DQ number");
        return eq(codeRequest.number, n);
      })();
  const q = tx.select().from(codeRequest).where(where);
  const [row] = lock ? await q.for("update") : await q;
  if (!row) throw notFound("request");
  return row;
}

/** What the guards read. */
export function factsOf(row: RequestRow): RequestFacts {
  return {
    id: row.id,
    status: row.status,
    kind: row.kind,
    spec: readSpec(row.spec),
    openQuestions: readQuestions(row.openQuestions),
    reuseCheck: readReuseCheck(row.reuseCheck),
    decision: row.decision ?? null,
    decisionReason: row.decisionReason ?? null,
    otherUses: row.otherUses ?? [],
    oneOffApprovedAt: iso(row.oneOffApprovedAt),
    claimedBy: row.claimedBy ?? null,
    claimedAt: iso(row.claimedAt),
    lastEventAt: (iso(row.lastEventAt) as string) ?? new Date(0).toISOString(),
    prUrl: row.prUrl ?? null,
    expectedPartId: row.expectedPartId ?? null,
  };
}

/** One event, and the request's last event time with it. */
export async function addRequestEvent(
  tx: Tx,
  requestId: string,
  e: {
    kind: CodeRequestEventKind;
    actor: CodeRequestActor;
    userId: string | null;
    body?: Record<string, unknown>;
    at?: Date;
  },
): Promise<void> {
  const at = e.at ?? new Date();
  await tx.insert(codeRequestEvent).values({
    requestId,
    at,
    actor: e.actor,
    userId: e.userId,
    kind: e.kind,
    body: e.body ?? {},
  });
  await tx.update(codeRequest).set({ lastEventAt: at }).where(eq(codeRequest.id, requestId));
}

async function userNames(tx: Tx, ids: readonly (string | null)[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((x): x is string => !!x))];
  if (wanted.length === 0) return new Map();
  const rows = await tx
    .select({ id: appUser.id, name: appUser.name, email: appUser.email })
    .from(appUser)
    .where(inArray(appUser.id, wanted));
  return new Map(rows.map((r) => [r.id, r.name ?? r.email]));
}

/** The builds each request is linked to (only those the session may see). */
async function linkedBuilds(
  tx: Tx,
  ids: readonly string[],
): Promise<Map<string, { id: string; title: string }[]>> {
  const out = new Map<string, { id: string; title: string }[]>();
  if (ids.length === 0) return out;
  const rows = await tx
    .selectDistinct({ requestId: codeRequestLink.requestId, id: build.id, title: build.title })
    .from(codeRequestLink)
    .innerJoin(build, eq(build.id, codeRequestLink.buildId))
    .where(inArray(codeRequestLink.requestId, [...ids]));
  for (const r of rows) {
    const list = out.get(r.requestId) ?? [];
    list.push({ id: r.id, title: r.title });
    out.set(r.requestId, list);
  }
  return out;
}

function summaryOf(
  row: RequestRow,
  builds: { id: string; title: string }[],
  names: Map<string, string>,
): CodeRequestSummary {
  const covered = coveredBy(readReuseCheck(row.reuseCheck));
  return {
    id: row.id,
    number: row.number,
    ref: dqNumber(row.number),
    title: row.title,
    kind: row.kind,
    status: row.status,
    inReview: row.status === "in_progress" && !!row.prUrl,
    decision: row.decision ?? null,
    owner: row.owner ?? null,
    claimedBy: row.claimedBy
      ? { id: row.claimedBy, name: names.get(row.claimedBy) ?? "Someone" }
      : null,
    prUrl: row.prUrl ?? null,
    expectedPartId: row.expectedPartId ?? null,
    shippedPartId: row.shippedPartId ?? null,
    shippedStagingAt: iso(row.shippedStagingAt),
    shippedProductionAt: iso(row.shippedProductionAt),
    builds,
    coveredBy:
      covered && row.status === "triage" ? { partId: covered.partId, name: covered.name } : null,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function requestSummaries(tx: Tx, rows: RequestRow[]): Promise<CodeRequestSummary[]> {
  const builds = await linkedBuilds(
    tx,
    rows.map((r) => r.id),
  );
  const names = await userNames(
    tx,
    rows.map((r) => r.claimedBy),
  );
  return rows.map((r) => summaryOf(r, builds.get(r.id) ?? [], names));
}

/** The links of a request, with their build's title and the gap item's. */
export async function linksOf(tx: Tx, requestId: string) {
  return tx
    .select({
      link: codeRequestLink,
      buildTitle: build.title,
      issueTitle: buildItem.title,
      issueState: buildItem.state,
    })
    .from(codeRequestLink)
    .innerJoin(build, eq(build.id, codeRequestLink.buildId))
    .leftJoin(buildItem, eq(buildItem.id, codeRequestLink.issueId))
    .where(eq(codeRequestLink.requestId, requestId))
    .orderBy(asc(codeRequestLink.createdAt));
}

export async function requestDetail(
  tx: Tx,
  row: RequestRow,
  now: Date,
  userId: string,
): Promise<CodeRequestDetail> {
  const links = await linksOf(tx, row.id);
  const events = await tx
    .select()
    .from(codeRequestEvent)
    .where(eq(codeRequestEvent.requestId, row.id))
    .orderBy(desc(codeRequestEvent.at), desc(codeRequestEvent.id))
    .limit(200);
  const names = await userNames(tx, [row.claimedBy, ...events.map((e) => e.userId)]);
  const [merged] = row.mergedIntoId
    ? await tx
        .select({ id: codeRequest.id, number: codeRequest.number })
        .from(codeRequest)
        .where(eq(codeRequest.id, row.mergedIntoId))
    : [];
  const builds = [
    ...new Map(
      links.map((l) => [l.link.buildId, { id: l.link.buildId, title: l.buildTitle }]),
    ).values(),
  ];
  const facts = factsOf(row);
  return {
    ...summaryOf(row, builds, names),
    spec: facts.spec,
    openQuestions: facts.openQuestions as CodeRequestDetail["openQuestions"],
    reuseCheck: facts.reuseCheck,
    decisionReason: row.decisionReason ?? null,
    otherUses: row.otherUses ?? [],
    oneOffApprovedAt: iso(row.oneOffApprovedAt),
    mergedInto: merged ? { id: merged.id, ref: dqNumber(merged.number) } : null,
    closeReason: row.closeReason ?? null,
    closedAt: iso(row.closedAt),
    links: links.map((l) => ({
      id: l.link.id,
      buildId: l.link.buildId,
      buildTitle: l.buildTitle,
      workflowId: l.link.workflowId ?? null,
      stepId: l.link.stepId ?? null,
      issueId: l.link.issueId ?? null,
      issueTitle: l.issueTitle ?? null,
      issueOpen: l.issueState ? l.issueState !== "done" && l.issueState !== "deferred" : null,
      createdAt: l.link.createdAt.toISOString(),
    })),
    events: events.map((e) => ({
      id: e.id,
      at: e.at.toISOString(),
      actor: e.actor as CodeRequestDetail["events"][number]["actor"],
      userName: e.userId ? (names.get(e.userId) ?? null) : null,
      kind: e.kind,
      body: (e.body ?? {}) as Record<string, unknown>,
    })),
    moves: requestMoves(facts, now, { userId }),
  };
}

/**
 * Links a build (and its step) to a request, once. The build's gap item for it says so: the one
 * named, or one made for the step (keyed, so made once). Its owner is engineering, never "You",
 * and it waits on the request. Returns whether the link is new.
 */
export async function linkRequest(
  tx: Tx,
  row: RequestRow,
  link: CodeRequestLinkInput,
  userId: string | null,
): Promise<{ created: boolean; issueId: string | null }> {
  const [b] = await tx
    .select({ id: build.id, phase: build.phase })
    .from(build)
    .where(eq(build.id, link.buildId));
  if (!b) throw notFound("build");
  const ref = dqNumber(row.number);
  let issueId = link.issueId ?? null;
  if (issueId) {
    const [item] = await tx
      .select({ id: buildItem.id, kind: buildItem.kind })
      .from(buildItem)
      .where(and(eq(buildItem.id, issueId), eq(buildItem.buildId, b.id)));
    if (!item) throw notFound("open item");
    if (item.kind !== "gap") {
      throw new HttpError(409, "not_a_gap", "only a gap item waits on a request for code");
    }
  } else {
    // One item per request and step: made once, by its key.
    const key = `dq:${row.id}:${link.workflowId ?? ""}:${link.stepId ?? ""}`;
    await tx
      .insert(buildItem)
      .values({
        buildId: b.id,
        phase: b.phase,
        kind: "gap",
        title: row.title.slice(0, 300),
        detail: `Waiting on ${ref}.`,
        owner: "engineering",
        state: "waiting",
        stepId: link.stepId ?? null,
        key,
        createdBy: userId,
      })
      .onConflictDoNothing();
    const [made] = await tx
      .select({ id: buildItem.id })
      .from(buildItem)
      .where(and(eq(buildItem.buildId, b.id), eq(buildItem.key, key)));
    issueId = made?.id ?? null;
  }
  if (issueId) {
    await tx
      .update(buildItem)
      .set({
        owner: "engineering",
        state: "waiting",
        ref: sql`${buildItem.ref} || ${JSON.stringify({ codeRequestId: row.id, codeRequestRef: ref })}::jsonb`,
        ...(link.stepId ? { stepId: link.stepId } : {}),
      })
      .where(eq(buildItem.id, issueId));
  }
  const inserted = await tx
    .insert(codeRequestLink)
    .values({
      requestId: row.id,
      buildId: b.id,
      workflowId: link.workflowId ?? null,
      stepId: link.stepId ?? null,
      issueId,
    })
    .onConflictDoNothing()
    .returning({ id: codeRequestLink.id });
  return { created: inserted.length > 0, issueId };
}

/** The open request already linked to this build's step, if any: one request per step. */
export async function requestForStep(
  tx: Tx,
  link: CodeRequestLinkInput,
): Promise<RequestRow | null> {
  if (!link.stepId && !link.issueId) return null;
  const rows = await tx
    .select({ request: codeRequest })
    .from(codeRequestLink)
    .innerJoin(codeRequest, eq(codeRequest.id, codeRequestLink.requestId))
    .where(
      and(
        eq(codeRequestLink.buildId, link.buildId),
        link.issueId
          ? eq(codeRequestLink.issueId, link.issueId)
          : and(
              eq(codeRequestLink.stepId, link.stepId as string),
              link.workflowId ? eq(codeRequestLink.workflowId, link.workflowId) : sql`true`,
            ),
        inArray(codeRequest.status, ["triage", "accepted", "in_progress"]),
      ),
    )
    .limit(1);
  return rows[0]?.request ?? null;
}

/** The steps that require code in these builds, each with its request as it is now. */
export async function stepRequests(
  tx: Tx,
  buildIds: readonly string[],
): Promise<StepCodeRequest[]> {
  if (buildIds.length === 0) return [];
  const rows = await tx
    .select({ link: codeRequestLink, request: codeRequest })
    .from(codeRequestLink)
    .innerJoin(codeRequest, eq(codeRequest.id, codeRequestLink.requestId))
    .where(inArray(codeRequestLink.buildId, [...buildIds]))
    .orderBy(asc(codeRequestLink.createdAt));
  return rows.map(({ link, request: r }) => ({
    buildId: link.buildId,
    workflowId: link.workflowId ?? null,
    stepId: link.stepId ?? null,
    request: {
      id: r.id,
      ref: dqNumber(r.number),
      title: r.title,
      status: r.status,
      inReview: r.status === "in_progress" && !!r.prUrl,
      shippedStagingAt: iso(r.shippedStagingAt),
    },
  }));
}
