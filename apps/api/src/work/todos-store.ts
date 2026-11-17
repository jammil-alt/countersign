// To-dos (docs/plan.md §1.123; migration 0062), the small part every back office work stream uses:
// add one (made once per `dedupeKey`), close those about an item, and the line a record's side
// panel shows. `todo` is operator-only (RLS on `app_is_operator()` and the clients served), so
// these run in an operator's transaction.

import type { WorkTodoLine } from "@countersign/core";
import { type Tx, todo } from "@countersign/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import { iso } from "../http";

export type TodoRow = typeof todo.$inferSelect;

export interface NewTodo {
  title: string;
  owner: TodoRow["owner"];
  ownerUserId?: string | null;
  clientId?: string | null;
  detail?: string;
  why?: string | null;
  dueAt?: Date | null;
  about?: { kind: NonNullable<TodoRow["aboutKind"]>; id: string } | null;
  source?: TodoRow["source"];
  playKey?: string | null;
  read?: string | null;
  sure?: string | null;
  plan?: unknown[] | null;
  draft?: {
    to: string;
    channel: "portal" | "email" | "portal_email";
    subject?: string;
    text: string;
  } | null;
  options?: unknown[] | null;
  primaryAction?: {
    label: string;
    kind: "send_reply" | "approve_plan" | "decide" | "open" | "confirm_card" | "send_requirements";
    ref: Record<string, string>;
  } | null;
  deskItemId?: string | null;
  dedupeKey?: string | null;
  createdBy?: string | null;
}

/** True when the transaction is an operator's (the only one `todo` lets in). */
export async function inOperatorTx(tx: Tx): Promise<boolean> {
  const [row] = await tx.execute<{ on: boolean }>(sql`select app_is_operator() as on`);
  return row?.on === true;
}

/** Adds a to-do; with a `dedupeKey` it is made once (the existing one is returned). */
export async function addTodo(tx: Tx, input: NewTodo): Promise<TodoRow> {
  const values = {
    title: input.title.slice(0, 300),
    owner: input.owner,
    ownerUserId: input.ownerUserId ?? null,
    clientId: input.clientId ?? null,
    detail: (input.detail ?? "").slice(0, 4000),
    why: input.why ? input.why.slice(0, 300) : null,
    dueAt: input.dueAt ?? null,
    aboutKind: input.about?.kind ?? null,
    aboutId: input.about?.id ?? null,
    source: input.source ?? "operator",
    playKey: input.playKey ?? null,
    read: input.read ?? null,
    sure: input.sure ?? null,
    plan: input.plan ?? null,
    draft: input.draft ?? null,
    options: input.options ?? null,
    primaryAction: input.primaryAction ?? null,
    deskItemId: input.deskItemId ?? null,
    dedupeKey: input.dedupeKey ?? null,
    createdBy: input.createdBy ?? null,
  };
  if (values.dedupeKey) {
    const [made] = await tx
      .insert(todo)
      .values(values)
      .onConflictDoNothing({
        target: todo.dedupeKey,
        where: sql`${todo.dedupeKey} is not null`,
      })
      .returning();
    if (made) return made;
    const [existing] = await tx.select().from(todo).where(eq(todo.dedupeKey, values.dedupeKey));
    if (!existing) throw new Error("to-do neither made nor found");
    return existing;
  }
  const [row] = await tx.insert(todo).values(values).returning();
  if (!row) throw new Error("to-do insert returned nothing");
  return row;
}

/** Marks the open to-dos about an item done (all of them, or those whose title matches). */
export async function closeTodosAbout(
  tx: Tx,
  kind: NonNullable<TodoRow["aboutKind"]>,
  id: string,
  by: string | null,
  only?: { playKey?: string; titlePrefix?: string },
): Promise<number> {
  const rows = await tx
    .update(todo)
    .set({ state: "done", doneAt: new Date(), doneBy: by })
    .where(
      and(
        eq(todo.aboutKind, kind),
        eq(todo.aboutId, id),
        inArray(todo.state, ["open", "snoozed"]),
        ...(only?.playKey ? [eq(todo.playKey, only.playKey)] : []),
        ...(only?.titlePrefix ? [sql`${todo.title} like ${`${only.titlePrefix}%`}`] : []),
      ),
    )
    .returning({ id: todo.id });
  return rows.length;
}

/** The open to-dos about an item, for its page's side panel. */
export async function todosAbout(
  tx: Tx,
  kind: NonNullable<TodoRow["aboutKind"]>,
  id: string,
): Promise<WorkTodoLine[]> {
  const rows = await tx
    .select()
    .from(todo)
    .where(
      and(eq(todo.aboutKind, kind), eq(todo.aboutId, id), inArray(todo.state, ["open", "snoozed"])),
    )
    .orderBy(todo.dueAt, todo.createdAt)
    .limit(50);
  return rows.map(todoLine);
}

export function todoLine(r: TodoRow): WorkTodoLine {
  return { id: r.id, owner: r.owner, title: r.title, dueAt: iso(r.dueAt), state: r.state };
}
