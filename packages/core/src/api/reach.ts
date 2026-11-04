import { z } from "zod";
import { isUuid } from "../ids";
import { PersonRole, ReachChannel, ReachConditions, ReachOutcome, RoleName } from "../reach/rules";
import { defineRoute } from "./contract";

// Reach out (docs/plan.md §1.25): who a client agent reaches (its roles bound to contacts, with
// conditions) and through which channels (each bound to a connection). People and conditions are
// edited by the operator and by the client admin; channels by the operator alone. Mezonas' email
// sending (Resend) is set up per client by the operator.

const Id = z.string().refine((v) => isUuid(v), "not an id");
const OPS = ["operator"] as const;
const CLIENT_ADMIN = ["client_admin"] as const;

export const MAX_CONTACTS_PER_ROLE = 10;

/** One role's binding: who fills it, and the conditions for reaching them. */
export const PeopleBinding = z.strictObject({
  contactIds: z.array(Id).max(MAX_CONTACTS_PER_ROLE),
  conditions: ReachConditions.default({}),
});
export type PeopleBinding = z.infer<typeof PeopleBinding>;
export type PeopleBindingInput = z.input<typeof PeopleBinding>;

export const PeopleBindings = z.record(RoleName, PeopleBinding);
export type PeopleBindings = z.infer<typeof PeopleBindings>;

/** The agent's channels: email, sms, whatsapp, voice → a connection of this client. */
export const ChannelBindings = z.partialRecord(ReachChannel, Id);
export type ChannelBindings = z.infer<typeof ChannelBindings>;

/** A contact as the People section lists it: enough to choose, nothing more. */
export const PersonOption = z.object({
  id: z.string(),
  name: z.string(),
  roles: z.array(z.string()),
  /** Channels with an address and consent, opt-out aside. */
  reachable: z.array(ReachChannel),
  optedOut: z.boolean(),
});
export type PersonOption = z.infer<typeof PersonOption>;

export const AgentPeople = z.object({
  agentId: z.string(),
  agentName: z.string(),
  /** The roles the agent's live (else latest) version declares. */
  roles: z.array(PersonRole),
  people: PeopleBindings,
  /** Required roles with nobody bound: activation is refused until they are. */
  missing: z.array(z.string()),
  contacts: z.array(PersonOption),
});
export type AgentPeople = z.infer<typeof AgentPeople>;

/** A connection the operator may bind a channel to. */
export const ChannelOption = z.object({
  connectionId: z.string(),
  connector: z.string(),
  label: z.string(),
  status: z.string(),
  channels: z.array(ReachChannel),
});
export type ChannelOption = z.infer<typeof ChannelOption>;

export const AgentChannels = z.object({
  agentId: z.string(),
  channels: ChannelBindings,
  options: z.array(ChannelOption),
});
export type AgentChannels = z.infer<typeof AgentChannels>;

/** One reach-out, as people read it (no reply text in lists: it is the contact's words). */
export const ReachOutSummary = z.object({
  id: z.string(),
  agentId: z.string(),
  contactId: z.string(),
  contactName: z.string(),
  role: z.string().nullable(),
  purpose: z.string(),
  urgency: z.string(),
  status: z.enum(["awaiting_approval", "open", "ended"]),
  outcome: ReachOutcome.nullable(),
  reason: z.string().nullable(),
  channels: z.array(ReachChannel),
  attempts: z.number().int(),
  createdAt: z.string(),
  endedAt: z.string().nullable(),
});
export type ReachOutSummary = z.infer<typeof ReachOutSummary>;

// ── Email sending (Resend, Mezonas' infrastructure) ─────────────────────────────────────────────

export const DnsRecord = z.object({
  record: z.string(),
  name: z.string(),
  type: z.string(),
  value: z.string(),
  ttl: z.string().nullable(),
  priority: z.number().nullable(),
  status: z.string(),
});
export type DnsRecord = z.infer<typeof DnsRecord>;

export const EmailSetup = z.object({
  /** Whether this deployment has Mezonas' Resend account (RESEND_API_KEY). */
  available: z.boolean(),
  /** Our own sending domain, used until the client's is verified. */
  fallbackDomain: z.string().nullable(),
  connection: z
    .object({
      connectionId: z.string(),
      status: z.string(),
      domain: z.string().nullable(),
      domainStatus: z.string().nullable(),
      /** The address agents send from now. */
      from: z.string().nullable(),
      records: z.array(DnsRecord),
      checkedAt: z.string().nullable(),
    })
    .nullable(),
  /** Where replies come back (the client's forwarding address), or null when not set up. */
  replyTo: z.string().nullable(),
});
export type EmailSetup = z.infer<typeof EmailSetup>;

const DOMAIN_RE = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;

const AgentParams = z.object({ id: Id });
const ClientParams = z.object({ id: Id });
const EmailResponse = z.object({ setup: EmailSetup });

export const reachRoutes = {
  opsAgentPeople: defineRoute({
    method: "GET",
    path: "/api/ops/agents/:id/people",
    auth: "session",
    roles: OPS,
    summary: "A client agent's roles, the people bound to them and the conditions",
    params: AgentParams,
    response: z.object({ people: AgentPeople }),
  }),
  opsSetAgentPeople: defineRoute({
    method: "PUT",
    path: "/api/ops/agents/:id/people",
    auth: "session",
    roles: OPS,
    summary: "Bind people to a client agent's roles, with conditions (not a new version)",
    params: AgentParams,
    body: z.strictObject({ people: PeopleBindings }),
    response: z.object({ people: AgentPeople }),
  }),
  opsAgentChannels: defineRoute({
    method: "GET",
    path: "/api/ops/agents/:id/channels",
    auth: "session",
    roles: OPS,
    summary: "A client agent's channels and the connections they can use",
    params: AgentParams,
    response: z.object({ channels: AgentChannels }),
  }),
  opsSetAgentChannels: defineRoute({
    method: "PUT",
    path: "/api/ops/agents/:id/channels",
    auth: "session",
    roles: OPS,
    summary: "Bind a client agent's email, text, WhatsApp and calling channels to connections",
    params: AgentParams,
    body: z.strictObject({ channels: ChannelBindings }),
    response: z.object({ channels: AgentChannels }),
  }),
  opsReachOuts: defineRoute({
    method: "GET",
    path: "/api/ops/clients/:id/reach-outs",
    auth: "session",
    roles: OPS,
    summary: "A client's recent reach-outs, newest first",
    params: ClientParams,
    response: z.object({ items: z.array(ReachOutSummary) }),
  }),
  opsEmail: defineRoute({
    method: "GET",
    path: "/api/ops/clients/:id/email",
    auth: "session",
    roles: OPS,
    summary: "A client's email sending: the domain, its DNS records and where replies come back",
    params: ClientParams,
    response: EmailResponse,
  }),
  opsEmailConnect: defineRoute({
    method: "POST",
    path: "/api/ops/clients/:id/email",
    auth: "session",
    roles: OPS,
    summary: "Set up email sending for a client, on its own domain (DNS to add) or ours until then",
    params: ClientParams,
    body: z.strictObject({
      domain: z.string().trim().toLowerCase().regex(DOMAIN_RE, "a domain like shop.com").nullable(),
      /** The part before the @, e.g. `orders`. */
      localPart: z
        .string()
        .trim()
        .toLowerCase()
        .regex(/^[a-z0-9][a-z0-9._-]{0,40}$/)
        .default("assistant"),
      fromName: z.string().trim().min(1).max(80).optional(),
    }),
    response: EmailResponse,
  }),
  opsEmailVerify: defineRoute({
    method: "POST",
    path: "/api/ops/clients/:id/email/verify",
    auth: "session",
    roles: OPS,
    summary: "Ask Resend to check the client's DNS records, and send from its domain once verified",
    params: ClientParams,
    response: EmailResponse,
  }),
  // Portal: the client admin binds people to its agents' roles and sets conditions.
  portalAgentPeople: defineRoute({
    method: "GET",
    path: "/api/people",
    auth: "session",
    roles: CLIENT_ADMIN,
    summary: "Your agents' roles and the people bound to them",
    response: z.object({ items: z.array(AgentPeople) }),
  }),
  portalSetAgentPeople: defineRoute({
    method: "PUT",
    path: "/api/people/:id",
    auth: "session",
    roles: CLIENT_ADMIN,
    summary: "Bind people to one of your agent's roles, with conditions",
    params: AgentParams,
    body: z.strictObject({ people: PeopleBindings }),
    response: z.object({ people: AgentPeople }),
  }),
} as const;
