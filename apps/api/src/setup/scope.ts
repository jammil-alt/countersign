// Getting started's Go live (docs/setup-plan.md §7; docs/plan.md §1.199, SU6): stream LIVE. The scope
// in the client's words, read from what the chapters already settled: what it does (its
// description), what it reads and may change (the SOP's systems and data, made by code from the
// version: `sopInputFor` and core's `sopView`, the same reader as the SOP tab), who signs and who
// answers (its seats with the people in them), the settings the client chose, and their open
// requests about it. The client admin signs it for one version; a new version is signed again.
// Signing never starts the trial: the operator does (§7; invariant 8). Nothing of ours (invariant
// 11): no bundle, prompt, cost or seat role beyond its label.

import {
  type AnyAgentBundle,
  adjustView,
  type PersonRole,
  readAgentGuide,
  type ScopeView,
  SETUP_TRIAL_DAYS,
  type SetupLeft,
  type SopView,
  seatKindOf,
  seatLabelOf,
  sopView,
} from "@countersign/core";
import { agent, appUser, membership, type Tx } from "@countersign/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import { HttpError, notFound } from "../http";
import type { Platform } from "../platform";
import { sopInputFor, sopVersion } from "../sop/inputs";
import { openAsks } from "./asks";

type AgentRow = typeof agent.$inferSelect;

export interface ScopeInput {
  tenantId: string;
  agentId: string;
  userId: string;
  name: string | null;
  isAdmin: boolean;
  /** The SOP's reader needs the platform's skills, tools and connectors. */
  platform: Platform;
}

const LIST = new Intl.ListFormat("en", { style: "long", type: "conjunction" });
const OR = new Intl.ListFormat("en", { style: "long", type: "disjunction" });

/** "bills": a record's name as the SOP writes it ("Bill"), plural and in lower case. */
function plural(record: string): string {
  const w = record.trim().toLowerCase();
  if (w.endsWith("s")) return w;
  if (/[^aeiou]y$/.test(w)) return `${w.slice(0, -1)}ies`;
  return `${w}s`;
}

/** "Your QuickBooks Online" → "your QuickBooks Online", for the middle of a sentence. */
const lower = (s: string) => (s.startsWith("Your ") ? `your ${s.slice(5)}` : s);

/** The client agent the portal names, or 404 (another client's, a test copy, a template). */
async function clientAgent(tx: Tx, tenantId: string, agentId: string, lock = false) {
  const q = tx
    .select()
    .from(agent)
    .where(and(eq(agent.id, agentId), eq(agent.tenantId, tenantId), eq(agent.kind, "client")));
  const [row] = lock ? await q.for("update") : await q;
  if (!row || row.testCopy) throw notFound("service");
  return row;
}

/** What it reads, by where it lives: "Your QuickBooks Online: bills and vendors". */
// DECISION: the scope's reads and changes are the SOP's data and systems, grouped by where they
// live, so the scope says what the SOP says; records the agent only saves in Mezonas are left out
// (they are ours to keep, not the client's tools).
function readsOf(sop: SopView): string[] {
  const by = new Map<string, string[]>();
  for (const d of sop.data) {
    if (!/reads/i.test(d.agentDoes)) continue;
    const list = by.get(d.livesIn) ?? [];
    const w = plural(d.record);
    if (!list.includes(w)) list.push(w);
    by.set(d.livesIn, list);
  }
  return [...by].map(([where, records]) => `${where}: ${LIST.format(records)}`);
}

/** What it may change, and whether it asks first: "Change bills in your QuickBooks Online. Each change waits for a signature." */
function changesOf(sop: SopView): string[] {
  // The verbs its steps use on each system (the system's row lists the connection's whole matrix).
  const used = new Map<string, Set<string>>();
  for (const line of sop.procedure) {
    if (line.line !== "step") continue;
    for (const x of line.systems) {
      const verbs = used.get(x.id) ?? new Set<string>();
      verbs.add(x.verb.toLowerCase());
      used.set(x.id, verbs);
    }
  }
  const out: string[] = [];
  for (const s of sop.systems) {
    const verbs = used.get(s.id) ?? new Set<string>();
    const words: string[] = [];
    const levels: string[] = [];
    if (verbs.has("create") && s.create && s.create !== "off") {
      words.push("create");
      levels.push(s.create);
    }
    if (verbs.has("update") && s.update && s.update !== "off") {
      words.push("change");
      levels.push(s.update);
    }
    if (words.length === 0) continue;
    const records = sop.data
      .filter((d) => /changes/i.test(d.agentDoes) && d.livesIn === `Your ${s.name}`)
      .map((d) => plural(d.record));
    const what = records.length ? LIST.format([...new Set(records)]) : "records";
    const verb = LIST.format(words);
    const asks = levels.every((l) => l === "ask")
      ? "Each change waits for a signature."
      : levels.some((l) => l === "ask")
        ? "Some changes wait for a signature."
        : "It doesn't ask first.";
    out.push(
      `${verb.charAt(0).toUpperCase()}${verb.slice(1)} ${what} in ${lower(`Your ${s.name}`)}. ${asks}`,
    );
  }
  return out;
}

/** The client's members by id, as names. */
async function memberNames(tx: Tx, tenantId: string): Promise<Map<string, string>> {
  const rows = await tx
    .select({ userId: membership.userId, name: appUser.name, email: appUser.email })
    .from(membership)
    .innerJoin(appUser, eq(appUser.id, membership.userId))
    .where(
      and(
        eq(membership.tenantId, tenantId),
        inArray(membership.role, ["client_admin", "client_user"]),
      ),
    );
  return new Map(rows.map((r) => [r.userId, r.name?.trim() || r.email]));
}

/**
 * Who sits in each seat of a kind, in words: "Approves bills: Dana Ruiz, with Luis Ortega as
 * backup". An empty seat reads as whoever a run would ask: the client admin.
 */
function seatLines(
  roles: readonly PersonRole[],
  people: AgentRow["people"],
  names: Map<string, string>,
  kind: "signs" | "answers",
): string[] {
  const who = (id: string) => names.get(id) ?? "A person no longer on your team";
  return roles
    .filter((r) => seatKindOf(r) === kind)
    .map((r) => {
      const b = (people as Record<string, { userIds?: string[]; backupUserIds?: string[] }>)[
        r.role
      ];
      const users = b?.userIds ?? [];
      const backups = b?.backupUserIds ?? [];
      if (users.length === 0) return `${seatLabelOf(r)}: nobody yet, so your admin is asked`;
      const main = OR.format(users.map(who));
      const backup = backups.length ? `, with ${OR.format(backups.map(who))} as backup` : "";
      return `${seatLabelOf(r)}: ${main}${backup}`;
    });
}

export async function scopeView(tx: Tx, input: ScopeInput): Promise<ScopeView> {
  const a = await clientAgent(tx, input.tenantId, input.agentId);
  const v = await sopVersion(tx, a);
  if (!v) throw notFound("service");
  const bundle = v.bundle as AnyAgentBundle;
  const read = await sopInputFor(tx, input.platform, a, {
    learned: null,
    measures: [],
    settings: [],
    asOf: new Date(),
  });
  if (!read) throw notFound("service");
  const sop = sopView({ ...read.input, revision: null, previous: null, history: [] });
  const names = await memberNames(tx, input.tenantId);
  const roles = (bundle.people ?? []) as PersonRole[];

  // The settings the client chose (Choose, setup-plan §9), as the portal's Settings shows them.
  const choices = adjustView(bundle, undefined, "client")
    .filter((s) => s.changedSide === "client")
    .map((s) => `${s.label}: ${s.current ?? "not set"}`);

  // DECISION: "Still open" is the client's own open requests about this agent; a client user reads
  // only the ones they raised, as on Requests.
  const open = await openAsks(tx, {
    tenantId: input.tenantId,
    agentIds: [a.id],
    ...(input.isAdmin ? {} : { raisedBy: input.userId }),
  });

  const signed = readAgentGuide(a.stageState).scope ?? null;
  return {
    agentId: a.id,
    name: a.serviceName ?? a.name,
    version: v.version,
    does: a.serviceDescription?.trim() || sop.purpose || sop.agent.name,
    reads: readsOf(sop),
    changes: changesOf(sop),
    signs: seatLines(roles, a.people, names, "signs"),
    answers: seatLines(roles, a.people, names, "answers"),
    choices,
    open: open.map((o) => (o.number !== null ? `#${o.number} ${o.title}` : o.title)),
    signed: signed
      ? { byName: signed.byName ?? "Your admin", at: signed.at, version: signed.version }
      : null,
    canSign: input.isAdmin && signed?.version !== v.version,
    trialDays: SETUP_TRIAL_DAYS,
    stage: (a.stage ?? null) as ScopeView["stage"],
  };
}

/**
 * The client admin signs the scope of the version it reads. The same version twice is 409; a new
 * version is signed again. It starts nothing: the lead starts the trial (§7).
 */
export async function signScope(tx: Tx, input: ScopeInput): Promise<void> {
  if (!input.isAdmin) {
    throw new HttpError(403, "forbidden", "Only your admin signs the scope.");
  }
  const a = await clientAgent(tx, input.tenantId, input.agentId, true);
  const v = await sopVersion(tx, a);
  if (!v) throw notFound("service");
  const signed = readAgentGuide(a.stageState).scope;
  if (signed?.version === v.version) {
    throw new HttpError(409, "already_signed", "This scope is already signed.");
  }
  const value = {
    by: input.userId,
    byName: input.name,
    at: new Date().toISOString(),
    version: v.version,
  };
  await tx
    .update(agent)
    .set({
      stageState: sql`jsonb_set(coalesce(${agent.stageState}, '{}'::jsonb), '{guide}', coalesce(${agent.stageState} -> 'guide', '{}'::jsonb) || jsonb_build_object('scope', ${JSON.stringify(value)}::jsonb))`,
    })
    .where(and(eq(agent.id, a.id), eq(agent.tenantId, input.tenantId)));
}

/** What Go live still holds per agent (agent id → lines), and how far it is. */
export async function liveProgress(
  tx: Tx,
  input: { tenantId: string; agentIds: readonly string[]; userId?: string },
): Promise<{ left: Map<string, SetupLeft[]>; done: number; total: number }> {
  const left = new Map<string, SetupLeft[]>();
  if (input.agentIds.length === 0) return { left, done: 0, total: 0 };
  const rows = await tx
    .select()
    .from(agent)
    .where(and(eq(agent.tenantId, input.tenantId), inArray(agent.id, [...input.agentIds])));
  const admins = await tx
    .select({ userId: membership.userId, name: appUser.name, email: appUser.email })
    .from(membership)
    .innerJoin(appUser, eq(appUser.id, membership.userId))
    .where(and(eq(membership.tenantId, input.tenantId), eq(membership.role, "client_admin")));
  // The client admin signs: the reader when they are one, else the first.
  const admin = admins.find((m) => m.userId === input.userId) ?? admins[0] ?? null;
  let done = 0;
  for (const row of rows) {
    const v = await sopVersion(tx, row);
    const signed = readAgentGuide(row.stageState).scope;
    if (v && signed?.version === v.version) {
      done += 1;
      continue;
    }
    left.set(row.id, [
      {
        key: "scope",
        chapter: "live",
        label: "Sign the scope",
        who: admin
          ? {
              userId: admin.userId,
              name: admin.name?.trim() || admin.email,
              me: admin.userId === input.userId,
            }
          : null,
      },
    ]);
  }
  return { left, done, total: input.agentIds.length };
}
