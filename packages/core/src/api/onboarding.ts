import { z } from "zod";
import { isUuid } from "../ids";
import { Role } from "../roles";
import { IanaTimeZone } from "../timezone";
import { defineRoute } from "./contract";

// Onboarding and settings (docs/plan.md §1.14, ARCHITECTURE §14–§15): the back office's overview of
// what needs attention across clients, inviting a client's people, a client's settings (approval
// delegation); the portal's Settings (users, notification settings) for client admins.

const Id = z.string().refine((v) => isUuid(v), "not an id");
const IdParams = z.object({ id: Id });
const OPS = ["operator"] as const;
const ADMIN = ["client_admin"] as const;
const Timestamp = z.string();

/**
 * Who approves a client's external actions by default (`tenant.settings.approvals.external_actions`,
 * ARCHITECTURE §4): the client's admin, or Mezonas on the client's behalf (delegated).
 */
export const ExternalApprover = z.enum(["client_admin", "operator"]);
export type ExternalApprover = z.infer<typeof ExternalApprover>;

/** The roles an invite can give: client users belong to exactly one client. */
export const InvitableRole = z.enum(["client_admin", "client_user"]);
export type InvitableRole = z.infer<typeof InvitableRole>;

export const INVITE_EMAIL_MAX = 320;

/** At most this many agents on one person's list (a client has far fewer). */
export const MEMBER_AGENTS_MAX = 200;

/**
 * Which of the client's agents a client user may see and work on (docs/plan.md §1.122): null for
 * every agent (as before), or a list of client agent ids. Only a client user is ever limited.
 */
export const MemberAgents = z.array(Id).max(MEMBER_AGENTS_MAX).nullable();
export type MemberAgents = z.infer<typeof MemberAgents>;

export const InviteBody = z.strictObject({
  email: z.string().trim().toLowerCase().max(INVITE_EMAIL_MAX).email(),
  name: z.string().trim().max(200).optional(),
  role: InvitableRole,
  // v0.12 W1-D: "can sign" (default yes). A client user who can't is a viewer; a client admin
  // always signs (ARCHITECTURE §4).
  canSign: z.boolean().optional(),
  /** §1.122: the agents a client user may see (omitted or null: every agent). */
  agentIds: MemberAgents.optional(),
});
export type InviteBody = z.infer<typeof InviteBody>;

/**
 * Inviting a person from the directory (2026-11-08): the role and "can sign" only. The email and
 * the name are the contact's, never the body's (strict: an `email` here is refused).
 */
export const ContactInviteBody = z.strictObject({
  role: InvitableRole,
  canSign: z.boolean().optional(),
  agentIds: MemberAgents.optional(),
});
export type ContactInviteBody = z.infer<typeof ContactInviteBody>;

/** A person in a client. */
export const Member = z.object({
  userId: z.string(),
  email: z.string(),
  name: z.string().nullable(),
  role: Role,
  /** Whether they have signed in yet; null where sign-in can't tell (the dev sign-in). */
  signedIn: z.boolean().nullable(),
  /** v0.12 W1-D: false for a viewer, who signs nothing (`membership.can_sign`). */
  canSign: z.boolean().optional(),
  /** §1.122: the agents a client user is limited to; null (or absent) for every agent. */
  agentIds: MemberAgents.optional(),
});
export type Member = z.infer<typeof Member>;

/**
 * Changing a client person's access in place (§1.122): their role, whether they sign, and which
 * agents they see. Omitted fields stay as they are. A client admin always signs and sees every
 * agent, so making someone an admin clears their list.
 */
export const MemberAccessBody = z
  .strictObject({
    role: InvitableRole.optional(),
    canSign: z.boolean().optional(),
    agentIds: MemberAgents.optional(),
  })
  .refine((b) => Object.keys(b).length > 0, "nothing to change");
export type MemberAccessBody = z.infer<typeof MemberAccessBody>;

/** A client agent a person can be given (the Team screen's choices). */
export const AssignableAgent = z.object({ id: z.string(), name: z.string() });
export type AssignableAgent = z.infer<typeof AssignableAgent>;

/** The invitation email: sent, not needed, or failed (the invite itself stands either way). */
export const InviteEmail = z.object({
  status: z.enum(["sent", "not_sent", "failed"]),
  /** `dev_sign_in`, `already_signed_up`, or the provider's error code. */
  reason: z.string().nullable(),
});
export type InviteEmail = z.infer<typeof InviteEmail>;

export const InviteResult = z.object({ member: Member, email: InviteEmail });
export type InviteResult = z.infer<typeof InviteResult>;

/**
 * Removing someone from a client (de-provisioning, docs/security.md §2): their membership goes now,
 * and their access within 5 minutes, since an open session carries memberships in its sealed
 * cookie for up to 5 minutes (docs/plan.md §1.93). Open items assigned to them by name go to the
 * client admin.
 */
export const RemoveMemberResult = z.object({
  removed: z.object({ userId: z.string(), email: z.string() }),
  /** Open inbox items that named them, now the client admin's. */
  reassigned: z.int(),
});
export type RemoveMemberResult = z.infer<typeof RemoveMemberResult>;

/** The client's notification switches (each person also picks their own channels: api/notify.ts). */
export const NotificationSettings = z.object({
  /** Email people when something waits on them in the inbox. */
  itemsWaiting: z.boolean(),
  /** A weekly summary of what the services did. */
  weeklyDigest: z.boolean(),
});
export type NotificationSettings = z.infer<typeof NotificationSettings>;

export const DEFAULT_NOTIFICATIONS: NotificationSettings = {
  itemsWaiting: true,
  weeklyDigest: true,
};

const Person = z.object({ id: z.string(), email: z.string(), name: z.string().nullable() });
const ClientRef = z.object({ id: z.string(), name: z.string() });
const AgentRef = z.object({ id: z.string(), slug: z.string(), name: z.string() });

export const OpsClientSettings = z.object({
  client: z.object({
    id: z.string(),
    name: z.string(),
    timezone: z.string(),
    /** The Sandbox client: the operator's own test client, with no client people. */
    sandbox: z.boolean(),
    /**
     * M43 (docs/plan.md §1.72): one of our own, Mezonas as its own first client: real data, never
     * billed, no Weekly Table. Set by an operator.
     */
    internal: z.boolean(),
  }),
  approvals: z.object({
    externalActions: ExternalApprover,
    /** Newest first. */
    changes: z.array(
      z.object({
        id: z.string(),
        from: ExternalApprover,
        to: ExternalApprover,
        reason: z.string(),
        by: Person.nullable(),
        createdAt: Timestamp,
      }),
    ),
  }),
  notifications: NotificationSettings,
  /** Everyone in the client: its people and the operators who serve it. */
  members: z.array(Member),
  /** §1.122: the client's agents, for choosing which a client user sees. */
  agents: z.array(AssignableAgent).optional(),
});
export type OpsClientSettings = z.infer<typeof OpsClientSettings>;

/** What needs the operator across the clients they serve (lists capped; counts are totals). */
export const OpsOverview = z.object({
  /** Failed live runs are counted from here (the last 7 days). */
  since: Timestamp,
  clients: z.number().int(),
  failedRuns: z.array(
    z.object({
      id: z.string(),
      client: ClientRef,
      agent: AgentRef.nullable(),
      workflowSlug: z.string(),
      error: z.string().nullable(),
      finishedAt: z.string().nullable(),
      createdAt: Timestamp,
    }),
  ),
  /** Open items waiting on the operator: delegated approvals, escalations, person steps. */
  inbox: z.array(
    z.object({
      id: z.string(),
      client: ClientRef,
      kind: z.string(),
      title: z.string(),
      dueAt: z.string().nullable(),
      createdAt: Timestamp,
    }),
  ),
  /** Connections the client has to sign in to again, or that agents use while disconnected. */
  connections: z.array(
    z.object({
      id: z.string(),
      client: ClientRef,
      connector: z.string(),
      connectorName: z.string(),
      status: z.string(),
      usedBy: z.array(z.string()),
    }),
  ),
  /** Client agents whose template has a newer live version. */
  updates: z.array(
    z.object({
      agent: AgentRef,
      client: ClientRef,
      template: z.object({ id: z.string(), name: z.string() }),
      behind: z.number().int(),
      releaseNote: z.string().nullable(),
    }),
  ),
  counts: z.object({
    failedRuns: z.number().int(),
    inbox: z.number().int(),
    connections: z.number().int(),
    updates: z.number().int(),
  }),
});
export type OpsOverview = z.infer<typeof OpsOverview>;

export const PortalSettings = z.object({
  client: z.object({ id: z.string(), name: z.string(), timezone: z.string() }),
  /** Who approves changes to the client's tools by default (the operator sets it). */
  approvals: ExternalApprover,
  notifications: NotificationSettings,
  /** False while Mezonas sends no email here (no sending key set up): rows are skipped. */
  emailsOn: z.boolean(),
});
export type PortalSettings = z.infer<typeof PortalSettings>;

export const onboardingRoutes = {
  opsOverview: defineRoute({
    method: "GET",
    path: "/api/ops/overview",
    auth: "session",
    roles: OPS,
    summary: "What needs attention across the clients this operator serves",
    response: OpsOverview,
  }),
  opsClientSettings: defineRoute({
    method: "GET",
    path: "/api/ops/clients/:id/settings",
    auth: "session",
    roles: OPS,
    summary: "A client's settings: details, approval delegation, notifications, people",
    params: IdParams,
    response: OpsClientSettings,
  }),
  opsUpdateClientSettings: defineRoute({
    method: "PATCH",
    path: "/api/ops/clients/:id/settings",
    auth: "session",
    roles: OPS,
    summary:
      "Change a client's name, timezone, who approves its external actions, or whether it is ours",
    params: IdParams,
    body: z.strictObject({
      name: z.string().trim().min(1).max(200).optional(),
      // QA (runs and dates): an IANA zone, checked here; the screen offers them as a list.
      timezone: IanaTimeZone.optional(),
      approvals: ExternalApprover.optional(),
      /** M43: whether the client is one of our own (`tenant.settings.internal`). */
      internal: z.boolean().optional(),
      /** Why approvals or the internal flag changed (kept in the client's change log). */
      reason: z.string().trim().max(500).optional(),
    }),
    response: OpsClientSettings,
  }),
  opsInvite: defineRoute({
    method: "POST",
    path: "/api/ops/clients/:id/invites",
    auth: "session",
    roles: OPS,
    summary: "Invite a client admin or user to a client; they sign in with that address",
    params: IdParams,
    body: InviteBody,
    response: InviteResult,
  }),
  opsRemoveMember: defineRoute({
    method: "DELETE",
    path: "/api/ops/clients/:id/members/:userId",
    auth: "session",
    roles: OPS,
    summary: "Remove a client admin or user from a client; they lose access within 5 minutes",
    params: z.object({ id: Id, userId: Id }),
    response: RemoveMemberResult,
  }),
  // DECISION: inviting from the directory has its own routes (one per surface) that read the
  // contact, check `canInviteContact` and then run the same invite as the email form; the existing
  // invite routes keep their body as it is.
  opsContactInvite: defineRoute({
    method: "POST",
    path: "/api/ops/clients/:id/contacts/:contactId/invite",
    auth: "session",
    roles: OPS,
    summary: "Invite one of a client's own people from its directory to sign in",
    params: z.object({ id: Id, contactId: Id }),
    body: ContactInviteBody,
    response: InviteResult,
  }),
  portalContactInvite: defineRoute({
    method: "POST",
    path: "/api/contacts/:id/invite",
    auth: "session",
    roles: ADMIN,
    summary: "Invite one of your own people from your directory to the portal",
    params: IdParams,
    body: ContactInviteBody,
    response: InviteResult,
  }),
  opsUpdateMember: defineRoute({
    method: "PATCH",
    path: "/api/ops/clients/:id/members/:userId",
    auth: "session",
    roles: OPS,
    summary: "Change a client person's role, whether they sign, and which agents they see",
    params: z.object({ id: Id, userId: Id }),
    body: MemberAccessBody,
    response: z.object({ member: Member }),
  }),
  portalUsers: defineRoute({
    method: "GET",
    path: "/api/users",
    auth: "session",
    roles: ADMIN,
    summary: "The people in your business who use the portal, and the agents you can give them",
    response: z.object({
      users: z.array(Member),
      /** §1.122: the client's agents, for choosing which a client user sees. */
      agents: z.array(AssignableAgent).optional(),
    }),
  }),
  portalUpdateUser: defineRoute({
    method: "PATCH",
    path: "/api/users/:id",
    auth: "session",
    roles: ADMIN,
    summary: "Change someone's role, whether they approve, and which agents they see",
    params: IdParams,
    body: MemberAccessBody,
    response: z.object({ member: Member }),
  }),
  portalInvite: defineRoute({
    method: "POST",
    path: "/api/users",
    auth: "session",
    roles: ADMIN,
    summary: "Invite someone from your business to the portal",
    body: InviteBody,
    response: InviteResult,
  }),
  portalRemoveUser: defineRoute({
    method: "DELETE",
    path: "/api/users/:id",
    auth: "session",
    roles: ADMIN,
    summary: "Remove someone from your business's portal; they lose access within 5 minutes",
    params: IdParams,
    response: RemoveMemberResult,
  }),
  portalSettings: defineRoute({
    method: "GET",
    path: "/api/settings",
    auth: "session",
    roles: ADMIN,
    summary: "Your settings: notifications, and who approves changes to your tools",
    response: PortalSettings,
  }),
  portalNotifications: defineRoute({
    method: "PATCH",
    path: "/api/settings/notifications",
    auth: "session",
    roles: ADMIN,
    summary: "Choose which notifications we send your people",
    body: z.strictObject({
      itemsWaiting: z.boolean().optional(),
      weeklyDigest: z.boolean().optional(),
    }),
    response: z.object({ notifications: NotificationSettings }),
  }),
} as const;
