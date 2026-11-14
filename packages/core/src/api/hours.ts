// R4 (docs/plan.md §1.86, §9; ARCHITECTURE §10.14 "Business hours", "Communications"): the
// client's business hours, each person's own hours and away dates, and the channels agents send
// and listen on.
//
// - Business hours: the client's week (default Monday to Friday, 8 to 6), in the client's zone,
//   with US federal holidays and the client's own closed dates. The client admin sets them; every
//   client person reads them; the operator reads them.
// - Person hours: per client user (their membership) and per directory contact. A person sets
//   their own; the client admin sets anyone's.
// - Channels: every account has a number and an email; an agent may have its own, which wins. The
//   operator sets the account's here; an agent's own stay `/api/ops/agents/:id/channels`
//   (api/reach.ts). The portal reads both.

import { z } from "zod";
import { isUuid } from "../ids";
import { BusinessHours, PersonHours } from "../process/hours";
import { ReachChannel } from "../reach/rules";
import { defineRoute } from "./contract";
import { ChannelBindings, ChannelOption } from "./reach";

const Id = z.string().refine((v) => isUuid(v), "not an id");
const OPS = ["operator"] as const;
const CLIENT = ["client_admin", "client_user"] as const;
const CLIENT_ADMIN = ["client_admin"] as const;

// ── Business hours ──────────────────────────────────────────────────────────────────────────────

/**
 * What the client admin sets: the week, whether US federal holidays are closed, and the closed
 * dates. The zone is the client's own (set with the client's details), so it is not in the body.
 */
// DECISION: one zone per client. Business hours run in the client's timezone (`tenant.timezone`,
// which schedules and quiet hours already use), so they can never disagree; the closed dates are
// the client's existing days off (`tenant.settings.holidays`, which schedules that skip holidays
// already read), so an office closure stops both.
export const BusinessHoursBody = BusinessHours.omit({ tz: true });
export type BusinessHoursBody = z.input<typeof BusinessHoursBody>;

export const ClientBusinessHours = z.object({
  /** The hours in force: the client's own, else the default week in the client's zone. */
  hours: BusinessHours,
  /** True while the client has set no week of its own (Monday to Friday, 8 to 6). */
  isDefault: z.boolean(),
});
export type ClientBusinessHours = z.infer<typeof ClientBusinessHours>;

// ── A person's hours ────────────────────────────────────────────────────────────────────────────

export const PersonKind = z.enum(["user", "contact"]);
export type PersonKind = z.infer<typeof PersonKind>;

/** One person on the client's People list with their hours. */
export const PersonHoursView = z.object({
  kind: PersonKind,
  /** A user id (kind `user`) or a contact id (kind `contact`). */
  id: z.string(),
  name: z.string(),
  /** Their own hours and away dates; null: the client's hours, never away. */
  hours: PersonHours.nullable(),
});
export type PersonHoursView = z.infer<typeof PersonHoursView>;

/** Null clears: the person goes back to the client's hours, never away. */
export const PersonHoursBody = z.strictObject({ hours: PersonHours.nullable() });
export type PersonHoursBody = z.input<typeof PersonHoursBody>;

/**
 * The most contacts the People hours list carries (as the agent People list does). A list with
 * this many may have left some out, so a contact missing from it has hours we don't know.
 */
export const PEOPLE_HOURS_MAX_CONTACTS = 2000;

export const PeopleHours = z.object({
  business: ClientBusinessHours,
  people: z.array(PersonHoursView),
});
export type PeopleHours = z.infer<typeof PeopleHours>;

const OnePerson = z.object({ person: PersonHoursView });

// ── Channels ────────────────────────────────────────────────────────────────────────────────────

/** Where a channel came from: the agent's own, the account's as set, or the account's default. */
export const ChannelSource = z.enum(["agent", "account", "default"]);
export type ChannelSource = z.infer<typeof ChannelSource>;

/** A channel as resolved: the connection that carries it and the number or address it uses. */
export const ChannelLine = z.object({
  kind: ReachChannel,
  connectionId: z.string(),
  connector: z.string(),
  /**
   * The number (E.164) it texts and calls from, or the email address people write to (an agent's
   * own address, §10.8, or the account's forwarding address, on Mezonas' sending; a bound mailbox's
   * own address); null when the connection has none yet.
   */
  address: z.string().nullable(),
  source: ChannelSource,
});
export type ChannelLine = z.infer<typeof ChannelLine>;

export const AgentChannelLines = z.object({
  agentId: z.string(),
  name: z.string(),
  /** What the agent sends on, kind by kind: its own where it has one, else the account's. */
  channels: z.array(ChannelLine),
});
export type AgentChannelLines = z.infer<typeof AgentChannelLines>;

export const PortalChannels = z.object({
  /** The account's number and email, kind by kind (a kind with nothing to carry it is left out). */
  account: z.array(ChannelLine),
  agents: z.array(AgentChannelLines),
});
export type PortalChannels = z.infer<typeof PortalChannels>;

export const OpsClientChannels = z.object({
  clientId: z.string(),
  /** The account's channels as the operator set them; a kind left out takes the default. */
  bindings: ChannelBindings,
  account: z.array(ChannelLine),
  agents: z.array(AgentChannelLines),
  /** Connections of this client that can carry a channel. */
  options: z.array(ChannelOption),
});
export type OpsClientChannels = z.infer<typeof OpsClientChannels>;

const ClientParams = z.object({ id: Id });

export const hoursRoutes = {
  portalBusinessHours: defineRoute({
    method: "GET",
    path: "/api/settings/business-hours",
    auth: "session",
    roles: CLIENT,
    summary: "Your business hours: the week, the zone and the days you are closed",
    response: ClientBusinessHours,
  }),
  portalSetBusinessHours: defineRoute({
    method: "PUT",
    path: "/api/settings/business-hours",
    auth: "session",
    roles: CLIENT_ADMIN,
    summary: "Set your business hours: the week, US holidays and the days you are closed",
    body: BusinessHoursBody,
    response: ClientBusinessHours,
  }),
  portalMyHours: defineRoute({
    method: "GET",
    path: "/api/settings/my-hours",
    auth: "session",
    roles: CLIENT,
    summary: "Your own hours and the days you are away",
    response: OnePerson,
  }),
  portalSetMyHours: defineRoute({
    method: "PUT",
    path: "/api/settings/my-hours",
    auth: "session",
    roles: CLIENT,
    summary: "Set your own hours and the days you are away (null: the business's hours)",
    body: PersonHoursBody,
    response: OnePerson,
  }),
  portalPeopleHours: defineRoute({
    method: "GET",
    path: "/api/settings/people-hours",
    auth: "session",
    roles: CLIENT_ADMIN,
    summary: "Your team's and your contacts' hours and away dates",
    response: PeopleHours,
  }),
  portalSetUserHours: defineRoute({
    method: "PUT",
    path: "/api/settings/people-hours/users/:id",
    auth: "session",
    roles: CLIENT_ADMIN,
    summary: "Set a team member's hours and away dates (null: the business's hours)",
    params: z.object({ id: Id }),
    body: PersonHoursBody,
    response: OnePerson,
  }),
  portalSetContactHours: defineRoute({
    method: "PUT",
    path: "/api/settings/people-hours/contacts/:id",
    auth: "session",
    roles: CLIENT_ADMIN,
    summary: "Set a contact's hours and away dates (null: the business's hours)",
    params: z.object({ id: Id }),
    body: PersonHoursBody,
    response: OnePerson,
  }),
  portalChannels: defineRoute({
    method: "GET",
    path: "/api/settings/channels",
    auth: "session",
    roles: CLIENT,
    summary: "The number and email your account and each of your services send from",
    response: PortalChannels,
  }),
  opsClientHours: defineRoute({
    method: "GET",
    path: "/api/ops/clients/:id/hours",
    auth: "session",
    roles: OPS,
    summary: "A client's business hours and its people's hours and away dates",
    params: ClientParams,
    response: PeopleHours,
  }),
  opsClientChannels: defineRoute({
    method: "GET",
    path: "/api/ops/clients/:id/channels",
    auth: "session",
    roles: OPS,
    summary: "A client account's channels, each agent's, and the connections that can carry them",
    params: ClientParams,
    response: OpsClientChannels,
  }),
  opsSetClientChannels: defineRoute({
    method: "PUT",
    path: "/api/ops/clients/:id/channels",
    auth: "session",
    roles: OPS,
    summary:
      "Bind a client account's email, text, WhatsApp and calling channels to connections (an agent's own win)",
    params: ClientParams,
    body: z.strictObject({ channels: ChannelBindings }),
    response: OpsClientChannels,
  }),
} as const;
