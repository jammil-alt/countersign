// Shipped is the system's (docs/plan.md §1.125). After a deploy (the Worker's first cron tick or
// request with a new commit, `DEPLOYED_SHA`, which /api/ready reports) the pass compares every
// open request's expected part with this deployment's catalog. A request whose part is there is
// shipped in this environment: staging or production, each its own column (a database is one
// environment's). Then everyone is told, every linked draft is checked again, and in each build
// the Builder either closes the gap item (the step validates now) or proposes putting the part in
// the waiting step. The same pass lapses claims with no event for 2 hours and no PR.

import { CLAIM_LAPSE_MS, dqNumber, shipEnvironment } from "@countersign/core";
import { build, buildItem, codeRequest, codeRequestLink, type Db, type Tx } from "@countersign/db";
import { and, eq, inArray, isNotNull, isNull, lte } from "drizzle-orm";
import { addMessage, type BuildRow, buildDetail } from "../build/store";
import type { NotifyDeps } from "../notify/outbox";
import { reportHandled } from "../observability/report";
import type { Platform } from "../platform";
import { findPart } from "./catalog";
import { asSystem, notifyRequest } from "./notify";
import { addRequestEvent } from "./store";

export interface ShipDeps {
  db: Db;
  platform: Platform;
  notify: Pick<NotifyDeps, "mailer" | "origin">;
  /** ENVIRONMENT: production stamps "In production"; anything else "Shipped to staging". */
  environment: string | undefined;
}

// DECISION: anything but production (staging, and development locally) stamps the staging column.
export function shipColumn(environment: string | undefined): "staging" | "production" {
  return shipEnvironment(environment) === "production" ? "production" : "staging";
}

/** Requests whose part this deployment has now; each marked, told and its builds checked. */
export async function shipPass(deps: ShipDeps, now: Date): Promise<string[]> {
  const env = shipColumn(deps.environment);
  const stampColumn =
    env === "production" ? codeRequest.shippedProductionAt : codeRequest.shippedStagingAt;
  const found = await asSystem(deps.db, async (tx) => {
    await lapseClaims(tx, now);
    const rows = await tx
      .select()
      .from(codeRequest)
      .where(
        and(
          isNotNull(codeRequest.expectedPartId),
          inArray(codeRequest.status, ["accepted", "in_progress", "shipped"]),
          isNull(stampColumn),
        ),
      );
    const shipped: { id: string; part: string; first: boolean }[] = [];
    for (const row of rows) {
      const part = findPart(deps.platform, row.expectedPartId as string);
      if (!part) continue;
      const first = row.status !== "shipped";
      await tx
        .update(codeRequest)
        .set({
          ...(first ? { status: "shipped" as const, shippedPartId: row.expectedPartId } : {}),
          ...(env === "production" ? { shippedProductionAt: now } : { shippedStagingAt: now }),
          updatedAt: now,
        })
        .where(eq(codeRequest.id, row.id));
      await addRequestEvent(tx, row.id, {
        kind: "shipped",
        actor: "system",
        userId: null,
        body: { environment: env, part: row.expectedPartId, name: part.name },
        at: now,
      });
      shipped.push({ id: row.id, part: part.name, first });
    }
    return shipped;
  });
  for (const s of found) {
    try {
      const builds = await asSystem(deps.db, (tx) =>
        revalidate(tx, deps.platform, s.id, s.part, now),
      );
      await notifyRequest(
        deps.db,
        deps.notify,
        s.id,
        { kind: "shipped", part: s.part, environment: env },
        { at: now, tellBuilds: false },
      );
      void builds;
    } catch (error) {
      reportHandled("telling a shipped request's builds failed", error, { job: "dev_queue" });
    }
  }
  return found.map((s) => s.id);
}

/** In progress, no PR and no event for 2 hours: back to Accepted, for anyone to claim. */
// DECISION: a claim with its PR attached doesn't lapse: the PR is the work, waiting on review and
// the deploy; the ship pass still finds its part.
async function lapseClaims(tx: Tx, now: Date): Promise<void> {
  const before = new Date(now.getTime() - CLAIM_LAPSE_MS);
  const lapsed = await tx
    .update(codeRequest)
    .set({ status: "accepted", claimedBy: null, claimedAt: null, updatedAt: now })
    .where(
      and(
        eq(codeRequest.status, "in_progress"),
        isNull(codeRequest.prUrl),
        lte(codeRequest.lastEventAt, before),
      ),
    )
    .returning({ id: codeRequest.id });
  for (const r of lapsed) {
    await addRequestEvent(tx, r.id, {
      kind: "status",
      actor: "system",
      userId: null,
      body: {
        from: "in_progress",
        to: "accepted",
        reason: "The claim lapsed: 2 hours with no event.",
      },
      at: now,
    });
  }
}

/**
 * Each linked build's draft, checked again: a step that validates now closes its gap item; one
 * that doesn't gets the Builder's proposal to put the part in. Returns how many builds it told.
 */
export async function revalidate(
  tx: Tx,
  platform: Platform,
  requestId: string,
  partName: string,
  now: Date,
): Promise<number> {
  const [row] = await tx.select().from(codeRequest).where(eq(codeRequest.id, requestId));
  if (!row) return 0;
  const ref = dqNumber(row.number);
  const links = await tx
    .select()
    .from(codeRequestLink)
    .where(eq(codeRequestLink.requestId, row.id));
  const buildIds = [...new Set(links.map((l) => l.buildId))];
  if (buildIds.length === 0) return 0;
  const builds = await tx.select().from(build).where(inArray(build.id, buildIds));
  for (const b of builds) {
    const detail = await buildDetail({ tx, services: { platform }, now: () => now }, b);
    for (const l of links.filter((x) => x.buildId === b.id)) {
      const problem = l.stepId
        ? (detail.draft?.problems.find((p) => p.stepId === l.stepId) ?? null)
        : null;
      const stepName = problem?.stepName ?? l.stepId ?? null;
      const about = l.issueId ? { about: `item:${l.issueId}` } : {};
      if (!problem) {
        await closeIssue(tx, b, l.issueId, now);
        await addMessage(tx, b, {
          role: "builder",
          text: `${ref} is in: ${partName}.${l.issueId ? " The step it was for has no problem now, so I closed its open item." : ""}`,
          meta: { ...about, codeRequest: { id: row.id, ref } },
        });
        continue;
      }
      const editable = b.phase === "draft" || b.phase === "poc";
      await addMessage(tx, b, {
        role: "builder",
        text: editable
          ? `${ref} is in: ${partName}. I'd put it in the step “${stepName}”.`
          : `${ref} is in: ${partName}. To put it in the step “${stepName}”, go back to the draft first.`,
        meta: {
          ...about,
          codeRequest: { id: row.id, ref },
          ...(editable
            ? {
                proposal: {
                  summary: `Put ${partName} in “${stepName}”`.slice(0, 300),
                  action: {
                    do: "edit_draft",
                    request:
                      `On “${stepName}”, use ${row.shippedPartId ?? row.expectedPartId} (${partName}), now in the catalog, to do what ${ref} was for: ${row.title}.`.slice(
                        0,
                        1000,
                      ),
                    ...(l.stepId ? { stepId: l.stepId } : {}),
                  },
                  state: "proposed",
                },
              }
            : {}),
        },
      });
    }
  }
  return builds.length;
}

async function closeIssue(tx: Tx, b: BuildRow, issueId: string | null, now: Date) {
  if (!issueId) return;
  await tx
    .update(buildItem)
    .set({ state: "done", resolvedAt: now })
    .where(
      and(
        eq(buildItem.id, issueId),
        eq(buildItem.buildId, b.id),
        inArray(buildItem.state, ["open", "in_progress", "waiting"]),
      ),
    );
}

/**
 * After an agreed draft edit in a build: each gap item waiting on a shipped request closes once
 * its step validates (the swap worked). Returns the closed items' titles.
 */
export async function settleShipped(
  tx: Tx,
  platform: Platform,
  b: BuildRow,
  now: Date,
): Promise<string[]> {
  const rows = await tx
    .select({ link: codeRequestLink, request: codeRequest, item: buildItem })
    .from(codeRequestLink)
    .innerJoin(codeRequest, eq(codeRequest.id, codeRequestLink.requestId))
    .innerJoin(buildItem, eq(buildItem.id, codeRequestLink.issueId))
    .where(
      and(
        eq(codeRequestLink.buildId, b.id),
        eq(codeRequest.status, "shipped"),
        inArray(buildItem.state, ["open", "in_progress", "waiting"]),
      ),
    );
  if (rows.length === 0) return [];
  const detail = await buildDetail({ tx, services: { platform }, now: () => now }, b);
  const closed: string[] = [];
  for (const r of rows) {
    const still = r.link.stepId
      ? detail.draft?.problems.some((p) => p.stepId === r.link.stepId)
      : false;
    if (still) continue;
    await closeIssue(tx, b, r.item.id, now);
    await addRequestEvent(tx, r.request.id, {
      kind: "note",
      actor: "system",
      userId: null,
      body: { text: `A build's step validates with it now; its open item is closed.`, build: b.id },
      at: now,
    });
    closed.push(r.item.title);
  }
  return closed;
}

// ── Noticing a deploy ────────────────────────────────────────────────────────────────────────────

let checkedSha: string | null | undefined;
let checkedAt = 0;
/** Without a new commit, the pass still runs this often (a backstop for a missed tick). */
export const SHIP_BACKSTOP_MS = 15 * 60_000;

/**
 * Whether the pass is due: the first tick or request of an isolate on a commit it hasn't
 * checked, or the backstop. Marks it taken.
 */
export function shipDue(sha: string | null, now: number): boolean {
  if (checkedSha === sha && now - checkedAt < SHIP_BACKSTOP_MS) return false;
  checkedSha = sha;
  checkedAt = now;
  return true;
}

/** Tests: forget what was checked. */
export function resetShipCheck(): void {
  checkedSha = undefined;
  checkedAt = 0;
}
