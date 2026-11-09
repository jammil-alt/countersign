// The back office's chart of accounts (docs/plan.md §1.79; owner, 2026-11-08: "full control, always
// behind an approval gate"). GET answers a client's ledger per accounting connection: accounts with
// what each is for, classes and locations, each with the version last synced. POST adds or changes
// one of them in the client's tool: the operator signs it as they make it (the back office shows
// the change and asks "Sign and save" first), so it is recorded as an external action they approved
// and run once through the connection's always-signed tool (signed-writes.ts), its before state
// captured and a stale version refused. Afterwards the connection syncs, so the ledger catches up.

import { connectionLabel, LEDGER_CHANGE_TOOLS, routes } from "@countersign/core";
import {
  connection,
  ledgerAccount,
  ledgerAccountNote,
  ledgerDimension,
  rawRecord,
} from "@countersign/db";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { Hono } from "hono";
import { type AppEnv, ensureClient, HttpError, mount, notFound } from "../http";
import { signedWriteFor } from "../signed-writes";
import { qboSyncFor, startQboSync } from "./qbo";

const PERSON_FIRST = { client: 0, operator: 1, agent: 2 } as const;

export function ledgerRoutes(app: Hono<AppEnv>): void {
  mount(app, routes.opsClientLedger, async (ctx) => {
    const { tx, params } = ctx;
    ensureClient(ctx, params.id);
    const tenantId = params.id;
    const accounts = await tx
      .select({ a: ledgerAccount, version: rawRecord.externalVersion })
      .from(ledgerAccount)
      .leftJoin(
        rawRecord,
        and(
          eq(rawRecord.id, ledgerAccount.rawRecordId),
          eq(rawRecord.tenantId, ledgerAccount.tenantId),
        ),
      )
      .where(eq(ledgerAccount.tenantId, tenantId))
      .orderBy(asc(ledgerAccount.fullName), asc(ledgerAccount.id));
    const dimensions = await tx
      .select({ d: ledgerDimension, version: rawRecord.externalVersion })
      .from(ledgerDimension)
      .leftJoin(
        rawRecord,
        and(
          eq(rawRecord.id, ledgerDimension.rawRecordId),
          eq(rawRecord.tenantId, ledgerDimension.tenantId),
        ),
      )
      .where(eq(ledgerDimension.tenantId, tenantId))
      .orderBy(asc(ledgerDimension.kind), asc(ledgerDimension.fullName));
    const notes = accounts.length
      ? await tx
          .select()
          .from(ledgerAccountNote)
          .where(
            and(
              eq(ledgerAccountNote.tenantId, tenantId),
              inArray(
                ledgerAccountNote.ledgerAccountId,
                accounts.map(({ a }) => a.id),
              ),
            ),
          )
          .orderBy(desc(ledgerAccountNote.createdAt))
      : [];
    const ids = [
      ...new Set([
        ...accounts.map(({ a }) => a.connectionId),
        ...dimensions.map(({ d }) => d.connectionId),
      ]),
    ];
    const conns = ids.length
      ? await tx
          .select()
          .from(connection)
          .where(and(eq(connection.tenantId, tenantId), inArray(connection.id, ids)))
          .orderBy(asc(connection.createdAt))
      : [];
    // A version the sync read: QuickBooks' SyncToken, or none for a record it saw deleted.
    const token = (v: string | null) => (v && /^\d+$/.test(v) ? v : null);
    return {
      ledgers: conns.map((c) => ({
        connectionId: c.id,
        connector: c.connector,
        accountName: connectionLabel(c.config, c.externalAccountId),
        status: c.status,
        lastSyncAt: c.lastSyncAt?.toISOString() ?? null,
        accounts: accounts
          .filter(({ a }) => a.connectionId === c.id)
          .map(({ a, version }) => ({
            id: a.id,
            externalId: a.externalId,
            name: a.name,
            fullName: a.fullName,
            number: a.number,
            classification: a.classification,
            kind: a.kind,
            type: a.accountType,
            subType: a.accountSubType,
            description: a.description,
            parentExternalId: a.parentExternalId,
            active: a.active,
            syncToken: token(version),
            notes: notes
              .filter((n) => n.ledgerAccountId === a.id)
              .sort((x, y) => PERSON_FIRST[x.source] - PERSON_FIRST[y.source])
              .slice(0, 5)
              .map((n) => ({ note: n.note, source: n.source })),
          })),
        dimensions: dimensions
          .filter(({ d }) => d.connectionId === c.id)
          .map(({ d, version }) => ({
            id: d.id,
            kind: d.kind,
            externalId: d.externalId,
            name: d.name,
            fullName: d.fullName,
            parentExternalId: d.parentExternalId,
            active: d.active,
            syncToken: token(version),
          })),
      })),
    };
  });

  mount(app, routes.opsClientLedgerChange, async (ctx) => {
    const { tx, params, body, services, session } = ctx;
    ensureClient(ctx, params.id);
    const [conn] = await tx
      .select({ id: connection.id, connector: connection.connector, status: connection.status })
      .from(connection)
      .where(and(eq(connection.tenantId, params.id), eq(connection.id, body.connectionId)));
    if (!conn) throw notFound("connection");
    if (conn.status !== "connected") {
      throw new HttpError(
        409,
        "not_connected",
        "the accounting tool isn't connected; ask the client to sign in again",
      );
    }
    if (!(LEDGER_CHANGE_TOOLS as readonly string[]).includes(body.tool)) throw notFound("change");
    // DECISION: the person signs as they make the change (the back office shows it first), the
    // same signed write a published guide is (M46): an external action they approved, run once.
    const outcome = await signedWriteFor(services, {
      tenantId: params.id,
      userId: session.user.id,
    })({
      connectionId: conn.id,
      tool: body.tool,
      input: body.input,
      idempotencyKey: `ledger:${body.requestId}`,
      title: "Change the chart of accounts",
    });
    if (outcome.status === "failed") {
      return { status: "failed" as const, output: null, error: outcome.error };
    }
    // The ledger catches up with QuickBooks' answer (its new version) on a sync of the connection.
    if (conn.connector === "qbo") {
      ctx.defer(() =>
        startQboSync(services.db, qboSyncFor(services.deps, services.env), {
          tenantId: params.id,
          connectionId: conn.id,
          reason: "operator",
        }),
      );
    }
    return {
      status: "done" as const,
      output: (outcome.output ?? null) as Record<string, unknown> | null,
      error: null,
    };
  });
}
