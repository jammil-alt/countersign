// A client user limited to some agents (docs/plan.md §1.122): the portal routes they may still
// use. Everything else in the portal is refused for them (403 `not_assigned`), so a section that
// isn't about their agents (the client's tools, contacts, records, reports, settings) is closed at
// the API as well as hidden in the app. The routes listed here that name an agent, a run or an
// item answer only for the agents on their list (apps/api checks each one).
//
// DECISION: an allowlist, not a denylist: a new portal route is closed to a limited client user
// until someone decides it belongs here. The entries are "METHOD path" so this file needs no route
// specs (routes.ts imports it); a core test checks each one names a real portal route.

/** "METHOD path" of each portal route a client user limited to some agents may use. */
export const ASSIGNED_USER_ROUTES: readonly string[] = [
  // Who they are, their own settings and their phones.
  "GET /api/session",
  "GET /api/connectors",
  "PUT /api/me/language",
  "GET /api/translation",
  "GET /api/me/devices",
  "POST /api/me/devices",
  "PATCH /api/me/devices/:id",
  "DELETE /api/me/devices/:id",
  "GET /api/settings/my-hours",
  "PUT /api/settings/my-hours",
  "GET /api/settings/my-notifications",
  "PUT /api/settings/my-notifications",
  "GET /api/settings/my-push",
  "PUT /api/settings/my-push",
  "GET /api/settings/business-hours",
  "POST /api/transcribe",
  // Telling us something is wrong.
  "POST /api/feedback",
  "GET /api/feedback/status",
  "PUT /api/feedback/:id/screenshot",
  // The team they work with (names and what each signs; no access settings).
  "GET /api/team",
  // Home: their agents now and what waits on them.
  "GET /api/overview",
  "GET /api/table",
  // Their agents.
  "GET /api/services/:id",
  "GET /api/services/:id/view",
  "GET /api/services/:id/run-forms",
  "GET /api/services/:id/triggers",
  // Its manual (docs/builder-plan.md §5): read only; the Manual tab shows for everyone who sees
  // the agent, so a limited user's agent answers and another agent is "not found" (docs/sop-plan.md S0).
  "GET /api/services/:id/manual",
  // Its SOP (docs/sop-plan.md S1), which takes the Manual tab's place: read only, as the manual.
  "GET /api/services/:id/sop",
  // Its architecture and security, the SOP's section 14 (docs/agent-assurance-plan.md §5).
  "GET /api/services/:id/assurance",
  "POST /api/services/:id/workflows/:slug/run",
  // Their agents' runs.
  "GET /api/runs",
  "GET /api/runs/:id",
  "GET /api/runs/:id/status",
  "GET /api/runs/:id/audit",
  "POST /api/runs/:id/conversations/:stepRunId",
  // Their inbox (items assigned to them, or to client users, for their agents).
  "GET /api/inbox",
  "POST /api/inbox/:id/resolve",
  "POST /api/inbox/:id/snooze",
  "POST /api/inbox/:id/undo",
  "PUT /api/inbox/:id/edit",
  "POST /api/inbox/:id/undo-change",
  "POST /api/inbox/batch/resolve",
  "GET /api/inbox/:id/pack-review",
  "POST /api/inbox/:id/pack-review",
  // §1.164: Confirm matches' look-up, for an item of one of their agents.
  "GET /api/inbox/:id/pack-review/lookup",
  // A document an item or a run shows (by its id; the list of documents stays closed).
  // DECISION (PLATFORM_QA SEC-4, owner 2026-11-20): checked by agent, not only by client: it opens
  // only when a run, step or inbox item of one of their agents names it, else 404
  // (apps/api `ensureSeesDocument`).
  "GET /api/documents/:id",
];

const allowed = new Set(ASSIGNED_USER_ROUTES);

/** Whether a client user limited to some agents may use this route. */
export function assignedUserMayUse(route: { method: string; path: string }): boolean {
  return allowed.has(`${route.method} ${route.path}`);
}

/** Whether a person's agent list lets them see this agent (null: every agent). */
export function seesAgent(agentIds: readonly string[] | null, agentId: string | null): boolean {
  if (agentIds === null) return true;
  return agentId !== null && agentIds.includes(agentId);
}
