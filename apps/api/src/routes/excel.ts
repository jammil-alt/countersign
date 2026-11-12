// §1.97: Excel's picking (ARCHITECTURE §6.11 row 10, docs/plan.md §1.97), as Google Sheets'
// (./gsheets.ts). The client admin searches their own OneDrive for .xlsx workbooks and picks some;
// each new one is checked with the connection's own grant (an .xlsx file in the signed-in person's
// drive) and the list is kept in the connection's config with the account (address and directory)
// that picked it. The connection's tokens never leave the Worker.

import {
  EXCEL_CONNECTOR_ID,
  type ExcelConfig,
  excelConfigOf,
  isExcelConnector,
  isExcelItemId,
  MicrosoftApiError,
  noopLogger,
  type PickedWorkbook,
  ReconnectRequiredError,
  WorkbookNotAvailableError,
  withPickedWorkbooks,
} from "@countersign/connectors";
import { type ExcelPicker, type JsonObject, routes } from "@countersign/core";
import { connection, connectionChange, type Tx } from "@countersign/db";
import { and, desc, eq } from "drizzle-orm";
import type { Hono } from "hono";
import { type AppEnv, HttpError, mount, type Services } from "../http";
import { reportHandled } from "../observability/report";
import { connectionCredentials } from "../secrets";
import { offeredTo } from "./connections";

type ConnectionRow = typeof connection.$inferSelect;

async function newest(tx: Tx, tenantId: string): Promise<ConnectionRow | undefined> {
  const [row] = await tx
    .select()
    .from(connection)
    .where(and(eq(connection.tenantId, tenantId), eq(connection.connector, EXCEL_CONNECTOR_ID)))
    .orderBy(desc(connection.createdAt))
    .limit(1);
  return row;
}

/** The config's account and picked workbooks; an unreadable config has none. */
function configOf(config: unknown): ExcelConfig | null {
  try {
    return excelConfigOf(config as JsonObject);
  } catch {
    return null;
  }
}

function pickerView(row: ConnectionRow | undefined): ExcelPicker {
  const connected = row?.status === "connected";
  const config = configOf(row?.config ?? {});
  return {
    available: Boolean(connected && config),
    connectionId: row?.id ?? null,
    account: connected ? (config?.address ?? null) : null,
    workbooks: (config?.workbooks ?? []).map((w) => ({
      id: w.id,
      name: w.name,
      url: w.url,
      addedAt: w.addedAt,
      usable: config !== null && w.account === config.address && w.tid === config.tid,
    })),
  };
}

async function connected(tx: Tx, tenantId: string, lock: boolean): Promise<ConnectionRow> {
  const found = await newest(tx, tenantId);
  if (found?.status !== "connected" || !found.credentialsEncrypted) {
    throw new HttpError(409, "not_connected", "Excel isn't connected");
  }
  if (!lock) return found;
  // The row is locked until the list is stored, so two pickers at once can't drop each other's.
  const [row] = await tx
    .select()
    .from(connection)
    .where(and(eq(connection.id, found.id), eq(connection.tenantId, tenantId)))
    .for("update");
  if (row?.status !== "connected")
    throw new HttpError(409, "not_connected", "Excel isn't connected");
  return row;
}

async function contextFor(tx: Tx, services: Services, row: ConnectionRow) {
  if (!services.env.ENCRYPTION_KEY) {
    throw new HttpError(503, "not_configured", "Excel is not set up here yet");
  }
  return {
    tenantId: row.tenantId,
    connection: {
      id: row.id,
      tenantId: row.tenantId,
      connector: row.connector,
      status: row.status,
      externalAccountId: row.externalAccountId,
      config: row.config as JsonObject,
      permissions: row.permissions,
    },
    credentials: await connectionCredentials(tx, services.env, row),
    logger: noopLogger,
    now: () => new Date(),
  };
}

function connectorOf(services: Services) {
  const connector = services.platform.connectors.get(EXCEL_CONNECTOR_ID);
  if (!isExcelConnector(connector)) {
    throw new HttpError(409, "not_available", "Excel is not available here");
  }
  return connector;
}

function microsoftFailed(error: unknown): never {
  if (error instanceof WorkbookNotAvailableError) {
    throw new HttpError(422, "workbook_not_available", error.message);
  }
  if (error instanceof ReconnectRequiredError) {
    throw new HttpError(
      409,
      "not_connected",
      "Microsoft ended this connection; connect Excel again",
    );
  }
  if (error instanceof MicrosoftApiError)
    throw new HttpError(502, "connector_failed", error.message);
  reportHandled("Excel picking failed", error, { connector: EXCEL_CONNECTOR_ID });
  throw new HttpError(502, "connector_failed", "Microsoft didn't answer; try again");
}

async function setWorkbooks(
  tx: Tx,
  services: Services,
  input: { tenantId: string; actorId: string; ids: readonly string[] },
): Promise<ExcelPicker> {
  const row = await connected(tx, input.tenantId, true);
  const ids = [...new Set(input.ids)];
  for (const id of ids) {
    if (!isExcelItemId(id))
      throw new HttpError(400, "invalid_body", "that isn't a OneDrive file id");
  }
  const config = configOf(row.config);
  if (!config) throw new HttpError(409, "not_connected", "connect Excel again");
  const current = config.workbooks;
  const keep = current.filter(
    (w) => w.account === config.address && w.tid === config.tid && ids.includes(w.id),
  );
  const added = ids.filter((id) => !keep.some((w) => w.id === id));
  let described: { id: string; name: string; url: string | null }[] = [];
  if (added.length > 0) {
    const connector = connectorOf(services);
    try {
      described = await connector.describeWorkbooks(await contextFor(tx, services, row), added);
    } catch (error) {
      microsoftFailed(error);
    }
  }
  const now = new Date().toISOString();
  const next: PickedWorkbook[] = [
    ...keep,
    ...described.map((d) => ({
      id: d.id,
      name: d.name,
      url: d.url,
      account: config.address,
      tid: config.tid,
      addedAt: now,
    })),
  ];
  const removed = current.filter((w) => !next.some((n) => n.id === w.id)).map((w) => w.id);
  const nextConfig = withPickedWorkbooks(row.config as JsonObject, next);
  await tx
    .update(connection)
    .set({ config: nextConfig })
    .where(and(eq(connection.id, row.id), eq(connection.tenantId, input.tenantId)));
  if (added.length > 0 || removed.length > 0) {
    await tx.insert(connectionChange).values({
      tenantId: input.tenantId,
      connectionId: row.id,
      actorId: input.actorId,
      change: { kind: "excel_workbooks", by: "client", added, removed },
    });
  }
  return pickerView({ ...row, config: nextConfig });
}

export function excelRoutes(app: Hono<AppEnv>): void {
  mount(app, routes.portalExcelPicker, async ({ tx, tenantIds }) => {
    const tenantId = tenantIds[0] as string;
    await offeredTo(tx, tenantId, EXCEL_CONNECTOR_ID);
    return pickerView(await newest(tx, tenantId));
  });

  mount(app, routes.portalExcelSearch, async ({ tx, tenantIds, services, query }) => {
    const tenantId = tenantIds[0] as string;
    await offeredTo(tx, tenantId, EXCEL_CONNECTOR_ID);
    const row = await connected(tx, tenantId, false);
    const connector = connectorOf(services);
    try {
      const results = await connector.searchWorkbooks(
        await contextFor(tx, services, row),
        query.q.trim(),
      );
      return { results };
    } catch (error) {
      microsoftFailed(error);
    }
  });

  mount(app, routes.portalExcelWorkbooks, async ({ tx, tenantIds, services, session, body }) => {
    const tenantId = tenantIds[0] as string;
    await offeredTo(tx, tenantId, EXCEL_CONNECTOR_ID);
    return setWorkbooks(tx, services, {
      tenantId,
      actorId: session.user.id,
      ids: body.workbookIds,
    });
  });
}
