// Browser connections (ARCHITECTURE §6.10, docs/plan.md §1.26 phase 3). The back office keeps the
// catalogue of sites agents may sign in to: add a site (version 1), add a version (connections keep
// the one they pinned), set the tier with a note of who checked the site's terms. The portal's
// client admin sets up a browser login on an offered site (it pins the site's current version and
// gets an agent identity at the code service) and may make it stricter, never looser. The login
// itself goes through the write-only credentials route (routes/access.ts).

import { BROWSER_CONNECTOR_ID, connectionDefaults } from "@countersign/connectors";
import {
  BrowserConnectionConfig,
  type BrowserSiteProfile,
  routes,
  stricterLoosening,
  uuidv7,
} from "@countersign/core";
import {
  browserSite,
  browserSiteVersion,
  connection,
  connectionChange,
  type Tx,
} from "@countersign/db";
import { and, desc, eq, sql } from "drizzle-orm";
import type { Hono } from "hono";
import { catalogue, catalogueForClient, siteView } from "../browser/sites";
import { CodesServiceError, codesFor } from "../codes/client";
import { type AppEnv, HttpError, mount, notFound } from "../http";
import { offeredTo } from "./connections";

async function viewOf(tx: Tx, slug: string) {
  const [entry] = await catalogue(tx, [slug]);
  if (!entry) throw notFound("site");
  return siteView(tx, entry);
}

async function siteRow(tx: Tx, slug: string) {
  const [row] = await tx.select().from(browserSite).where(eq(browserSite.slug, slug));
  if (!row) throw notFound("site");
  return row;
}

function codesError(error: unknown): never {
  if (error instanceof CodesServiceError) {
    throw new HttpError(
      error.code === "not_configured" || error.code === "unavailable" ? 503 : 422,
      `codes_${error.code}`,
      error.message,
    );
  }
  throw error;
}

export function browserRoutes(app: Hono<AppEnv>): void {
  mount(app, routes.opsBrowserSites, async ({ tx }) => {
    const entries = await catalogue(tx);
    const sites = [];
    for (const e of entries) {
      // A version that no longer parses is shown by its raw fields elsewhere; skip it here.
      if (e.current.parsed) sites.push(await siteView(tx, e));
    }
    return { sites };
  });

  mount(app, routes.opsCreateBrowserSite, async ({ tx, body, session }) => {
    const [taken] = await tx.select().from(browserSite).where(eq(browserSite.slug, body.slug));
    if (taken) throw new HttpError(409, "conflict", `a site called ${body.slug} already exists`);
    const id = uuidv7();
    await tx.insert(browserSite).values({
      id,
      slug: body.slug,
      name: body.name,
      tier: body.tier,
      notes: body.notes,
      createdBy: session.user.id,
      updatedBy: session.user.id,
    });
    await tx.insert(browserSiteVersion).values({
      siteId: id,
      version: 1,
      profile: body.profile as BrowserSiteProfile,
      changeNote: "First version",
      authorId: session.user.id,
    });
    return { site: await viewOf(tx, body.slug) };
  });

  mount(app, routes.opsNewBrowserSiteVersion, async ({ tx, params, body, session }) => {
    const site = await siteRow(tx, params.slug);
    const [last] = await tx
      .select()
      .from(browserSiteVersion)
      .where(eq(browserSiteVersion.siteId, site.id))
      .orderBy(desc(browserSiteVersion.version))
      .limit(1);
    if (last && JSON.stringify(last.profile) === JSON.stringify(body.profile)) {
      throw new HttpError(409, "no_op", "nothing changed from the current version");
    }
    // Versions are only ever added (immutable, invariant 3); connections keep theirs.
    await tx.insert(browserSiteVersion).values({
      siteId: site.id,
      version: (last?.version ?? 0) + 1,
      profile: body.profile as BrowserSiteProfile,
      changeNote: body.changeNote ?? null,
      authorId: session.user.id,
    });
    await tx
      .update(browserSite)
      .set({ updatedBy: session.user.id })
      .where(eq(browserSite.id, site.id));
    return { site: await viewOf(tx, params.slug) };
  });

  mount(app, routes.opsSetBrowserSiteTier, async ({ tx, params, body, session }) => {
    const site = await siteRow(tx, params.slug);
    await tx
      .update(browserSite)
      .set({ tier: body.tier, notes: body.notes, updatedBy: session.user.id })
      .where(eq(browserSite.id, site.id));
    // Each client connection on the site keeps a line in its own log (clients this operator serves).
    const affected = await tx
      .select({ id: connection.id, tenantId: connection.tenantId })
      .from(connection)
      .where(
        and(
          eq(connection.connector, BROWSER_CONNECTOR_ID),
          sql`${connection.config}->>'site' = ${site.slug}`,
        ),
      );
    for (const c of affected) {
      await tx.insert(connectionChange).values({
        tenantId: c.tenantId,
        connectionId: c.id,
        actorId: session.user.id,
        change: { kind: "browser_tier", by: "operator", before: site.tier, after: body.tier },
      });
    }
    return { site: await viewOf(tx, params.slug) };
  });

  mount(app, routes.portalSetUpBrowser, async ({ tx, tenantIds, body, session, services }) => {
    const tenantId = tenantIds[0] as string;
    await offeredTo(tx, tenantId, BROWSER_CONNECTOR_ID);
    const connector = services.platform.connectors.get(BROWSER_CONNECTOR_ID);
    if (!connector) throw notFound("connector");
    const [entry] = await catalogueForClient(tx, [body.site]);
    if (!entry?.current.parsed) throw notFound("site");
    if (entry.site.tier === "blocked") {
      throw new HttpError(409, "not_allowed", "agents never sign in to this site");
    }
    const existing = await tx
      .select({ id: connection.id })
      .from(connection)
      .where(
        and(
          eq(connection.tenantId, tenantId),
          eq(connection.connector, BROWSER_CONNECTOR_ID),
          sql`${connection.config}->>'site' = ${body.site}`,
        ),
      );
    if (existing.length > 0) {
      throw new HttpError(409, "conflict", "a login for this site is already set up");
    }
    const factor = entry.current.parsed.login.secondFactor;
    if (factor.kind === "totp" && !body.authenticator) {
      throw new HttpError(
        422,
        "invalid_setup",
        "this site uses an authenticator app: paste the setup link it shows",
      );
    }
    // The agent identity for its codes: an address on our agent domain, a number for texts, or
    // the site's authenticator key (sent to the code service, never kept here).
    let identity: { id: string; email: string; phone: string | null } | null = null;
    if (factor.kind !== "none") {
      const codes = codesFor(services.env);
      if (!codes) {
        throw new HttpError(503, "codes_not_configured", "sign-in codes are not available yet");
      }
      try {
        let made = await codes.createIdentity({
          tenantId,
          label: `${entry.site.name} agent account`.slice(0, 120),
        });
        if (factor.kind === "sms") made = await codes.addPhone({ tenantId, identityId: made.id });
        if (factor.kind === "totp") {
          await codes.setAuthenticator({
            tenantId,
            identityId: made.id,
            siteKey: entry.site.slug,
            otpauthUri: body.authenticator as string,
          });
        }
        identity = { id: made.id, email: made.email, phone: made.phone };
      } catch (error) {
        codesError(error);
      }
    }
    const config = BrowserConnectionConfig.parse({
      site: entry.site.slug,
      siteVersionId: entry.current.id,
      identity,
    });
    const id = uuidv7();
    await tx.insert(connection).values({
      id,
      tenantId,
      connector: BROWSER_CONNECTOR_ID,
      status: "pending",
      permissions: connectionDefaults(connector.manifest),
      config,
    });
    await tx.insert(connectionChange).values({
      tenantId,
      connectionId: id,
      actorId: session.user.id,
      change: {
        kind: "browser_setup",
        by: "client",
        site: entry.site.slug,
        siteVersion: entry.current.version,
        identity: identity !== null,
      },
    });
    return { connectionId: id };
  });

  mount(app, routes.portalSetBrowserStricter, async ({ tx, tenantIds, params, body, session }) => {
    const tenantId = tenantIds[0] as string;
    const [row] = await tx
      .select()
      .from(connection)
      .where(
        and(
          eq(connection.id, params.connectionId),
          eq(connection.tenantId, tenantId),
          eq(connection.connector, BROWSER_CONNECTOR_ID),
        ),
      );
    if (!row) throw notFound("browser login");
    const config = BrowserConnectionConfig.safeParse(row.config);
    if (!config.success) throw new HttpError(409, "invalid_state", "this login is not set up");
    const loosened = stricterLoosening(config.data.stricter, body);
    if (loosened.length > 0) {
      throw new HttpError(
        403,
        "loosening",
        "only we can loosen a website login; you can make it stricter",
      );
    }
    await tx
      .update(connection)
      .set({ config: { ...(row.config as Record<string, unknown>), stricter: body } })
      .where(and(eq(connection.id, row.id), eq(connection.tenantId, tenantId)));
    await tx.insert(connectionChange).values({
      tenantId,
      connectionId: row.id,
      actorId: session.user.id,
      change: { kind: "browser_stricter", by: "client", before: config.data.stricter, after: body },
    });
    return { connectionId: row.id };
  });
}
