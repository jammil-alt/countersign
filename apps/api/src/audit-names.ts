// The audit log with names (overnight S6.9, QA SC2): for a page of audit rows, what each id in a
// row's target names ("Bill clerk" for an agent, "Demo client" for a client, "Bill clerk run" for
// a run) and who each actor is by name. Read in the operator's scope, so an id of a client the
// operator doesn't serve stays an id. Nothing in `audit_event` is changed (invariant 14).

import { type AuditSubject, auditTargetSubjects, isUuid } from "@countersign/core";
import {
  agent,
  appUser,
  build,
  document,
  inboxItem,
  issue,
  run,
  type Tx,
  tenant,
} from "@countersign/db";
import { eq, inArray } from "drizzle-orm";

interface AuditRowIn {
  id: string;
  action: string;
  actorUserId: string | null;
  target: unknown;
}

const agentName = (a: { name: string; serviceName: string | null }) =>
  a.serviceName?.trim() || a.name;

/** Each subject's names, by id, for the ids asked. */
async function namesOf(
  tx: Tx,
  ids: Record<AuditSubject, Set<string>>,
): Promise<Record<AuditSubject, Map<string, string>>> {
  const list = (s: AuditSubject) => [...ids[s]];
  const map = <T>(rows: T[], key: (r: T) => string, name: (r: T) => string) =>
    new Map(rows.map((r) => [key(r), name(r)]));
  const [clients, agents, runs, items, documents, builds, users, issues] = await Promise.all([
    list("client").length
      ? tx
          .select({ id: tenant.id, name: tenant.name })
          .from(tenant)
          .where(inArray(tenant.id, list("client")))
      : [],
    list("agent").length
      ? tx
          .select({ id: agent.id, name: agent.name, serviceName: agent.serviceName })
          .from(agent)
          .where(inArray(agent.id, list("agent")))
      : [],
    list("run").length
      ? tx
          .select({ id: run.id, name: agent.name, serviceName: agent.serviceName })
          .from(run)
          .innerJoin(agent, eq(agent.id, run.agentId))
          .where(inArray(run.id, list("run")))
      : [],
    list("item").length
      ? tx
          .select({ id: inboxItem.id, title: inboxItem.title })
          .from(inboxItem)
          .where(inArray(inboxItem.id, list("item")))
      : [],
    list("document").length
      ? tx
          .select({ id: document.id, filename: document.filename })
          .from(document)
          .where(inArray(document.id, list("document")))
      : [],
    list("build").length
      ? tx
          .select({ id: build.id, title: build.title })
          .from(build)
          .where(inArray(build.id, list("build")))
      : [],
    list("user").length
      ? tx
          .select({ id: appUser.id, name: appUser.name, email: appUser.email })
          .from(appUser)
          .where(inArray(appUser.id, list("user")))
      : [],
    list("issue").length
      ? tx
          .select({ id: issue.id, number: issue.number, title: issue.title })
          .from(issue)
          .where(inArray(issue.id, list("issue")))
      : [],
  ]);
  return {
    client: map(
      clients,
      (r) => r.id,
      (r) => r.name,
    ),
    agent: map(agents, (r) => r.id, agentName),
    run: map(
      runs,
      (r) => r.id,
      (r) => `${agentName(r)} run`,
    ),
    item: map(
      items,
      (r) => r.id,
      (r) => r.title,
    ),
    document: map(
      documents,
      (r) => r.id,
      (r) => r.filename,
    ),
    build: map(
      builds,
      (r) => r.id,
      (r) => r.title,
    ),
    user: map(
      users,
      (r) => r.id,
      (r) => r.name?.trim() || r.email,
    ),
    issue: map(
      issues,
      (r) => r.id,
      (r) => `#${r.number} ${r.title}`,
    ),
  };
}

/**
 * For each row, its target's ids by name (`{ id: "Bill clerk run", client: "Demo client" }`),
 * and each actor's name by user id. An id that names nothing found is left out.
 */
export async function auditNames(
  tx: Tx,
  rows: readonly AuditRowIn[],
): Promise<{ targets: Map<string, Record<string, string>>; actors: Map<string, string> }> {
  const ids: Record<AuditSubject, Set<string>> = {
    client: new Set(),
    agent: new Set(),
    run: new Set(),
    item: new Set(),
    document: new Set(),
    build: new Set(),
    user: new Set(),
    issue: new Set(),
  };
  const wanted = rows.map((r) => {
    const target = (typeof r.target === "object" && r.target !== null ? r.target : {}) as Record<
      string,
      unknown
    >;
    const subjects = auditTargetSubjects(r.action);
    const pairs: [string, AuditSubject, string][] = [];
    for (const [key, subject] of Object.entries(subjects)) {
      const value = target[key];
      if (typeof value !== "string" || !isUuid(value)) continue;
      ids[subject].add(value);
      pairs.push([key, subject, value]);
    }
    if (r.actorUserId) ids.user.add(r.actorUserId);
    return { id: r.id, pairs };
  });
  const names = await namesOf(tx, ids);
  const targets = new Map<string, Record<string, string>>();
  for (const w of wanted) {
    const out: Record<string, string> = {};
    for (const [key, subject, value] of w.pairs) {
      const name = names[subject].get(value);
      if (name) out[key] = name;
    }
    targets.set(w.id, out);
  }
  return { targets, actors: names.user };
}
