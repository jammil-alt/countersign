import { type Connector, defineConnector } from "../connector";

/**
 * "upload": built in and always on (ARCHITECTURE §6.3, §6.5). Files a client uploads or forwards
 * become documents; a CSV of purchases becomes raw records, then transactions. It has no tools of
 * its own: agents read documents through the platform's `docs.*` tools.
 */
export const UPLOAD_CONNECTOR_ID = "upload";

export function createUploadConnector(): Connector {
  return defineConnector({
    id: UPLOAD_CONNECTOR_ID,
    name: "Upload and forwarding",
    description:
      "Upload invoices, receipts and purchase CSVs, or forward invoices from your email to your private address.",
    icon: "upload",
    auth: "none",
    entities: ["Purchase"],
    tools: [],
  });
}
