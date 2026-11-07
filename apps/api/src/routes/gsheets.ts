// v0.14 W4-D: Google Sheets' picking (ARCHITECTURE §6.11 row 7, docs/plan.md §1.52). The client
// admin picks spreadsheets with Google's Picker on the portal's picking page; the page sends their
// ids here, each new one is checked with the connection's own grant (a spreadsheet Google opened to
// this connection, not in the bin), and the list is kept in the connection's config with the
// account that picked it. The Picker's key, the project number and the OAuth client id are public
// values Google restricts by origin; the connection's tokens never leave the Worker.

import {
  GSHEETS_CONNECTOR_ID,
  gsheetsConfigOf,
  isFileId,
  isGsheetsConnector,
  noopLogger,
  type PickedSheet,
  ReconnectRequiredError,
  SheetNotAvailableError,
  SheetsApiError,
  withPickedSheets,
} from "@countersign/connectors";
import { type GsheetsPicker, type JsonObject, routes } from "@countersign/core";
import { connection, connectionChange, type Tx } from "@countersign/db";
import { and, desc, eq } from "drizzle-orm";
import type { Hono } from "hono";
import type { Bindings } from "../env";
import { type AppEnv, HttpError, mount, type Services } from "../http";
import { reportHandled } from "../observability/report";
import { connectionCredentials } from "../secrets";
import { offeredTo } from "./connections";

type ConnectionRow = typeof connection.$inferSelect;

async function newest(tx: Tx, tenantId: string): Promise<ConnectionRow | undefined> {
  const [row] = await tx
    .select()
    .from(connection)
    .where(and(eq(connection.tenantId, tenantId), eq(connection.connector, GSHEETS_CONNECTOR_ID)))
    .orderBy(desc(connection.createdAt))
    .limit(1);
  return row;
}

/** The picked sheets a config keeps; an unreadable config has none. */
function sheetsOf(config: unknown): { address: string | null; sheets: PickedSheet[] } {
  try {
    const c = gsheetsConfigOf(config as JsonObject);
    return { address: c.address, sheets: c.sheets };
  } catch {
    return { address: null, sheets: [] };
  }
}

function pickerView(env: Bindings, row: ConnectionRow | undefined): GsheetsPicker {
  const connected = row?.status === "connected";
  const { address, sheets } = sheetsOf(row?.config ?? {});
  const developerKey = env.GOOGLE_PICKER_API_KEY?.trim() || null;
  const appId = env.GOOGLE_PROJECT_NUMBER?.trim() || null;
  const clientId = env.GOOGLE_CLIENT_ID?.trim() || null;
  return {
    available: Boolean(connected && developerKey && appId && clientId),
    connectionId: row?.id ?? null,
    account: connected ? address : null,
    developerKey,
    appId,
    clientId,
    sheets: sheets.map((s) => ({
      id: s.id,
      name: s.name,
      url: s.url,
      addedAt: s.addedAt,
      usable: address !== null && s.account === address,
    })),
  };
}

async function setSheets(
  tx: Tx,
  services: Services,
  input: { tenantId: string; actorId: string; ids: readonly string[] },
): Promise<GsheetsPicker> {
  const { tenantId } = input;
  const found = await newest(tx, tenantId);
  if (found?.status !== "connected" || !found.credentialsEncrypted) {
    throw new HttpError(409, "not_connected", "Google Sheets isn't connected");
  }
  // The row is locked until the list is stored, so two pickers at once can't drop each other's.
  const [row] = await tx
    .select()
    .from(connection)
    .where(and(eq(connection.id, found.id), eq(connection.tenantId, tenantId)))
    .for("update");
  if (row?.status !== "connected") {
    throw new HttpError(409, "not_connected", "Google Sheets isn't connected");
  }
  const ids = [...new Set(input.ids)];
  for (const id of ids) {
    if (!isFileId(id))
      throw new HttpError(400, "invalid_body", "that isn't a Google spreadsheet id");
  }
  const { address, sheets: current } = sheetsOf(row.config);
  if (!address) throw new HttpError(409, "not_connected", "connect Google Sheets again");
  const keep = current.filter((s) => s.account === address && ids.includes(s.id));
  const added = ids.filter((id) => !keep.some((s) => s.id === id));
  let described: { id: string; name: string; url: string | null }[] = [];
  if (added.length > 0) {
    const connector = services.platform.connectors.get(GSHEETS_CONNECTOR_ID);
    if (!isGsheetsConnector(connector)) {
      throw new HttpError(409, "not_available", "Google Sheets is not available here");
    }
    if (!services.env.ENCRYPTION_KEY) {
      throw new HttpError(503, "not_configured", "Google Sheets is not set up here yet");
    }
    try {
      described = await connector.describeSheets(
        {
          tenantId,
          connection: {
            id: row.id,
            tenantId,
            connector: row.connector,
            status: row.status,
            externalAccountId: row.externalAccountId,
            config: row.config as JsonObject,
            permissions: row.permissions,
          },
          credentials: await connectionCredentials(tx, services.env, row),
          logger: noopLogger,
          now: () => new Date(),
        },
        added,
      );
    } catch (error) {
      if (error instanceof SheetNotAvailableError) {
        throw new HttpError(422, "sheet_not_available", error.message);
      }
      if (error instanceof ReconnectRequiredError) {
        throw new HttpError(
          409,
          "not_connected",
          "Google ended this connection; connect Google Sheets again",
        );
      }
      if (error instanceof SheetsApiError)
        throw new HttpError(502, "connector_failed", error.message);
      reportHandled("Google Sheets picking failed", error, { connector: GSHEETS_CONNECTOR_ID });
      throw new HttpError(502, "connector_failed", "Google didn't answer; try again");
    }
  }
  const now = new Date().toISOString();
  const next: PickedSheet[] = [
    ...keep,
    ...described.map((d) => ({
      id: d.id,
      name: d.name,
      url: d.url,
      account: address,
      addedAt: now,
    })),
  ];
  const removed = current.filter((s) => !next.some((n) => n.id === s.id)).map((s) => s.id);
  const config = withPickedSheets(row.config as JsonObject, next);
  await tx
    .update(connection)
    .set({ config })
    .where(and(eq(connection.id, row.id), eq(connection.tenantId, tenantId)));
  if (added.length > 0 || removed.length > 0) {
    await tx.insert(connectionChange).values({
      tenantId,
      connectionId: row.id,
      actorId: input.actorId,
      change: { kind: "gsheets_sheets", by: "client", added, removed },
    });
  }
  return pickerView(services.env, { ...row, config });
}

export function gsheetsRoutes(app: Hono<AppEnv>): void {
  mount(app, routes.portalGsheetsPicker, async ({ tx, tenantIds, services }) => {
    const tenantId = tenantIds[0] as string;
    await offeredTo(tx, tenantId, GSHEETS_CONNECTOR_ID);
    return pickerView(services.env, await newest(tx, tenantId));
  });

  mount(app, routes.portalGsheetsSheets, async ({ tx, tenantIds, services, session, body }) => {
    const tenantId = tenantIds[0] as string;
    await offeredTo(tx, tenantId, GSHEETS_CONNECTOR_ID);
    return setSheets(tx, services, { tenantId, actorId: session.user.id, ids: body.sheetIds });
  });
}
