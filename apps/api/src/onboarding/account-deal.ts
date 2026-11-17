// Every account is in Sales (docs/cases-plan.md §3.1; docs/plan.md §1.125): a client made anywhere
// (the back office's New client, Reggie's `client_create`, a deal's set-up, Invite and Sign up now)
// is made by one route, `opsCreateClient`, and this runs in its transaction, so each new client is
// logged in Sales exactly once. The deal it is set up from (named, else the company's open New
// account deal) moves to Set up the account, the stages it passes over marked skipped; with none,
// a New account deal is opened there with the stages before it skipped ("signed up directly"). The
// company's client file (named, the deal's, the company's prospect file, else a new one) becomes
// the client's. What Set up the account wants and wasn't given becomes a to-do on Your call.

import {
  type DealStage,
  dealStageIndex,
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
    row = await openNewDealFor(tx, tenantIds, { name, fileId: file?.id ?? null });
  }

  if (!file && row?.clientFileId) file = await readFile(tx, tenantIds, row.clientFileId, true);
  if (!file) file = await prospectFileNamed(tx, name);
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
        ...(Number(row.mrr) === 0 ? { mrr: agreed } : {}),
      })
      .where(eq(deal.id, row.id));
    await addActivity(tx, row.id, {
      kind: "terms",
      actor: "operator",
      userId,
      body: `Recorded the agreed terms: ${wholeMoney(agreed, currency)} a month from ${shortDay(from)}.`,
      meta: { agreedMrr: agreed, currency, from },
    });
  }

  const [after] = await tx.select().from(deal).where(eq(deal.id, row.id));
  if (!after) throw new Error("the deal is not visible");
  const chosen = sales.chosen ?? (sales.dealId ? true : after.agentsSold.length > 0);
  await addWantedTodos(tx, after, after.company ?? name, userId, { nothingChosen: !chosen });
  return { dealId: after.id, fileId: file.id };
}
