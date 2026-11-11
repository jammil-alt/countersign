// The browser connector's platform services for one client's browser connection
// (ConnectorServices.browser, docs/plan.md §1.26): the pinned site, a fresh browser, the code
// service for this client, the connection's sign-in counters and stop, documents for downloads,
// screenshots kept as evidence and the session log. Each database read or write is its own short
// transaction for the connection's client; nothing here holds a transaction across a browser call.
// Wave 4: the client's published scripts on the connection's site (docs/plan.md §1.86).

import type {
  BrowserCodesPort,
  BrowserServices,
  BrowserTab,
  ConnectionRef,
  ContentStore,
} from "@countersign/connectors";
import {
  BrowserConnectionState,
  BrowserScriptDefinition,
  emptyBrowserState,
  FINGERPRINT_KEY,
  findingFingerprint,
  type JsonObject,
  type PublishedBrowserScript,
} from "@countersign/core";
import {
  browserScript,
  browserScriptVersion,
  connection,
  connectionChange,
  type Db,
  inboxItem,
  withTenant,
} from "@countersign/db";
import { storeDocument } from "@countersign/documents";
import { emit } from "@countersign/senses";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { z } from "zod";
import type { CodesClient } from "../codes/client";
import { pinnedSite } from "./sites";

export interface BrowserDeps {
  /**
   * A fresh browser for one site (Browser Run), kept open while idle for `keepAliveMs` when given;
   * absent where the deployment has none.
   */
  open?: (options: {
    hosts: string[];
    keepAliveMs?: number | undefined;
  }) => Promise<BrowserTab | null>;
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
          // The supervisor's fingerprint for this issue (docs/plan.md §1.28): its report finds
          // these items open and adds none of its own.
          const fingerprint = findingFingerprint({ kind: "login_stopped", connectionId: conn.id });
          for (const role of ["operator", "client_admin"] as const) {
            await tx.insert(inboxItem).values({
              tenantId,
              kind: "review",
              subjectType: BROWSER_STOP_SUBJECT,
              subjectId: conn.id,
              assigneeRole: role,
              title: "A website sign-in stopped and needs a person".slice(0, 200),
              payload: {
                [FINGERPRINT_KEY]: fingerprint,
                kind: BROWSER_STOP_SUBJECT,
                connectionId: conn.id,
                site: String((conn.config as Record<string, unknown>).site ?? ""),
                reason,
                explanation:
                  "We stopped signing in to this website until someone checks the agent account. Enter its login again on the Access page to start again.",
              },
            });
          }
          // In the stop's own transaction (the outbox pattern); the dispatcher or the cron sends it.
          await emit(tx, {
            tenantId,
            type: "connection.needs_attention",
            subjectType: "connection",
            subjectId: conn.id,
            payload: {
              connectionId: conn.id,
              connector: conn.connector,
              reason: "login_stopped",
              detail: reason.slice(0, 500),
              sourceId: null,
            },
          });
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
    script: publishedScriptFor(db, conn),
  };
}

// ── Recording and testing scripts: a sign-in allowance of their own ───────────────────────────────

/**
 * Sign-ins a day for recording and testing scripts on one connection, counted apart from the
 * agents' (the connection's caps), so a recording never uses up what the agents may spend.
 */
// DECISION: 30 a day, apart from the agents' allowance (docs/plan.md §1.86 "Scripts (wave 4)").
// A recording can't hold one browser across requests (a Worker keeps nothing between them; the
// held session lives inside one run's step), so each recorded action signs in again unless the
// site keeps its session (low tier). The failure count and the stop stay the connection's own: it
// is the same account, and two failed sign-ins in a row stop it for agents and recordings alike.
export const RECORDER_SIGN_INS_PER_DAY = 30;

const RecorderCount = z.object({ day: z.string(), signIns: z.number().int().min(0) });

/**
 * dbBrowserServices for a recording or a test: the day's sign-ins are counted under the
 * connection's `recorderState`, never its `browserState`; failures and the stop are shared.
 */
export function recorderBrowserServices(
  db: Db,
  conn: ConnectionRef,
  deps: BrowserDeps,
): BrowserServices {
  const base = dbBrowserServices(db, conn, deps);
  const tenantId = conn.tenantId;
  const mine = and(eq(connection.id, conn.id), eq(connection.tenantId, tenantId));
  return {
    ...base,
    state: {
      get: () =>
        withTenant(db, tenantId, async (tx) => {
          const [row] = await tx.select({ config: connection.config }).from(connection).where(mine);
          const config = (row?.config ?? {}) as Record<string, unknown>;
          const agents = BrowserConnectionState.safeParse(config.browserState);
          const own = RecorderCount.safeParse(config.recorderState);
          return {
            day: own.success ? own.data.day : "",
            signIns: own.success ? own.data.signIns : 0,
            failures: agents.success ? agents.data.failures : 0,
            stopped: agents.success ? agents.data.stopped : null,
          };
        }),
      put: (state) =>
        withTenant(db, tenantId, async (tx) => {
          const count = JSON.stringify({ day: state.day, signIns: state.signIns });
          const shared = JSON.stringify({ failures: state.failures, stopped: state.stopped });
          const empty = JSON.stringify(emptyBrowserState(state.day));
          await tx
            .update(connection)
            .set({
              config: sql`${connection.config} || jsonb_build_object(
                'recorderState', ${count}::jsonb,
                'browserState', coalesce(${connection.config}->'browserState', ${empty}::jsonb) || ${shared}::jsonb
              )`,
            })
            .where(mine);
        }),
      stop: base.state.stop,
    },
  };
}

// ── The tools' port: a client's published script, inside its own transaction ──────────────────────

/**
 * BrowserServices `script` for one connection: the published version of the client's script on
 * the connection's site with this slug, or null (none, a draft, or a version that no longer parses).
 */
export function publishedScriptFor(
  db: Db,
  conn: ConnectionRef,
): (slug: string) => Promise<PublishedBrowserScript | null> {
  return (slug) =>
    withTenant(db, conn.tenantId, async (tx) => {
      const [row] = await tx
        .select({ script: browserScript, version: browserScriptVersion })
        .from(browserScript)
        .innerJoin(
          browserScriptVersion,
          and(
            eq(browserScriptVersion.scriptId, browserScript.id),
            eq(browserScriptVersion.tenantId, browserScript.tenantId),
            eq(browserScriptVersion.version, browserScript.publishedVersion),
          ),
        )
        .where(
          and(
            eq(browserScript.tenantId, conn.tenantId),
            eq(browserScript.connectionId, conn.id),
            eq(browserScript.slug, slug),
            isNotNull(browserScript.publishedVersion),
          ),
        );
      if (!row) return null;
      const definition = BrowserScriptDefinition.safeParse(row.version.definition);
      if (!definition.success) return null;
      return {
        id: row.script.id,
        slug: row.script.slug,
        versionId: row.version.id,
        version: row.version.version,
        definition: definition.data,
      };
    });
}
