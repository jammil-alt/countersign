// Getting started's overview (docs/setup-plan.md §2; docs/plan.md §1.185, SU2): one line per agent
// being set up with what is left before its trial and who it waits on, and the five chapters'
// progress. Read from what each chapter keeps: the intake (business), the setup checklist's connect
// items (tools), the seats (people), the walkthrough and tries (see it work) and the scope (go live).
// The client's own words and people only (invariant 11).

import {
  type ChapterProgress,
  type GettingStartedView,
  minutesLeft,
  readTenantGuide,
  type SetupLeft,
  type SetupWho,
  seatKindOf,
  seatLabelOf,
} from "@countersign/core";
import { agent, appUser, membership, type Tx, tenant } from "@countersign/db";
import { leadDisplayName, leadOf } from "@countersign/threads";
import { and, eq } from "drizzle-orm";
import { currentIntake, loadIntake, progressOf } from "../onboarding/intake";
import { agentSetupView } from "./checklist";
import { seatAgents } from "./people-chapter";
import { liveProgress } from "./scope";
import { toolsLeft } from "./tools-chapter";
import { seeProgress } from "./walkthrough";

type AgentRow = typeof agent.$inferSelect;

/** An agent is being set up until its trial starts: on the bench, or with no stage yet. */
export function inSetup(row: Pick<AgentRow, "stage" | "runStatus" | "status" | "testCopy">) {
  return (
    row.status === "active" &&
    !row.testCopy &&
    row.runStatus !== "retired" &&
    (row.stage === null || row.stage === "bench")
  );
}

/** The client agents being set up that this person sees, by name. */
export async function setupAgents(
  tx: Tx,
  tenantId: string,
  sees: readonly string[] | null,
): Promise<AgentRow[]> {
  const rows = await tx
    .select()
    .from(agent)
    .where(and(eq(agent.tenantId, tenantId), eq(agent.kind, "client")))
    .orderBy(agent.name);
  return rows.filter((r) => inSetup(r) && (sees === null || sees.includes(r.id)));
}

export interface OverviewInput {
  tenantId: string;
  userId: string;
  sees: readonly string[] | null;
  ctx?: Parameters<typeof agentSetupView>[2];
  now: Date;
}

const chapter = (
  key: ChapterProgress["key"],
  done: number,
  total: number,
  confirmed = false,
): ChapterProgress => ({
  key,
  done,
  total,
  state:
    total === 0
      ? "not_needed"
      : done >= total || confirmed
        ? "done"
        : done === 0
          ? "not_started"
          : "open",
});

export async function gettingStarted(tx: Tx, input: OverviewInput): Promise<GettingStartedView> {
  const rows = await setupAgents(tx, input.tenantId, input.sees);
  const ids = rows.map((r) => r.id);
  const [settingsRow] = await tx
    .select({ settings: tenant.settings })
    .from(tenant)
    .where(eq(tenant.id, input.tenantId));
  const guide = readTenantGuide(settingsRow?.settings);
  const admins = await tx
    .select({ userId: membership.userId, name: appUser.name, email: appUser.email })
    .from(membership)
    .innerJoin(appUser, eq(appUser.id, membership.userId))
    .where(and(eq(membership.tenantId, input.tenantId), eq(membership.role, "client_admin")));
  const nameOfUser = async (userId: string): Promise<string> => {
    const [u] = await tx
      .select({ name: appUser.name, email: appUser.email })
      .from(appUser)
      .where(eq(appUser.id, userId));
    return u?.name?.trim() || u?.email || "Someone";
  };
  // The client admin does what a person must, unless someone else was asked.
  const admin = admins.find((a) => a.userId === input.userId) ?? admins[0] ?? null;
  const adminWho: SetupWho | null = admin
    ? {
        userId: admin.userId,
        name: admin.name?.trim() || admin.email,
        me: admin.userId === input.userId,
      }
    : null;

  // Business: the open intake's cards (this person's), else nothing to answer.
  let business = { done: 0, total: 0 };
  const [open] = await currentIntake(tx, input.tenantId, input.now);
  if (open) {
    const progress = progressOf(await loadIntake(tx, open));
    business = {
      done: progress.filter((p) => p.answered + p.notSure >= p.total).length,
      total: progress.length,
    };
  }

  // Tools and the agent's own questions: the setup checklist.
  const left = new Map<string, SetupLeft[]>(ids.map((id) => [id, []]));
  const tools = new Map<string, boolean>();
  let ownDone = 0;
  let ownTotal = 0;
  const fromTools = await toolsLeft(tx, { tenantId: input.tenantId, agentIds: ids });
  for (const row of rows) {
    const setup = await agentSetupView(tx, row, input.ctx);
    const lines = left.get(row.id) as SetupLeft[];
    for (const item of setup?.items ?? []) {
      if (item.guards === "live") continue;
      if (item.kind === "connect" && item.connector) {
        tools.set(item.connector, (tools.get(item.connector) ?? false) || item.done);
        if (!item.done && !fromTools) {
          const asked = guide.tools?.[item.connector]?.askedOf;
          lines.push({
            key: `tool:${item.connector}`,
            chapter: "tools",
            label: item.label,
            who: asked
              ? {
                  userId: asked.userId,
                  name: await nameOfUser(asked.userId),
                  me: asked.userId === input.userId,
                }
              : adminWho,
          });
        }
        continue;
      }
      ownTotal += 1;
      if (item.done) ownDone += 1;
      else
        lines.push({
          key: `item:${item.id}`,
          chapter: "business",
          label: item.label,
          who: adminWho,
        });
    }
    for (const l of fromTools?.get(row.id) ?? []) lines.push(l);
  }

  // People: every seat of the agents being set up; a seat that signs or answers left empty holds.
  const seatRows = (await seatAgents(tx, input.tenantId)).filter((a) => ids.includes(a.row.id));
  const seats = new Map<string, boolean>();
  for (const { row, roles } of seatRows) {
    const people = row.people as Record<string, { userIds?: string[]; contactIds?: string[] }>;
    for (const r of roles) {
      const b = people[r.role];
      const filled = (b?.userIds?.length ?? 0) + (b?.contactIds?.length ?? 0) > 0;
      seats.set(r.role, (seats.get(r.role) ?? true) && filled);
      const kind = seatKindOf(r);
      if (!filled && (r.required || kind === "signs" || kind === "answers")) {
        left.get(row.id)?.push({
          key: `seat:${r.role}`,
          chapter: "people",
          label: seatLabelOf(r),
          who: adminWho,
        });
      }
    }
  }

  const see = await seeProgress(tx, { tenantId: input.tenantId, agentIds: ids });
  const live = await liveProgress(tx, {
    tenantId: input.tenantId,
    agentIds: ids,
    userId: input.userId,
  });
  for (const id of ids) {
    left.get(id)?.push(...(see.left.get(id) ?? []), ...(live.left.get(id) ?? []));
  }

  const lead = await leadOf(tx, input.tenantId);
  const toolDone = [...tools.values()].filter(Boolean).length;
  const seatDone = [...seats.values()].filter(Boolean).length;
  const chapters: ChapterProgress[] = [
    chapter("business", business.done + ownDone, business.total + ownTotal),
    chapter("tools", toolDone, tools.size),
    chapter("people", seatDone, seats.size, guide.people !== undefined && seatDone === seats.size),
    chapter("see", see.done, see.total),
    chapter("live", live.done, live.total),
  ];
  const agents = rows.map((row) => ({
    agentId: row.id,
    name: row.serviceName ?? row.name,
    description: row.serviceDescription ?? null,
    stage: row.stage as GettingStartedView["agents"][number]["stage"],
    left: left.get(row.id) ?? [],
  }));
  return {
    agents,
    chapters,
    lead: lead ? { name: leadDisplayName(lead) } : null,
    minutesLeft: minutesLeft(agents.flatMap((a) => a.left)),
  };
}
