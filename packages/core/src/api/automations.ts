import { z } from "zod";
import { isUuid } from "../ids";
import { AutomationDefinition, AutomationRequires } from "../schemas/automation";
import { JsonSchema, NodeId, Slug } from "../schemas/common";
import { defineRoute } from "./contract";

// v0.12 W2-B: automations (ARCHITECTURE §10.7, §14 "Automations"; docs/plan.md §1.45). Reusable,
// versioned step chains, shared or written for one client, edited and published by the operator
// only. Every route here is the back office's: no portal route returns an automation (invariant 11).

const Id = z.string().refine((v) => isUuid(v), "not an id");
const IdParams = z.object({ id: Id });
const OPS = ["operator"] as const;
const Note = z.string().max(2000);

const CheckError = z.object({
  stepId: z.string().nullable(),
  field: z.string(),
  message: z.string(),
  code: z.string(),
});

/** How an automation does in live runs: the last 30 days of its use steps. */
export const AutomationHealth = z.object({
  /** Use steps in live runs of the last 30 days that ended (succeeded or failed). */
  uses: z.number().int(),
  /** Of those, the ones that succeeded in a run that wasn't a retry. */
  clean: z.number().int(),
  /** `clean / uses`, 0–1; null with no uses. */
  cleanRunRate: z.number().nullable(),
});
export type AutomationHealth = z.infer<typeof AutomationHealth>;

export const AutomationListItem = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  description: z.string(),
  source: z.enum(["shared", "client"]),
  clientId: z.string().nullable(),
  clientName: z.string().nullable(),
  status: z.string(),
  liveVersion: z.number().int().nullable(),
  latestVersion: z.number().int().nullable(),
  latestStatus: z.string().nullable(),
  /** Top-level fields of its input schema and of its output. */
  inputs: z.array(z.string()),
  outputs: z.array(z.string()),
  requires: AutomationRequires,
  /** Live versions of templates and client agents that use any version of it. */
  usedBy: z.number().int(),
  health: AutomationHealth,
});
export type AutomationListItem = z.infer<typeof AutomationListItem>;

export const AutomationVersionView = z.object({
  id: z.string(),
  version: z.number().int(),
  status: z.string(),
  definition: AutomationDefinition,
  changeNote: z.string().nullable(),
  authorId: z.string().nullable(),
  parentVersionId: z.string().nullable(),
  createdAt: z.string(),
});
export type AutomationVersionView = z.infer<typeof AutomationVersionView>;

export const AutomationUse = z.object({
  agentId: z.string(),
  kind: z.enum(["template", "client"]),
  slug: z.string(),
  name: z.string(),
  clientId: z.string().nullable(),
  clientName: z.string().nullable(),
  /** The version it pins (`slug@version`). */
  ref: z.string(),
  /** The agent's live version that uses it. */
  version: z.number().int(),
});
export type AutomationUse = z.infer<typeof AutomationUse>;

/** An automation as the workflow builder places and types it (ARCHITECTURE §10.5). */
export const BuilderAutomation = z.object({
  /** The pinned reference a use step names: `slug@version`. */
  ref: z.string(),
  slug: z.string(),
  version: z.number().int(),
  name: z.string(),
  description: z.string(),
  source: z.enum(["shared", "client"]),
  /** live: the version agents get today; pinned: a version the agent's latest version names. */
  status: z.string(),
  definition: AutomationDefinition,
  /** The use step's output, typed from the automation's `output`. */
  outputSchema: JsonSchema,
});
export type BuilderAutomation = z.infer<typeof BuilderAutomation>;

export const automationRoutes = {
  opsAutomations: defineRoute({
    method: "GET",
    path: "/api/ops/automations",
    auth: "session",
    roles: OPS,
    summary: "Automations: shared and the clients' own, with used-by and clean-run rate",
    query: z.object({ client: Id.optional() }),
    response: z.object({ automations: z.array(AutomationListItem) }),
  }),
  opsCreateAutomation: defineRoute({
    method: "POST",
    path: "/api/ops/automations",
    auth: "session",
    roles: OPS,
    summary: "A new automation (shared, or for one client) with its v1 draft",
    body: z.strictObject({
      clientId: Id.optional(),
      definition: z.unknown(),
      changeNote: Note.optional(),
    }),
    response: z.object({
      automation: AutomationListItem,
      version: AutomationVersionView,
      /** What would stop a publish (a draft may be saved with errors). */
      errors: z.array(CheckError),
    }),
  }),
  opsAutomation: defineRoute({
    method: "GET",
    path: "/api/ops/automations/:id",
    auth: "session",
    roles: OPS,
    summary: "An automation with its versions, the agents that use it and its clean-run rate",
    params: IdParams,
    response: z.object({
      automation: AutomationListItem,
      versions: z.array(AutomationVersionView),
      usedBy: z.array(AutomationUse),
    }),
  }),
  opsSaveAutomationVersion: defineRoute({
    method: "POST",
    path: "/api/ops/automations/:id/versions",
    auth: "session",
    roles: OPS,
    summary: "Save a new draft version of an automation",
    params: IdParams,
    body: z.strictObject({
      definition: z.unknown(),
      parentVersionId: Id.optional(),
      changeNote: Note.optional(),
    }),
    response: z.object({ version: AutomationVersionView, errors: z.array(CheckError) }),
  }),
  opsPublishAutomation: defineRoute({
    method: "POST",
    path: "/api/ops/automations/:id/versions/:vid/publish",
    auth: "session",
    roles: OPS,
    summary: "Publish an automation version; agents move to it only by their own new version",
    params: z.object({ id: Id, vid: Id }),
    response: z.object({ version: AutomationVersionView }),
  }),
  opsRollbackAutomation: defineRoute({
    method: "POST",
    path: "/api/ops/automations/:id/rollback",
    auth: "session",
    roles: OPS,
    summary: "Roll an automation back: an older version copied as a new one and published",
    params: IdParams,
    body: z.strictObject({ versionId: Id }),
    response: z.object({ version: AutomationVersionView }),
  }),
  opsAutomationFromSteps: defineRoute({
    method: "POST",
    path: "/api/ops/automations/from-steps",
    auth: "session",
    roles: OPS,
    summary: "Save as automation: selected steps become an automation draft, used in their place",
    body: z.strictObject({
      agentId: Id,
      versionId: Id,
      stepIds: z.array(NodeId).min(1).max(100),
      slug: Slug,
      name: z.string().trim().min(1).max(120),
      description: z.string().max(2000).optional(),
    }),
    response: z.object({
      automation: AutomationListItem,
      version: AutomationVersionView,
      /** The agent's new draft version, with one use step in place of the selection. */
      agentVersion: z.object({ id: z.string(), version: z.number().int() }),
    }),
  }),
} as const;
