// The setup checklist's routes (docs/builder-plan.md §6, B4): the portal's Getting started lists
// each agent's checklist and the client admin answers and confirms there; the back office records
// an item on the client copy's page when it steps in. The checklist itself travels with the agent's
// version; its progress is the agent's (`stage_state.setup`). No portal answer carries the agent's
// version, instructions, prompts or cost (invariant 11).

import { z } from "zod";
import { isUuid } from "../ids";
import { AgentStage } from "../lifecycle/stage";
import { SetupItemId } from "../setup/item";
import { SetupView } from "../setup/view";
import { defineRoute } from "./contract";
import { GoLive } from "./lifecycle";

const Id = z.string().refine((v) => isUuid(v), "not an id");
const OPS = ["operator"] as const;
const CLIENT = ["client_admin", "client_user"] as const;
const CLIENT_ADMIN = ["client_admin"] as const;

const ItemParams = z.object({ id: Id, itemId: SetupItemId });

/** One agent's checklist on Getting started. */
export const PortalSetupAgent = z.object({
  agentId: z.string(),
  name: z.string(),
  stage: AgentStage.nullable(),
  setup: SetupView,
});
export type PortalSetupAgent = z.infer<typeof PortalSetupAgent>;

/**
 * An answer, a confirm or a file: `value` is the answer (a confirm's note, optional); `files` are
 * documents the client uploaded; `done: false` takes a confirm back.
 */
export const SetupItemBody = z.strictObject({
  value: z.string().max(2000).optional(),
  files: z.array(Id).max(20).optional(),
  done: z.boolean().optional(),
});
export type SetupItemBody = z.infer<typeof SetupItemBody>;

export const setupRoutes = {
  portalSetup: defineRoute({
    method: "GET",
    path: "/api/setup",
    auth: "session",
    roles: CLIENT,
    summary:
      "Getting started: each agent's setup checklist, what is done and by whom, and what holds its trial and go-live",
    response: z.object({ agents: z.array(PortalSetupAgent) }),
  }),
  portalSetupItem: defineRoute({
    method: "POST",
    path: "/api/setup/:id/items/:itemId",
    auth: "session",
    roles: CLIENT_ADMIN,
    summary:
      "The client admin answers, confirms or sends a file for one item of an agent's setup checklist; an answer that sets a value makes a new version by code",
    params: ItemParams,
    body: SetupItemBody,
    response: z.object({ agent: PortalSetupAgent }),
  }),
  opsSetupItem: defineRoute({
    method: "POST",
    path: "/api/ops/agents/:id/setup/:itemId",
    auth: "session",
    roles: OPS,
    summary:
      "Record one item of a client agent's setup checklist for the client (who did it is kept); an answer that sets a value makes a new version by code",
    params: ItemParams,
    body: SetupItemBody,
    response: z.object({ goLive: GoLive }),
  }),
  opsSetupItemFiles: defineRoute({
    method: "POST",
    path: "/api/ops/agents/:id/setup/:itemId/files",
    auth: "session",
    roles: OPS,
    summary:
      "G10: send a file item of a client agent's setup checklist for the client (multipart, field `files`): stored quietly in the client's documents, then recorded on the item as ours",
    params: ItemParams,
    response: z.object({
      goLive: GoLive,
      /** Files that weren't kept, with why. */
      refused: z.array(z.object({ filename: z.string(), error: z.string() })),
    }),
  }),
} as const;
