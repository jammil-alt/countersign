// v0.12 W3-A: Builder conversations in the database (ARCHITECTURE §5.5, §9.6; docs/plan.md §1.51).
// `builder_session` keeps the working draft; `builder_turn` keeps every message, the labelled
// changes a turn made and the draft after it. Every function runs in the request's operator
// transaction (RLS: shared sessions in operator sessions only, a client's in its scope) and also
// checks the session is in the request's scope.

import { entryKey, undoneEntries } from "@countersign/agents";
import {
  type BuilderChange,
  type BuilderSessionView,
  BuilderTurnMeta,
  type BuilderTurnView,
  type ValidationError,
} from "@countersign/core";
import {
  type BuilderChangeEntry,
  builderSession,
  builderTurn,
  type Tx,
  tenant,
} from "@countersign/db";
import { asc, eq, max } from "drizzle-orm";
import { HttpError, iso, notFound } from "../http";

export type SessionRow = typeof builderSession.$inferSelect;
export type TurnRow = typeof builderTurn.$inferSelect;

interface Scope {
  tx: Tx;
  tenantIds: readonly string[];
}

/** The session, locked for this transaction, when it is in scope. */
export async function lockSession(ctx: Scope, id: string): Promise<SessionRow> {
  const [row] = await ctx.tx
    .select()
    .from(builderSession)
    .where(eq(builderSession.id, id))
    .for("update");
  if (!row || (row.tenantId !== null && !ctx.tenantIds.includes(row.tenantId))) {
    throw notFound("builder session");
  }
  return row;
}

export async function readSession(ctx: Scope, id: string): Promise<SessionRow> {
  const [row] = await ctx.tx.select().from(builderSession).where(eq(builderSession.id, id));
  if (!row || (row.tenantId !== null && !ctx.tenantIds.includes(row.tenantId))) {
    throw notFound("builder session");
  }
  return row;
}

export function refuseClosed(row: SessionRow): void {
  if (row.status === "closed") {
    throw new HttpError(409, "session_closed", "this conversation is closed");
  }
}

export async function turnsOf(tx: Tx, sessionId: string): Promise<TurnRow[]> {
  return tx
    .select()
    .from(builderTurn)
    .where(eq(builderTurn.sessionId, sessionId))
    .orderBy(asc(builderTurn.seq));
}

async function nextSeq(tx: Tx, sessionId: string): Promise<number> {
  const [row] = await tx
    .select({ n: max(builderTurn.seq) })
    .from(builderTurn)
    .where(eq(builderTurn.sessionId, sessionId));
  return (row?.n ?? 0) + 1;
}

export interface NewTurn {
  id?: string;
  role: "operator" | "builder";
  text: string;
  command?: string | null;
  changes?: BuilderChange[];
  bundle?: unknown;
  meta?: Partial<BuilderTurnMeta>;
  savedVersionId?: string | null;
  costUsd?: string | null;
}

/** Appends a turn (the session must be locked by the caller). */
export async function addTurn(tx: Tx, session: SessionRow, turn: NewTurn): Promise<TurnRow> {
  const [row] = await tx
    .insert(builderTurn)
    .values({
      ...(turn.id ? { id: turn.id } : {}),
      tenantId: session.tenantId,
      sessionId: session.id,
      seq: await nextSeq(tx, session.id),
      role: turn.role,
      text: turn.text.slice(0, 20_000),
      command: turn.command ?? null,
      changes: (turn.changes ?? []) as BuilderChangeEntry[],
      bundle: turn.bundle ?? null,
      meta: BuilderTurnMeta.parse(turn.meta ?? {}),
      savedVersionId: turn.savedVersionId ?? null,
      costUsd: turn.costUsd ?? "0",
    })
    .returning();
  if (!row) throw new Error("builder turn insert returned nothing");
  return row;
}

/** Updates the session's draft, status or target (the session must be locked by the caller). */
export async function updateSession(
  tx: Tx,
  id: string,
  set: Partial<Pick<SessionRow, "bundle" | "status" | "agentId" | "skillId">>,
): Promise<void> {
  await tx.update(builderSession).set(set).where(eq(builderSession.id, id));
}

/** The draft before a turn: the latest earlier turn that changed it (the first turn has the start). */
export function bundleBefore(turns: readonly TurnRow[], seq: number): unknown {
  let out: unknown = null;
  for (const t of turns) {
    if (t.seq >= seq) break;
    if (t.bundle !== null) out = t.bundle;
  }
  return out;
}

/** The version the next save builds on: the last one saved here, else the one it started from. */
export function lastSavedVersion(session: SessionRow, turns: readonly TurnRow[]): string | null {
  for (let i = turns.length - 1; i >= 0; i--) {
    const v = turns[i]?.savedVersionId;
    if (v) return v;
  }
  return session.baseVersionId;
}

export function turnView(row: TurnRow, undone: ReadonlySet<string>): BuilderTurnView {
  const meta = BuilderTurnMeta.parse(row.meta ?? {});
  return {
    id: row.id,
    seq: row.seq,
    role: row.role,
    text: row.text,
    command: row.command,
    changes: row.changes.map((c) => ({ ...c, undone: undone.has(entryKey(row.id, c.id)) })),
    questions: meta.questions,
    gaps: meta.gaps,
    notes: meta.notes,
    errors: meta.errors,
    savedVersionId: row.savedVersionId,
    costUsd: row.costUsd,
    undoneAt: iso(row.undoneAt),
    createdAt: iso(row.createdAt) as string,
  };
}

export function turnViews(rows: readonly TurnRow[]): BuilderTurnView[] {
  const undone = undoneEntries(rows);
  return rows.map((r) => turnView(r, undone));
}

export async function clientName(tx: Tx, tenantId: string | null): Promise<string | null> {
  if (!tenantId) return null;
  const [row] = await tx.select({ name: tenant.name }).from(tenant).where(eq(tenant.id, tenantId));
  return row?.name ?? null;
}

export function sessionSummary(
  row: SessionRow,
  name: string | null,
): Omit<BuilderSessionView, "bundle" | "errors" | "closest"> {
  return {
    id: row.id,
    kind: row.kind,
    clientId: row.tenantId,
    clientName: name,
    agentId: row.agentId,
    skillId: row.skillId,
    baseVersionId: row.baseVersionId,
    status: row.status,
    createdAt: iso(row.createdAt) as string,
    updatedAt: iso(row.updatedAt) as string,
  };
}

/** Errors as the turn and session views carry them. */
/** An error as the views carry it (a validation code, or a conversation's own). */
export interface CheckError {
  stepId: string | null;
  field: string;
  message: string;
  code: string;
  workflow?: string;
}

export function checkErrors(errors: readonly ValidationError[]): CheckError[] {
  return errors.map((e) => ({
    stepId: e.stepId ?? null,
    field: e.field,
    message: e.message,
    code: e.code,
    ...(e.workflow ? { workflow: e.workflow } : {}),
  }));
}
