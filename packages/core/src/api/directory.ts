// The directory's routes (docs/plan.md §1.27). The client admin and the operator edit it fully;
// client users read it. People are edited through the contact routes (api/messaging.ts), which
// carry the directory's fields; organizations, the vendor link, imports and agents' suggestions
// are here. The operator's twins live under /api/ops/clients/:id/directory.

import { z } from "zod";
import { OrganizationKind, Relationship } from "../directory/kinds";
import {
  ConnectorPreviewBody,
  CsvPreviewBody,
  DirectoryEntryType,
  DirectorySuggestion,
  ImportApplyBody,
  ImportPreview,
  ImportResult,
  ImportSource,
  Organization,
  OrganizationCreate,
  OrganizationPatch,
} from "../directory/schemas";
import { isUuid } from "../ids";
import { RoleName } from "../reach/rules";
import { defineRoute } from "./contract";
import { Contact } from "./messaging";

const Id = z.string().refine((v) => isUuid(v), "not an id");
const OPS = ["operator"] as const;
const CLIENT_ADMIN = ["client_admin"] as const;
const CLIENT = ["client_admin", "client_user"] as const;

/** The directory's list: words and filters, as the screens send them in the query string. */
export const DirectoryListQuery = z.object({
  q: z.string().trim().max(200).optional(),
  type: DirectoryEntryType.optional(),
  relationship: Relationship.optional(),
  kind: OrganizationKind.optional(),
  role: RoleName.optional(),
  organizationId: Id.optional(),
});
export type DirectoryListQuery = z.input<typeof DirectoryListQuery>;

export const DIRECTORY_LIST_MAX = 500;

export const DirectoryList = z.object({
  people: z.array(Contact),
  organizations: z.array(Organization),
  /** Agents' suggestions waiting for the client admin. */
  pendingSuggestions: z.number().int(),
});
export type DirectoryList = z.infer<typeof DirectoryList>;

export const SuggestionResolveBody = z.strictObject({
  decision: z.enum(["approve", "reject"]),
  note: z.string().trim().max(2000).optional(),
});
export type SuggestionResolveBody = z.input<typeof SuggestionResolveBody>;

export const SuggestionsQuery = z.object({ status: z.enum(["open", "all"]).optional() });

const ClientParams = z.object({ id: Id });
const OpsOrgParams = z.object({ id: Id, organizationId: Id });
const OpsSuggestionParams = z.object({ id: Id, suggestionId: Id });
const OneOrganization = z.object({ organization: Organization });
const Suggestions = z.object({ items: z.array(DirectorySuggestion) });
const OneSuggestion = z.object({ suggestion: DirectorySuggestion });
const Sources = z.object({ sources: z.array(ImportSource) });

export const directoryRoutes = {
  // ── Portal ──
  portalDirectory: defineRoute({
    method: "GET",
    path: "/api/directory",
    auth: "session",
    roles: CLIENT,
    summary: "Your directory: people and organizations, by words and filters",
    query: DirectoryListQuery,
    response: DirectoryList,
  }),
  portalOrganizationCreate: defineRoute({
    method: "POST",
    path: "/api/directory/organizations",
    auth: "session",
    roles: CLIENT_ADMIN,
    summary: "Add an organization",
    body: OrganizationCreate,
    response: OneOrganization,
  }),
  portalOrganizationUpdate: defineRoute({
    method: "PATCH",
    path: "/api/directory/organizations/:id",
    auth: "session",
    roles: CLIENT_ADMIN,
    summary: "Edit an organization",
    params: ClientParams,
    body: OrganizationPatch,
    response: OneOrganization,
  }),
  portalOrganizationLinkVendor: defineRoute({
    method: "POST",
    path: "/api/directory/organizations/:id/vendor",
    auth: "session",
    roles: CLIENT_ADMIN,
    summary: "Link an organization to its vendor record, made from its name if there is none",
    params: ClientParams,
    response: OneOrganization,
  }),
  portalOrganizationUnlinkVendor: defineRoute({
    method: "DELETE",
    path: "/api/directory/organizations/:id/vendor",
    auth: "session",
    roles: CLIENT_ADMIN,
    summary: "Unlink an organization from its vendor record",
    params: ClientParams,
    response: OneOrganization,
  }),
  portalDirectoryImportSources: defineRoute({
    method: "GET",
    path: "/api/directory/import/sources",
    auth: "session",
    roles: CLIENT_ADMIN,
    summary: "The connected tools the directory can import from",
    response: Sources,
  }),
  portalDirectoryImportCsv: defineRoute({
    method: "POST",
    path: "/api/directory/import/csv",
    auth: "session",
    roles: CLIENT_ADMIN,
    summary: "Preview a CSV of people or organizations: what each row would do",
    body: CsvPreviewBody,
    response: ImportPreview,
  }),
  portalDirectoryImportConnector: defineRoute({
    method: "POST",
    path: "/api/directory/import/connector",
    auth: "session",
    roles: CLIENT_ADMIN,
    summary: "Read people or organizations from Zoho CRM or Podio, as suggestions to accept",
    body: ConnectorPreviewBody,
    response: ImportPreview,
  }),
  portalDirectoryImportApply: defineRoute({
    method: "POST",
    path: "/api/directory/import/apply",
    auth: "session",
    roles: CLIENT_ADMIN,
    summary: "Apply the chosen import rows, with a result per row",
    body: ImportApplyBody,
    response: ImportResult,
  }),
  portalDirectorySuggestions: defineRoute({
    method: "GET",
    path: "/api/directory/suggestions",
    auth: "session",
    roles: CLIENT_ADMIN,
    summary: "Agents' suggestions for the directory",
    query: SuggestionsQuery,
    response: Suggestions,
  }),
  portalDirectorySuggestionResolve: defineRoute({
    method: "POST",
    path: "/api/directory/suggestions/:id",
    auth: "session",
    roles: CLIENT_ADMIN,
    summary: "Accept or decline an agent's suggestion",
    params: ClientParams,
    body: SuggestionResolveBody,
    response: OneSuggestion,
  }),

  // ── Back office ──
  opsDirectory: defineRoute({
    method: "GET",
    path: "/api/ops/clients/:id/directory",
    auth: "session",
    roles: OPS,
    summary: "A client's directory: people and organizations, by words and filters",
    params: ClientParams,
    query: DirectoryListQuery,
    response: DirectoryList,
  }),
  opsOrganizationCreate: defineRoute({
    method: "POST",
    path: "/api/ops/clients/:id/directory/organizations",
    auth: "session",
    roles: OPS,
    summary: "Add an organization to a client's directory",
    params: ClientParams,
    body: OrganizationCreate,
    response: OneOrganization,
  }),
  opsOrganizationUpdate: defineRoute({
    method: "PATCH",
    path: "/api/ops/clients/:id/directory/organizations/:organizationId",
    auth: "session",
    roles: OPS,
    summary: "Edit an organization in a client's directory",
    params: OpsOrgParams,
    body: OrganizationPatch,
    response: OneOrganization,
  }),
  opsOrganizationLinkVendor: defineRoute({
    method: "POST",
    path: "/api/ops/clients/:id/directory/organizations/:organizationId/vendor",
    auth: "session",
    roles: OPS,
    summary: "Link an organization to its vendor record, made from its name if there is none",
    params: OpsOrgParams,
    response: OneOrganization,
  }),
  opsOrganizationUnlinkVendor: defineRoute({
    method: "DELETE",
    path: "/api/ops/clients/:id/directory/organizations/:organizationId/vendor",
    auth: "session",
    roles: OPS,
    summary: "Unlink an organization from its vendor record",
    params: OpsOrgParams,
    response: OneOrganization,
  }),
  opsDirectoryImportSources: defineRoute({
    method: "GET",
    path: "/api/ops/clients/:id/directory/import/sources",
    auth: "session",
    roles: OPS,
    summary: "The client's connected tools the directory can import from",
    params: ClientParams,
    response: Sources,
  }),
  opsDirectoryImportCsv: defineRoute({
    method: "POST",
    path: "/api/ops/clients/:id/directory/import/csv",
    auth: "session",
    roles: OPS,
    summary: "Preview a CSV of people or organizations for a client",
    params: ClientParams,
    body: CsvPreviewBody,
    response: ImportPreview,
  }),
  opsDirectoryImportConnector: defineRoute({
    method: "POST",
    path: "/api/ops/clients/:id/directory/import/connector",
    auth: "session",
    roles: OPS,
    summary: "Read people or organizations from the client's Zoho CRM or Podio",
    params: ClientParams,
    body: ConnectorPreviewBody,
    response: ImportPreview,
  }),
  opsDirectoryImportApply: defineRoute({
    method: "POST",
    path: "/api/ops/clients/:id/directory/import/apply",
    auth: "session",
    roles: OPS,
    summary: "Apply the chosen import rows to a client's directory",
    params: ClientParams,
    body: ImportApplyBody,
    response: ImportResult,
  }),
  opsDirectorySuggestions: defineRoute({
    method: "GET",
    path: "/api/ops/clients/:id/directory/suggestions",
    auth: "session",
    roles: OPS,
    summary: "Agents' suggestions for a client's directory",
    params: ClientParams,
    query: SuggestionsQuery,
    response: Suggestions,
  }),
  opsDirectorySuggestionResolve: defineRoute({
    method: "POST",
    path: "/api/ops/clients/:id/directory/suggestions/:suggestionId",
    auth: "session",
    roles: OPS,
    summary: "Accept or decline an agent's suggestion for a client",
    params: OpsSuggestionParams,
    body: SuggestionResolveBody,
    response: OneSuggestion,
  }),
} as const;
