// v0.19 O8 (ARCHITECTURE §10.15 "Changes the owner drafts", docs/plan.md §1.117): what an owner
// learns from, turned into suggestions for the operator. Once a day per client, code (no model)
// looks at the last 14 days of each area's processes:
// - the same step corrected and tried again 3 or more times (the owner's own decisions);
// - people editing the same field of the same step before signing 3 or more times.
// Each becomes one operator item in the owner's name, with the evidence (invariant 10), and the
// operator decides in the builder. Nothing changes a process on its own (§10.15: every change is
// suggested and approved). The same suggestion is not made again for 30 days.
// G12 (docs/open.md): a client's request past the bounds of a setting, and "This is wrong
// because…" on a line of the manual, are issues whose created event names what they are about
// (`about`, setup/adjust.ts). Each becomes a suggestion too, carrying that change: the setting
// with its value now and the value asked, or the line, its decision and the person's why. Still
// only a suggestion: nothing is drafted or applied here.

import {
  type AgentBundle,
  changedFields,
  oversightFingerprint,
  readAdjustable,
  readManual,
  stepPathOf,
} from "@countersign/core";
import {
  agentVersion,
  areaOwner,
  type Db,
  externalAction,
  inboxItem,
  issue,
  issueEvent,
  oversightDecision,
  run,
  stepRun,
  type Tx,
  withTenant,
} from "@countersign/db";
import { and, eq, gte, isNotNull, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { processesOf } from "./store";

export const SIGNAL_DAYS = 14;
export const SIGNAL_MIN = 3;
export const SUGGEST_AGAIN_DAYS = 30;
export const OWNER_SUGGESTION_SUBJECT = "owner_suggestion";

export interface OwnerSignal {
  kind: "corrected" | "edited";
  agentId: string;
  /** The step, by its path in the process (a loop's index left out). */
  stepId: string;
  /** For `edited`: the field people kept changing. */
  field: string | null;
  count: number;
  /** The decisions or external actions it rests on. */
  sources: string[];
}

/** The signals of one client's processes over the last 14 days. */
export async function ownerSignals(db: Db, tenantId: string, at: Date): Promise<OwnerSignal[]> {
  const since = new Date(at.getTime() - SIGNAL_DAYS * 86_400_000);
  return withTenant(db, tenantId, async (tx) => {
    const out: OwnerSignal[] = [];
    // The owner's own corrections, step by step.
    const corrections = await tx
      .select({ id: oversightDecision.id, nodeId: oversightDecision.nodeId, agentId: run.agentId })
      .from(oversightDecision)
      .innerJoin(
        run,
        and(eq(run.id, oversightDecision.runId), eq(run.tenantId, oversightDecision.tenantId)),
      )
      .where(
        and(
          eq(oversightDecision.tenantId, tenantId),
          eq(oversightDecision.action, "retry_with"),
          eq(run.mode, "live"),
          gte(oversightDecision.createdAt, since),
        ),
      );
    const byStep = new Map<string, { agentId: string; stepId: string; ids: string[] }>();
    for (const c of corrections) {
      const stepId = stepPathOf(c.nodeId) || c.nodeId;
      const key = `${c.agentId}|${stepId}`;
      const g = byStep.get(key) ?? { agentId: c.agentId, stepId, ids: [] };
      g.ids.push(c.id);
      byStep.set(key, g);
    }
    for (const g of byStep.values()) {
      if (g.ids.length >= SIGNAL_MIN) {
        out.push({
          kind: "corrected",
          agentId: g.agentId,
          stepId: g.stepId,
          field: null,
          count: g.ids.length,
          sources: g.ids,
        });
      }
    }
    // People's edits before signing, field by field.
    const edits = await tx
      .select({
        id: externalAction.id,
        input: externalAction.input,
        edited: externalAction.editedInput,
        nodeId: stepRun.nodeId,
        agentId: run.agentId,
      })
      .from(externalAction)
      .innerJoin(
        run,
        and(eq(run.id, externalAction.runId), eq(run.tenantId, externalAction.tenantId)),
      )
      .innerJoin(
        stepRun,
        and(
          eq(stepRun.id, externalAction.stepRunId),
          eq(stepRun.tenantId, externalAction.tenantId),
        ),
      )
      .where(
        and(
          eq(externalAction.tenantId, tenantId),
          isNotNull(externalAction.editedAt),
          gte(externalAction.editedAt, since),
        ),
      );
    const byField = new Map<
      string,
      { agentId: string; stepId: string; field: string; ids: string[] }
    >();
    for (const e of edits) {
      const stepId = stepPathOf(e.nodeId) || e.nodeId;
      for (const field of changedFields(e.input, e.edited)) {
        const key = `${e.agentId}|${stepId}|${field}`;
        const g = byField.get(key) ?? { agentId: e.agentId, stepId, field, ids: [] };
        g.ids.push(e.id);
        byField.set(key, g);
      }
    }
    for (const g of byField.values()) {
      if (g.ids.length >= SIGNAL_MIN) {
        out.push({
          kind: "edited",
          agentId: g.agentId,
          stepId: g.stepId,
          field: g.field,
          count: g.ids.length,
          sources: g.ids,
        });
      }
    }
    return out;
  });
}

// ── G12: the requests that name what they are about ──────────────────────────────────────────────

/** A request past a setting's bounds, as its created event names it (setup/adjust.ts). */
const AdjustAbout = z.object({
  kind: z.literal("adjustable"),
  agentId: z.string(),
  versionId: z.string(),
  settingId: z.string(),
  asked: z.string(),
  current: z.string().nullable(),
});

/** "This is wrong because…" on a line of the manual, as its created event names it. */
const ManualAbout = z.object({
  kind: z.literal("manual_line"),
  agentId: z.string(),
  versionId: z.string().nullable(),
  section: z.string(),
  lineId: z.string().nullable(),
  decisionId: z.string().nullable(),
  line: z.string(),
  /** The person's why: requests made before G12 have it only in the issue's words. */
  because: z.string().optional(),
});

const RequestAbout = z.discriminatedUnion("kind", [AdjustAbout, ManualAbout]);

/** What an owner's suggestion from a request carries: the change it is about. */
export type OwnerRequestChange =
  | {
      kind: "setting";
      versionId: string;
      settingId: string;
      label: string;
      from: string | null;
      to: string;
    }
  | {
      kind: "manual_line";
      versionId: string | null;
      section: string;
      lineId: string | null;
      line: string;
      because: string | null;
      decision: { id: string; what: string; value: string | null } | null;
    };

export interface OwnerRequest {
  issueId: string;
  number: number;
  agentId: string;
  change: OwnerRequestChange;
}

/**
 * The client's open requests of the last 14 days that name what they are about, with that change
 * read from the version they were made on (the setting's label, the decision's words).
 */
async function ownerRequests(tx: Tx, tenantId: string, at: Date): Promise<OwnerRequest[]> {
  const since = new Date(at.getTime() - SIGNAL_DAYS * 86_400_000);
  const rows = await tx
    .select({
      id: issue.id,
      number: issue.number,
      agentId: issue.agentId,
      description: issue.description,
      about: sql<unknown>`${issueEvent.payload}->'about'`,
    })
    .from(issueEvent)
    .innerJoin(
      issue,
      and(eq(issue.id, issueEvent.issueId), eq(issue.tenantId, issueEvent.tenantId)),
    )
    .where(
      and(
        eq(issueEvent.tenantId, tenantId),
        eq(issue.tenantId, tenantId),
        eq(issueEvent.kind, "created"),
        ne(issue.stage, "closed"),
        gte(issueEvent.createdAt, since),
        sql`${issueEvent.payload}->'about'->>'kind' in ('adjustable', 'manual_line')`,
      ),
    );
  const bundles = new Map<string, AgentBundle | null>();
  const bundleOf = async (versionId: string | null): Promise<AgentBundle | null> => {
    if (!versionId) return null;
    if (!bundles.has(versionId)) {
      const [v] = await tx
        .select({ bundle: agentVersion.bundle })
        .from(agentVersion)
        .where(and(eq(agentVersion.id, versionId), eq(agentVersion.tenantId, tenantId)));
      bundles.set(versionId, (v?.bundle as AgentBundle | undefined) ?? null);
    }
    return bundles.get(versionId) ?? null;
  };
  const out: OwnerRequest[] = [];
  for (const r of rows) {
    const parsed = RequestAbout.safeParse(r.about);
    // A link that doesn't read, or names another agent than the issue's, is left to the operator.
    if (!parsed.success || !r.agentId || parsed.data.agentId !== r.agentId) continue;
    const a = parsed.data;
    const bundle = await bundleOf(a.versionId);
    if (a.kind === "adjustable") {
      const setting = readAdjustable(bundle?.definition.adjustable).find(
        (x) => x.id === a.settingId,
      );
      out.push({
        issueId: r.id,
        number: r.number,
        agentId: r.agentId,
        change: {
          kind: "setting",
          versionId: a.versionId,
          settingId: a.settingId,
          label: setting?.label ?? a.settingId,
          from: a.current,
          to: a.asked,
        },
      });
    } else {
      const found = a.decisionId
        ? readManual(bundle?.definition.manual)?.decisions.find((d) => d.id === a.decisionId)
        : undefined;
      // Before G12 the why is only in the issue's words, after "This is wrong because: ".
      const because =
        a.because ?? /This is wrong because: ([\s\S]*)$/.exec(r.description)?.[1]?.trim() ?? null;
      out.push({
        issueId: r.id,
        number: r.number,
        agentId: r.agentId,
        change: {
          kind: "manual_line",
          versionId: a.versionId,
          section: a.section,
          lineId: a.lineId,
          line: a.line,
          because: because || null,
          decision: found ? { id: found.id, what: found.what, value: found.value ?? null } : null,
        },
      });
    }
  }
  return out;
}

const quote = (text: string, max: number) =>
  text.length > max ? `"${text.slice(0, max - 1).trimEnd()}…"` : `"${text}"`;

/**
 * The day's suggestions for one client: each signal, and each request that names what it is
 * about (G12), becomes an operator item in its area owner's name, unless the same one was
 * suggested in the last 30 days. Returns how many were made.
 */
export async function ownerSuggestions(
  deps: { db: Db; catalog: Parameters<typeof processesOf>[2]["catalog"] },
  tenantId: string,
  at: Date,
): Promise<number> {
  const signals = await ownerSignals(deps.db, tenantId, at);
  return withTenant(deps.db, tenantId, async (tx) => {
    const requests = await ownerRequests(tx, tenantId, at);
    if (signals.length === 0 && requests.length === 0) return 0;
    const processes = await processesOf(tx, tenantId, { catalog: deps.catalog });
    const owners = await tx.select().from(areaOwner).where(eq(areaOwner.tenantId, tenantId));
    const since = new Date(at.getTime() - SUGGEST_AGAIN_DAYS * 86_400_000);
    const suggested = async (fingerprint: string) => {
      const [seen] = await tx
        .select({ id: inboxItem.id })
        .from(inboxItem)
        .where(
          and(
            eq(inboxItem.tenantId, tenantId),
            eq(inboxItem.subjectType, OWNER_SUGGESTION_SUBJECT),
            sql`${inboxItem.payload}->>'fingerprint' = ${fingerprint}`,
            gte(inboxItem.createdAt, since),
          ),
        )
        .limit(1);
      return !!seen;
    };
    let made = 0;
    for (const s of signals) {
      const p = processes.find((x) => x.agentId === s.agentId);
      const owner = owners.find((o) => o.area === p?.area);
      if (!p || !owner) continue;
      const fingerprint = oversightFingerprint({
        agentId: s.agentId,
        workflowSlug: "owner",
        nodeId: `${s.stepId}:${s.kind}:${s.field ?? ""}`,
        summary: "owner suggestion",
      });
      if (await suggested(fingerprint)) continue;
      const what =
        s.kind === "corrected"
          ? `I corrected the input of "${s.stepId}" ${s.count} times in ${SIGNAL_DAYS} days`
          : `people changed "${s.field}" in "${s.stepId}" before signing ${s.count} times in ${SIGNAL_DAYS} days`;
      await tx.insert(inboxItem).values({
        tenantId,
        kind: "review",
        agentId: s.agentId,
        subjectType: OWNER_SUGGESTION_SUBJECT,
        subjectId: s.agentId,
        assigneeRole: "operator",
        title: `${owner.name} suggests a change to ${p.name}: ${what}`.slice(0, 200),
        payload: {
          fingerprint,
          owner: { id: owner.id, name: owner.name, area: owner.area },
          signal: { ...s },
          // Every owner change is suggested and approved (owner, 2026-11-12): the operator
          // drafts it in the builder, and a change to the client's own settings goes to its admin.
          class: "process",
          sources: s.sources,
        },
      });
      made += 1;
    }
    for (const r of requests) {
      const p = processes.find((x) => x.agentId === r.agentId);
      const owner = owners.find((o) => o.area === p?.area);
      if (!p || !owner) continue;
      // One suggestion per request: the 30 days outlast the 14 a request is read for.
      const fingerprint = oversightFingerprint({
        agentId: r.agentId,
        workflowSlug: "owner",
        nodeId: `issue:${r.issueId}`,
        summary: "owner suggestion",
      });
      if (await suggested(fingerprint)) continue;
      const c = r.change;
      // DECISION (ARCHITECTURE §10.15, invariant 9: an owner never drafts one that loosens): a
      // value past a setting's bounds goes past the limits we set, on the looser side or on a side
      // with no order (options, schedules, a number with no stricter side: unknown is loosening,
      // as in core's `classifyChange`; a stricter one was applied at once). So it is passed on in
      // the `never` class, for the operator to decide, never drafted. A line of the manual said to
      // be wrong is a `process` suggestion, which the operator drafts in the builder, where
      // `classifyChange` labels the draft.
      const loosens = c.kind === "setting";
      const title =
        c.kind === "setting"
          ? `${owner.name} passes on request #${r.number} for ${p.name}: "${c.label}" from ${c.from ?? "its value now"} to ${c.to}, past its limits`
          : `${owner.name} suggests a change to ${p.name}: request #${r.number} says ${quote(c.decision?.what ?? c.line, 80)} is wrong`;
      await tx.insert(inboxItem).values({
        tenantId,
        kind: "review",
        agentId: r.agentId,
        subjectType: OWNER_SUGGESTION_SUBJECT,
        subjectId: r.agentId,
        assigneeRole: "operator",
        title: title.slice(0, 200),
        payload: {
          fingerprint,
          owner: { id: owner.id, name: owner.name, area: owner.area },
          request: { id: r.issueId, number: r.number },
          change: c,
          class: loosens ? "never" : "process",
          ...(loosens
            ? { reasons: ["goes past the limits we set for this setting, so it is ours to decide"] }
            : {}),
          sources: [r.issueId],
        },
      });
      made += 1;
    }
    return made;
  });
}
