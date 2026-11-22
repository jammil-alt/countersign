// Client adjustments and feedback (docs/builder-plan.md §7, B5). The settings a client may adjust
// travel in the agent's version (`definition.adjustable`, marked by the operator, with bounds). The
// client admin changes one on the agent's Settings in the portal:
// - within the bounds, or tighter than now: a new version made by code from the version shown
//   (the "client settings" class, ARCHITECTURE §10.15), with the change written into the manual's
//   decisions (who and when), published at once when that version is live;
// - beyond the bounds: a request to us (an issue, §1.124), linked to the setting;
// - never anything else: only a skill parameter or a schedule can be marked, and the new bundle is
//   checked by code to differ only there and in the manual (`onlyAdjusted`).
// "This is wrong because…" on a line of the manual files a request linked to that line. Every
// function runs in the caller's transaction, scoped to the agent's client (invariant 1).

import type { RegistryContext } from "@countersign/agents";
import {
  type AdjustableSetting,
  type AdjustBody,
  type AdjustResult,
  type AdjustRowView,
  type AdjustTarget,
  type AnyAgentBundle,
  adjustValue,
  adjustView,
  applyAdjustValue,
  deepEqual,
  judgeAdjustment,
  type ManualFeedbackBody,
  onlyAdjusted,
  parseSkillRef,
  readAdjustable,
  recordAdjustment,
} from "@countersign/core";
import { agent, agentChange, type agentVersion, type Tx } from "@countersign/db";
import { and, eq } from "drizzle-orm";
import { HttpError, notFound } from "../http";
import { createIssue } from "../work/issues";
import { type SetupActor, shownVersion, writeClientVersion } from "./checklist";

type AgentRow = typeof agent.$inferSelect;
type VersionRow = typeof agentVersion.$inferSelect;

/** A client's own copy, as the portal sees its services: never a template or a test copy. */
async function clientAgent(tx: Tx, tenantId: string, agentId: string, lock = false) {
  const q = tx
    .select()
    .from(agent)
    .where(and(eq(agent.id, agentId), eq(agent.tenantId, tenantId), eq(agent.kind, "client")));
  const [row] = lock ? await q.for("update") : await q;
  if (!row || row.testCopy) throw notFound("service");
  return row;
}

/** A parameter's default from the skill as the platform's catalog has it, when the agent sets none. */
function defaultsFrom(ctx: Pick<RegistryContext, "catalog"> | undefined) {
  return (target: AdjustTarget): unknown => {
    if (target.kind !== "parameter" || !ctx) return undefined;
    const def = ctx.catalog.get(parseSkillRef(target.skill).id);
    return def?.parameters?.find((p) => p.name === target.parameter)?.default;
  };
}

/** The adjustable settings as the portal shows them, read from the version shown. */
export async function adjustableView(
  tx: Tx,
  row: AgentRow,
  ctx?: Pick<RegistryContext, "catalog">,
): Promise<AdjustRowView[]> {
  const v = await shownVersion(tx, row);
  if (!v) return [];
  return adjustView(v.bundle as AnyAgentBundle, defaultsFrom(ctx), "client");
}

export async function portalAdjustable(
  tx: Tx,
  tenantId: string,
  agentId: string,
  ctx?: Pick<RegistryContext, "catalog">,
): Promise<AdjustRowView[]> {
  return adjustableView(tx, await clientAgent(tx, tenantId, agentId), ctx);
}

/** "8", or "8 (between 0 and 5)" words for the request. */
function requestText(input: {
  agentName: string;
  setting: AdjustableSetting;
  asked: string;
  current: string | null;
  reason: string;
  who: string;
  note: string | undefined;
}): string {
  const lines = [
    `${input.who} asked to change "${input.setting.label}" on ${input.agentName} to ${input.asked}${
      input.current ? ` (it is ${input.current} now)` : ""
    }.`,
    input.reason,
  ];
  if (input.note) lines.push("", `Why: ${input.note}`);
  return lines.join("\n");
}

/**
 * The client admin's change to one adjustable setting: applied by code when within the bounds or
 * tighter, a request to us when beyond them. Answers what happened and the settings as they are.
 */
export async function adjustSetting(
  tx: Tx,
  input: {
    tenantId: string;
    agentId: string;
    settingId: string;
    body: AdjustBody;
    actor: SetupActor;
    ctx: RegistryContext;
    now?: Date;
  },
): Promise<AdjustResult> {
  const now = input.now ?? new Date();
  const row = await clientAgent(tx, input.tenantId, input.agentId, true);
  const shown = await shownVersion(tx, row);
  const bundle = shown?.bundle as AnyAgentBundle | undefined;
  const setting = readAdjustable(bundle?.definition.adjustable).find(
    (s) => s.id === input.settingId,
  );
  // Only a setting we marked can be changed: an approval, a permission, a write or a step never is.
  if (!shown || !bundle || !setting) throw notFound("setting");
  const defaults = defaultsFrom(input.ctx);
  const current = adjustValue(bundle, setting.target) ?? defaults(setting.target);
  const judged = judgeAdjustment(setting, input.body.value, current);
  const settings = () => adjustableView(tx, row, input.ctx);
  if (judged.outcome === "invalid") throw new HttpError(422, "bad_value", judged.reason);
  const who = input.actor.name ?? "Your admin";
  const agentName = row.serviceName ?? row.name;

  if (judged.outcome === "request") {
    const currentText = adjustView(bundle, defaults).find((r) => r.id === setting.id)?.current;
    const text = requestText({
      agentName,
      setting,
      asked: judged.text,
      current: currentText ?? null,
      reason: judged.reason,
      who,
      note: input.body.note,
    });
    // DECISION: a request past the bounds is an issue (§1.124), not an ask: the issue's created
    // event keeps what it is about (the setting and the value asked) with no migration; an ask
    // has no such place. The operator decides; a change to the bounds is ours (§10, point 2).
    const issue = await createIssue(tx, {
      tenantId: input.tenantId,
      title: `Change "${setting.label}" to ${judged.text}`,
      description: text,
      agentId: row.id,
      source: "portal",
      raisedBy: input.actor.userId,
      actor: "client",
      userId: input.actor.userId,
      openingText: text,
      about: {
        kind: "adjustable",
        agentId: row.id,
        versionId: shown.id,
        settingId: setting.id,
        asked: judged.text,
        current: currentText ?? null,
      },
      now,
    });
    await tx.insert(agentChange).values({
      tenantId: row.tenantId,
      agentId: row.id,
      actorId: input.actor.userId,
      change: {
        kind: "adjust",
        setting: setting.id,
        // G10: what the back office's change list reads.
        label: setting.label,
        value: judged.text,
        outcome: "requested",
        issueId: issue.id,
      },
    });
    return {
      outcome: "requested",
      message: `That is outside what we set up, so we sent it to us as request #${issue.number}. We'll answer there.`,
      request: { id: issue.id, number: issue.number },
      settings: await settings(),
    };
  }

  if (deepEqual(judged.value, current)) {
    return {
      outcome: "unchanged",
      message: `${setting.label} is already ${judged.text}.`,
      request: null,
      settings: await settings(),
    };
  }
  const applied = applyAdjustValue(bundle, setting.target, judged.value);
  if (!applied.ok) throw new HttpError(409, "setting_gone", applied.reason);
  const next = {
    ...applied.bundle,
    definition: {
      ...applied.bundle.definition,
      manual: recordAdjustment(
        bundle.definition.manual,
        setting,
        judged.text,
        { name: input.actor.name, side: input.actor.side },
        now.toISOString(),
      ),
    },
  } as AnyAgentBundle;
  // The last guard: the new version may differ only in this setting and the manual's record of it.
  if (!onlyAdjusted(bundle, next, setting.target)) {
    throw new HttpError(409, "not_adjustable", "That would change more than this setting.");
  }
  const v = await writeClientVersion(tx, {
    row,
    from: shown,
    bundle: next,
    actor: input.actor,
    changeNote: `Settings change from ${who}: ${setting.label} ${judged.text}`,
    ctx: input.ctx,
  });
  await tx.insert(agentChange).values({
    tenantId: row.tenantId,
    agentId: row.id,
    actorId: input.actor.userId,
    change: {
      kind: "adjust",
      setting: setting.id,
      label: setting.label,
      value: judged.text,
      outcome: "applied",
      side: input.actor.side,
      tightens: judged.tightens,
      ...(v ? { versionId: v.id } : {}),
    },
  });
  const [after] = await tx.select().from(agent).where(eq(agent.id, row.id));
  const live = v !== null && after?.liveVersionId === v.id;
  return {
    outcome: "applied",
    message: live
      ? `Saved. ${setting.label} is now ${judged.text}; new runs use it.`
      : `Saved. ${setting.label} is now ${judged.text}; it applies once we put this version live.`,
    request: null,
    settings: after ? await adjustableView(tx, after, input.ctx) : await settings(),
  };
}

const SECTION_WORDS: Record<ManualFeedbackBody["section"], string> = {
  what: "What it does",
  how: "How it works",
  decision: "Decisions",
  point: "Who decides what",
  risk: "Known risks",
  setup: "What we set up with you",
  learned: "What it learned",
};

/**
 * "This is wrong because…" on a line of an agent's manual: a request to us (an issue) quoting the
 * line, linked to it on the issue's created event (a decision by its id, checked against the
 * manual the client reads). The owner and the operator take it from there (§7.2).
 */
export async function manualFeedback(
  tx: Tx,
  input: {
    tenantId: string;
    agentId: string;
    body: ManualFeedbackBody;
    actor: SetupActor;
    now?: Date;
  },
): Promise<{ id: string; number: number }> {
  const row = await clientAgent(tx, input.tenantId, input.agentId);
  const v: VersionRow | null = await shownVersion(tx, row);
  const manual = (v?.bundle as AnyAgentBundle | undefined)?.definition.manual;
  let decisionId: string | null = null;
  if (input.body.section === "decision") {
    // A decision is linked by its id; one the manual doesn't hold is "not found".
    const found = manual?.decisions.find((d) => d.id === input.body.lineId);
    if (!found) throw notFound("decision");
    decisionId = found.id;
  }
  const agentName = row.serviceName ?? row.name;
  const quoted = input.body.line.replace(/\s+/g, " ").trim();
  const text = [
    `On ${agentName}'s manual (${SECTION_WORDS[input.body.section]}): "${quoted}"`,
    "",
    `This is wrong because: ${input.body.because}`,
  ].join("\n");
  const clipped = quoted.length > 60 ? `${quoted.slice(0, 59).trimEnd()}…` : quoted;
  const issue = await createIssue(tx, {
    tenantId: input.tenantId,
    title: `Wrong in the manual: ${clipped}`,
    description: text,
    agentId: row.id,
    source: "portal",
    raisedBy: input.actor.userId,
    actor: "client",
    userId: input.actor.userId,
    openingText: text,
    about: {
      kind: "manual_line",
      agentId: row.id,
      versionId: v?.id ?? null,
      section: input.body.section,
      lineId: input.body.lineId ?? null,
      decisionId,
      line: quoted.slice(0, 1000),
    },
    ...(input.now ? { now: input.now } : {}),
  });
  return { id: issue.id, number: issue.number };
}
