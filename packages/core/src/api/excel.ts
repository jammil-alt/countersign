import { z } from "zod";
import { defineRoute } from "./contract";

// §1.97: Excel's picking (ARCHITECTURE §6.11 row 10, docs/plan.md §1.97). The client admin signs in
// through the generic OAuth routes, then picks workbooks on the portal's picking page from a search
// of their own OneDrive; the picked ids are checked with the connection's own grant and kept in its
// config. Agents' workbook tools refuse any other workbook. The connection's tokens never reach the
// browser.

const CLIENT_ADMIN = ["client_admin"] as const;

/** A OneDrive item id (checked by the connector's own rule in the API). */
const WorkbookIdInput = z.string().min(1).max(200);

export const ExcelPickedWorkbook = z.object({
  id: z.string(),
  name: z.string(),
  url: z.string().nullable(),
  addedAt: z.string(),
  /** Picked by the Microsoft account connected now: only those work for agents. */
  usable: z.boolean(),
});
export type ExcelPickedWorkbook = z.infer<typeof ExcelPickedWorkbook>;

export const ExcelPicker = z.object({
  /** Connected: workbooks can be searched and picked. */
  available: z.boolean(),
  connectionId: z.string().nullable(),
  /** The connected Microsoft account. */
  account: z.string().nullable(),
  workbooks: z.array(ExcelPickedWorkbook),
});
export type ExcelPicker = z.infer<typeof ExcelPicker>;

export const ExcelSearchResult = z.object({
  id: z.string(),
  name: z.string(),
  url: z.string().nullable(),
  /** Its folder in the OneDrive (`Finance/2026`), "" at the top, null when unknown. */
  folder: z.string().nullable(),
  modifiedAt: z.string().nullable(),
});
export type ExcelSearchResult = z.infer<typeof ExcelSearchResult>;

export const ExcelWorkbooksBody = z.strictObject({
  /** Every workbook the connection should have: new ids are checked with Microsoft, missing ones dropped. */
  workbookIds: z.array(WorkbookIdInput).max(50),
});

export const excelRoutes = {
  portalExcelPicker: defineRoute({
    method: "GET",
    path: "/api/connections/excel/picker",
    auth: "session",
    roles: CLIENT_ADMIN,
    summary: "Excel: whether workbooks can be picked, and the workbooks picked so far",
    response: ExcelPicker,
  }),
  portalExcelSearch: defineRoute({
    method: "GET",
    path: "/api/connections/excel/search",
    auth: "session",
    roles: CLIENT_ADMIN,
    summary:
      "Excel: the connected person's .xlsx workbooks in their own OneDrive matching a search",
    query: z.object({ q: z.string().max(100).default("") }),
    response: z.object({ results: z.array(ExcelSearchResult) }),
  }),
  portalExcelWorkbooks: defineRoute({
    method: "PUT",
    path: "/api/connections/excel/workbooks",
    auth: "session",
    roles: CLIENT_ADMIN,
    summary:
      "Excel: set the workbooks agents may use; new ones must be .xlsx files in the connected person's OneDrive",
    body: ExcelWorkbooksBody,
    response: ExcelPicker,
  }),
} as const;
