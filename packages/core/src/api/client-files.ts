// The client file and saved starts (docs/plan.md §1.125; docs/cases-plan.md §4.1, §4.3): the lead
// record's knowledge about a company, from the first conversation on, and Sign up now's presets.
// Operator only: both are operator-only tables, and no portal route returns a file, a fact or a
// start (invariant 11). Request and response schemas; stream SALES mounts the handlers.

import { z } from "zod";
import { isUuid } from "../ids";
import {
  ClientFactView,
  ClientFileStatus,
  IntakeStatus,
  NewClientFact,
  NewSalesStart,
  SalesStartView,
  UpdateSalesStart,
} from "../onboarding";
import { DealKind, DealOutcome, DealStage } from "../work/deals";
import { defineRoute } from "./contract";

const Id = z.string().refine((v) => isUuid(v), "not an id");
const OPS = ["operator"] as const;
const IdParams = z.object({ id: Id });

/** At most this many facts in one call (a debrief's card, ticked). */
export const FACTS_PER_CALL_MAX = 50;

const Website = z
  .string()
  .trim()
  .max(300)
  .regex(/^(https?:\/\/)?[a-z0-9.-]+\.[a-z]{2,}(\/\S*)?$/i, "a website such as acme.com");

export const ClientFileSummary = z.object({
  id: z.string(),
  name: z.string(),
  website: z.string().nullable(),
  status: ClientFileStatus,
  /** The client it became, once set up. */
  client: z.object({ id: z.string(), name: z.string() }).nullable(),
  /** Current facts (corrections replace, so a corrected fact counts once). */
  facts: z.number().int(),
  /** Open deals pointing at it. */
  openDeals: z.number().int(),
  lastFactAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ClientFileSummary = z.infer<typeof ClientFileSummary>;

export const ClientFileDetail = z.object({
  file: ClientFileSummary,
  /** Current facts, newest first; with `?history=true`, the replaced ones too. */
  facts: z.array(ClientFactView),
  deals: z.array(
    z.object({
      id: z.string(),
      kind: DealKind,
      title: z.string(),
      stage: DealStage,
      outcome: DealOutcome,
    }),
  ),
  intakes: z.array(
    z.object({
      id: z.string(),
      clientId: z.string(),
      status: IntakeStatus,
      createdAt: z.string(),
    }),
  ),
});
export type ClientFileDetail = z.infer<typeof ClientFileDetail>;

export const NewClientFile = z.strictObject({
  name: z.string().trim().min(1).max(200),
  website: Website.optional(),
  /** An existing client this file is about (a client made before files existed). */
  clientId: Id.optional(),
  /** A deal to point at this file. */
  dealId: Id.optional(),
});
export type NewClientFile = z.infer<typeof NewClientFile>;

export const UpdateClientFile = z.strictObject({
  name: z.string().trim().min(1).max(200).optional(),
  website: Website.nullable().optional(),
  status: ClientFileStatus.optional(),
  /** Link the file to the client it became (once: a client has one file). */
  clientId: Id.optional(),
  /** Point a deal at this file. */
  dealId: Id.optional(),
});
export type UpdateClientFile = z.infer<typeof UpdateClientFile>;

export const clientFileRoutes = {
  opsClientFiles: defineRoute({
    method: "GET",
    path: "/api/ops/client-files",
    auth: "session",
    roles: OPS,
    summary: "Client files: prospects' and clients' (those the operator serves), newest first",
    query: z.object({
      status: ClientFileStatus.optional(),
      q: z.string().trim().max(200).optional(),
      client: Id.optional(),
    }),
    response: z.object({ files: z.array(ClientFileSummary) }),
  }),
  opsCreateClientFile: defineRoute({
    method: "POST",
    path: "/api/ops/client-files",
    auth: "session",
    roles: OPS,
    summary: "A new client file for a company (a prospect, or a client that has none yet)",
    body: NewClientFile,
    response: ClientFileDetail,
  }),
  opsClientFile: defineRoute({
    method: "GET",
    path: "/api/ops/client-files/:id",
    auth: "session",
    roles: OPS,
    summary: "A client file: its facts by section, its deals and intakes",
    params: IdParams,
    query: z.object({ history: z.enum(["true", "false"]).default("false") }),
    response: ClientFileDetail,
  }),
  opsUpdateClientFile: defineRoute({
    method: "PATCH",
    path: "/api/ops/client-files/:id",
    auth: "session",
    roles: OPS,
    summary:
      "Change a client file's name, website or status, or link it to its client or a deal (its facts are only added to)",
    params: IdParams,
    body: UpdateClientFile,
    response: ClientFileDetail,
  }),
  opsAddClientFacts: defineRoute({
    method: "POST",
    path: "/api/ops/client-files/:id/facts",
    auth: "session",
    roles: OPS,
    summary:
      "Add facts to a client file (a correction names the fact it replaces; nothing is edited in place)",
    params: IdParams,
    body: z.strictObject({ facts: z.array(NewClientFact).min(1).max(FACTS_PER_CALL_MAX) }),
    response: ClientFileDetail,
  }),
} as const;

export const startRoutes = {
  opsStarts: defineRoute({
    method: "GET",
    path: "/api/ops/starts",
    auth: "session",
    roles: OPS,
    summary: "Saved starts for Sign up now and Invite (seeded ones included; archived on request)",
    query: z.object({ archived: z.enum(["true", "false"]).default("false") }),
    response: z.object({ starts: z.array(SalesStartView) }),
  }),
  opsCreateStart: defineRoute({
    method: "POST",
    path: "/api/ops/starts",
    auth: "session",
    roles: OPS,
    summary: "Save a start: its name, what it covers, the lead's note and how the client starts",
    body: NewSalesStart,
    response: z.object({ start: SalesStartView }),
  }),
  opsUpdateStart: defineRoute({
    method: "PATCH",
    path: "/api/ops/starts/:id",
    auth: "session",
    roles: OPS,
    summary: "Change or archive a start (never deleted)",
    params: IdParams,
    body: UpdateSalesStart,
    response: z.object({ start: SalesStartView }),
  }),
} as const;
