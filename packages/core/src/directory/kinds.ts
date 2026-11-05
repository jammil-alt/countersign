// The directory's fixed lists (docs/plan.md §1.27), kept apart from its schemas so the contact
// schemas (api/messaging.ts) can use them without importing the rest of the directory.

import { z } from "zod";

/** What an organization is to the client; several are allowed (a vendor that is also a customer). */
export const ORGANIZATION_KINDS = ["vendor", "customer", "partner", "own", "other"] as const;
export const OrganizationKind = z.enum(ORGANIZATION_KINDS);
export type OrganizationKind = z.infer<typeof OrganizationKind>;

/** What a person is to the client. */
export const CONTACT_RELATIONSHIPS = [
  "employee",
  "contractor",
  "customer",
  "vendor",
  "partner",
  "other",
] as const;
export const Relationship = z.enum(CONTACT_RELATIONSHIPS);
export type Relationship = z.infer<typeof Relationship>;

/** Where an entry came from: by hand, a CSV, an agent's accepted suggestion, or a connector. */
export const DirectorySource = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, "a source like manual");
export type DirectorySource = z.infer<typeof DirectorySource>;

/** The connectors whose contact reads can feed the directory today (Zoho CRM and Podio). */
export const DIRECTORY_IMPORT_CONNECTORS = ["zoho_crm", "podio"] as const;
export const DirectoryImportConnector = z.enum(DIRECTORY_IMPORT_CONNECTORS);
export type DirectoryImportConnector = z.infer<typeof DirectoryImportConnector>;

export const DIRECTORY_TITLE_MAX = 120;
export const ORGANIZATION_NAME_MAX = 200;
