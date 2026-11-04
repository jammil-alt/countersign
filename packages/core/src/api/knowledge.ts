import { z } from "zod";
import { isUuid } from "../ids";
import { defineRoute } from "./contract";

// The per-client knowledge base (docs/plan.md §1.21): FAQs and policies written by the operator or
// the client admin, the client's documents, and its agents' memory notes, searched by agents with
// `knowledge.search`. The back office manages a client's entries and sees what is indexed; the
// client admin adds and edits the client's own FAQs and policies from the portal. Every save keeps
// the previous text as a version.

const Id = z.string().refine((v) => isUuid(v), "not an id");
const OPS = ["operator"] as const;
const CLIENT_ADMIN = ["client_admin"] as const;

export const KNOWLEDGE_TITLE_MAX = 200;
export const KNOWLEDGE_BODY_MAX = 20_000;
export const KNOWLEDGE_SEARCH_QUERY_MAX = 500;

export const KnowledgeEntryKind = z.enum(["faq", "policy"]);
export type KnowledgeEntryKind = z.infer<typeof KnowledgeEntryKind>;

export const KnowledgeEntryInput = z.strictObject({
  kind: KnowledgeEntryKind,
  title: z.string().trim().min(1).max(KNOWLEDGE_TITLE_MAX),
  body: z.string().trim().min(1).max(KNOWLEDGE_BODY_MAX),
});
export type KnowledgeEntryInput = z.infer<typeof KnowledgeEntryInput>;

/** An edit names the version it started from; a newer one on the server refuses it (409). */
export const KnowledgeEntryEdit = z.strictObject({
  title: z.string().trim().min(1).max(KNOWLEDGE_TITLE_MAX),
  body: z.string().trim().min(1).max(KNOWLEDGE_BODY_MAX),
  baseVersion: z.number().int().min(1),
});
export type KnowledgeEntryEdit = z.infer<typeof KnowledgeEntryEdit>;

export const KnowledgeEntryArchive = z.strictObject({ baseVersion: z.number().int().min(1) });

const Author = z.object({
  role: z.enum(["operator", "client_admin"]),
  /** The person's name; null when unknown. */
  name: z.string().nullable(),
});

export const KnowledgeEntry = z.object({
  id: z.string(),
  kind: KnowledgeEntryKind,
  status: z.enum(["active", "archived"]),
  version: z.number().int(),
  title: z.string(),
  body: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  updatedBy: Author,
});
export type KnowledgeEntry = z.infer<typeof KnowledgeEntry>;

export const KnowledgeEntryVersion = z.object({
  id: z.string(),
  version: z.number().int(),
  title: z.string(),
  body: z.string(),
  status: z.enum(["active", "archived"]),
  author: Author,
  createdAt: z.string(),
});
export type KnowledgeEntryVersion = z.infer<typeof KnowledgeEntryVersion>;

export const KnowledgeDocument = z.object({
  id: z.string(),
  filename: z.string(),
  source: z.string(),
  status: z.string(),
  receivedAt: z.string(),
  /** What search shows it as (e.g. "Invoice 20418 from Northline"); null until indexed. */
  title: z.string().nullable(),
  passages: z.number().int(),
  /** Indexed from its latest reading (or from its name and headers, before it is read). */
  indexed: z.boolean(),
});
export type KnowledgeDocument = z.infer<typeof KnowledgeDocument>;

export const KnowledgeMemoryNote = z.object({
  id: z.string(),
  agent: z.object({ id: z.string(), name: z.string() }),
  note: z.string(),
  createdAt: z.string(),
});
export type KnowledgeMemoryNote = z.infer<typeof KnowledgeMemoryNote>;

export const KnowledgeHit = z.object({
  kind: z.enum(["faq", "policy", "document", "memory"]),
  id: z.string(),
  title: z.string(),
  excerpt: z.string(),
  score: z.number(),
  sources: z.array(z.string()),
});
export type KnowledgeHit = z.infer<typeof KnowledgeHit>;

const Show = z.object({ show: z.enum(["active", "all"]).default("active") });
const ClientParams = z.object({ id: Id });
const ClientEntryParams = z.object({ id: Id, entryId: Id });
const EntryParams = z.object({ id: Id });
const EntryResponse = z.object({ entry: KnowledgeEntry });

export const knowledgeRoutes = {
  opsKnowledge: defineRoute({
    method: "GET",
    path: "/api/ops/clients/:id/knowledge",
    auth: "session",
    roles: OPS,
    summary:
      "A client's knowledge base: its FAQs and policies, its documents and whether each is indexed, its agents' memory notes",
    params: ClientParams,
    query: Show,
    response: z.object({
      entries: z.array(KnowledgeEntry),
      documents: z.array(KnowledgeDocument),
      memoryNotes: z.object({ count: z.number().int(), recent: z.array(KnowledgeMemoryNote) }),
    }),
  }),
  opsKnowledgeCreate: defineRoute({
    method: "POST",
    path: "/api/ops/clients/:id/knowledge/entries",
    auth: "session",
    roles: OPS,
    summary: "Add an FAQ or a policy to a client's knowledge base",
    params: ClientParams,
    body: KnowledgeEntryInput,
    response: EntryResponse,
  }),
  opsKnowledgeEdit: defineRoute({
    method: "PUT",
    path: "/api/ops/clients/:id/knowledge/entries/:entryId",
    auth: "session",
    roles: OPS,
    summary: "Save a new version of a client's FAQ or policy (restores an archived one)",
    params: ClientEntryParams,
    body: KnowledgeEntryEdit,
    response: EntryResponse,
  }),
  opsKnowledgeArchive: defineRoute({
    method: "POST",
    path: "/api/ops/clients/:id/knowledge/entries/:entryId/archive",
    auth: "session",
    roles: OPS,
    summary: "Take a client's FAQ or policy out of search; its versions are kept",
    params: ClientEntryParams,
    body: KnowledgeEntryArchive,
    response: EntryResponse,
  }),
  opsKnowledgeVersions: defineRoute({
    method: "GET",
    path: "/api/ops/clients/:id/knowledge/entries/:entryId/versions",
    auth: "session",
    roles: OPS,
    summary: "Every saved version of a client's FAQ or policy, oldest first, with who saved it",
    params: ClientEntryParams,
    response: z.object({ versions: z.array(KnowledgeEntryVersion) }),
  }),
  opsKnowledgeSearch: defineRoute({
    method: "GET",
    path: "/api/ops/clients/:id/knowledge/search",
    auth: "session",
    roles: OPS,
    summary:
      "Try a search as an agent would (FAQs, policies, documents, and every agent's live memory notes)",
    params: ClientParams,
    query: z.object({
      q: z.string().trim().min(1).max(KNOWLEDGE_SEARCH_QUERY_MAX),
      limit: z.coerce.number().int().min(1).max(20).default(10),
    }),
    response: z.object({ results: z.array(KnowledgeHit) }),
  }),
  portalKnowledge: defineRoute({
    method: "GET",
    path: "/api/knowledge",
    auth: "session",
    roles: CLIENT_ADMIN,
    summary: "Your FAQs and policies, which our agents use to answer for you",
    query: Show,
    response: z.object({ entries: z.array(KnowledgeEntry) }),
  }),
  portalKnowledgeCreate: defineRoute({
    method: "POST",
    path: "/api/knowledge/entries",
    auth: "session",
    roles: CLIENT_ADMIN,
    summary: "Add an FAQ or a policy",
    body: KnowledgeEntryInput,
    response: EntryResponse,
  }),
  portalKnowledgeEdit: defineRoute({
    method: "PUT",
    path: "/api/knowledge/entries/:id",
    auth: "session",
    roles: CLIENT_ADMIN,
    summary: "Change an FAQ or a policy (restores an archived one); the previous text is kept",
    params: EntryParams,
    body: KnowledgeEntryEdit,
    response: EntryResponse,
  }),
  portalKnowledgeArchive: defineRoute({
    method: "POST",
    path: "/api/knowledge/entries/:id/archive",
    auth: "session",
    roles: CLIENT_ADMIN,
    summary: "Archive an FAQ or a policy: agents stop using it",
    params: EntryParams,
    body: KnowledgeEntryArchive,
    response: EntryResponse,
  }),
} as const;
