// The setup checklist on a client copy (docs/builder-plan.md §6, B4). The items travel in the
// agent's version (`definition.setup`); the client's progress is the agent's own
// (`agent.stage_state.setup`, operational, never in a version). A connect item is done when its
// connector is connected and bound to the agent; the rest when a person answers, confirms or sends
// a file. An answer that sets a skill parameter becomes a new version of the copy, by code: the
// "client settings" class (ARCHITECTURE §10.15), never a loosening. The go-live stages read the
// holds (`lifecycle/stages.ts`). Every function runs in the caller's transaction, scoped to the
// agent's client (invariant 1).

import { AgentsError, createVersion, publish, type RegistryContext } from "@countersign/agents";
import {
  type AgentStage,
  type AnyAgentBundle,
  applySetupSetting,
  type PortalSetupAgent,
  readSetupAnswer,
  readStageState,
  type SetupFacts,
  type SetupItem,
  type SetupItemBody,
  SetupChecklist,
  type SetupProgress,
  type SetupView,
  settingValue,
  setupHolds,
  setupView,
  withSetupProgress,
} from "@countersign/core";
import {
  type AgentStageState,
  agent,
  agentChange,
  agentVersion,
  connection,
  document,
  type Tx,
} from "@countersign/db";
import { and, desc, eq, inArray } from "drizzle-orm";
import { HttpError, notFound } from "../http";

type AgentRow = typeof agent.$inferSelect;
type VersionRow = typeof agentVersion.$inferSelect;

/** The version the checklist is read from: the live one, else the latest (the one going live). */
// DECISION: as the agent page's `writes` (shownVersionWrites): a copy on the bench whose only
// version is a draft still shows its checklist, so the client can start on it before it goes live.
export async function shownVersion(tx: Tx, row: AgentRow): Promise<VersionRow | null> {
  if (row.liveVersionId) {
    const [live] = await tx
      .select()
      .from(agentVersion)
      .where(eq(agentVersion.id, row.liveVersionId));
    if (live) return live;
  }
  const [latest] = await tx
    .select()
    .from(agentVersion)
    .where(eq(agentVersion.agentId, row.id))
    .orderBy(desc(agentVersion.version))
    .limit(1);
  return latest ?? null;
}

/** The checklist a version carries (none for versions made before it, or one that doesn't read). */
export function checklistOf(bundle: unknown): SetupItem[] {
  const raw = (bundle as { definition?: { setup?: unknown } } | null)?.definition?.setup;
  if (raw === undefined) return [];
  const parsed = SetupChecklist.safeParse(raw);
  return parsed.success ? parsed.data : [];
}

/**
 * Which of the copy's connectors are usable and bound to it, for its connect items: connected, or
 * pending for a connector that needs no sign-in, as the activation check counts them.
 */
// DECISION: without the registry (the hourly pass has none), only a connected one counts.
export async function setupFacts(
  tx: Tx,
  row: AgentRow,
  ctx?: Pick<RegistryContext, "tools">,
): Promise<SetupFacts> {
  const ids = Object.values(row.bindings);
  if (!row.tenantId || ids.length === 0) return { connected: () => false };
  const rows = await tx
    .select({ id: connection.id, connector: connection.connector, status: connection.status })
    .from(connection)
    .where(and(eq(connection.tenantId, row.tenantId), inArray(connection.id, ids)));
  const usable = (c: (typeof rows)[number]) =>
    c.status === "connected" ||
    (c.status === "pending" && ctx?.tools.connectors.get(c.connector)?.manifest.auth === "none");
  const ok = new Set(rows.filter(usable).map((c) => `${c.connector}|${c.id}`));
  return {
    connected: (connector) => {
      const bound = row.bindings[connector];
      return bound !== undefined && ok.has(`${connector}|${bound}`);
    },
  };
}

/** The copy's checklist with its progress, or null when its version carries none. */
export async function agentSetupView(
  tx: Tx,
  row: AgentRow,
  ctx?: Pick<RegistryContext, "tools">,
): Promise<SetupView | null> {
  if (row.kind !== "client") return null;
  const v = await shownVersion(tx, row);
  const items = checklistOf(v?.bundle);
  if (items.length === 0) return null;
  const state = readStageState(row.stageState);
  return setupView(items, state.setup, await setupFacts(tx, row, ctx));
}

/**
 * The items not done that hold a move to `to`, read from the live version (the stage moves read
 * the live version alone, as `liveVersionWrites`), else the latest.
 */
export async function setupHoldsFor(
  tx: Tx,
  row: AgentRow,
  to: AgentStage,
  ctx?: Pick<RegistryContext, "tools">,
): Promise<SetupItem[]> {
  if (row.kind !== "client") return [];
  const v = await shownVersion(tx, row);
  const items = checklistOf(v?.bundle);
  if (items.length === 0) return [];
  const facts = await setupFacts(tx, row, ctx);
  return setupHolds(items, readStageState(row.stageState).setup, facts, to);
}

/** Who records an item: the person and their side. */
export interface SetupActor {
  userId: string;
  name: string | null;
  side: "client" | "operator";
}

/**
 * Records one item for a client copy: an answer (read for its item; one that sets a parameter
 * makes a new version by code), a confirm (with an optional note), or a file item's documents. A
 * confirm or a file may be taken back (`done: false`); a connect item is done by its connection
 * only. Answers the agent as it is now.
 */
export async function recordSetupItem(
  tx: Tx,
  input: {
    agentId: string;
    tenantId: string;
    itemId: string;
    body: SetupItemBody;
    actor: SetupActor;
    ctx: RegistryContext;
    now?: Date;
  },
): Promise<AgentRow> {
  const now = input.now ?? new Date();
  const [row] = await tx
    .select()
    .from(agent)
    .where(and(eq(agent.id, input.agentId), eq(agent.tenantId, input.tenantId)))
    .for("update");
  if (row?.kind !== "client" || row.testCopy) throw notFound("agent");
  const shown = await shownVersion(tx, row);
  const item = checklistOf(shown?.bundle).find((i) => i.id === input.itemId);
  if (!shown || !item) throw notFound("setup item");
  if (item.kind === "connect" && item.connector) {
    throw new HttpError(
      409,
      "connect_item",
      "This is done when the tool is connected: connect it on the Accounts page.",
    );
  }
  const base: Omit<SetupProgress, "done"> = {
    by: input.actor.userId,
    byName: input.actor.name,
    side: input.actor.side,
    at: now.toISOString(),
  };
  let progress: SetupProgress;
  if (input.body.done === false) {
    progress = { ...base, done: false };
  } else if (item.kind === "file") {
    const files = [...new Set(input.body.files ?? [])];
    if (files.length === 0) throw new HttpError(422, "no_files", "Add the file first.");
    const found = await tx
      .select({ id: document.id })
      .from(document)
      .where(and(eq(document.tenantId, input.tenantId), inArray(document.id, files)));
    if (found.length !== files.length) throw notFound("file");
    const note = input.body.value?.trim();
    progress = { ...base, done: true, files, ...(note ? { value: note } : {}) };
  } else if (item.kind === "answer") {
    const current = item.setting
      ? settingValue(shown.bundle as AnyAgentBundle, item.setting)
      : undefined;
    const answer = readSetupAnswer(item, input.body.value ?? "", current);
    if (!answer.ok) throw new HttpError(422, "bad_answer", answer.reason);
    progress = { ...base, done: true, value: answer.text };
    if (item.setting) {
      const versionId = await writeSetting(tx, {
        row,
        from: shown,
        item,
        value: answer.value,
        text: answer.text,
        actor: input.actor,
        ctx: input.ctx,
      });
      if (versionId) progress = { ...progress, versionId };
    }
  } else {
    // A confirm (or a connect item with no connector to check): the person says it is settled.
    const note = input.body.value?.trim();
    progress = { ...base, done: true, ...(note ? { value: note } : {}) };
  }
  const state = withSetupProgress(readStageState(row.stageState), item.id, progress);
  const [updated] = await tx
    .update(agent)
    .set({ stageState: state as AgentStageState })
    .where(eq(agent.id, row.id))
    .returning();
  await tx.insert(agentChange).values({
    tenantId: row.tenantId,
    agentId: row.id,
    actorId: input.actor.userId,
    change: {
      kind: "setup",
      item: item.id,
      done: progress.done,
      side: input.actor.side,
      ...(progress.versionId ? { versionId: progress.versionId } : {}),
    },
  });
  return updated ?? row;
}

/**
 * The answer's value written into the parameter it sets, as a new version of the copy made by
 * code from the version the checklist was read from. Published at once when that version is live
 * (the copy runs on it); otherwise a draft the operator publishes with the rest. Answers the new
 * version's id, or null when the value was already set.
 */
// DECISION: the new version is authored as `operator` with the person's id (the author types are
// fixed by a check constraint and this milestone adds no migration); its change note says it is a
// client's setup answer and whose, so the history reads true. The value is within its item's
// bounds and sets only a parameter: never an approval, a permission, a write or a step (§10.15).
// DECISION: made from the version the checklist is read from (live, else latest). With a live
// version, the value goes live at once in a new version from it; an operator's newer draft is left
// as it is (its publish is theirs, and the answer stays on the checklist to set again). With no live
// version, the new version is the next draft, and the copy goes live with it.
async function writeSetting(
  tx: Tx,
  input: {
    row: AgentRow;
    from: VersionRow;
    item: SetupItem;
    value: unknown;
    text: string;
    actor: SetupActor;
    ctx: RegistryContext;
  },
): Promise<string | null> {
  const setting = input.item.setting;
  if (!setting) return null;
  const bundle = input.from.bundle as AnyAgentBundle;
  const out = applySetupSetting(bundle, setting, input.value);
  if (!out.ok) throw new HttpError(409, "setting_gone", out.reason);
  const who = input.actor.name ?? (input.actor.side === "client" ? "the client" : "us");
  let v: VersionRow;
  try {
    v = await createVersion(tx, {
      agentId: input.row.id,
      bundle: out.bundle,
      parentVersionId: input.from.id,
      authorType: "operator",
      authorId: input.actor.userId,
      changeNote: `Setup answer from ${who}: ${input.item.label} ${input.text}`.slice(0, 500),
    });
  } catch (error) {
    if (error instanceof AgentsError && error.code === "no_op") return null;
    throw error;
  }
  if (input.from.status === "live") {
    // DECISION: published in a savepoint. A client's session can't read our shared skills, which
    // a publish snapshots into the client (`snapshotSharedSkills`), so a copy that uses one keeps
    // the new version as a draft for us to publish; its answer is recorded either way.
    try {
      await tx.transaction((sp) =>
        publish(sp, {
          agentId: input.row.id,
          versionId: v.id,
          actorId: input.actor.userId,
          ctx: input.ctx,
          // A parameter's value is the only change: every step was there before.
          existingFrom: bundle,
        }),
      );
    } catch (error) {
      if (!(error instanceof AgentsError)) throw error;
    }
  }
  return v.id;
}

/** Getting started: each of the client's agents whose version carries a checklist. */
export async function portalSetupAgents(
  tx: Tx,
  tenantId: string,
  agents: readonly string[] | null,
  ctx?: Pick<RegistryContext, "tools">,
): Promise<PortalSetupAgent[]> {
  const rows = await tx
    .select()
    .from(agent)
    .where(and(eq(agent.tenantId, tenantId), eq(agent.kind, "client"), eq(agent.status, "active")))
    .orderBy(agent.slug);
  const out: PortalSetupAgent[] = [];
  for (const row of rows) {
    if (row.testCopy || row.runStatus === "retired") continue;
    if (agents !== null && !agents.includes(row.id)) continue;
    const setup = await agentSetupView(tx, row, ctx);
    if (setup) out.push(portalSetupAgent(row, setup));
  }
  return out;
}

export function portalSetupAgent(row: AgentRow, setup: SetupView): PortalSetupAgent {
  const stage = row.stage;
  return {
    agentId: row.id,
    name: row.serviceName ?? row.name,
    stage:
      stage === "bench" || stage === "trial" || stage === "signoff" || stage === "live"
        ? stage
        : null,
    setup,
  };
}
