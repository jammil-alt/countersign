// Packs on the platform (ARCHITECTURE §12.1, §14; docs/plan.md §1.13): the back office lists the
// deployment's packs and switches one on for a client (a `tenant_pack` row), which installs the
// pack's templates once as template v1 rows, published, that the operator edits like any other
// (invariant 4); forking one into a client stays the usual fork. Pack reports for the portal and,
// for any client served, the back office, as JSON or CSV; and a pack's review card on an inbox
// item. Nothing here names a pack: each comes from the platform's registered packs (packs.ts).

import {
  createSkill,
  createTemplate,
  createVersion,
  customSlug,
  mayResolve,
  publish,
  publishSkill,
} from "@countersign/agents";
import {
  type AgentBundle,
  bundleHash,
  type ClientPack,
  complianceOf,
  type OpsClientPack,
  PACK_CONFIG_SETTING,
  type PackReviewDecision,
  type PackTemplateUpdate,
  PROCESSOR_NAMES,
  packConfigOf,
  parseCoveredProcessors,
  type Role,
  resolvePackConfig,
  routes,
  uncoveredProcessors,
} from "@countersign/core";
import {
  agent,
  agentVersion,
  inboxItem,
  run,
  skill,
  type Tx,
  tenant,
  tenantChange,
  tenantPack,
  testCase,
} from "@countersign/db";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Hono } from "hono";
import {
  type AppEnv,
  ensureClient,
  HttpError,
  mount,
  mountFile,
  mountLong,
  notFound,
  type Services,
  txOnly,
} from "../http";
import { withCanSign } from "../inbox";
import { refusePhoneSession } from "../mobile/devices";
import type { PackReportHandler, RegisteredPack } from "../packs";
import { signedWriteFor } from "../signed-writes";
import { portalInboxFilter } from "./portal";

const today = () => new Date().toISOString().slice(0, 10);

function packOf(services: Services, id: string): RegisteredPack {
  const pack = services.platform.packs.find((p) => p.manifest.id === id);
  if (!pack) throw notFound("pack");
  return pack;
}

const screensOf = (pack: RegisteredPack) =>
  pack.manifest.screens.map((s) => ({ route: s.route, title: s.title }));

async function enabledPacks(tx: Tx, tenantId: string) {
  return tx
    .select({ pack: tenantPack.pack, enabledAt: tenantPack.enabledAt })
    .from(tenantPack)
    .where(eq(tenantPack.tenantId, tenantId));
}

async function clientPacks(tx: Tx, services: Services, tenantId: string): Promise<ClientPack[]> {
  const on = await enabledPacks(tx, tenantId);
  return services.platform.packs.map((p) => {
    const row = on.find((e) => e.pack === p.manifest.id);
    return {
      id: p.manifest.id,
      name: p.manifest.name,
      area: p.manifest.intakeSection?.title ?? p.manifest.name,
      description: p.manifest.description,
      enabled: Boolean(row),
      enabledAt: row?.enabledAt.toISOString() ?? null,
      screens: screensOf(p),
      connections: p.manifest.connections ?? [],
    };
  });
}

async function tenantSettings(tx: Tx, tenantId: string): Promise<Record<string, unknown>> {
  const [row] = await tx
    .select({ settings: tenant.settings })
    .from(tenant)
    .where(eq(tenant.id, tenantId));
  return (row?.settings as Record<string, unknown> | undefined) ?? {};
}

/**
 * §1.230: the Areas tab's view of each pack for one client: the portal's, with the pack's area,
 * its configuration (this client's values, defaults until set) and its vendors of ours, each
 * marked when this client's HIPAA mode holds it back.
 */
async function opsClientPacks(
  tx: Tx,
  services: Services,
  tenantId: string,
): Promise<OpsClientPack[]> {
  const settings = await tenantSettings(tx, tenantId);
  const profile = complianceOf(settings);
  const covered = parseCoveredProcessors(services.env.BAA_PROCESSORS);
  const views = await clientPacks(tx, services, tenantId);
  return views.map((view) => {
    const { manifest } = packOf(services, view.id);
    return {
      ...view,
      areaId: manifest.area,
      config: {
        fields: manifest.config,
        values: packConfigOf(manifest.config, settings, manifest.id),
      },
      processors: manifest.processors.map((id) => ({
        id,
        name: PROCESSOR_NAMES[id],
        heldForHipaa: uncoveredProcessors(profile, covered, [id]).length > 0,
      })),
    };
  });
}

/**
 * §1.230: keeps a client's configuration of a pack in `tenant.settings.packs.<id>`, the operator's
 * input over what it has, every other field at its default; a `tenant_change` row says what
 * changed. A key the pack doesn't declare, or a value its field doesn't take, is a 400.
 */
// DECISION (§1.230): the configuration lives in `tenant.settings` (no migration): it is a client's
// setting like its hours or channels, read by the pack with core's `packConfigOf`, and a pack
// switched off and on again keeps it.
async function saveConfig(
  tx: Tx,
  pack: RegisteredPack,
  tenantId: string,
  actorId: string,
  input: Readonly<Record<string, unknown>>,
): Promise<void> {
  const { manifest } = pack;
  if (manifest.config.length === 0 && Object.keys(input).length === 0) return;
  const [row] = await tx
    .select({ settings: tenant.settings })
    .from(tenant)
    .where(eq(tenant.id, tenantId))
    .for("update");
  const settings = (row?.settings as Record<string, unknown> | undefined) ?? {};
  const before = packConfigOf(manifest.config, settings, manifest.id);
  const resolved = resolvePackConfig(manifest.config, input, before);
  if (!resolved.ok) {
    throw new HttpError(400, "invalid_config", resolved.problems.join("; "));
  }
  const all = settings[PACK_CONFIG_SETTING];
  const kept =
    all && typeof all === "object" && !Array.isArray(all)
      ? (all as Record<string, unknown>)[manifest.id]
      : undefined;
  // Unchanged and already written: nothing to keep or log.
  if (kept !== undefined && JSON.stringify(before) === JSON.stringify(resolved.values)) return;
  await tx
    .update(tenant)
    .set({
      settings: sql`jsonb_set(coalesce(${tenant.settings}, '{}'::jsonb), ${`{${PACK_CONFIG_SETTING}}`}::text[],
        coalesce(${tenant.settings} -> ${PACK_CONFIG_SETTING}, '{}'::jsonb)
          || jsonb_build_object(${manifest.id}::text, ${JSON.stringify(resolved.values)}::jsonb))`,
    })
    .where(eq(tenant.id, tenantId));
  await tx.insert(tenantChange).values({
    tenantId,
    actorId,
    change: {
      setting: `${PACK_CONFIG_SETTING}.${manifest.id}`,
      from: kept === undefined ? null : before,
      to: resolved.values,
    },
    reason: `The ${manifest.name} pack's settings`,
  });
}

/** The pack's templates by slug, among the operator's templates (tenant_id null). */
async function installedTemplates(tx: Tx, slugs: string[]) {
  if (slugs.length === 0) return [];
  return tx
    .select({ id: agent.id, slug: agent.slug })
    .from(agent)
    .where(and(isNull(agent.tenantId), eq(agent.kind, "template"), inArray(agent.slug, slugs)));
}

/** The pack's later versions of a template it doesn't hold yet (by bundle hash), in order. */
async function missingVersions(
  tx: Tx,
  templateId: string,
  t: RegisteredPack["manifest"]["templates"][number],
): Promise<{ n: number; bundle: AgentBundle }[]> {
  const later = t.versions ?? [];
  if (later.length === 0) return [];
  const held = new Set(
    (
      await tx
        .select({ hash: agentVersion.bundleHash })
        .from(agentVersion)
        .where(eq(agentVersion.agentId, templateId))
    ).map((r) => r.hash),
  );
  const out: { n: number; bundle: AgentBundle }[] = [];
  for (const [i, bundle] of later.entries()) {
    if (!held.has(await bundleHash(bundle))) out.push({ n: i + 2, bundle });
  }
  return out;
}

/**
 * Adds a template's missing later versions as new versions by the pack. Each is published when
 * `publishOver` allows it (a fresh install; or the live version is the pack's own), else it waits
 * as a draft beside the operator's live version. Publishing a template changes no client agent
 * (invariant 11): each fork is offered the update and moves only by its reviewed merge.
 */
async function addLaterVersions(
  tx: Tx,
  services: Services,
  pack: RegisteredPack,
  templateId: string,
  t: RegisteredPack["manifest"]["templates"][number],
  actorId: string,
  publishOver: boolean,
): Promise<PackTemplateUpdate[]> {
  const from = `the ${pack.manifest.name} pack ${pack.manifest.version}`;
  const out: PackTemplateUpdate[] = [];
  for (const { n, bundle } of await missingVersions(tx, templateId, t)) {
    const draft = await createVersion(tx, {
      agentId: templateId,
      bundle,
      authorType: "pack",
      authorId: actorId,
      changeNote: `Installed with ${from}: its v${n}`,
      releaseNote: `The pack's v${n}`,
    });
    if (publishOver) {
      await publish(tx, {
        agentId: templateId,
        versionId: draft.id,
        actorId,
        ctx: services.platform.ctx,
      });
    }
    out.push({ slug: t.slug, templateId, version: draft.version, published: publishOver });
  }
  return out;
}

/**
 * Installs the pack's templates that aren't there yet: a template v1 by the pack, published so it
 * can be forked, then its later versions (R9: the Bookkeeper's and the marketing agents' v2, their
 * v4 processes), published in order. A template with the same slug already there counts as
 * installed and is left as it is: its later versions come with `updatePackTemplates`.
 */
// DECISION: a pack's templates are installed the first time the pack is switched on for any client
// (not at deploy), so a deployment that never uses a pack has none of its templates.
// DECISION (wave 3b, replacing R9's): switching a pack on for a client never changes a template
// that is already installed; "Update templates" (opsUpdatePackTemplates) adds its later versions,
// so a routine per-client action never publishes a template version for every client.
async function installTemplates(
  tx: Tx,
  services: Services,
  pack: RegisteredPack,
  actorId: string,
): Promise<{ slug: string; templateId: string }[]> {
  const have = await installedTemplates(
    tx,
    pack.manifest.templates.map((t) => t.slug),
  );
  const installed: { slug: string; templateId: string }[] = [];
  const from = `the ${pack.manifest.name} pack ${pack.manifest.version}`;
  for (const t of pack.manifest.templates) {
    if (have.some((h) => h.slug === t.slug)) continue;
    const made = await createTemplate(tx, {
      slug: t.slug,
      bundle: t.bundle,
      authorType: "pack",
      authorId: actorId,
      changeNote: `Installed with ${from}`,
      releaseNote: "First version",
    });
    await publish(tx, {
      agentId: made.agent.id,
      versionId: made.version.id,
      // Review: the pack's first version, from code: none of its steps is new work.
      installed: true,
      actorId,
      ctx: services.platform.ctx,
    });
    await addLaterVersions(tx, services, pack, made.agent.id, t, actorId, true);
    installed.push({ slug: t.slug, templateId: made.agent.id });
  }
  return installed;
}

/**
 * §1.88: installs the pack's shared Library skills that aren't there yet: an operator skill each
 * (`custom:<slug>`, tenant_id null), v1 by the pack, published so agents can use it. A shared skill
 * of that slug already there is left as it is: from its install on, it is the operator's to edit,
 * version, test and publish in the Library, and the pack never changes it.
 */
// DECISION (review of vendor/web3, finding 1): installed when the pack is switched on for a client
// (as its templates are) and by "Update templates", so a deployment that had the pack on before
// gets them; a Library skill is never re-installed over the operator's versions.
export async function installLibrarySkills(
  tx: Tx,
  services: Services,
  pack: RegisteredPack,
  actorId: string,
): Promise<{ ref: string; skillId: string }[]> {
  const defs = pack.manifest.librarySkills ?? [];
  if (defs.length === 0) return [];
  const slugs = defs.map((d) => customSlug(d.id));
  const have = new Set(
    (
      await tx
        .select({ slug: skill.slug })
        .from(skill)
        .where(and(isNull(skill.tenantId), inArray(skill.slug, slugs)))
    ).map((r) => r.slug),
  );
  const installed: { ref: string; skillId: string }[] = [];
  for (const def of defs) {
    if (have.has(customSlug(def.id))) continue;
    // Step model §8: a Loop is never published untested, so a pack's Loop comes with its test set.
    const cases = pack.manifest.loopTests?.[def.id] ?? [];
    if (def.loop !== undefined && cases.length === 0) {
      throw new HttpError(
        422,
        "loop_without_tests",
        `${def.id} is a Loop and the ${pack.manifest.name} pack ships it without a test set`,
      );
    }
    const made = await createSkill(tx, {
      tenantId: null,
      definition: def,
      authorId: actorId,
      changeNote: `Installed with the ${pack.manifest.name} pack ${pack.manifest.version}`,
      tools: services.platform.tools,
    });
    await publishSkill(tx, { skillId: made.skill.id, versionId: made.version.id });
    // Its cases are kept with it, so the lab shows and runs them (shared, synthetic data).
    for (const c of cases) {
      await tx.insert(testCase).values({
        tenantId: null,
        targetKind: "skill",
        targetId: made.skill.id,
        name: c.name,
        input: c.input ?? null,
        fixtures: c.fixtures,
        expected: c.expected ?? null,
        matcher: c.matcher,
        required: true,
        source: "manual",
        createdBy: actorId,
      });
    }
    installed.push({ ref: def.id, skillId: made.skill.id });
  }
  return installed;
}

/**
 * Wave 3b: gives the pack's installed templates the later versions the pack carries (the v4
 * processes), so clients that already have the pack are offered them: each client agent forked
 * from the template sees the update and takes it only by a reviewed merge (invariant 11).
 */
// DECISION (wave 3b): a later version is published over a live version the pack made (or when the
// template has none live); over a live version the operator made, it is saved as a draft for the
// operator to review and publish, so their own edits are never retired by an update.
export async function updatePackTemplates(
  tx: Tx,
  services: Services,
  pack: RegisteredPack,
  actorId: string,
): Promise<PackTemplateUpdate[]> {
  const rows = await tx
    .select({ id: agent.id, slug: agent.slug, liveVersionId: agent.liveVersionId })
    .from(agent)
    .where(
      and(
        isNull(agent.tenantId),
        eq(agent.kind, "template"),
        inArray(
          agent.slug,
          pack.manifest.templates.map((t) => t.slug),
        ),
      ),
    );
  const out: PackTemplateUpdate[] = [];
  for (const t of pack.manifest.templates) {
    const row = rows.find((r) => r.slug === t.slug);
    if (!row) continue;
    const [live] = row.liveVersionId
      ? await tx
          .select({ authorType: agentVersion.authorType })
          .from(agentVersion)
          .where(eq(agentVersion.id, row.liveVersionId))
      : [];
    const publishOver = !live || live.authorType === "pack";
    out.push(...(await addLaterVersions(tx, services, pack, row.id, t, actorId, publishOver)));
  }
  return out;
}

/**
 * A pack's report for a client that has the pack on. M50: in the portal, only one the pack lets
 * the portal read (`portalReports`); any other is 404 there, as a report that doesn't exist.
 */
async function reportHandler(
  tx: Tx,
  services: Services,
  tenantId: string,
  packId: string,
  name: string,
  surface: "ops" | "portal" = "ops",
) {
  const pack = packOf(services, packId);
  const on = await enabledPacks(tx, tenantId);
  if (!on.some((e) => e.pack === packId)) throw notFound("report");
  if (surface === "portal" && pack.portalReports && !pack.portalReports.includes(name)) {
    throw notFound("report");
  }
  const handler = pack.reports?.[name];
  if (!handler) throw notFound("report");
  return handler;
}

/**
 * §1.73: the report's query parameters, checked by the pack's own schema (a 400 when they don't
 * pass). The session's `client` is the platform's, never the pack's; a report without a schema
 * gets none.
 */
export function reportQuery(
  handler: Pick<PackReportHandler, "query">,
  raw: Readonly<Record<string, string>> | undefined,
): Record<string, unknown> {
  if (!handler.query) return {};
  const { client: _client, ...rest } = raw ?? {};
  const parsed = handler.query.safeParse(rest);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.length ? `${issue.path.join(".")}: ` : "";
    throw new HttpError(400, "invalid_query", `${where}${issue?.message ?? "a bad query"}`);
  }
  return parsed.data as Record<string, unknown>;
}

async function reportResponse(
  tx: Tx,
  services: Services,
  tenantId: string,
  packId: string,
  name: string,
  query?: Readonly<Record<string, string>>,
  surface: "ops" | "portal" = "ops",
) {
  const handler = await reportHandler(tx, services, tenantId, packId, name, surface);
  return { report: await handler.json(tx, tenantId, today(), reportQuery(handler, query)) };
}

// P-9: one row of a report in full; a report without items answers 404.
async function reportItem(
  tx: Tx,
  services: Services,
  tenantId: string,
  packId: string,
  name: string,
  itemId: string,
  query?: Readonly<Record<string, string>>,
  surface: "ops" | "portal" = "ops",
) {
  const handler = await reportHandler(tx, services, tenantId, packId, name, surface);
  if (!handler.item) throw notFound("report item");
  const found = await handler.item(tx, tenantId, itemId, today(), reportQuery(handler, query));
  if (!found) throw notFound("report item");
  return { report: found };
}

// P-1: the CSV through mountFile, as the exports send theirs (main's file routes).
async function reportCsv(
  tx: Tx,
  services: Services,
  tenantId: string,
  packId: string,
  name: string,
  query?: Readonly<Record<string, string>>,
  surface: "ops" | "portal" = "ops",
) {
  const handler = await reportHandler(tx, services, tenantId, packId, name, surface);
  const day = today();
  const q = reportQuery(handler, query);
  return {
    filename: `${packId}-${name}-${day}.csv`,
    contentType: "text/csv; charset=utf-8" as const,
    // A fresh ArrayBuffer-backed copy, as the exports' csvFile makes.
    bytes: new Uint8Array(new TextEncoder().encode(await handler.csv(tx, tenantId, day, q))),
  };
}

type InboxRow = typeof inboxItem.$inferSelect;

function reviewKey(item: InboxRow): string | null {
  const payload = item.payload as Record<string, unknown>;
  return typeof payload.review === "string" ? payload.review : null;
}

function reviewHandler(services: Services, key: string) {
  for (const p of services.platform.packs) {
    const h = p.reviews?.[key];
    if (h) return h;
  }
  return null;
}

async function reviewView(
  tx: Tx,
  services: Services,
  item: InboxRow,
  who: { userId: string; role: Role },
) {
  const key = reviewKey(item);
  const handler = key ? reviewHandler(services, key) : null;
  if (!key || !handler) throw notFound("review");
  const data = await handler.load(tx, item.tenantId, item.payload as Record<string, unknown>);
  // 5.14: a viewer signs nothing (ARCHITECTURE §4), as on every other inbox item.
  const by = await withCanSign(tx, item.tenantId, who);
  return {
    review: key,
    status: item.status,
    canDecide: item.status === "open" && mayResolve(item, by),
    data,
  };
}

/** A pack's refusal on a card (`ReviewError`, Materials' `MatchError`) as the card's 422. */
async function asCard<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof Error && /ReviewError|MatchError/.test(error.name)) {
      throw new HttpError(422, "invalid_decision", error.message);
    }
    throw error;
  }
}

/**
 * §1.164: a card's search (Confirm matches' look-up). Only someone who may decide the open item
 * searches from it, and only that item's client's records (the pack queries by its tenant, inside
 * the route's transaction, which holds that client).
 */
async function reviewLookup(
  tx: Tx,
  services: Services,
  item: InboxRow,
  who: { userId: string; role: Role },
  query: { q: string; module?: string | undefined },
) {
  const key = reviewKey(item);
  const handler = key ? reviewHandler(services, key) : null;
  if (!key || !handler?.lookup) throw notFound("review lookup");
  if (item.status !== "open") throw new HttpError(409, "not_open", "this item is closed");
  const by = await withCanSign(tx, item.tenantId, who);
  if (by.canSign === false || !mayResolve(item, by)) {
    throw new HttpError(403, "not_assignee", "only someone who decides this card searches from it");
  }
  const lookup = handler.lookup.bind(handler);
  const records = await asCard(() =>
    lookup(tx, item.tenantId, item.payload as Record<string, unknown>, query),
  );
  return { records: records.slice(0, 20) };
}

/**
 * §1.164: the answer a finished card hands its waiting run, from the pack (`answer`): what was
 * recorded, never what the browser sent. Undefined for an item that isn't a card, or a card whose
 * pack gives none (the browser's answer stands, as before). The inbox's resolve routes pass it.
 */
export function packReviewAnswer(services: Services) {
  return async (tx: Tx, item: InboxRow): Promise<unknown> => {
    const key = reviewKey(item);
    const handler = key ? reviewHandler(services, key) : null;
    if (!handler?.answer) return undefined;
    const answer = handler.answer.bind(handler);
    return asCard(() => answer(tx, item.tenantId, item.payload as Record<string, unknown>));
  };
}

/**
 * A review's decision: the item is read and checked in one short transaction, the pack's handler
 * decides in its own (it records the match and learns the alias), and the view is read in a third.
 * No transaction is held across the handler's (`mountLong`: a Worker has one pooled connection).
 */
async function decide(
  inTx: <T>(work: (tx: Tx) => Promise<T>) => Promise<T>,
  services: Services,
  find: (tx: Tx) => Promise<InboxRow>,
  who: { userId: string; role: Role },
  body: PackReviewDecision,
) {
  const { item, handler, testRun } = await inTx(async (tx) => {
    const item = await find(tx);
    const key = reviewKey(item);
    const handler = key ? reviewHandler(services, key) : null;
    if (!key || !handler) throw notFound("review");
    if (item.status !== "open") throw new HttpError(409, "not_open", "this item is closed");
    // 5.14: a viewer signs nothing (ARCHITECTURE §4), as `resolveInboxItem` refuses.
    const by = await withCanSign(tx, item.tenantId, who);
    if (by.canSign === false) {
      throw new HttpError(
        403,
        "cannot_sign",
        "you can see this, but you don't approve for your team",
      );
    }
    if (!mayResolve(item, by)) {
      throw new HttpError(403, "not_assignee", "this item is assigned to someone else");
    }
    let testRun = false;
    if (item.runId) {
      const [r] = await tx.select({ mode: run.mode }).from(run).where(eq(run.id, item.runId));
      testRun = r?.mode === "test";
    }
    return { item, handler, testRun };
  });
  await asCard(() =>
    handler.decide(services.db, {
      tenantId: item.tenantId,
      userId: who.userId,
      payload: item.payload as Record<string, unknown>,
      decision: body,
      testRun,
    }),
  );
  return inTx(async (tx) => reviewView(tx, services, await find(tx), who));
}

/**
 * §1.230: the one install path, the same for every pack and taking only configuration: the
 * configuration is checked and kept first (a bad one switches nothing on), then the pack is
 * on for the client, its templates and Library skills installed once for the deployment.
 * Installing again changes only the configuration.
 */
export async function installPack(
  tx: Tx,
  services: Services,
  tenantId: string,
  packId: string,
  actorId: string,
  config: Readonly<Record<string, unknown>>,
) {
  const pack = packOf(services, packId);
  await saveConfig(tx, pack, tenantId, actorId, config);
  await tx
    .insert(tenantPack)
    .values({ tenantId, pack: pack.manifest.id, version: pack.manifest.version })
    .onConflictDoNothing();
  const installed = await installTemplates(tx, services, pack, actorId);
  await installLibrarySkills(tx, services, pack, actorId);
  const packs = await opsClientPacks(tx, services, tenantId);
  const view = packs.find((p) => p.id === pack.manifest.id);
  if (!view) throw notFound("pack");
  return { pack: view, installed };
}

/** What switching on a fork's packs did: on now, or left for the operator, with why. */
export interface PacksSwitched {
  switchedOn: string[];
  needsSetup: { pack: string; reason: string }[];
}

/**
 * A template forked into a client gets the packs its skills need (owner, 2026-11-24): each one
 * that is off is switched on as the Areas tab's "Switch on" does (`installPack`, no settings, so
 * every setting at its default). One that needs settings without a default, or that this
 * deployment doesn't have, is left off and named, for the operator to set up; the fork goes ahead.
 */
// DECISION: on at the fork, not at activation: activation already refuses without it, and the
// client test forks before it activates. Recorded in the fork's own audit row (its route).
export async function switchOnPacks(
  tx: Tx,
  services: Services,
  tenantId: string,
  packIds: readonly string[],
  actorId: string,
): Promise<PacksSwitched> {
  const out: PacksSwitched = { switchedOn: [], needsSetup: [] };
  if (packIds.length === 0) return out;
  const on = new Set((await enabledPacks(tx, tenantId)).map((r) => r.pack));
  for (const id of packIds) {
    if (on.has(id)) continue;
    if (!services.platform.packs.some((p) => p.manifest.id === id)) {
      out.needsSetup.push({ pack: id, reason: "this deployment doesn't have the pack" });
      continue;
    }
    try {
      await installPack(tx, services, tenantId, id, actorId, {});
      out.switchedOn.push(id);
    } catch (e) {
      // saveConfig refuses before it writes, so the transaction goes on.
      if (!(e instanceof HttpError)) throw e;
      out.needsSetup.push({ pack: id, reason: e.message });
    }
  }
  return out;
}

export function packRouteHandlers(app: Hono<AppEnv>): void {
  // ── Back office ────────────────────────────────────────────────────────────────────────────────
  mount(app, routes.opsPacks, async ({ tx, tenantIds, services }) => {
    const clients =
      tenantIds.length > 0
        ? await tx
            .select({ id: tenant.id, name: tenant.name })
            .from(tenant)
            .where(inArray(tenant.id, [...tenantIds]))
            .orderBy(tenant.name)
        : [];
    const on =
      tenantIds.length > 0
        ? await tx
            .select()
            .from(tenantPack)
            .where(inArray(tenantPack.tenantId, [...tenantIds]))
        : [];
    const packs = [];
    for (const p of services.platform.packs) {
      const have = await installedTemplates(
        tx,
        p.manifest.templates.map((t) => t.slug),
      );
      packs.push({
        id: p.manifest.id,
        name: p.manifest.name,
        version: p.manifest.version,
        description: p.manifest.description,
        templates: await Promise.all(
          p.manifest.templates.map(async (t) => {
            const templateId = have.find((h) => h.slug === t.slug)?.id ?? null;
            return {
              slug: t.slug,
              name: t.bundle.definition.identity.name,
              templateId,
              newVersions: templateId ? (await missingVersions(tx, templateId, t)).length : 0,
            };
          }),
        ),
        screens: screensOf(p),
        clients: clients.map((c) => {
          const row = on.find((r) => r.tenantId === c.id && r.pack === p.manifest.id);
          return {
            id: c.id,
            name: c.name,
            enabled: Boolean(row),
            enabledAt: row?.enabledAt.toISOString() ?? null,
          };
        }),
      });
    }
    return { packs };
  });

  mount(app, routes.opsClientPacks, async (ctx) => {
    ensureClient(ctx, ctx.params.id);
    return { packs: await opsClientPacks(ctx.tx, ctx.services, ctx.params.id) };
  });

  mount(app, routes.opsEnableClientPack, async (ctx) => {
    const { tx, params, services, session } = ctx;
    ensureClient(ctx, params.id);
    return installPack(tx, services, params.id, params.pack, session.user.id, {});
  });

  mount(app, routes.opsInstallClientPack, async (ctx) => {
    const { tx, params, services, session, body } = ctx;
    ensureClient(ctx, params.id);
    return installPack(tx, services, params.id, params.pack, session.user.id, body.config);
  });

  mount(app, routes.opsUpdatePackTemplates, async ({ tx, params, services, session }) => {
    const pack = packOf(services, params.pack);
    await installLibrarySkills(tx, services, pack, session.user.id);
    return { updated: await updatePackTemplates(tx, services, pack, session.user.id) };
  });

  mount(app, routes.opsClientPackReport, async (ctx) => {
    ensureClient(ctx, ctx.params.id);
    const { tx, services, params, query } = ctx;
    return reportResponse(tx, services, params.id, params.pack, params.report, query);
  });

  // P-9
  mount(app, routes.opsClientPackReportItem, async (ctx) => {
    ensureClient(ctx, ctx.params.id);
    const { tx, services, params, query } = ctx;
    return reportItem(tx, services, params.id, params.pack, params.report, params.itemId, query);
  });

  mountFile(app, routes.opsClientPackReportCsv, async (ctx) => {
    ensureClient(ctx, ctx.params.id);
    const { tx, services, params, query } = ctx;
    return reportCsv(tx, services, params.id, params.pack, params.report, query);
  });

  // The pack's action opens its own transaction (and a signed write reaches the client's tool):
  // none is held across it (`mountLong`; a Worker's database has one pooled connection).
  mountLong(app, routes.opsClientPackAction, async (ctx) => {
    const { params, services, session, body } = ctx;
    ensureClient(ctx, params.id);
    const pack = packOf(services, params.pack);
    const on = await ctx.inTx(({ tx }) => enabledPacks(tx, params.id));
    if (!on.some((e) => e.pack === pack.manifest.id)) throw notFound("pack");
    const handler = pack.actions?.[params.action];
    if (!handler) throw notFound("action");
    const input = handler.input.parse(body);
    try {
      // Its own transaction for that one client (the pack's action opens it).
      return {
        result: await handler.run(services.db, {
          tenantId: params.id,
          userId: session.user.id,
          input,
          // M46: a change outside the person signs with this action (publishing a guide).
          signedWrite: signedWriteFor(services, { tenantId: params.id, userId: session.user.id }),
        }),
      };
    } catch (error) {
      // A pack's refusal (Materials' MatchError; `PackRefusal` for any pack's own) is a 422.
      if (error instanceof Error && (error.name === "MatchError" || error.name === "PackRefusal")) {
        throw new HttpError(422, "refused", error.message);
      }
      throw error;
    }
  });

  async function opsItem(tx: Tx, tenantIds: readonly string[], id: string): Promise<InboxRow> {
    const [item] = await tx
      .select()
      .from(inboxItem)
      .where(and(eq(inboxItem.id, id), inArray(inboxItem.tenantId, [...tenantIds])));
    if (!item) throw notFound("inbox item");
    return item;
  }

  mount(app, routes.opsPackReview, async ({ tx, tenantIds, params, services, session, role }) =>
    reviewView(tx, services, await opsItem(tx, tenantIds, params.id), {
      userId: session.user.id,
      role,
    }),
  );

  // §1.164: the card's search, for the item's client only.
  mount(
    app,
    routes.opsPackReviewLookup,
    async ({ tx, tenantIds, params, services, session, role, query }) =>
      reviewLookup(
        tx,
        services,
        await opsItem(tx, tenantIds, params.id),
        {
          userId: session.user.id,
          role,
        },
        query,
      ),
  );

  mountLong(app, routes.opsPackReviewDecide, async (ctx) => {
    const { tenantIds, params, services, session, role, body } = ctx;
    return decide(
      txOnly(ctx.inTx),
      services,
      (tx) => opsItem(tx, tenantIds, params.id),
      { userId: session.user.id, role },
      body,
    );
  });

  // ── Portal ─────────────────────────────────────────────────────────────────────────────────────
  mount(app, routes.portalPacks, async ({ tx, tenantIds, services }) => ({
    packs: (await clientPacks(tx, services, tenantIds[0] as string)).filter((p) => p.enabled),
  }));

  // P-9
  mount(app, routes.portalPackReportItem, async ({ tx, tenantIds, params, services, query }) =>
    reportItem(
      tx,
      services,
      tenantIds[0] as string,
      params.pack,
      params.report,
      params.itemId,
      query,
      "portal",
    ),
  );

  // M50: the portal reads only the reports a pack lets it (`portalReports`).
  mount(app, routes.portalPackReport, async ({ tx, tenantIds, params, services, query }) =>
    reportResponse(
      tx,
      services,
      tenantIds[0] as string,
      params.pack,
      params.report,
      query,
      "portal",
    ),
  );

  mountFile(app, routes.portalPackReportCsv, async ({ tx, tenantIds, params, services, query }) =>
    reportCsv(tx, services, tenantIds[0] as string, params.pack, params.report, query, "portal"),
  );

  async function portalItem(
    tx: Tx,
    tenantId: string,
    role: Role,
    userId: string,
    id: string,
  ): Promise<InboxRow> {
    const [item] = await tx
      .select()
      .from(inboxItem)
      .where(
        and(
          eq(inboxItem.id, id),
          eq(inboxItem.tenantId, tenantId),
          portalInboxFilter(role, userId),
        ),
      );
    if (!item) throw notFound("inbox item");
    return item;
  }

  mount(
    app,
    routes.portalPackReview,
    async ({ tx, tenantIds, params, services, session, role }) => {
      const item = await portalItem(tx, tenantIds[0] as string, role, session.user.id, params.id);
      return reviewView(tx, services, item, { userId: session.user.id, role });
    },
  );

  // §1.164: the card's search: the portal's own client's records only.
  mount(
    app,
    routes.portalPackReviewLookup,
    async ({ tx, tenantIds, params, services, session, role, query }) => {
      const item = await portalItem(tx, tenantIds[0] as string, role, session.user.id, params.id);
      return reviewLookup(tx, services, item, { userId: session.user.id, role }, query);
    },
  );

  mountLong(app, routes.portalPackReviewDecide, async (ctx) => {
    const { tenantIds, params, services, session, role, body } = ctx;
    // Audit 5.2: a phone's session decides a card only with a signature; this route carries none.
    refusePhoneSession(session);
    return decide(
      txOnly(ctx.inTx),
      services,
      (tx) => portalItem(tx, tenantIds[0] as string, role, session.user.id, params.id),
      { userId: session.user.id, role },
      body,
    );
  });
}
