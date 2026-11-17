// The client file and saved starts (docs/plan.md §1.125; docs/cases-plan.md §4.1, §4.3): operator
// only, in a transaction scoped to the clients the operator serves (a prospect's file names none).
// Facts are only added; a correction names the fact it replaces. Starts are seeded in code (General
// only, one per area with a pack, one per published template, Just the account) and archived,
// never deleted. No portal or public route returns a file, a fact or a start (invariant 11).

import { routes } from "@countersign/core";
import { clientFile } from "@countersign/db";
import { and, desc, eq, ilike, type SQL } from "drizzle-orm";
import type { Hono } from "hono";
import { type AppEnv, ensureClient, HttpError, mount } from "../http";
import {
  addFacts,
  fileDetail,
  fileOfClient,
  fileSummaries,
  filesInScope,
  linkFileToClient,
  newFile,
  pointDealAt,
  readFile,
} from "../onboarding/files";
import { createStart, listStarts, seedStarts, startView, updateStart } from "../onboarding/starts";
import { readDeal } from "../work/deals";

/** At most this many files on the list. */
const FILES_LISTED = 500;

const likeEscaped = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

export function clientFileRoutes(app: Hono<AppEnv>): void {
  mount(app, routes.opsClientFiles, async ({ tx, tenantIds, query }) => {
    const where: SQL[] = [filesInScope(tenantIds) as SQL];
    if (query.status) where.push(eq(clientFile.status, query.status));
    if (query.q) where.push(ilike(clientFile.name, likeEscaped(query.q)));
    if (query.client) {
      ensureClient({ tenantIds }, query.client);
      where.push(eq(clientFile.clientId, query.client));
    }
    const rows = await tx
      .select()
      .from(clientFile)
      .where(and(...where))
      .orderBy(desc(clientFile.updatedAt))
      .limit(FILES_LISTED);
    return { files: await fileSummaries(tx, tenantIds, rows) };
  });

  mount(app, routes.opsCreateClientFile, async ({ tx, tenantIds, body, session }) => {
    const dealRow = body.dealId ? await readDeal(tx, tenantIds, body.dealId, true) : null;
    const clientId = body.clientId ?? dealRow?.clientId ?? null;
    if (clientId) {
      ensureClient({ tenantIds }, clientId);
      if (dealRow?.clientId && dealRow.clientId !== clientId) {
        throw new HttpError(422, "other_client", "that deal is another client's");
      }
      if (await fileOfClient(tx, clientId)) {
        throw new HttpError(409, "client_has_file", "that client already has a file");
      }
    }
    const row = await newFile(tx, {
      name: body.name,
      website: body.website ?? null,
      clientId,
      userId: session.user.id,
    });
    if (dealRow) await pointDealAt(tx, dealRow, row);
    return fileDetail(tx, tenantIds, row);
  });

  mount(app, routes.opsClientFile, async ({ tx, tenantIds, params, query }) =>
    fileDetail(tx, tenantIds, await readFile(tx, tenantIds, params.id), query.history === "true"),
  );

  mount(app, routes.opsUpdateClientFile, async ({ tx, tenantIds, params, body }) => {
    let row = await readFile(tx, tenantIds, params.id, true);
    if (body.clientId) {
      ensureClient({ tenantIds }, body.clientId);
      row = await linkFileToClient(tx, row, body.clientId);
    }
    const set: Partial<typeof clientFile.$inferInsert> = {};
    if (body.name !== undefined) set.name = body.name;
    if (body.website !== undefined) set.website = body.website;
    if (body.status !== undefined && body.status !== row.status) {
      // A file is a client's once it is linked; a client's file is never a prospect's again.
      if (body.status === "client" && !row.clientId) {
        throw new HttpError(422, "no_client", "link the file to its client first");
      }
      if (body.status === "prospect" && row.clientId) {
        throw new HttpError(422, "is_client", "this file is a client's");
      }
      set.status = body.status;
    }
    if (Object.keys(set).length > 0) {
      await tx.update(clientFile).set(set).where(eq(clientFile.id, row.id));
    }
    if (body.dealId) {
      const d = await readDeal(tx, tenantIds, body.dealId, true);
      await pointDealAt(tx, d, row);
      // A client's deal and its file agree on the client.
      if (d.clientId && !row.clientId) row = await linkFileToClient(tx, row, d.clientId);
    }
    return fileDetail(tx, tenantIds, await readFile(tx, tenantIds, row.id));
  });

  mount(app, routes.opsAddClientFacts, async ({ tx, tenantIds, params, body, session }) => {
    const row = await readFile(tx, tenantIds, params.id, true);
    await addFacts(tx, row, body.facts, { actor: "operator", userId: session.user.id });
    return fileDetail(tx, tenantIds, row);
  });

  mount(app, routes.opsStarts, async ({ tx, query, services }) => {
    // Seeded on first read, once each by key: the areas and templates are the running platform's.
    await seedStarts(
      tx,
      services.platform.packs.map((p) => p.manifest.id),
    );
    return { starts: (await listStarts(tx, query.archived === "true")).map(startView) };
  });

  mount(app, routes.opsCreateStart, async ({ tx, body, session }) => ({
    start: startView(await createStart(tx, body, session.user.id)),
  }));

  mount(app, routes.opsUpdateStart, async ({ tx, params, body }) => ({
    start: startView(await updateStart(tx, params.id, body)),
  }));
}
