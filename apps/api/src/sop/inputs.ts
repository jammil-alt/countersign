// The agent's SOP (docs/sop-plan.md): everything core's `sopView` needs, read for one client agent
// inside the request's one-client scope (invariant 1). Names are resolved within that client only;
// an id that resolves to nobody reads "A person no longer on your team", never the id.

import {
  clientApproverSetting,
  getVersion,
  latestVersion,
  skillContext,
} from "@countersign/agents";
import {
  type AgentBundle,
  type ApproverRule,
  complianceOf,
  isUuid,
  type OwnerArea,
  PeopleBindings,
  processArea,
  processes,
  readApproverRuleSet,
  type SopConnection,
  type SopInput,
  type SopParty,
  STANDARD_POLICIES,
  sopCode,
} from "@countersign/core";
import {
  agent,
  agentGrant,
  appUser,
  areaOwner,
  areaOwnerVersion,
  connection,
  contact,
  membership,
  type Tx,
  tenant,
} from "@countersign/db";
import { clientModelName } from "@countersign/llm";
import { and, asc, eq, inArray } from "drizzle-orm";
import { clientBusinessHours } from "../hours/hours";
import type { Platform } from "../platform";

type AgentRow = typeof agent.$inferSelect;

const DAY_WORDS: Record<string, string> = {
  mon: "Monday",
  tue: "Tuesday",
  wed: "Wednesday",
  thu: "Thursday",
  fri: "Friday",
  sat: "Saturday",
  sun: "Sunday",
};

/** "Monday to Friday, 08:00 to 18:00 (America/Chicago)" when every open day has the same hours. */
export function hoursWords(hours: {
  tz: string;
  week: Partial<Record<string, { from: string; to: string }[]>>;
}): string {
  const days = Object.keys(DAY_WORDS).filter((d) => (hours.week[d]?.length ?? 0) > 0);
  if (days.length === 0) return `Closed every day (${hours.tz})`;
  const same = days.every(
    (d) => JSON.stringify(hours.week[d]) === JSON.stringify(hours.week[days[0] as string]),
  );
  const span = (d: string) =>
    (hours.week[d] ?? []).map((o) => `${o.from} to ${o.to}`).join(" and ");
  const consecutive = days.every(
    (d, i) =>
      i === 0 ||
      Object.keys(DAY_WORDS).indexOf(d) ===
        Object.keys(DAY_WORDS).indexOf(days[i - 1] as string) + 1,
  );
  if (same && consecutive && days.length > 1) {
    return `${DAY_WORDS[days[0] as string]} to ${DAY_WORDS[days.at(-1) as string]}, ${span(days[0] as string)} (${hours.tz})`;
  }
  return `${days.map((d) => `${DAY_WORDS[d]} ${span(d)}`).join("; ")} (${hours.tz})`;
}

/** The version that runs: the live one, else the version being set up (as the manual reads it). */
export async function sopVersion(tx: Tx, a: AgentRow) {
  const v = a.liveVersionId ? await getVersion(tx, a.liveVersionId) : await latestVersion(tx, a.id);
  if (!v || v.agentId !== a.id) return null;
  return v;
}

/** The SOP's code: the agent's place among the client's agents in its area, oldest first. */
async function codeOf(tx: Tx, a: AgentRow, area: OwnerArea, areaOf: (row: AgentRow) => OwnerArea) {
  const rows = await tx
    .select()
    .from(agent)
    .where(
      and(
        eq(agent.tenantId, a.tenantId as string),
        eq(agent.kind, "client"),
        eq(agent.testCopy, false),
      ),
    )
    .orderBy(asc(agent.createdAt), asc(agent.id));
  const inArea = rows.filter((r) => (r.id === a.id ? area : areaOf(r)) === area);
  return sopCode(area, inArea.findIndex((r) => r.id === a.id) + 1);
}

export interface SopInputOptions {
  /** The reader is the client admin, who alone sees what the agent learned. */
  learned: SopInput["learned"];
  measures: SopInput["measures"];
  settings: SopInput["settings"];
  asOf: Date;
}

/**
 * Everything but the revision and its history: those come from `sop_revision` (./revisions.ts).
 * Null when the agent has no version.
 */
export async function sopInputFor(
  tx: Tx,
  platform: Platform,
  a: AgentRow,
  options: SopInputOptions,
): Promise<{
  input: Omit<SopInput, "revision" | "previous" | "history">;
  versionId: string;
  versionNumber: number;
} | null> {
  const tenantId = a.tenantId as string;
  const v = await sopVersion(tx, a);
  if (!v) return null;
  const bundle = v.bundle as AgentBundle;
  const definition = bundle.definition as AgentBundle["definition"] & {
    area?: string;
  };

  const [t] = await tx.select().from(tenant).where(eq(tenant.id, tenantId));
  if (!t) return null;
  const settings = (t.settings ?? {}) as Record<string, unknown>;

  const { skills } = await skillContext(tx, { tenantId, bundle, catalog: platform.catalog });
  const tools = platform.tools.specs(a.bindings);
  const requiresPacks = (row: { skills?: readonly { skill: string }[] }) => [
    ...new Set((row.skills ?? []).flatMap((s) => skills[s.skill]?.requiresPacks ?? [])),
  ];
  const area = processArea({
    set: a.area,
    declared: definition.area,
    requiresPacks: requiresPacks(definition),
  });
  const areaOf = (row: AgentRow) => processArea({ set: row.area, declared: null });

  // People: the client's members and the contacts the agent names, by id.
  const members = await tx
    .select({
      userId: membership.userId,
      role: membership.role,
      name: appUser.name,
      email: appUser.email,
    })
    .from(membership)
    .innerJoin(appUser, eq(appUser.id, membership.userId))
    .where(eq(membership.tenantId, tenantId));
  const byUser = new Map(members.map((m) => [m.userId, m]));
  const ids = new Set<string>();
  JSON.stringify(bundle, (_k, value) => {
    if (typeof value === "string" && isUuid(value)) ids.add(value);
    return value;
  });
  for (const ids2 of Object.values((a.people ?? {}) as Record<string, { contactIds?: string[] }>)) {
    for (const id of ids2?.contactIds ?? []) ids.add(id);
  }
  const contactIds = [...ids].filter((id) => !byUser.has(id));
  const contacts = contactIds.length
    ? await tx
        .select({ id: contact.id, name: contact.name })
        .from(contact)
        .where(and(eq(contact.tenantId, tenantId), inArray(contact.id, contactIds)))
    : [];
  const byContact = new Map(contacts.map((c) => [c.id, c.name]));
  const leadId = (settings.lead as { userId?: string } | undefined)?.userId ?? null;
  const leadUser = leadId
    ? await tx
        .select({ name: appUser.name, email: appUser.email })
        .from(appUser)
        .where(eq(appUser.id, leadId))
    : [];
  const lead: SopParty | null = leadId
    ? { key: "lead", kind: "person", name: leadUser[0]?.name?.trim() || "Your Mezonas lead" }
    : null;

  const nameOf = (m: { name: string | null; email: string }) => m.name?.trim() || m.email;
  // Setup-plan §4.1: a seat reads as whoever a run would ask: its one person by name, several as
  // "Luis Ortega or Dana Ruiz", and an empty seat as the client admin (where its items go).
  const seats = processes.seatsFromBindings(PeopleBindings.safeParse(a.people ?? {}).data ?? {});
  const party = (who: string): SopParty => {
    const seat = processes.seatRoleOf(who);
    if (seat !== null) {
      const s = seats[seat];
      const ids = [...new Set([...(s?.userIds ?? []), ...(s?.contactIds ?? [])])];
      const [first] = ids;
      if (first === undefined) return party("client_admin");
      if (ids.length === 1) return party(first);
      return { key: who, kind: "team", name: ids.map((id) => party(id).name).join(" or ") };
    }
    if (who === "client_admin")
      return { key: "role:client_admin", kind: "team", name: "Your admin" };
    if (who === "client_user") return { key: "role:client_user", kind: "team", name: "Your team" };
    if (who === "lead") return lead ?? { key: "lead", kind: "person", name: "Your Mezonas lead" };
    if (who === "operator") return { key: "mezonas", kind: "mezonas", name: "Mezonas" };
    if (who.includes("{{"))
      return { key: `run:${who}`, kind: "person", name: "The person the run names" };
    const m = byUser.get(who);
    if (m) {
      if (who === leadId && lead) return lead;
      // Our people are "Mezonas" in the client's SOP; the lead alone by name (as the audit export).
      if (m.role === "operator") return { key: "mezonas", kind: "mezonas", name: "Mezonas" };
      return { key: who, kind: "person", name: nameOf(m) };
    }
    const c = byContact.get(who);
    if (c) return { key: who, kind: "person", name: c };
    if (isUuid(who)) return { key: who, kind: "person", name: "A person no longer on your team" };
    const words = who.replaceAll(/[_-]+/g, " ").trim();
    return {
      key: `role:${who}`,
      kind: "team",
      name: words.charAt(0).toUpperCase() + words.slice(1),
    };
  };

  // Other agents of this client, by slug.
  const siblings = await tx
    .select({ slug: agent.slug, name: agent.name, serviceName: agent.serviceName })
    .from(agent)
    .where(and(eq(agent.tenantId, tenantId), eq(agent.kind, "client"), eq(agent.testCopy, false)));
  const agentParty = (slug: string): SopParty | null => {
    const s = siblings.find((x) => x.slug === slug);
    return s ? { key: `agent:${slug}`, kind: "agent", name: s.serviceName ?? s.name } : null;
  };

  // Accountable: the agent's approver, else the client's admins (docs/sop-plan.md §7, question 2).
  const admins = members.filter((m) => m.role === "client_admin");
  const accountable: SopParty[] =
    a.approver && a.approver !== "client_admin" && a.approver !== "operator"
      ? [party(a.approver)]
      : admins.map((m) => ({ key: m.userId, kind: "person" as const, name: nameOf(m) }));

  // The area's owner, when it exists (it is made the first time the area is used, not by a read).
  const [owner] = await tx
    .select({ name: areaOwner.name, definition: areaOwnerVersion.definition })
    .from(areaOwner)
    .leftJoin(areaOwnerVersion, eq(areaOwnerVersion.id, areaOwner.liveVersionId))
    .where(and(eq(areaOwner.tenantId, tenantId), eq(areaOwner.area, area)));
  const ownerModel = (owner?.definition as { model?: { id?: string } } | null)?.model?.id ?? null;

  // Connections the agent is bound to, and its grants on them.
  const bindings = Object.entries((a.bindings ?? {}) as Record<string, string>);
  const connIds = bindings.map(([, id]) => id).filter((id) => isUuid(id));
  const conns = connIds.length
    ? await tx
        .select()
        .from(connection)
        .where(and(eq(connection.tenantId, tenantId), inArray(connection.id, connIds)))
    : [];
  const grants = connIds.length
    ? await tx
        .select()
        .from(agentGrant)
        .where(
          and(
            eq(agentGrant.tenantId, tenantId),
            eq(agentGrant.agentId, a.id),
            inArray(agentGrant.connectionId, connIds),
          ),
        )
    : [];
  const connections: SopConnection[] = bindings.map(([key, id]) => {
    const c = conns.find((x) => x.id === id);
    const connector = c?.connector ?? key.split(":")[0] ?? key;
    const manifest = platform.connectors.get(connector)?.manifest;
    const config = (c?.config ?? {}) as Record<string, unknown>;
    const by = c?.connectedBy ? byUser.get(c.connectedBy) : undefined;
    return {
      key,
      connector,
      id: c?.id ?? null,
      name: manifest?.name ?? connector,
      account:
        [config.accountName, config.label, config.name].find(
          (x): x is string => typeof x === "string" && x.trim() !== "",
        ) ?? null,
      // DECISION: a connection with an error is still connected for the SOP (its health is the
      // Connectors page's): only never connecting or disconnecting it changes what the SOP says.
      connected: c !== undefined && c.status !== "pending" && c.status !== "disconnected",
      connectedBy: by && by.role !== "operator" ? nameOf(by) : c?.connectedBy ? "Mezonas" : null,
      matrix: (c?.permissions ?? null) as SopConnection["matrix"],
      grant: (grants.find((g) => g.connectionId === id)?.limits ?? null) as SopConnection["grant"],
    };
  });

  // Policies its steps read: ours by what it does (the client's own tagged policies come next).
  const writes = Object.values(tools).some((t) => t.sideEffect === "external");
  const tags = new Set<string>(["security", "data-handling", area]);
  if (writes) tags.add("writing-into-tools");
  const policies = STANDARD_POLICIES.filter((p) => p.tags.some((tag) => tags.has(tag))).map(
    (p) => p.title,
  );

  const rules: readonly ApproverRule[] = readApproverRuleSet(settings).rules;
  const clientApprover = clientApproverSetting(settings);

  return {
    versionId: v.id,
    versionNumber: v.version,
    input: {
      agent: {
        id: a.id,
        slug: a.slug,
        name: a.serviceName ?? a.name,
        area,
        stage: a.stage ?? null,
        runStatus: a.runStatus ?? null,
        approver: a.approver ?? null,
      },
      client: t.name,
      code: await codeOf(tx, a, area, areaOf),
      bundle,
      skills,
      tools,
      connections,
      party,
      agentParty,
      accountable,
      owner: owner
        ? { party: { key: `owner:${area}`, kind: "agent", name: owner.name }, model: ownerModel }
        : null,
      lead,
      approverRules: rules,
      clientApprover,
      businessHours: hoursWords(clientBusinessHours({ timezone: t.timezone, settings }).hours),
      modelName: clientModelName,
      hipaa: complianceOf(settings).hipaa,
      measures: options.measures,
      policies,
      takesOverFrom: [],
      knowledge: [],
      settings: options.settings,
      learned: options.learned,
      fallbackPurpose: a.serviceDescription ?? null,
      asOf: options.asOf.toISOString(),
    },
  };
}
