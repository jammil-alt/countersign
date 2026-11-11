// Packs on the platform (ARCHITECTURE §12.1, §14; docs/plan.md §1.13): the back office lists the
// deployment's packs and switches one on for a client (a `tenant_pack` row), which installs the
// pack's templates once as template v1 rows, published, that the operator edits like any other
// (invariant 4); forking one into a client stays the usual fork. Pack reports for the portal and,
// for any client served, the back office, as JSON or CSV; and a pack's review card on an inbox
// item. Nothing here names a pack: each comes from the platform's registered packs (packs.ts).

import { createTemplate, createVersion, mayResolve, publish } from "@countersign/agents";
import {
  type AnyAgentBundle,
  bundleHash,
  type ClientPack,
  type PackReviewDecision,
  type PackTemplateUpdate,
  type Role,
  routes,
} from "@countersign/core";
import { agent, agentVersion, inboxItem, run, type Tx, tenant, tenantPack } from "@countersign/db";
import { and, eq, inArray, isNull } from "drizzle-orm";
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
      description: p.manifest.description,
      enabled: Boolean(row),
      enabledAt: row?.enabledAt.toISOString() ?? null,
      screens: screensOf(p),
    };
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
): Promise<{ n: number; bundle: AnyAgentBundle }[]> {
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
  const out: { n: number; bundle: AnyAgentBundle }[] = [];
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
  return {
    review: key,
    status: item.status,
    canDecide: item.status === "open" && mayResolve(item, who),
    data,
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
    if (!mayResolve(item, who)) {
      throw new HttpError(403, "not_assignee", "this item is assigned to someone else");
    }
    let testRun = false;
    if (item.runId) {
      const [r] = await tx.select({ mode: run.mode }).from(run).where(eq(run.id, item.runId));
      testRun = r?.mode === "test";
    }
    return { item, handler, testRun };
  });
  try {
    await handler.decide(services.db, {
      tenantId: item.tenantId,
      userId: who.userId,
      payload: item.payload as Record<string, unknown>,
      decision: body,
      testRun,
    });
  } catch (error) {
    if (error instanceof Error && /ReviewError|MatchError/.test(error.name)) {
      throw new HttpError(422, "invalid_decision", error.message);
    }
    throw error;
  }
  return inTx(async (tx) => reviewView(tx, services, await find(tx), who));
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
    return { packs: await clientPacks(ctx.tx, ctx.services, ctx.params.id) };
  });

  mount(app, routes.opsEnableClientPack, async (ctx) => {
    const { tx, params, services, session } = ctx;
    ensureClient(ctx, params.id);
    const pack = packOf(services, params.pack);
    await tx
      .insert(tenantPack)
      .values({ tenantId: params.id, pack: pack.manifest.id, version: pack.manifest.version })
      .onConflictDoNothing();
    const installed = await installTemplates(tx, services, pack, session.user.id);
    const packs = await clientPacks(tx, services, params.id);
    const view = packs.find((p) => p.id === pack.manifest.id);
    if (!view) throw notFound("pack");
    return { pack: view, installed };
  });

  mount(app, routes.opsUpdatePackTemplates, async ({ tx, params, services, session }) => {
    const pack = packOf(services, params.pack);
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

  mountLong(app, routes.portalPackReviewDecide, async (ctx) => {
    const { tenantIds, params, services, session, role, body } = ctx;
    return decide(
      txOnly(ctx.inTx),
      services,
      (tx) => portalItem(tx, tenantIds[0] as string, role, session.user.id, params.id),
      { userId: session.user.id, role },
      body,
    );
  });
}
