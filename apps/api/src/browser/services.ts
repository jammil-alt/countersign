// The browser connector's platform services for one client's browser connection
// (ConnectorServices.browser, docs/plan.md §1.26): the pinned site, a fresh browser, the code
// service for this client, the connection's sign-in counters and stop, documents for downloads,
// screenshots kept as evidence and the session log. Each database read or write is its own short
// transaction for the connection's client; nothing here holds a transaction across a browser call.

import type {
  BrowserCodesPort,
  BrowserServices,
  BrowserTab,
  ConnectionRef,
  ContentStore,
} from "@countersign/connectors";
import { BrowserConnectionState, type JsonObject } from "@countersign/core";
import { connection, connectionChange, type Db, inboxItem, withTenant } from "@countersign/db";
import { storeDocument } from "@countersign/documents";
import { and, eq, sql } from "drizzle-orm";
import type { CodesClient } from "../codes/client";
import { pinnedSite } from "./sites";

export interface BrowserDeps {
  /** A fresh browser for one site (Browser Run); absent where the deployment has none. */
  open?: (options: { hosts: string[] }) => Promise<BrowserTab | null>;
  /** The code service; null where `CODES` is not bound. */
  codes: CodesClient | null;
  /** Where downloads and screenshots are stored. */
  content: ContentStore;
  /** Tests pass a fast sleep for claiming codes. */
  sleep?: (ms: number) => Promise<void>;
}

/** The code service as a sign-in uses it, for one client. Codes are never logged. */
export function codesPort(codes: CodesClient, tenantId: string): BrowserCodesPort {
  return {
    openWait: (input) => codes.openWait({ ...input, tenantId }),
    claim: (input) => codes.claim({ ...input, tenantId }),
  };
}

export const BROWSER_STOP_SUBJECT = "browser_stop";

export function dbBrowserServices(db: Db, conn: ConnectionRef, deps: BrowserDeps): BrowserServices {
  const tenantId = conn.tenantId;
  const mine = and(eq(connection.id, conn.id), eq(connection.tenantId, tenantId));
  const inTenant = <T>(fn: Parameters<typeof withTenant<T>>[2]) => withTenant(db, tenantId, fn);
  return {
    site: (ref) => pinnedSite(db, ref),
    open: async (options) => (deps.open ? deps.open(options) : null),
    codes: deps.codes ? codesPort(deps.codes, tenantId) : null,
    state: {
      get: () =>
        inTenant(async (tx) => {
          const [row] = await tx.select({ config: connection.config }).from(connection).where(mine);
          const parsed = BrowserConnectionState.safeParse(
            (row?.config as Record<string, unknown> | undefined)?.browserState,
          );
          return parsed.success ? parsed.data : null;
        }),
      put: (state) =>
        inTenant(async (tx) => {
          await tx
            .update(connection)
            .set({
              config: sql`${connection.config} || ${JSON.stringify({ browserState: state })}::jsonb`,
            })
            .where(mine);
        }),
      stop: (reason) =>
        inTenant(async (tx) => {
          const [row] = await tx.select({ status: connection.status }).from(connection).where(mine);
          // Needs attention: the connection is unusable until a person checks the account and
          // enters the login again (the credentials route clears the stop).
          await tx.update(connection).set({ status: "error" }).where(mine);
          await tx.insert(connectionChange).values({
            tenantId,
            connectionId: conn.id,
            actorId: null,
            change: {
              kind: "browser_stopped",
              reason,
              before: row?.status ?? null,
              after: "error",
            },
          });
          for (const role of ["operator", "client_admin"] as const) {
            await tx.insert(inboxItem).values({
              tenantId,
              kind: "review",
              subjectType: BROWSER_STOP_SUBJECT,
              subjectId: conn.id,
              assigneeRole: role,
              title: "A website sign-in stopped and needs a person".slice(0, 200),
              payload: {
                kind: BROWSER_STOP_SUBJECT,
                connectionId: conn.id,
                site: String((conn.config as Record<string, unknown>).site ?? ""),
                reason,
                explanation:
                  "We stopped signing in to this website until someone checks the agent account. Enter its login again on the Access page to start again.",
              },
            });
          }
        }),
    },
    storeDocument: (file) =>
      inTenant(async (tx) => {
        const stored = await storeDocument(tx, deps.content, {
          tenantId,
          source: "connector",
          connectionId: conn.id,
          bytes: file.bytes,
          filename: file.filename,
          mimeType: file.mimeType,
          meta: {
            via: "browser",
            site: String((conn.config as Record<string, unknown>).site ?? ""),
            sourceUrl: file.sourceUrl,
          },
        });
        // `document.received` is in the outbox; the dispatcher (or the next cron tick) sends it.
        return { documentId: stored.document.id, created: stored.created };
      }),
    async saveScreenshot(png) {
      const stored = await deps.content.put({
        tenantId,
        bytes: png,
        contentType: "image/png",
        metadata: { kind: "browser_evidence", connectionId: conn.id },
      });
      return stored.key;
    },
    record: (session) =>
      inTenant(async (tx) => {
        await tx.insert(connectionChange).values({
          tenantId,
          connectionId: conn.id,
          actorId: null,
          change: { kind: "browser_session", ...session } as unknown as JsonObject,
        });
      }),
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
  };
}
