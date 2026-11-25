// The Dev queue's two loud moments (docs/plan.md §1.125): a request accepted ("DQ-012 approved:
// <title>. Building it next.") and a request shipped ("DQ-012 is on staging: <part>. 2 builds
// waiting on it can go on."). Each goes to every operator by email through Mezonas' mail, as a
// to-do about the request on Your call (the back office's list of what is ours), and as a message
// in each linked build's conversation; then a `notified` event. The words carry no client data:
// only the number, the title, the part and a link (docs/plan.md, "Notifications never carry record
// content"). Run in a scope over every client: it is the system telling every operator, and the
// builds waiting may be any client's.

import { dqNumber } from "@countersign/core";
import {
  activeClient,
  appUser,
  build,
  codeRequest,
  codeRequestLink,
  type Db,
  membership,
  type Tx,
  tenant,
  withOperator,
} from "@countersign/db";
import { eq, inArray } from "drizzle-orm";
import { addMessage } from "../build/store";
import type { NotifyDeps } from "../notify/outbox";
import { reportHandled } from "../observability/report";
import { devQueueHref } from "../work/todos";
import { addTodo } from "../work/todos-store";
import { addRequestEvent } from "./store";

export type Moment =
  | { kind: "accepted" }
  | { kind: "shipped"; part: string; environment: "staging" | "production" };

/** Work in an operator scope over every client that isn't retired. */
// DECISION: the system's notices run over every client, as the cron's passes do one by one: an
// operator serves every client (add-operator), and a build waiting on a request may be any
// client's. The words name no client.
export async function asSystem<T>(db: Db, work: (tx: Tx) => Promise<T>): Promise<T> {
  const clients = await db.select({ id: tenant.id }).from(tenant).where(activeClient());
  return withOperator(
    db,
    clients.map((c) => c.id),
    work,
  );
}

/** Every operator's address: whoever has an operator membership. */
export async function operatorAddresses(tx: Tx): Promise<{ userId: string; email: string }[]> {
  return tx
    .selectDistinct({ userId: appUser.id, email: appUser.email })
    .from(membership)
    .innerJoin(appUser, eq(appUser.id, membership.userId))
    .where(eq(membership.role, "operator"));
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The sentence a moment says, everywhere it is said. */
export function momentText(
  r: { number: number; title: string },
  moment: Moment,
  waiting: number,
): string {
  const ref = dqNumber(r.number);
  if (moment.kind === "accepted") return `${ref} approved: ${r.title}. Building it next.`;
  const where = moment.environment === "production" ? "in production" : "on staging";
  return `${ref} is ${where}: ${moment.part}. ${plural(waiting, "build")} waiting on it can go on.`;
}

/**
 * Tells everyone. `tellBuilds` false when the caller posts its own message in each build (the
 * ship pass, which proposes the swap there).
 */
export async function notifyRequest(
  db: Db,
  deps: Pick<NotifyDeps, "mailer" | "origin">,
  requestId: string,
  moment: Moment,
  options: { at: Date; tellBuilds?: boolean },
): Promise<{ emails: number; builds: number }> {
  const prep = await asSystem(db, async (tx) => {
    const [row] = await tx.select().from(codeRequest).where(eq(codeRequest.id, requestId));
    if (!row) return null;
    const links = await tx
      .select({ buildId: codeRequestLink.buildId, issueId: codeRequestLink.issueId })
      .from(codeRequestLink)
      .where(eq(codeRequestLink.requestId, row.id));
    const buildIds = [...new Set(links.map((l) => l.buildId))];
    const text = momentText(row, moment, buildIds.length);
    const ref = dqNumber(row.number);
    await addTodo(tx, {
      owner: "operator",
      title: text,
      detail:
        moment.kind === "accepted"
          ? "Accepted in the Dev queue. A Claude Code session or the daily task builds it next."
          : "Shipped. The builds waiting on it have the Builder's proposal to put it in.",
      about: { kind: "code_request", id: row.id },
      source: "system",
      primaryAction: { label: `Open ${ref}`, kind: "open", ref: { id: row.id } },
      dedupeKey: `dq:${row.id}:${moment.kind}${moment.kind === "shipped" ? `:${moment.environment}` : ""}`,
    });
    if (options.tellBuilds !== false && buildIds.length > 0) {
      const rows = await tx.select().from(build).where(inArray(build.id, buildIds));
      for (const b of rows) {
        const issue = links.find((l) => l.buildId === b.id && l.issueId)?.issueId;
        await addMessage(tx, b, {
          role: "builder",
          text,
          meta: {
            codeRequest: { id: row.id, ref },
            ...(issue ? { about: `item:${issue}` } : {}),
          },
        });
      }
    }
    return {
      row,
      text,
      ref,
      builds: buildIds.length,
      to: deps.mailer.isConfigured ? await operatorAddresses(tx) : [],
    };
  });
  if (!prep) return { emails: 0, builds: 0 };
  const link = `${deps.origin}${devQueueHref(prep.ref)}`;
  let emails = 0;
  for (const person of prep.to) {
    try {
      await deps.mailer.send({
        to: person.email,
        subject: prep.text.split(". ")[0]?.slice(0, 150) ?? prep.ref,
        text: `${prep.text}\n\nOpen it in the Dev queue: ${link}\n`,
        idempotencyKey: `dq-${prep.row.id}-${moment.kind}-${person.userId}`,
      });
      emails++;
    } catch (error) {
      // Named by the request and the moment, never the person's address.
      reportHandled(`Dev queue notice ${prep.ref} (${moment.kind}) failed to send`, error, {
        job: "dev_queue",
      });
    }
  }
  await asSystem(db, (tx) =>
    addRequestEvent(tx, prep.row.id, {
      kind: "notified",
      actor: "system",
      userId: null,
      body: {
        moment: moment.kind,
        ...(moment.kind === "shipped" ? { environment: moment.environment } : {}),
        emails,
        builds: prep.builds,
        text: prep.text,
      },
      at: options.at,
    }),
  );
  return { emails, builds: prep.builds };
}
