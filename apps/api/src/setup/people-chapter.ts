// Getting started's Your people (docs/setup-plan.md §4.2; docs/plan.md §1.185, SU2): each seat the
// client's agents declare (who approves, answers, is told or contacted), merged across the agents
// so a seat two agents share is filled once; who is in it; and "We think" from the client's own
// intake answers, matched to its members by name in code (never a model). Filling a seat writes the
// same people to every agent that declares it, through the registry's `setPeople`, which checks
// each person (a member who can see the agent; one who can sign, for a seat that signs).
//
// Owner, §1.185 q1: once an agent's trial has started, a change to who signs applies at once and
// leaves the lead a to-do; adding a person or a backup tells nobody.

import { agentRoles, setPeople } from "@countersign/agents";
import {
  membersNamedIn,
  type PeopleBinding,
  type PeopleBindings,
  type PeopleChapterView,
  type PersonRole,
  readTenantGuide,
  type SeatBody,
  type SeatContact,
  type SeatMember,
  type SeatView,
  seatKindOf,
  seatLabelOf,
} from "@countersign/core";
import {
  agent,
  appUser,
  contact,
  intake,
  intakeAnswer,
  membership,
  type Tx,
  tenant,
  withOperator,
} from "@countersign/db";
import { leadOf } from "@countersign/threads";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { HttpError } from "../http";
import { addTodo } from "../work/todos-store";

type AgentRow = typeof agent.$inferSelect;
type Db = Parameters<typeof withOperator>[0];

/** The intake's questions whose answers name the client's people. */
// DECISION: the general section's "who approves" and "who does what", and each area's "who does
// it today", newest answer first; any other answer is never read for names.
const PEOPLE_FIELDS = (key: string) =>
  key === "general.approver" || key === "general.team" || /^area\.[a-z_]+\.who$/.test(key);

/** The client's active agents and the roles each declares (live version, else latest). */
export async function seatAgents(
  tx: Tx,
  tenantId: string,
): Promise<{ row: AgentRow; roles: PersonRole[] }[]> {
  const rows = await tx
    .select()
    .from(agent)
    .where(
      and(
        eq(agent.tenantId, tenantId),
        eq(agent.kind, "client"),
        eq(agent.status, "active"),
        eq(agent.testCopy, false),
      ),
    )
    .orderBy(agent.name);
  const out: { row: AgentRow; roles: PersonRole[] }[] = [];
  for (const row of rows) {
    if (row.runStatus === "retired") continue;
    const roles = (await agentRoles(tx, row)).filter((r) => seatKindOf(r) !== "reached");
    if (roles.length) out.push({ row, roles });
  }
  return out;
}

const agentName = (row: AgentRow) => row.serviceName ?? row.name;
const same = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((v, i) => v === b[i]);

async function membersOf(tx: Tx, tenantId: string, meId: string): Promise<SeatMember[]> {
  const rows = await tx
    .select({
      userId: membership.userId,
      role: membership.role,
      canSign: membership.canSign,
      name: appUser.name,
      email: appUser.email,
      workosUserId: appUser.workosUserId,
    })
    .from(membership)
    .innerJoin(appUser, eq(appUser.id, membership.userId))
    .where(
      and(
        eq(membership.tenantId, tenantId),
        inArray(membership.role, ["client_admin", "client_user"]),
      ),
    )
    .orderBy(appUser.name);
  return rows.map((r) => ({
    userId: r.userId,
    name: r.name,
    email: r.email,
    role: r.role as "client_admin" | "client_user",
    canSign: r.role === "client_admin" || r.canSign,
    joined: r.workosUserId !== null,
    me: r.userId === meId,
  }));
}

async function contactsOf(tx: Tx, tenantId: string): Promise<SeatContact[]> {
  const rows = await tx
    .select({ id: contact.id, name: contact.name, email: contact.email, phone: contact.phone })
    .from(contact)
    .where(eq(contact.tenantId, tenantId))
    .orderBy(contact.name)
    .limit(500);
  return rows.map((c) => ({
    id: c.id,
    name: c.name,
    email: c.email,
    reachable: [...(c.email ? (["email"] as const) : []), ...(c.phone ? (["sms"] as const) : [])],
  }));
}

/** The client's answers that name its people, newest first, as plain text. */
async function peopleAnswers(tx: Tx, tenantId: string): Promise<string[]> {
  const rows = await tx
    .select({ fieldKey: intakeAnswer.fieldKey, value: intakeAnswer.value })
    .from(intakeAnswer)
    .innerJoin(intake, and(eq(intake.id, intakeAnswer.intakeId), eq(intake.tenantId, tenantId)))
    .where(
      and(
        eq(intakeAnswer.tenantId, tenantId),
        inArray(intakeAnswer.state, ["answered", "confirmed", "corrected"]),
      ),
    )
    .orderBy(desc(intakeAnswer.createdAt))
    .limit(200);
  return rows
    .filter((r) => PEOPLE_FIELDS(r.fieldKey) && typeof r.value === "string")
    .map((r) => r.value as string);
}

/**
 * "We think" for a seat: the first answer that names someone, matched to the members who may sit
 * in it (signers for a seat that signs). For a seat that signs, the answer to "who approves" first.
 */
function weThink(
  seat: { kind: string; label: string; role: string },
  answers: readonly string[],
  members: readonly SeatMember[],
): SeatView["weThink"] {
  const eligible = members.filter((m) => seat.kind !== "signs" || m.canSign);
  for (const text of answers) {
    const ids = membersNamedIn(text, eligible);
    if (ids.length) return { userIds: ids.slice(0, 3), from: text.slice(0, 300) };
  }
  return null;
}

/** Your people, for the person reading. */
export async function peopleChapter(
  tx: Tx,
  input: { tenantId: string; userId: string; canEdit: boolean },
): Promise<PeopleChapterView> {
  const agents = await seatAgents(tx, input.tenantId);
  const members = await membersOf(tx, input.tenantId, input.userId);
  const [contacts, answers, settings] = await Promise.all([
    contactsOf(tx, input.tenantId),
    peopleAnswers(tx, input.tenantId),
    tx.select({ settings: tenant.settings }).from(tenant).where(eq(tenant.id, input.tenantId)),
  ]);
  const byRole = new Map<string, SeatView>();
  for (const { row, roles } of agents) {
    const people = row.people as Record<string, Partial<PeopleBinding>>;
    for (const r of roles) {
      const b = people[r.role];
      const userIds = [...(b?.userIds ?? [])];
      const backupUserIds = [...(b?.backupUserIds ?? [])];
      const contactIds = [...(b?.contactIds ?? [])];
      const seen = byRole.get(r.role);
      if (!seen) {
        byRole.set(r.role, {
          role: r.role,
          label: seatLabelOf(r),
          kind: seatKindOf(r),
          description: r.description,
          required: r.required,
          agents: [{ id: row.id, name: agentName(row) }],
          userIds,
          backupUserIds,
          contactIds,
          weThink: null,
          filled: true,
        });
        continue;
      }
      seen.agents.push({ id: row.id, name: agentName(row) });
      seen.required ||= r.required;
      // Agents that hold different people: the seat reads as the first's, and not filled, so a
      // save writes the same people to all of them.
      if (
        !same(seen.userIds, userIds) ||
        !same(seen.backupUserIds, backupUserIds) ||
        !same(seen.contactIds, contactIds)
      ) {
        seen.filled = false;
      }
    }
  }
  const seats = [...byRole.values()].map((s) => {
    const empty = s.userIds.length + s.contactIds.length === 0;
    return {
      ...s,
      filled: s.filled && !empty,
      weThink: empty && s.kind !== "told" ? weThink(s, answers, members) : null,
    };
  });
  const guide = readTenantGuide(settings[0]?.settings);
  return {
    seats,
    members,
    contacts,
    canEdit: input.canEdit,
    confirmed: guide.people ? { byName: guide.people.byName ?? "", at: guide.people.at } : null,
  };
}

/**
 * Puts people in a seat on every agent that declares it. Lists left out are kept. Returns the
 * agents whose trial had started and whose signers changed, for the lead's to-do.
 */
export async function fillSeat(
  tx: Tx,
  input: {
    tenantId: string;
    role: string;
    body: SeatBody;
    actorId: string;
  },
): Promise<{ changedLive: { agentId: string; name: string }[]; label: string }> {
  const agents = (await seatAgents(tx, input.tenantId)).filter((a) =>
    a.roles.some((r) => r.role === input.role),
  );
  if (agents.length === 0) throw new HttpError(404, "not_found", "no agent has that seat");
  const changedLive: { agentId: string; name: string }[] = [];
  let label = input.role;
  for (const { row, roles } of agents) {
    const role = roles.find((r) => r.role === input.role) as PersonRole;
    label = seatLabelOf(role);
    const people = { ...(row.people as unknown as PeopleBindings) };
    const before = people[input.role];
    const next = {
      contactIds: input.body.contactIds ?? before?.contactIds ?? [],
      conditions: before?.conditions ?? {},
      userIds: input.body.userIds ?? before?.userIds ?? [],
      backupUserIds: input.body.backupUserIds ?? before?.backupUserIds ?? [],
    };
    people[input.role] = next;
    try {
      await setPeople(tx, {
        agentId: row.id,
        tenantId: input.tenantId,
        actorId: input.actorId,
        by: "client",
        people,
      });
    } catch (error) {
      // The registry's reasons name people by id; say it in words.
      const message = error instanceof Error ? error.message : String(error);
      if (/can't sign/.test(message)) {
        throw new HttpError(
          422,
          "not_a_signer",
          "That person can only view, so they can't approve.",
        );
      }
      if (/can't see this agent/.test(message)) {
        throw new HttpError(422, "not_assigned", `That person doesn't see ${agentName(row)}.`);
      }
      if (/not one of this client's/.test(message)) {
        throw new HttpError(
          422,
          "not_a_member",
          "That person isn't on your team yet: invite them first.",
        );
      }
      if (/needs people who sign in|is for contacts/.test(message)) {
        throw new HttpError(422, "wrong_kind", message);
      }
      throw error;
    }
    const removed = (before?.userIds ?? []).some((id) => !next.userIds.includes(id));
    const started = row.stage === "trial" || row.stage === "signoff" || row.stage === "live";
    if (seatKindOf(role) === "signs" && started && removed) {
      changedLive.push({ agentId: row.id, name: agentName(row) });
    }
  }
  return { changedLive, label };
}

/** Owner, §1.185 q1: the lead hears about a change to who signs, once the trial has started. */
export async function tellLeadSeatChanged(
  db: Db,
  input: {
    tenantId: string;
    clientName: string;
    label: string;
    byName: string;
    agents: readonly { agentId: string; name: string }[];
  },
): Promise<void> {
  if (input.agents.length === 0) return;
  await withOperator(db, [input.tenantId], async (tx) => {
    const lead = await leadOf(tx, input.tenantId);
    const names = input.agents.map((a) => a.name).join(", ");
    await addTodo(tx, {
      title: `${input.clientName} changed who signs: ${input.label}`,
      owner: "operator",
      ownerUserId: lead?.userId ?? null,
      clientId: input.tenantId,
      about: { kind: "client", id: input.tenantId },
      source: "system",
      why: `${input.byName} changed it while ${names} ${input.agents.length === 1 ? "is" : "are"} past setup.`,
      detail: "It applied at once. Check the new person can answer in time.",
      dueAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      dedupeKey: `seat-changed:${input.tenantId}:${input.label}:${new Date().toISOString().slice(0, 13)}`,
    });
  });
}

/** "Looks right" on Your people, kept on the client. */
export async function confirmPeople(
  tx: Tx,
  input: { tenantId: string; userId: string; name: string | null },
): Promise<void> {
  const value = { by: input.userId, byName: input.name, at: new Date().toISOString() };
  await tx
    .update(tenant)
    .set({
      settings: sql`jsonb_set(coalesce(${tenant.settings}, '{}'::jsonb), '{setupGuide}', coalesce(${tenant.settings} -> 'setupGuide', '{}'::jsonb) || jsonb_build_object('people', ${JSON.stringify(value)}::jsonb))`,
    })
    .where(eq(tenant.id, input.tenantId));
}
