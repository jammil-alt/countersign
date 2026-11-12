import { z } from "zod";
import { isUuid } from "../ids";
import { DecimalString } from "../money";
import { OversightReview } from "../oversight/decision";
import { OWNER_AREAS } from "../owners/areas";
import { OWNER_NOTES_MAX } from "../owners/definition";
import { OWNER_NAME_MAX, OWNER_NAME_MIN } from "../owners/names";
import { ModelChoice } from "../schemas/skill";
import { defineRoute } from "./contract";

// v0.17 (ARCHITECTURE §10.15, docs/plan.md §1.96, O4): a client's area owners. The back office
// sees and edits everything about them (model, notes, review defaults, memory notes, the area of
// each process); the portal sees each owner's name and area only, and the client admin may rename
// one (invariant 11: no notes, model or cost reach the portal).

const Id = z.string().refine((v) => isUuid(v), "not an id");
const IdParams = z.object({ id: Id });
const OPS = ["operator"] as const;
const CLIENT = ["client_admin", "client_user"] as const;

const Area = z.enum(OWNER_AREAS);
const OwnerName = z.string().trim().min(OWNER_NAME_MIN).max(OWNER_NAME_MAX);

/** The area defaults an owner gives processes that saved none. */
export const OwnerOversightEdit = z.strictObject({
  review: OversightReview,
  maxPerRun: z.number().int().min(0).max(10),
  maxCostUsd: DecimalString,
});

/** A process (a client agent) an owner oversees. */
export const OwnerProcess = z.object({
  agentId: z.string(),
  name: z.string(),
  /** Set on the agent row by the operator; false when read from its template or skills. */
  areaSet: z.boolean(),
});

export const OwnerMemoryView = z.object({
  id: z.string(),
  note: z.string(),
  createdAt: z.string(),
});

/** An owner in the back office. */
export const OpsOwnerView = z.object({
  id: z.string(),
  tenantId: z.string(),
  area: Area,
  name: z.string(),
  avatar: z.string().nullable(),
  version: z.number().int(),
  versionId: z.string(),
  /** Null: each process reviews on its own model. */
  model: ModelChoice.nullable(),
  notes: z.string(),
  /** Null: v4 processes reviewed on failures, stored v3 ones off. */
  oversight: OwnerOversightEdit.nullable(),
  processes: z.array(OwnerProcess),
  memory: z.array(OwnerMemoryView),
});
export type OpsOwnerView = z.infer<typeof OpsOwnerView>;

export const OwnerVersionSummary = z.object({
  version: z.number().int(),
  authorType: z.enum(["operator", "system"]),
  changeNote: z.string().nullable(),
  createdAt: z.string(),
});

/** A new version of an owner's settings: the whole of them, as the owner's page edits them. */
export const OwnerVersionInput = z.strictObject({
  model: ModelChoice.nullable(),
  notes: z.string().max(OWNER_NOTES_MAX),
  oversight: OwnerOversightEdit.nullable(),
  changeNote: z.string().trim().max(500).optional(),
});
export type OwnerVersionInput = z.infer<typeof OwnerVersionInput>;

/** An owner in the portal: who it is and what it owns, nothing of how it works. */
export const PortalOwnerView = z.object({
  id: z.string(),
  name: z.string(),
  area: Area,
  avatar: z.string().nullable(),
});
export type PortalOwnerView = z.infer<typeof PortalOwnerView>;

export const ownerRoutes = {
  opsClientOwners: defineRoute({
    method: "GET",
    path: "/api/ops/clients/:id/owners",
    auth: "session",
    roles: OPS,
    summary:
      "A client's area owners, one for each area its processes are in (created on first look)",
    params: IdParams,
    response: z.object({ owners: z.array(OpsOwnerView) }),
  }),
  opsOwner: defineRoute({
    method: "GET",
    path: "/api/ops/owners/:id",
    auth: "session",
    roles: OPS,
    summary: "An area owner: its settings, notes, memory notes, processes and versions",
    params: IdParams,
    response: z.object({ owner: OpsOwnerView, versions: z.array(OwnerVersionSummary) }),
  }),
  opsOwnerVersion: defineRoute({
    method: "POST",
    path: "/api/ops/owners/:id/versions",
    auth: "session",
    roles: OPS,
    summary: "Save an owner's model, notes and review defaults as its next version",
    params: IdParams,
    body: OwnerVersionInput,
    response: z.object({ owner: OpsOwnerView }),
  }),
  opsOwnerRename: defineRoute({
    method: "PATCH",
    path: "/api/ops/owners/:id",
    auth: "session",
    roles: OPS,
    summary: "Rename an owner (not a new version)",
    params: IdParams,
    body: z.strictObject({ name: OwnerName }),
    response: z.object({ owner: OpsOwnerView }),
  }),
  opsOwnerForget: defineRoute({
    method: "DELETE",
    path: "/api/ops/owners/:id/memory/:noteId",
    auth: "session",
    roles: OPS,
    summary: "Delete one of an owner's memory notes",
    params: z.object({ id: Id, noteId: Id }),
    response: z.object({ ok: z.literal(true) }),
  }),
  opsAgentArea: defineRoute({
    method: "PATCH",
    path: "/api/ops/agents/:id/area",
    auth: "session",
    roles: OPS,
    summary: "Put a client agent's process in a business area, or back to its default (null)",
    params: IdParams,
    body: z.strictObject({ area: Area.nullable() }),
    response: z.object({ agentId: z.string(), area: Area }),
  }),
  owners: defineRoute({
    method: "GET",
    path: "/api/owners",
    auth: "session",
    roles: CLIENT,
    summary: "Your agents by area: each one's name and what it owns",
    response: z.object({ owners: z.array(PortalOwnerView) }),
  }),
  ownerRename: defineRoute({
    method: "PATCH",
    path: "/api/owners/:id",
    auth: "session",
    roles: ["client_admin"],
    summary: "Rename one of your agents",
    params: IdParams,
    body: z.strictObject({ name: OwnerName }),
    response: z.object({ owner: PortalOwnerView }),
  }),
} as const;
