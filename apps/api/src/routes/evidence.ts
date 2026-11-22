// Round 4 D (docs/plan.md §1.211; ARCHITECTURE §10.18): the evidence on a proposed write, and the
// client's dollar thresholds.
//
// The evidence is read at once from the rows the write already left, never stored twice: the
// external action (its input or the signer's edit, its before state, the agent version), the card's
// payload (the step and the verifier's outcome), the agent version's step (its name, the steps its
// input reads and the `when` it sits under), the run's subjects (what it read) and the documents'
// readings (their confidence). The portal's copy names no agent version and shows only the
// subjects its timeline shows (invariant 11); neither side returns a prompt, model or cost.
//
// Thresholds live in `tenant.settings.write_thresholds` with a revision; every save is a
// `tenant_change` row. They only tighten the gate (packages/agents reads them at each proposal).
// The operator may only lower or add one (invariant 8: we never loosen a client's setting); the
// client admin may also raise or remove their own.

import {
  confidenceIn,
  type EvidenceSource,
  evidenceValues,
  isPlainObject,
  type OpsWriteEvidence,
  readWriteThresholds,
  evidenceRoutes as routes,
  stepsReferenced,
  type ThresholdsView,
  thresholdLooseningProblems,
  WriteThreshold,
  WriteVerification,
} from "@countersign/core";
import {
  agentVersion,
  docExtraction,
  externalAction,
  inboxItem,
  runSubject,
  stepRun,
  type Tx,
  tenant,
  tenantChange,
} from "@countersign/db";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { Hono } from "hono";
import { type AppEnv, ensureClient, HttpError, mount, notFound } from "../http";
import { portalInboxFilter } from "./portal";

const SETTING = "write_thresholds";

type Item = typeof inboxItem.$inferSelect;
interface FoundStep {
  id: string;
  name: string;
  input: unknown;
  rule: string | null;
}

/** A `when`'s rules in plain words: "entity is purchase" (a template's last field, not its path). */
function ruleWords(when: unknown): string | null {
  if (!isPlainObject(when) || !Array.isArray(when.rules)) return null;
  const parts = when.rules.flatMap((r) => {
    if (!isPlainObject(r)) return [];
    const field = String(r.field ?? "")
      .replace(/[{}\s]/g, "")
      .split(".")
      .pop();
    const op = String(r.op ?? "").replace(/_/g, " ");
    const value = typeof r.value === "string" || typeof r.value === "number" ? r.value : "";
    return field ? [`${field} ${op} ${value}`.trim()] : [];
  });
  if (parts.length === 0) return null;
  return parts.join(when.match === "any" ? " or " : " and ");
}

/** The step with this id anywhere in a bundle, with the nearest `when` above it. */
export function findStep(bundle: unknown, stepId: string): FoundStep | null {
  let found: FoundStep | null = null;
  const walk = (node: unknown, when: unknown) => {
    if (found) return;
    if (Array.isArray(node)) {
      for (const n of node) walk(n, when);
      return;
    }
    if (!isPlainObject(node)) return;
    const here = node.when ?? when;
    if (node.id === stepId && typeof node.name === "string" && typeof node.kind === "string") {
      found = { id: stepId, name: node.name, input: node.input ?? null, rule: ruleWords(here) };
      return;
    }
    for (const v of Object.values(node)) walk(v, here);
  };
  walk(bundle, null);
  return found;
}

/** The names of the steps with these ids in a bundle, in the order given. */
function stepNames(bundle: unknown, ids: string[]): { id: string; name: string }[] {
  return ids.flatMap((id) => {
    const s = findStep(bundle, id);
    return s ? [{ id, name: s.name }] : [];
  });
}

export async function evidenceFor(
  tx: Tx,
  item: Item,
  side: "portal" | "ops",
): Promise<OpsWriteEvidence> {
  const [action] = await tx
    .select()
    .from(externalAction)
    .where(and(eq(externalAction.tenantId, item.tenantId), eq(externalAction.inboxItemId, item.id)))
    .orderBy(asc(externalAction.createdAt))
    .limit(1);
  if (!action) throw new HttpError(404, "no_evidence", "this item proposes no change");
  const payload = isPlainObject(item.payload) ? item.payload : {};
  const stepId = typeof payload.stepId === "string" ? payload.stepId : null;

  let step: FoundStep | null = null;
  let from: { id: string; name: string }[] = [];
  if (action.agentVersionId && stepId) {
    const [v] = await tx
      .select({ bundle: agentVersion.bundle })
      .from(agentVersion)
      .where(
        and(eq(agentVersion.id, action.agentVersionId), eq(agentVersion.tenantId, item.tenantId)),
      );
    if (v) {
      step = findStep(v.bundle, stepId);
      from = step ? stepNames(v.bundle, stepsReferenced(step.input)) : [];
    }
  }

  const runId = action.runId;
  const subjects = runId
    ? await tx
        .select()
        .from(runSubject)
        .where(
          and(
            eq(runSubject.tenantId, item.tenantId),
            eq(runSubject.runId, runId),
            eq(runSubject.role, "read"),
            ...(side === "portal" ? [eq(runSubject.clientVisible, true)] : []),
          ),
        )
        .orderBy(asc(runSubject.createdAt))
        .limit(20)
    : [];
  const sources: EvidenceSource[] = subjects.map((s) => ({
    kind: s.kind,
    label: s.label,
    number: s.number,
    amount: s.amount,
    currency: s.currency,
    recordId: s.recordId,
  }));

  // Confidence: the run's document reading, else the producing steps' own (newest first).
  let confidence: OpsWriteEvidence["confidence"] = { value: null, basis: null };
  const docIds = subjects.flatMap((s) => (s.kind === "document" && s.recordId ? [s.recordId] : []));
  if (docIds.length > 0) {
    const [reading] = await tx
      .select({ confidence: docExtraction.confidence })
      .from(docExtraction)
      .where(
        and(eq(docExtraction.tenantId, item.tenantId), inArray(docExtraction.documentId, docIds)),
      )
      .orderBy(desc(docExtraction.createdAt))
      .limit(1);
    if (reading?.confidence) confidence = { value: reading.confidence, basis: "document" };
  }
  if (confidence.value === null && runId && from.length > 0) {
    const outputs = await tx
      .select({ nodeId: stepRun.nodeId, output: stepRun.output })
      .from(stepRun)
      .where(
        and(
          eq(stepRun.tenantId, item.tenantId),
          eq(stepRun.runId, runId),
          inArray(
            stepRun.nodeId,
            from.map((f) => f.id),
          ),
        ),
      );
    for (const f of [...from].reverse()) {
      const value = confidenceIn(outputs.find((o) => o.nodeId === f.id)?.output);
      if (value) {
        confidence = { value, basis: "step" };
        break;
      }
    }
  }

  const verification = WriteVerification.safeParse(payload.verification);
  const threshold = WriteThreshold.safeParse(payload.threshold);
  return {
    itemId: item.id,
    actionId: action.id,
    sources,
    producedBy: {
      step: step ? { id: step.id, name: step.name } : null,
      from,
      rule: step?.rule ?? null,
    },
    confidence,
    values: evidenceValues(action.editedInput ?? action.input, action.before),
    verification: verification.success ? verification.data : null,
    threshold: threshold.success ? threshold.data : null,
    agentVersionId: side === "ops" ? action.agentVersionId : null,
  };
}

async function thresholdsView(tx: Tx, tenantId: string, mayLoosen: boolean) {
  const [t] = await tx.select().from(tenant).where(eq(tenant.id, tenantId));
  if (!t) throw notFound("client");
  return { ...readWriteThresholds(t.settings), mayLoosen } satisfies ThresholdsView;
}

async function saveThresholds(
  tx: Tx,
  input: {
    tenantId: string;
    side: "operator" | "client";
    actorId: string;
    body: { thresholds: WriteThreshold[]; revision: number };
  },
) {
  const [t] = await tx.select().from(tenant).where(eq(tenant.id, input.tenantId)).for("update");
  if (!t) throw notFound("client");
  const current = readWriteThresholds(t.settings);
  if (input.body.revision !== current.revision) {
    throw new HttpError(
      409,
      "stale",
      "someone changed these amounts since you opened them; reload",
    );
  }
  const problems = thresholdLooseningProblems(current.thresholds, input.body.thresholds);
  const duplicate = problems.filter((p) => p.code === "duplicate");
  if (duplicate.length > 0) {
    throw new HttpError(422, "duplicate", "one amount per currency", duplicate);
  }
  // DECISION (§1.211): we only tighten a client's thresholds; their admin may also raise or remove
  // one (their own authorization, like a connection loosened under it).
  if (input.side === "operator" && problems.length > 0) {
    throw new HttpError(403, "loosening", "we can only lower or add a threshold", problems);
  }
  const next = { revision: current.revision + 1, thresholds: input.body.thresholds };
  await tx
    .update(tenant)
    .set({ settings: { ...t.settings, [SETTING]: next } })
    .where(eq(tenant.id, t.id));
  await tx.insert(tenantChange).values({
    tenantId: t.id,
    actorId: input.actorId,
    change: { setting: SETTING, side: input.side, from: current, to: next },
    reason: input.side === "operator" ? "thresholds lowered or added" : "thresholds changed",
  });
}

export function evidenceRouteHandlers(app: Hono<AppEnv>): void {
  mount(app, routes.portalInboxEvidence, async (ctx) => {
    const tenantId = ctx.tenantIds[0] as string;
    // Only an item the portal's inbox shows this person, in their one client (invariant 1).
    const [item] = await ctx.tx
      .select()
      .from(inboxItem)
      .where(
        and(
          eq(inboxItem.id, ctx.params.id),
          eq(inboxItem.tenantId, tenantId),
          portalInboxFilter(ctx.role, ctx.session.user.id),
        ),
      );
    if (!item) throw notFound("inbox item");
    const { agentVersionId: _ops, ...evidence } = await evidenceFor(ctx.tx, item, "portal");
    return { evidence };
  });

  mount(app, routes.opsInboxEvidence, async (ctx) => {
    const [item] = await ctx.tx
      .select()
      .from(inboxItem)
      .where(and(eq(inboxItem.id, ctx.params.id), inArray(inboxItem.tenantId, [...ctx.tenantIds])));
    if (!item) throw notFound("inbox item");
    return { evidence: await evidenceFor(ctx.tx, item, "ops") };
  });

  mount(app, routes.portalWriteThresholds, async ({ tx, tenantIds, role }) =>
    thresholdsView(tx, tenantIds[0] as string, role === "client_admin"),
  );

  mount(app, routes.portalSaveWriteThresholds, async ({ tx, tenantIds, session, body }) => {
    const tenantId = tenantIds[0] as string;
    await saveThresholds(tx, { tenantId, side: "client", actorId: session.user.id, body });
    return thresholdsView(tx, tenantId, true);
  });

  mount(app, routes.opsWriteThresholds, async (ctx) => {
    ensureClient(ctx, ctx.params.id);
    return thresholdsView(ctx.tx, ctx.params.id, false);
  });

  mount(app, routes.opsSaveWriteThresholds, async (ctx) => {
    ensureClient(ctx, ctx.params.id);
    await saveThresholds(ctx.tx, {
      tenantId: ctx.params.id,
      side: "operator",
      actorId: ctx.session.user.id,
      body: ctx.body,
    });
    return thresholdsView(ctx.tx, ctx.params.id, false);
  });
}
