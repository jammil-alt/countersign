// The client's open requests about its agents (docs/plan.md §1.124: an issue for a problem, an ask
// for an idea), for Go live's "Still open" and the Setup tab's change asks. Read inside the
// caller's transaction, one client at a time (invariant 1).
import { readAgentGuide } from "@countersign/core";
import { agent, appUser, clientAsk, issue, type Tx } from "@countersign/db";
import { and, desc, eq, inArray, ne } from "drizzle-orm";

// DECISION: a request counts as the client's when one of its people raised it, from the portal,
// Sloan, email, feedback, a trial's rejection or a request from before §1.124. Ours (an operator's,
// Reggie's, an error report, a security check in review) are not change asks.
const CLIENT_ISSUE_SOURCES = [
  "portal",
  "sloan",
  "email",
  "feedback",
  "trial_rejection",
  "legacy_request",
] as const;
const CLIENT_ASK_SOURCES = [...CLIENT_ISSUE_SOURCES, "question"] as const;

export interface OpenAsk {
  id: string;
  /** An issue's number; null for an ask (an idea), which has none. */
  number: number | null;
  agentId: string | null;
  title: string;
  text: string;
  raisedBy: string | null;
  raisedByName: string | null;
  at: Date;
  /** The step it is about, when the walkthrough or a try filed it. */
  stepId: string | null;
}

/**
 * The open issues and asks about these agents that the client's people raised, newest first.
 * `raisedBy` narrows them to one person's (a client user reads only their own, as on Requests).
 */
export async function openAsks(
  tx: Tx,
  input: { tenantId: string; agentIds: readonly string[]; raisedBy?: string },
): Promise<OpenAsk[]> {
  if (input.agentIds.length === 0) return [];
  const ids = [...input.agentIds];
  const issues = await tx
    .select()
    .from(issue)
    .where(
      and(
        eq(issue.tenantId, input.tenantId),
        inArray(issue.agentId, ids),
        ne(issue.stage, "closed"),
        inArray(issue.source, [...CLIENT_ISSUE_SOURCES]),
        ...(input.raisedBy ? [eq(issue.raisedBy, input.raisedBy)] : []),
      ),
    )
    .orderBy(desc(issue.createdAt))
    .limit(100);
  const asks = await tx
    .select()
    .from(clientAsk)
    .where(
      and(
        eq(clientAsk.tenantId, input.tenantId),
        inArray(clientAsk.agentId, ids),
        inArray(clientAsk.status, ["open", "grouped"]),
        inArray(clientAsk.source, [...CLIENT_ASK_SOURCES]),
        ...(input.raisedBy ? [eq(clientAsk.raisedBy, input.raisedBy)] : []),
      ),
    )
    .orderBy(desc(clientAsk.createdAt))
    .limit(100);

  // The step each was filed on: the walkthrough's marks and the tries' verdicts keep the request.
  const steps = new Map<string, string>();
  const rows = await tx
    .select({ stageState: agent.stageState })
    .from(agent)
    .where(and(eq(agent.tenantId, input.tenantId), inArray(agent.id, ids)));
  for (const r of rows) {
    const guide = readAgentGuide(r.stageState);
    for (const [stepId, mark] of Object.entries(guide.marks ?? {})) {
      if (mark.requestId) steps.set(mark.requestId, stepId);
    }
    for (const t of guide.tries ?? []) {
      for (const [stepId, v] of Object.entries(t.verdicts ?? {})) {
        if (v.requestId) steps.set(v.requestId, stepId);
      }
    }
  }

  const people = [
    ...new Set(
      [...issues.map((i) => i.raisedBy), ...asks.map((a) => a.raisedBy)].filter(
        (v): v is string => !!v,
      ),
    ),
  ];
  const names = new Map<string, string>();
  if (people.length) {
    for (const u of await tx
      .select({ id: appUser.id, name: appUser.name, email: appUser.email })
      .from(appUser)
      .where(inArray(appUser.id, people))) {
      names.set(u.id, u.name?.trim() || u.email);
    }
  }
  const out: OpenAsk[] = [
    ...issues.map((i) => ({
      id: i.id,
      number: i.number,
      agentId: i.agentId,
      title: i.title,
      text: i.description || i.title,
      raisedBy: i.raisedBy,
      raisedByName: i.raisedBy ? (names.get(i.raisedBy) ?? null) : null,
      at: i.createdAt,
      stepId: steps.get(i.id) ?? null,
    })),
    ...asks.map((a) => ({
      id: a.id,
      number: null,
      agentId: a.agentId,
      title: a.title,
      text: a.text,
      raisedBy: a.raisedBy,
      raisedByName: a.raisedBy ? (names.get(a.raisedBy) ?? null) : null,
      at: a.createdAt,
      stepId: steps.get(a.id) ?? null,
    })),
  ];
  return out.sort((a, b) => b.at.getTime() - a.at.getTime());
}
