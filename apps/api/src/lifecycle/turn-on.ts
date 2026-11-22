// Turn on in one button (docs/builder-plan.md §11.4 S4, §12.4; docs/plan.md §1.170). From a
// finished draft to the client's trial in one action: publish the version, copy a template to the
// client (or update the copy it already has), bind the client's connections, activate and start
// the trial (14 days or 25 runs, every write signed). Every piece is today's: the registry's
// publish, fork and update merge, `bindTestCopy`, Activate and the lifecycle's trial. What is
// still missing comes back as one list.
//
// What holds the button is ours alone: the version never tried at the client, and the validator's
// errors. What the client owes (connect, allow, who signs, the setup checklist) is listed and
// holds nothing. A build's high-risk decisions come first and hold nothing (owner, 2026-11-21).
// Nothing here loosens a client's connection, a grant or an approval (invariant 8): the trial
// signs every write, whatever the draft says.

import {
  type AgentRow,
  AgentsError,
  type AgentVersionRow,
  convertLookup,
  createUpdateDraft,
  discardDraft,
  existingBundle,
  fork,
  getAgent,
  getVersion,
  grantsOfClient,
  latestVersion,
  publish,
  validateForPublish,
} from "@countersign/agents";
import {
  type AgentStage,
  AnyAgentBundle,
  DECISION_CATEGORY_WORDS,
  decisionReviewed,
  type GrantLimits,
  type RouteSpec,
  readFitGap,
  readStageState,
  type SetupFacts,
  setupHolds,
  setupView,
  type TurnOnAnswer,
  type TurnOnBody,
  type TurnOnItem,
  toProcessBundle,
  withDecisionRisk,
} from "@countersign/core";
import { agent, agentVersion, build, connection, run, type Tx, tenant } from "@countersign/db";
import { and, desc, eq, inArray, isNull, ne, or } from "drizzle-orm";
import { freeSlug, moveToClientTest, type TrialBlock } from "../build/client-test";
import { type BuildRow, draftWritingSteps } from "../build/store";
import { bundleNeeds, connectorName, gapsOf, gapWords } from "../connector-access/service";
import { ensureClient, type HandlerCtx, HttpError, notFound } from "../http";
import { activateAgent, bindingsToAdd, bindTestCopy } from "../routes/ops-agents";
import { checklistOf, setupFacts } from "../setup/checklist";
import { stageOf } from "./stages";

type Ctx = Pick<
  HandlerCtx<RouteSpec>,
  "tx" | "services" | "session" | "role" | "tenantIds" | "operator"
>;

/** What a Turn on is about: the agent, the client, the version, the copy there and the build. */
interface Subject {
  row: AgentRow;
  template: boolean;
  clientId: string;
  clientName: string;
  version: AgentVersionRow;
  bundle: AnyAgentBundle;
  /** The client's agent that runs: the agent itself, or a template's copy at the client. */
  running: AgentRow | null;
  /** The agent's open build, when it has one. */
  build: BuildRow | null;
}

async function subject(
  ctx: Ctx,
  id: string,
  input: { clientId?: string | undefined; versionId?: string | undefined },
): Promise<Subject> {
  const { tx } = ctx;
  const row = await getAgent(tx, id).catch(() => {
    throw notFound("agent");
  });
  if (row.tenantId !== null && !ctx.tenantIds.includes(row.tenantId)) throw notFound("agent");
  if (row.testCopy) {
    throw new HttpError(
      422,
      "test_copy",
      "a template's test copy only test-runs: turn on the template",
    );
  }
  const template = row.kind === "template";
  const clientId = template ? input.clientId : (row.tenantId as string);
  if (!clientId) {
    throw new HttpError(422, "client_required", "say which client to turn this template on for");
  }
  if (!template && input.clientId && input.clientId !== clientId) {
    throw new HttpError(422, "invalid_request", "a client's agent is turned on at its own client");
  }
  ensureClient(ctx, clientId);
  const version = input.versionId
    ? await getVersion(tx, input.versionId).catch(() => {
        throw notFound("version");
      })
    : await latestVersion(tx, row.id);
  if (!version || version.agentId !== row.id) {
    throw input.versionId
      ? notFound("version")
      : new HttpError(409, "no_version", "there is no draft yet");
  }
  const [client] = await tx
    .select({ name: tenant.name })
    .from(tenant)
    .where(eq(tenant.id, clientId));
  if (!client) throw notFound("client");
  const [open] = await tx
    .select()
    .from(build)
    .where(and(eq(build.agentId, row.id), eq(build.kind, "agent"), eq(build.status, "open")))
    .orderBy(desc(build.updatedAt))
    .limit(1);
  return {
    row,
    template,
    clientId,
    clientName: client.name,
    version,
    bundle: AnyAgentBundle.parse(version.bundle),
    running: template ? await copyAt(tx, row, clientId, open ?? null) : row,
    build: open ?? null,
  };
}

/**
 * A template's copy at the client, to update rather than fork again: the one its build's client
 * test made there, else the newest copy of it there that is neither a test copy nor retired.
 */
// DECISION: as the client test (STATE-8), one copy per template and client is brought up to date;
// a second fork is made only when there is none.
async function copyAt(
  tx: Tx,
  template: AgentRow,
  clientId: string,
  open: BuildRow | null,
): Promise<AgentRow | null> {
  const mine = and(
    eq(agent.tenantId, clientId),
    eq(agent.kind, "client"),
    eq(agent.testCopy, false),
    eq(agent.status, "active"),
    or(isNull(agent.runStatus), ne(agent.runStatus, "retired")),
  );
  if (open && !open.clientId && open.testAgentId && open.testClientId === clientId) {
    const [made] = await tx
      .select()
      .from(agent)
      .where(and(eq(agent.id, open.testAgentId), mine));
    if (made) return made;
  }
  const [newest] = await tx
    .select()
    .from(agent)
    .where(and(eq(agent.templateId, template.id), mine))
    .orderBy(desc(agent.createdAt))
    .limit(1);
  return newest ?? null;
}

/**
 * Whether the bundle was tried at the client: a test run there, of a version with the same bundle,
 * by the agent itself or a copy of its template (a template is tried as its test copy). Test runs
 * never write. `passed` when one finished; `failed` when the last one failed.
 */
async function triedAt(
  tx: Tx,
  input: { clientId: string; hashes: string[]; agentIds: string[]; templateId: string | null },
): Promise<{ passed: boolean; failed: boolean }> {
  const lineage = [
    ...(input.agentIds.length > 0 ? [inArray(run.agentId, input.agentIds)] : []),
    ...(input.templateId ? [eq(agent.templateId, input.templateId)] : []),
  ];
  if (input.hashes.length === 0 || lineage.length === 0) return { passed: false, failed: false };
  const runs = await tx
    .select({ status: run.status })
    .from(run)
    .innerJoin(agentVersion, eq(agentVersion.id, run.agentVersionId))
    .innerJoin(agent, eq(agent.id, run.agentId))
    .where(
      and(
        eq(run.tenantId, input.clientId),
        eq(run.mode, "test"),
        inArray(agentVersion.bundleHash, input.hashes),
        or(...lineage),
      ),
    )
    .orderBy(desc(run.createdAt))
    .limit(50);
  return {
    passed: runs.some((r) => r.status === "succeeded"),
    failed: runs[0]?.status === "failed",
  };
}

/** The validator's errors that are about the client's connection, not the draft. */
// DECISION: a client agent's publish check reads its connection (none bound, a verb off there);
// those are the client's to fix and come back as their connect and allow items, never as ours.
const CLIENT_CODES: ReadonlySet<string> = new Set(["connection_missing", "verb_off"]);

const lower = (s: string) => (s ? `${s[0]?.toLowerCase()}${s.slice(1)}` : s);

/** The list, high-risk decisions first, then ours, then the client's. */
async function itemsOf(ctx: Ctx, s: Subject, hashes: string[]): Promise<TurnOnItem[]> {
  const { tx, services } = ctx;
  const { platform } = services;
  const items: TurnOnItem[] = [];

  // 1. A build's high-risk decisions, worked out by code as the build shows them (§4.2).
  if (s.build) {
    let writes = new Set<string>();
    try {
      const processes = toProcessBundle(s.bundle, convertLookup(platform.catalog, platform.tools));
      writes = await draftWritingSteps({ tx, services }, { bundle: processes, agentRow: s.row });
    } catch {
      // A bundle that doesn't convert has no writing steps to read; the Builder's flags still count.
    }
    for (const d of withDecisionRisk(readFitGap(s.build.fitgap).decisions, writes)) {
      if (d.risk !== "high") continue;
      items.push({
        key: `decision:${d.id}`,
        kind: "decision",
        title: d.what,
        detail: d.why || (d.category ? DECISION_CATEGORY_WORDS[d.category] : undefined) || "",
        owner: "operator",
        holds: false,
        done: decisionReviewed(d),
        ...(d.stepId ? { stepId: d.stepId } : {}),
      });
    }
    for (const i of items) if (i.detail === "") delete i.detail;
  }

  // 2. Ours: tried at the client, and the validator's errors.
  const tried = await triedAt(tx, {
    clientId: s.clientId,
    hashes,
    agentIds: s.running ? [s.running.id] : [],
    templateId: s.template ? s.row.id : s.row.templateId,
  });
  items.push(
    tried.passed
      ? {
          key: "tried",
          kind: "tried",
          title: "Tried on a real example",
          detail: `A test run at ${s.clientName} finished. Nothing was written.`,
          owner: "operator",
          holds: false,
          done: true,
        }
      : {
          key: "tried",
          kind: "tried",
          title: "Not tried yet",
          detail: tried.failed
            ? `Its last try at ${s.clientName} failed. Try it again once it is fixed.`
            : `Run it once at ${s.clientName} on a real example before they see it. Nothing is written.`,
          owner: "operator",
          holds: true,
        },
  );
  const checked = s.template
    ? s.row
    : { ...s.row, bindings: { ...s.row.bindings, ...(await bindingsToAdd(ctx, s.row, s.bundle)) } };
  // What the client's connection leaves out is the client's to do: it is listed below as theirs.
  const errors = (
    await validateForPublish(tx, checked, s.bundle, platform.ctx, {
      previous: await existingBundle(tx, s.version),
    })
  ).filter((e) => !CLIENT_CODES.has(e.code));
  errors.slice(0, 20).forEach((e, n) => {
    items.push({
      key: `invalid:${n}`,
      kind: "invalid",
      title: e.message,
      owner: "operator",
      holds: true,
      ...(e.stepId ? { stepId: e.stepId } : {}),
    });
  });
  if (errors.length > 20) {
    items.push({
      key: "invalid:more",
      kind: "invalid",
      title: `${errors.length - 20} more to fix before it can publish`,
      owner: "operator",
      holds: true,
    });
  }

  // 3. The client's: connections, what to allow, who signs, the setup checklist. A template's copy
  // not made yet is read as the copy will be: bound to the client's connections on the way.
  const running = s.running;
  const needs = await bundleNeeds(tx, s.clientId, s.bundle, platform);
  const connections = await tx
    .select()
    .from(connection)
    .where(eq(connection.tenantId, s.clientId))
    .orderBy(connection.createdAt);
  const grants: Record<string, GrantLimits | null> = {};
  if (running) {
    for (const g of await grantsOfClient(tx, s.clientId)) {
      if (g.agentId === running.id) grants[g.connectionId] = g.limits;
    }
  }
  const bindings = running
    ? { ...running.bindings, ...(await bindingsToAdd(ctx, running, s.bundle)) }
    : null;
  const gaps = gapsOf(needs, {
    connections,
    platform,
    ...(bindings ? { bindings, grants } : {}),
  });
  const name = running?.serviceName ?? running?.name ?? s.row.serviceName ?? s.row.name;

  // The setup checklist the version carries, with the copy's progress where there is a copy.
  const checklist = checklistOf(s.bundle);
  const facts: SetupFacts = running
    ? await setupFacts(
        tx,
        { ...running, bindings: bindings ?? running.bindings },
        platform.ctx,
        s.bundle,
      )
    : { connected: () => false };
  const progress = running ? readStageState(running.stageState).setup : undefined;
  const holdTrial = new Set(setupHolds(checklist, progress, facts, "trial").map((i) => i.id));
  const guardedConnectors = new Set(
    checklist
      .filter(
        (i) =>
          i.kind === "connect" && i.connector && (i.guards === "setup" || i.guards === "trial"),
      )
      .map((i) => i.connector as string),
  );

  for (const connector of [...new Set(needs.map((n) => n.connector))]) {
    const mine = gaps.filter((g) => g.connector === connector && g.kind !== "could_run_alone");
    const label = connectorName(platform, connector);
    const missing = mine.find((g) => g.kind === "not_connected" || g.kind === "broken");
    if (missing) {
      items.push({
        key: `connect:${connector}`,
        kind: "connect",
        title: missing.kind === "broken" ? `Sign in to ${label} again` : `Connect ${label}`,
        detail: `${s.clientName} signs in to its own ${label}. We ask them in their portal's Getting started.`,
        owner: "client",
        holds: false,
        waits: true,
      });
      continue;
    }
    // A connection there and nobody bound: Turn on binds it, so it isn't anyone's to do.
    const allow = mine.filter((g) => g.kind !== "not_bound");
    if (allow.length === 0) {
      items.push({
        key: `connect:${connector}`,
        kind: "connect",
        title: `${label} is connected`,
        detail: `What it reads and changes there is set on ${s.clientName}'s connection.`,
        owner: "client",
        holds: false,
        done: true,
      });
      continue;
    }
    for (const g of allow) {
      const ours = g.fixBy === "mezonas";
      items.push({
        key: `allow:${connector}:${g.kind}`,
        kind: "allow",
        title: gapWords(platform, g, name),
        detail: ours
          ? `${name}'s access to ${label} leaves this out. We widen it from the agent's page.`
          : `${s.clientName} allows it on their ${label} connection. Writes stay at Ask me first.`,
        owner: ours ? "operator" : "client",
        holds: false,
        ...(guardedConnectors.has(connector) ? { waits: true } : {}),
        ...(g.needs[0]?.because[0]?.stepId ? { stepId: g.needs[0].because[0].stepId } : {}),
      });
    }
  }

  for (const role of s.bundle.people ?? []) {
    if (!role.required) continue;
    if ((running?.people[role.role]?.contactIds.length ?? 0) > 0) continue;
    const words = role.role.replace(/[-_]/g, " ");
    items.push({
      key: `who:${role.role}`,
      kind: "who",
      title: `Who is the ${words}`,
      detail:
        role.description ||
        `${s.clientName} names who at setup. It starts with their default approver.`,
      owner: "client",
      holds: false,
      waits: true,
    });
  }

  const view = setupView(checklist, progress, facts);
  for (const r of view.items) {
    if (r.done || (r.kind === "connect" && r.connector)) continue;
    items.push({
      key: `setup:${r.id}`,
      kind: "setup",
      title: r.label,
      ...(r.hint ? { detail: r.hint } : {}),
      owner: "client",
      holds: false,
      ...(holdTrial.has(r.id) ? { waits: true } : {}),
    });
  }
  return items;
}

function answer(
  s: Subject,
  items: TurnOnItem[],
  extra: {
    running?: AgentRow | null;
    versionId?: string;
    version?: number;
    refused?: string[];
  } = {},
): TurnOnAnswer {
  const running = extra.running === undefined ? s.running : extra.running;
  const stage: AgentStage = (running ? stageOf(running) : null) ?? "bench";
  return {
    agentId: running?.id ?? null,
    clientId: s.clientId,
    clientName: s.clientName,
    versionId: extra.versionId ?? s.version.id,
    version: extra.version ?? s.version.version,
    started: !!running && stage !== "bench" && running.runStatus === "active",
    stage,
    items,
    ...(extra.refused && extra.refused.length > 0 ? { refused: extra.refused } : {}),
  };
}

/** What Turn on would do and what holds it. Changes nothing. */
export async function turnOnPreview(
  ctx: Ctx,
  id: string,
  clientId: string | undefined,
): Promise<TurnOnAnswer> {
  const s = await subject(ctx, id, { clientId });
  return answer(s, await itemsOf(ctx, s, [s.version.bundleHash]));
}

/** A refusal's words, with its reasons (the activation check's list). */
function reasonsOf(error: unknown): string[] | null {
  if (error instanceof AgentsError && error.code !== "not_found") {
    const details = Array.isArray(error.details)
      ? error.details
          .map((d) => (typeof d === "string" ? d : (d as { message?: unknown } | null)?.message))
          .filter((m): m is string => typeof m === "string")
      : [];
    return details.length > 0 ? details.slice(0, 20) : [error.message];
  }
  if (error instanceof HttpError && error.status === 409) return [error.message];
  return null;
}

/** Runs `work` in a savepoint; a refusal rolls it back and is answered as its reasons. */
async function attempt<T>(
  tx: Tx,
  work: (sp: Tx) => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; reasons: string[] }> {
  try {
    return { ok: true, value: await tx.transaction((sp) => work(sp)) };
  } catch (error) {
    const reasons = reasonsOf(error);
    if (!reasons) throw error;
    return { ok: false, reasons };
  }
}

/**
 * Turn on, in one transaction: what holds it refuses with 409 before anything changes; then the
 * version is published, a template copied (or its copy updated), the client's connections bound,
 * the agent activated and its trial started. A refusal of the copy's publish, its update or the
 * activation (what the client owes) is answered with `started: false` and its reasons; the rest
 * stays done, and the agent's open build moves to its client test with the refusal as an open
 * item, as the client-test move does.
 */
export async function turnOn(ctx: Ctx, id: string, body: TurnOnBody): Promise<TurnOnAnswer> {
  const { tx, services } = ctx;
  const { platform } = services;
  const actorId = ctx.session.user.id;
  const s = await subject(ctx, id, body);
  const before = await itemsOf(ctx, s, [s.version.bundleHash]);
  const holding = before.filter((i) => i.holds);
  if (holding.length > 0) {
    throw new HttpError(
      409,
      "turn_on_held",
      `not yet: ${holding.map((i) => lower(i.title)).join("; ")}`.slice(0, 500),
      answer(s, before),
    );
  }

  // 1. The version, published. A client's agent is bound first: it is validated with its bindings,
  // and one its client's connection still refuses (none there yet) waits on the client.
  const refused: string[] = [];
  let blocked: TrialBlock | null = null;
  let row = s.row;
  if (!s.template) row = await bindTestCopy(ctx, row, s.bundle);
  if (row.liveVersionId !== s.version.id) {
    const agentId = row.id;
    const published = s.template
      ? {
          ok: true as const,
          value: await publish(tx, {
            agentId,
            versionId: s.version.id,
            actorId,
            ctx: platform.ctx,
          }),
        }
      : await attempt(tx, (sp) =>
          publish(sp, { agentId, versionId: s.version.id, actorId, ctx: platform.ctx }),
        );
    if (!published.ok) {
      refused.push(...published.reasons);
      blocked = { title: "Publish it", detail: published.reasons.join("; ") };
    }
    row = await getAgent(tx, row.id);
  }

  // 2. A template's copy at the client: updated where it has run, else forked afresh.
  let running: AgentRow = row;
  if (s.template) {
    let copy = s.running;
    if (copy && !copy.liveVersionId) {
      // Never published there: discarded and forked again from this version, as the client test.
      await discardDraft(tx, { agentId: copy.id, actorId });
      copy = null;
    }
    if (copy) {
      const current = copy;
      const latest = await latestVersion(tx, current.id);
      let target: AgentVersionRow | null = latest;
      if (latest?.basedOnTemplateVersionId !== s.version.id) {
        const updated = await attempt(tx, (sp) =>
          createUpdateDraft(sp, {
            agentId: current.id,
            actorId,
            changeNote: "The template's new version, for the client's trial",
            ctx: platform.ctx,
          }),
        );
        if (updated.ok) target = updated.value.version;
        else {
          target = null;
          refused.push(...updated.reasons);
          blocked = { title: "Update the client's copy", detail: updated.reasons.join("; ") };
        }
      }
      if (target) {
        copy = await bindTestCopy(ctx, current, AnyAgentBundle.parse(target.bundle));
        if (target.id !== copy.liveVersionId) {
          const vid = target.id;
          const published = await attempt(tx, (sp) =>
            publish(sp, { agentId: current.id, versionId: vid, actorId, ctx: platform.ctx }),
          );
          if (!published.ok) {
            refused.push(...published.reasons);
            blocked = { title: "Publish the client's copy", detail: published.reasons.join("; ") };
          }
        }
      }
      running = await getAgent(tx, current.id);
    } else {
      const made = await fork(tx, {
        tenantId: s.clientId,
        slug: await freeSlug(tx, s.clientId, row.slug),
        templateVersionId: s.version.id,
        templateId: row.id,
        actorId,
      });
      const bound = await bindTestCopy(ctx, made.agent, made.version.bundle);
      const vid = made.version.id;
      const published = await attempt(tx, (sp) =>
        publish(sp, { agentId: bound.id, versionId: vid, actorId, ctx: platform.ctx }),
      );
      if (!published.ok) {
        refused.push(...published.reasons);
        blocked = { title: "Publish the client's copy", detail: published.reasons.join("; ") };
      }
      running = await getAgent(tx, bound.id);
    }
  }

  // 3. Activate: the activation check, then the trial (the lifecycle's own code).
  const live = running.liveVersionId ? await getVersion(tx, running.liveVersionId) : null;
  if (!blocked && live) {
    // DECISION (docs/plan.md §1.170): the activation check wants a passing test run of the live
    // version at the client. A template's fresh copy has none of its own, though the same bundle
    // was tried there as the template's test copy; that run counts, and only that one (the same
    // bundle hash, at this client, of this agent or a copy of its template). Anything else the
    // check asks for (connections, roles, packs, the setup checklist) it still asks for.
    const sameBundle = await triedAt(tx, {
      clientId: s.clientId,
      hashes: [live.bundleHash],
      agentIds: [running.id],
      templateId: s.template ? s.row.id : s.row.templateId,
    });
    const target = running;
    const activated = await attempt(tx, (sp) =>
      activateAgent({ ...ctx, tx: sp }, target, sameBundle.passed ? { requireTestRun: false } : {}),
    );
    if (activated.ok) running = activated.value;
    else {
      refused.push(...activated.reasons);
      blocked = {
        title: "Start the trial: activate the client's copy",
        detail: activated.reasons.join("; "),
      };
    }
  }
  running = await getAgent(tx, running.id);

  // 4. The agent's open build, at its client test, as the client-test move leaves it.
  if (s.build && s.build.phase !== "qa") {
    const [locked] = await tx.select().from(build).where(eq(build.id, s.build.id)).for("update");
    if (locked && locked.status === "open") {
      await moveToClientTest(tx, locked, {
        clientId: s.clientId,
        testAgentId: running.id,
        userId: actorId,
        blocked,
        key: `start:${running.id}:${s.version.id}`,
      });
    }
  }

  // 5. The answer, read again: the agent that runs as it is now (a template's copy is read as the
  // client's agent it is, with its own live bundle), and what the client still owes.
  const after: Subject =
    s.template && live
      ? {
          ...s,
          row: running,
          template: false,
          version: live,
          bundle: AnyAgentBundle.parse(live.bundle),
          running,
        }
      : { ...s, row, running };
  const items = await itemsOf(ctx, after, [
    ...new Set([s.version.bundleHash, ...(live ? [live.bundleHash] : [])]),
  ]);
  return answer(after, items, {
    running,
    ...(live ? { versionId: live.id, version: live.version } : {}),
    refused,
  });
}
