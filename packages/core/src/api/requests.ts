import { z } from "zod";
import { isUuid } from "../ids";
import { defineRoute } from "./contract";

// Requests (ARCHITECTURE §1 item 7, §11): a client asks the operator for a change to one of its
// services, or for something new, from the portal. A request is an inbox item of kind
// `change_request` assigned to the operator; it lands in the back office's requests queue and is
// resolved there, as done (with the client agent or template versions made for it, and a note to
// the client) or declined (with a note saying why).

const Id = z.string().refine((v) => isUuid(v), "not an id");
const IdParams = z.object({ id: Id });
const OPS = ["operator"] as const;
const CLIENT = ["client_admin", "client_user"] as const;

export const REQUEST_SUBJECT_MAX = 200;
export const REQUEST_TEXT_MAX = 4000;
export const REQUEST_NOTE_MAX = 2000;
/** Versions one resolution may link. */
export const REQUEST_LINKS_MAX = 20;

export const RequestSubmission = z.strictObject({
  subject: z.string().trim().min(1).max(REQUEST_SUBJECT_MAX).optional(),
  text: z.string().trim().min(1).max(REQUEST_TEXT_MAX),
  /** The service it is about; none for a new service or anything else. */
  serviceId: Id.optional(),
});
export type RequestSubmission = z.infer<typeof RequestSubmission>;

/** Open until the operator resolves it, then done or declined. */
export const RequestStatus = z.enum(["open", "done", "declined"]);
export type RequestStatus = z.infer<typeof RequestStatus>;

export const RequestResolution = z
  .strictObject({
    outcome: z.enum(["done", "declined"]).default("done"),
    /** What the client reads: what we did, or why not. */
    note: z.string().trim().max(REQUEST_NOTE_MAX).optional(),
    /** The client agent or template versions made for it. */
    links: z.array(Id).max(REQUEST_LINKS_MAX).default([]),
  })
  .refine((b) => b.outcome === "done" || (b.note !== undefined && b.note.length > 0), {
    message: "say why you are declining it",
    path: ["note"],
  })
  .refine((b) => b.outcome === "declined" || b.links.length > 0 || !!b.note, {
    message: "link the versions made for it, or write a note",
    path: ["links"],
  })
  .refine((b) => b.outcome === "done" || b.links.length === 0, {
    message: "a declined request links no versions",
    path: ["links"],
  });
export type RequestResolutionInput = z.input<typeof RequestResolution>;

const Person = z.object({ id: z.string(), email: z.string(), name: z.string().nullable() });
const Named = z.object({ id: z.string(), name: z.string() });

/** A request as the client sees it: no templates, agent slugs or anything internal. */
export const PortalRequest = z.object({
  id: z.string(),
  subject: z.string(),
  text: z.string(),
  service: Named.nullable(),
  status: RequestStatus,
  raisedBy: z.object({ id: z.string(), name: z.string().nullable() }).nullable(),
  createdAt: z.string(),
  resolvedAt: z.string().nullable(),
  note: z.string().nullable(),
  /** The client's own services that changed for it, and the version each is now on. */
  changes: z.array(z.object({ service: Named, version: z.number().int() })),
});
export type PortalRequest = z.infer<typeof PortalRequest>;

export const RequestLink = z.object({
  agentVersionId: z.string(),
  agentId: z.string(),
  kind: z.enum(["template", "client"]),
  /** Null for a template. */
  tenantId: z.string().nullable(),
  slug: z.string(),
  name: z.string(),
  version: z.number().int(),
});
export type RequestLink = z.infer<typeof RequestLink>;

export const OpsRequest = z.object({
  id: z.string(),
  client: Named,
  subject: z.string(),
  text: z.string(),
  /** The client agent it is about (the service the client picked). */
  agent: z
    .object({ id: z.string(), slug: z.string(), name: z.string(), serviceName: z.string() })
    .nullable(),
  status: RequestStatus,
  raisedBy: Person.nullable(),
  createdAt: z.string(),
  resolvedAt: z.string().nullable(),
  resolvedBy: Person.nullable(),
  note: z.string().nullable(),
  links: z.array(RequestLink),
});
export type OpsRequest = z.infer<typeof OpsRequest>;

export const requestRoutes = {
  portalRequests: defineRoute({
    method: "GET",
    path: "/api/requests",
    auth: "session",
    roles: CLIENT,
    summary: "Your requests to us, newest first (client users: the ones they raised)",
    query: z.object({ status: z.enum(["open", "resolved", "all"]).default("all") }),
    response: z.object({ items: z.array(PortalRequest) }),
  }),
  portalRaiseRequest: defineRoute({
    method: "POST",
    path: "/api/requests",
    auth: "session",
    roles: CLIENT,
    summary: "Ask us for a change to a service, or for something new",
    body: RequestSubmission,
    response: z.object({ item: PortalRequest }),
  }),
  opsRequests: defineRoute({
    method: "GET",
    path: "/api/ops/requests",
    auth: "session",
    roles: OPS,
    summary: "The requests queue: clients' requests across the clients served, newest first",
    query: z.object({
      status: z.enum(["open", "resolved", "all"]).default("open"),
      client: Id.optional(),
    }),
    response: z.object({ items: z.array(OpsRequest) }),
  }),
  opsResolveRequest: defineRoute({
    method: "POST",
    path: "/api/ops/requests/:id/resolve",
    auth: "session",
    roles: OPS,
    summary: "Resolve a request: done (link the versions made for it) or declined, with a note",
    params: IdParams,
    body: RequestResolution,
    response: z.object({ item: OpsRequest }),
  }),
} as const;
