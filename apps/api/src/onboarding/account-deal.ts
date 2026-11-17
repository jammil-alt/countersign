// Every account is in Sales (docs/cases-plan.md §3.1; docs/plan.md §1.126): a client made anywhere
// (the back office's New client, Reggie's `client_create`, a deal's set-up, Invite and Sign up now)
// is made by one route, `opsCreateClient`, and this runs in its transaction, so each new client is
// logged in Sales exactly once. The deal it is set up from (named, or the named file's open New
// account deal) moves to Set up the account, the stages it passes over marked skipped; with none,
// a New account deal is opened there with the stages before it skipped ("signed up directly"). The
// client file (named, the deal's, else a new one) becomes the client's. What Set up the account
// wants and wasn't given becomes a to-do on Your call.
//
// DECISION (review, a change to cases-plan §3.1's "else the company's open New account deal"):
// nothing is linked by name alone. A prospect's file holds what we heard about that company, and a
// file becomes the client's intake's "We think" lines, so a different company that shares the name
// must never get it. Invite and Sign up now find a same-name file or deal and show it in the
// confirmation, then name it here; New client and Reggie's `client_create` name none, so a
// same-name file or deal in Sales is left as a to-do for the operator to check and link.

import {
  type DealStage,
  dealStageIndex,
  dec,
  SIGNED_UP_DIRECTLY,
  shortDay,
  stagesBefore,
  toNumeric,
  wholeMoney,
} from "@countersign/core";
import { clientFile, deal, type Tx } from "@countersign/db";
import { eq } from "drizzle-orm";
import { HttpError } from "../http";
import { addSkippedBefore, addWantedTodos, moveDealStage } from "../work/deal-stages";
import { addActivity, type DealRow, readDeal, salesToday } from "../work/deals";
import { addTodo, closeTodosAbout } from "../work/todos-store";
import {
  type FileRow,
  linkFileToClient,
  newFile,
  openNewDealFor,
  prospectFileNamed,
  readFile,
} from "./files";

/** What `opsCreateClient`'s body may say about Sales (core's `sales`). */
export interface AccountSales {
  dealId?: string | undefined;
  fileId?: string | undefined;
  website?: string | undefined;
  title?: string | undefined;
  why?: string | undefined;
  agreedMrr?: string | undefined;
  currency?: string | undefined;
  chosen?: boolean | undefined;
}

export interface AccountInSales {
  /** The operator's scope with the new client in it (it was just made in this transaction). */
  tenantIds: readonly string[];
  clientId: string;
  name: string;
  userId: string;
  sales?: AccountSales | undefined;
}

const SETUP: DealStage = "setup";

/** Logs a new client in Sales: its deal at Set up the account and its file. Once per client. */
export async function logAccountInSales(
  tx: Tx,
  input: AccountInSales,
): Promise<{ dealId: string; fileId: string }> {
  const { tenantIds, clientId, name, userId } = input;
  const sales = input.sales ?? {};
  // A named deal moves without a reason of its own (its page says why); one found or opened here
  // was set up outside Sales: "signed up directly".
  const why = sales.why ?? (sales.dealId ? null : SIGNED_UP_DIRECTLY);
  let file: FileRow | null = sales.fileId
    ? await readFile(tx, tenantIds, sales.fileId, true)
    : null;

  let row: DealRow | null;
  if (sales.dealId) {
    row = await readDeal(tx, tenantIds, sales.dealId, true);
    if (row.kind !== "new" || row.outcome !== "open" || row.clientId) {
      throw new HttpError(409, "deal_not_open", "that deal can't take a new client");
    }
  } else {
    row = file ? await openNewDealFor(tx, tenantIds, { name, fileId: file.id }, false) : null;
  }

  if (!file && row?.clientFileId) file = await readFile(tx, tenantIds, row.clientFileId, true);
  // A same-name file or deal in Sales, when nothing was named: the operator's to check.
  const lookalike =
    !sales.dealId && !sales.fileId
      ? ((await prospectFileNamed(tx, name)) ??
        (await openNewDealFor(tx, tenantIds, { name, fileId: null })))
      : null;
  if (!file) file = await newFile(tx, { name, website: sales.website ?? null, userId });
  file = await linkFileToClient(tx, file, clientId);
  if (sales.website && !file.website) {
    await tx.update(clientFile).set({ website: sales.website }).where(eq(clientFile.id, file.id));
  }

  const by = { actor: "operator" as const, userId, why };
  if (row) {
    const set: Partial<typeof deal.$inferInsert> = { clientId, clientFileId: file.id };
    if (dealStageIndex("new", row.stage as DealStage) < dealStageIndex("new", SETUP)) {
      Object.assign(set, await moveDealStage(tx, row, SETUP, by));
    }
    await tx.update(deal).set(set).where(eq(deal.id, row.id));
    if (!sales.dealId) {
      await addActivity(tx, row.id, {
        kind: "system",
        actor: "operator",
        userId,
        body: `${name} was made a client directly.`,
        meta: { clientId },
      });
    }
  } else {
    const [made] = await tx
      .insert(deal)
      .values({
        kind: "new",
        clientId,
        company: name,
        title: sales.title ?? "New account",
        stage: SETUP,
        mrr: toNumeric(sales.agreedMrr ?? "0"),
        currency: sales.currency ?? "USD",
        source: "ops",
        clientFileId: file.id,
        createdBy: userId,
      })
      .returning();
    if (!made) throw new Error("deal insert returned nothing");
    row = made;
    await addSkippedBefore(tx, row, stagesBefore("new", SETUP), by);
    await addActivity(tx, row.id, {
      kind: "system",
      actor: "operator",
      userId,
      body: "Opened at Set up the account.",
      meta: { clientId },
    });
  }

  if (sales.agreedMrr !== undefined) {
    // DECISION: a price given with the sign-up is the agreed price from today, and the deal's
    // estimate too when it had none.
    const agreed = toNumeric(sales.agreedMrr);
    const currency = sales.currency ?? row.currency;
    const from = salesToday();
    await tx
      .update(deal)
      .set({
        agreedMrr: agreed,
        agreedFrom: from,
        currency,
        ...(dec(row.mrr).isZero() ? { mrr: agreed } : {}),
      })
      .where(eq(deal.id, row.id));
    await addActivity(tx, row.id, {
      kind: "terms",
      actor: "operator",
      userId,
      body: `Recorded the agreed terms: ${wholeMoney(agreed, currency)} a month from ${shortDay(from)}.`,
      meta: { agreedMrr: agreed, currency, from },
    });
    // A named deal's "Record X's agreed price" is done now (as opsRecordTerms closes it).
    await closeTodosAbout(tx, "deal", row.id, userId, { titlePrefix: "Record " });
  }

  if (lookalike) {
    await addTodo(tx, {
      clientId,
      owner: "operator",
      title: `Check whether ${name} is the ${name} already in Sales`,
      why: "A client was made with the name of a company in Sales. Nothing was linked; link its file if it's the same company.",
      dueAt: new Date(`${salesToday()}T23:59:59Z`),
      about: { kind: "client", id: clientId },
      source: "system",
      dedupeKey: `client:${clientId}:same-name`,
      createdBy: userId,
    });
  }

  const [after] = await tx.select().from(deal).where(eq(deal.id, row.id));
  if (!after) throw new Error("the deal is not visible");
  const chosen = sales.chosen ?? (sales.dealId ? true : after.agentsSold.length > 0);
  await addWantedTodos(tx, after, after.company ?? name, userId, { nothingChosen: !chosen });
  return { dealId: after.id, fileId: file.id };
}
