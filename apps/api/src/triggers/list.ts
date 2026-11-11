// The triggers list (ARCHITECTURE §10.8, §14; docs/plan.md §1.48 "Triggers list"): each trigger of a
// client agent's live (else latest) version, with its workflow, its guards as written, and when it
// last fired, answered from `run.trigger` (no new table). The operator's only.

import {
  type AgentTriggers,
  type AnyAgentBundle,
  agentAddress,
  agentCommandNames,
  allTriggers,
  type TriggerListItem,
  type TriggerOn,
} from "@countersign/core";
import { agentVersion, run, type Tx, tenant } from "@countersign/db";
import { commandCandidates } from "@countersign/threads";
import { and, desc, eq, sql } from "drizzle-orm";

function summaryOf(on: TriggerOn): string {
  switch (on.type) {
    case "event":
      return on.filter?.rules.length ? `When ${on.event}, if its rules match` : `When ${on.event}`;
    case "schedule":
      return `On ${on.cron}${on.tz ? ` (${on.tz})` : " in the client's time zone"}${
        on.skipHolidays ? ", skips holidays" : ""
      }`;
    case "manual":
      return on.client?.canRun ? "Started by hand; the client may run it" : "Started by hand";
    case "command":
      return `Command /${on.command}`;
    case "webhook":
      return `A delivery to hook ${on.hookId}${on.rateLimit ? `, at most ${on.rateLimit.max} a ${on.rateLimit.per}` : ""}`;
    case "message":
      return `A message by ${on.channels.join(", ")} from the people it names`;
    case "handoff":
      return `When ${on.from.agent}${on.from.workflow ? ` (${on.from.workflow})` : ""} finishes a live run`;
  }
}

function guardsOf(on: TriggerOn): Record<string, unknown> {
  const { type: _type, ...rest } = on;
  return rest;
}

/**
 * Each client agent's own email address (ARCHITECTURE §10.8), by agent id: its command name (live
 * agents only) at the client on the forwarding domain. Empty without a domain. `names` are the
 * client's command names when the caller has them already.
 */
export async function agentAddresses(
  tx: Tx,
  tenantId: string,
  domain: string | null | undefined,
  names?: ReadonlyMap<string, string>,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const d = domain?.trim();
  if (!d) return out;
  const commandNames = names ?? agentCommandNames(await commandCandidates(tx, tenantId));
  if (commandNames.size === 0) return out;
  const [client] = await tx
    .select({ name: tenant.name })
    .from(tenant)
    .where(eq(tenant.id, tenantId));
  if (!client) return out;
  for (const [agentId, commandName] of commandNames) {
    out.set(agentId, agentAddress({ commandName, clientName: client.name, tenantId, domain: d }));
  }
  return out;
}

export async function agentTriggers(
  tx: Tx,
  row: { id: string; tenantId: string; liveVersionId: string | null },
  domain: string | null | undefined,
): Promise<AgentTriggers> {
  const where = row.liveVersionId
    ? and(eq(agentVersion.id, row.liveVersionId), eq(agentVersion.tenantId, row.tenantId))
    : and(eq(agentVersion.agentId, row.id), eq(agentVersion.tenantId, row.tenantId));
  const [v] = await tx
    .select({ id: agentVersion.id, bundle: agentVersion.bundle })
    .from(agentVersion)
    .where(where)
    .orderBy(desc(agentVersion.version))
    .limit(1);
  const bundle: AnyAgentBundle | null = v?.bundle ?? null;

  const fired = await tx.execute<{
    trigger_id: string;
    id: string;
    status: string;
    mode: string;
    created_at: Date | string;
  }>(sql`
    select distinct on (${run.trigger}->>'triggerId')
      ${run.trigger}->>'triggerId' as trigger_id, ${run.id} as id, ${run.status} as status,
      ${run.mode} as mode, ${run.createdAt} as created_at
    from ${run}
    where ${run.tenantId} = ${row.tenantId} and ${run.agentId} = ${row.id}
    order by ${run.trigger}->>'triggerId', ${run.createdAt} desc`);
  const last = new Map<string, TriggerListItem["lastFired"]>();
  for (const f of [...fired]) {
    last.set(f.trigger_id, {
      at: new Date(f.created_at).toISOString(),
      runId: f.id,
      status: f.status,
      mode: f.mode,
    });
  }

  const triggers: TriggerListItem[] = [];
  for (const wf of bundle?.workflows ?? []) {
    allTriggers(wf.workflow).forEach((t, i) => {
      triggers.push({
        workflow: wf.slug,
        workflowName: wf.name,
        enabled: wf.enabled,
        triggerId: t.id,
        type: t.on.type,
        first: i === 0,
        summary: summaryOf(t.on),
        guards: guardsOf(t.on),
        lastFired: last.get(t.id) ?? null,
      });
    });
  }

  const names = agentCommandNames(await commandCandidates(tx, row.tenantId));
  const commandName = names.get(row.id) ?? null;
  const address = (await agentAddresses(tx, row.tenantId, domain, names)).get(row.id) ?? null;
  return {
    agentId: row.id,
    versionId: v?.id ?? null,
    live: Boolean(row.liveVersionId && v?.id === row.liveVersionId),
    commandName,
    address,
    triggers,
  };
}
