import { z } from "zod";
import { isUuid } from "../ids";
import { Role } from "../roles";
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

export const InviteBody = z.strictObject({
  email: z.string().trim().toLowerCase().max(INVITE_EMAIL_MAX).email(),
  name: z.string().trim().max(200).optional(),
  role: InvitableRole,
});
export type InviteBody = z.infer<typeof InviteBody>;

/** A person in a client. */
export const Member = z.object({
  userId: z.string(),
  email: z.string(),
  name: z.string().nullable(),
  role: Role,
  /** Whether they have signed in yet; null where sign-in can't tell (the dev sign-in). */
  signedIn: z.boolean().nullable(),
});
export type Member = z.infer<typeof Member>;

/** The invitation email: sent, not needed, or failed (the invite itself stands either way). */
export const InviteEmail = z.object({
  status: z.enum(["sent", "not_sent", "failed"]),
  /** `dev_sign_in`, `already_signed_up`, or the provider's error code. */
  reason: z.string().nullable(),
});
export type InviteEmail = z.infer<typeof InviteEmail>;

export const InviteResult = z.object({ member: Member, email: InviteEmail });
export type InviteResult = z.infer<typeof InviteResult>;

/** Stored only: notification emails come with M11 and stay off until then. */
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
  /** False until Mezonas sends notification emails (M11): the settings are stored only. */
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
    summary: "Change a client's name, timezone or who approves its external actions",
    params: IdParams,
    body: z.strictObject({
      name: z.string().trim().min(1).max(200).optional(),
      timezone: z.string().trim().min(1).max(100).optional(),
      approvals: ExternalApprover.optional(),
      /** Why approvals changed (kept in the client's change log). */
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
  portalUsers: defineRoute({
    method: "GET",
    path: "/api/users",
    auth: "session",
    roles: ADMIN,
    summary: "The people in your business who use the portal",
    response: z.object({ users: z.array(Member) }),
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
    summary: "Choose which emails we send (stored; emails start later)",
    body: z.strictObject({
      itemsWaiting: z.boolean().optional(),
      weeklyDigest: z.boolean().optional(),
    }),
    response: z.object({ notifications: NotificationSettings }),
  }),
} as const;
